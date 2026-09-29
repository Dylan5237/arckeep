import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { planShell, resolveBash } from '../src/main/tool-launch.js'
import { killProcessTree, runPlan, terminationCommand } from '../src/main/tool-runner.js'
import { expandCommand } from '../src/shared/tools/quote.js'
import type { ShellKind } from '../src/shared/tools/types.js'

const markers: string[] = []

afterEach(() => {
  for (const marker of markers.splice(0)) {
    rmSync(marker, { force: true })
  }
})

function markerPath(name: string): string {
  const file = path.join(tmpdir(), `arckeep-inject-${process.pid}-${name}-${Date.now()}`)
  markers.push(file)
  return file
}

describe('process tree termination', () => {
  it('uses taskkill /T on Windows and a process group elsewhere', () => {
    expect(terminationCommand(42, 'win32')).toEqual({
      file: 'taskkill.exe',
      args: ['/PID', '42', '/T', '/F']
    })
    expect(terminationCommand(42, 'linux')).toEqual({ group: true })
  })

  it('kills a child that the command itself started', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'arckeep-kill-'))
    const script = path.join(dir, 'parent.js')
    const pidFile = path.join(dir, 'child.pid')
    writeFileSync(script, `
      const { spawn } = require('node:child_process')
      const fs = require('node:fs')
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 500)'], { stdio: 'ignore' })
      fs.writeFileSync(process.argv[2], String(child.pid))
      setInterval(() => {}, 500)
    `)
    const parent = spawn(process.execPath, [script, pidFile], {
      detached: process.platform !== 'win32',
      stdio: 'ignore'
    })
    try {
      const childPid = await waitForPid(pidFile)
      await killProcessTree(parent)
      await waitUntilDead(parent.pid ?? -1)
      await waitUntilDead(childPid)
    } finally {
      try { await killProcessTree(parent) } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})

async function waitForPid(file: string): Promise<number> {
  const start = Date.now()
  while (Date.now() - start < 5000) {
    if (existsSync(file)) {
      const pid = Number(readFileSync(file, 'utf8'))
      if (pid > 0) return pid
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('child pid was not written')
}

async function waitUntilDead(pid: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < 5000) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`process ${pid} is still running`)
}

const roundTripTemplate = `node -e "process.stdout.write(process.argv[1] ?? '')" {{payload}}`

const hostilePayloads: Array<(marker: string) => string> = [
  marker => `& echo pwned>${marker}`,
  marker => `; rm -rf x>${marker}`,
  () => '"',
  marker => `$(echo pwned>${marker})`,
  marker => '`echo pwned>' + marker + '`',
  () => '%PATH%',
  marker => `\necho pwned>${marker}`
]

function expectedData(shell: ShellKind, payload: string): string {
  if (shell !== 'cmd') return payload
  let out = ''
  for (const ch of payload) {
    const code = ch.charCodeAt(0)
    if (code === 0 || code === 8 || code === 0x1b || code === 0x9b) continue
    out += ch === '\n' || ch === '\r' ? ' ' : ch
  }
  return out
}

function windowsPowerShellHosts(): string[] {
  const hosts = ['powershell.exe']
  const found = spawnSync('where.exe', ['pwsh'], { encoding: 'utf8', windowsHide: true })
  if (found.status !== 0) return hosts
  for (const line of found.stdout.split(/\r?\n/)) {
    const file = line.trim()
    if (!file || hosts.some(host => host.toLowerCase() === file.toLowerCase())) continue
    const probe = spawnSync(file, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
      windowsHide: true,
      timeout: 20_000
    })
    if (probe.status === 0) hosts.push(file)
  }
  return hosts
}

async function assertPayloadIsData(
  shell: ShellKind,
  payload: string,
  marker: string,
  env?: NodeJS.ProcessEnv
): Promise<void> {
  const script = expandCommand(roundTripTemplate, { payload }, shell)
  const plan = planShell(shell, script, env)
  const cwd = mkdtempSync(path.join(tmpdir(), 'arckeep-shell-'))
  const result = await runPlan(plan, cwd)
  const detail = `${shell}\n${script}\nstdout=${JSON.stringify(result.stdout)}\nstderr=${JSON.stringify(result.stderr)}\ncode=${result.code} error=${result.error ?? ''}`
  expect(existsSync(marker), detail).toBe(false)
  expect(result.code, detail).toBe(0)
  expect(result.stdout, detail).toBe(expectedData(shell, payload))
  if (payload === '%PATH%') expect(result.stdout).not.toBe(process.env.PATH ?? '')
  rmSync(cwd, { recursive: true, force: true })
}

const shells: ShellKind[] = ['cmd', 'powershell', 'git-bash']

describe('live shell injection', () => {
  for (const shell of shells) {
    const hosts = shell === 'powershell' && process.platform === 'win32' ? windowsPowerShellHosts() : [shell]
    for (const host of hosts) {
      const label = shell === 'powershell' && process.platform === 'win32' ? `powershell ${path.basename(host)}` : shell
      const env = shell === 'powershell' && process.platform === 'win32'
        ? { ...process.env, ARCKEEP_POWERSHELL: host }
        : undefined
      const available = shell === 'git-bash'
        ? resolveBash(process.env, process.platform) !== null && (process.platform !== 'win32' || existsSync(resolveBash(process.env, process.platform) ?? ''))
        : process.platform === 'win32'

      it.skipIf(!available)(`${label} keeps hostile parameters as data`, async () => {
        for (const [index, build] of hostilePayloads.entries()) {
          const marker = markerPath(`${label}-${index}`)
          await assertPayloadIsData(shell, build(marker), marker, env)
        }
      }, 60_000)

      it.skipIf(!available)(`${label} reports exit code 3`, async () => {
        const plan = planShell(shell, 'node -e "process.exit(3)"', env)
        const cwd = mkdtempSync(path.join(tmpdir(), 'arckeep-exit-'))
        const result = await runPlan(plan, cwd)
        expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(3)
        rmSync(cwd, { recursive: true, force: true })
      }, 20_000)
    }
  }

  it('streams stdout and stderr', async () => {
    const shell: ShellKind = process.platform === 'win32' ? 'powershell' : 'git-bash'
    const plan = planShell(shell, `node -e "process.stdout.write('out-a'); process.stderr.write('err-b')"`)
    const cwd = mkdtempSync(path.join(tmpdir(), 'arckeep-stream-'))
    const result = await runPlan(plan, cwd)
    expect(result.stdout).toContain('out-a')
    expect(result.stderr).toContain('err-b')
    rmSync(cwd, { recursive: true, force: true })
  }, 20_000)
})
