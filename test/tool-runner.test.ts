import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cmdScriptFromPlan, planShell, resolveBash } from '../src/main/tool-launch.js'
import { IncrementalOutputDecoder, killProcessTree, normalizePowerShellStderr, runPlan, terminationCommand, ToolRunner } from '../src/main/tool-runner.js'
import { expandCommand, quotePowerShellArg } from '../src/shared/tools/quote.js'
import type { ShellKind, ToolRunEvent } from '../src/shared/tools/types.js'

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
  () => 'a"b',
  () => 'say "hello"',
  () => '中文值',
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
    const plan = planShell(shell, `node -e "process.stdout.write('北区'); process.stderr.write('错因')"`)
    const cwd = mkdtempSync(path.join(tmpdir(), 'arckeep-stream-'))
    const result = await runPlan(plan, cwd)
    expect(result.stdout).toContain('北区')
    expect(result.stderr).toContain('错因')
    rmSync(cwd, { recursive: true, force: true })
  }, 20_000)
})

describe('live CMD builtin output encoding', () => {
  it.skipIf(process.platform !== 'win32')('preserves UTF-8 stdout and stderr with the actual planned script', async () => {
    const command = 'echo 中文stdout & echo 中文stderr 1>&2'
    const plan = planShell('cmd', command, process.env, 'win32')
    expect(plan.script).toBe(`chcp 65001 >NUL & ${command}`)
    expect(cmdScriptFromPlan(plan)).toBe(plan.script)
    const cwd = mkdtempSync(path.join(tmpdir(), 'arckeep-cmd-output-'))
    try {
      const result = await runPlan(plan, cwd)
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('中文stdout')
      expect(result.stderr).toContain('中文stderr')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 20_000)

  it.skipIf(process.platform !== 'win32')('preserves builtin and native UTF-8 output in either command order', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'arckeep-cmd-mixed-output-'))
    try {
      const builtinFirst = await runPlan(
        planShell('cmd', `echo 中文builtin-first & node -e "process.stdout.write('中文native-tail')"`, process.env, 'win32'),
        cwd
      )
      expect(builtinFirst.code).toBe(0)
      expect(builtinFirst.stdout).toContain('中文builtin-first')
      expect(builtinFirst.stdout).toContain('中文native-tail')

      const nativeFirst = await runPlan(
        planShell('cmd', `node -e "process.stdout.write('中文native-first'); process.stderr.write('中文native-stderr')" & echo 中文builtin-tail 1>&2`, process.env, 'win32'),
        cwd
      )
      expect(nativeFirst.code).toBe(0)
      expect(nativeFirst.stdout).toContain('中文native-first')
      expect(nativeFirst.stderr).toContain('中文native-stderr')
      expect(nativeFirst.stderr).toContain('中文builtin-tail')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 20_000)

  it.skipIf(process.platform !== 'win32')('passes cwd and stdin EOF through the hidden launcher', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'arckeep-cmd-stdio-'))
    try {
      const script = `node -e "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(process.cwd() + '|stdin-ended'))"`
      const result = await runPlan(planShell('cmd', script, process.env, 'win32'), cwd)
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${cwd}|stdin-ended`)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 20_000)
})

describe('live CMD relay process tree cleanup', () => {
  it.skipIf(process.platform !== 'win32')('kills a native descendant when aborting the hidden cmd relay', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'arckeep-cmd-tree-'))
    const scriptFile = path.join(cwd, 'parent.js')
    const pidFile = path.join(cwd, 'child.pid')
    writeFileSync(scriptFile, `
      const { spawn } = require('node:child_process')
      const fs = require('node:fs')
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 500)'], { stdio: 'ignore' })
      fs.writeFileSync(process.argv[2], String(child.pid))
      setInterval(() => {}, 500)
    `)
    let resolveDone!: (event: ToolRunEvent) => void
    const done = new Promise<ToolRunEvent>(resolve => { resolveDone = resolve })
    const runner = new ToolRunner(event => {
      if (event.type === 'done') resolveDone(event)
    })
    let runId: string | null = null
    let abortTimer: NodeJS.Timeout | undefined
    try {
      runId = runner.start(planShell('cmd', `node "${scriptFile}" "${pidFile}"`, process.env, 'win32'), cwd)
      const childPid = await waitForPid(pidFile)
      expect(runner.abort(runId)).toBe(true)
      const completion = await Promise.race([
        done,
        new Promise<ToolRunEvent>((_resolve, reject) => {
          abortTimer = setTimeout(() => reject(new Error('cmd relay did not close after abort')), 10_000)
        })
      ])
      expect(completion.aborted).toBe(true)
      await waitUntilDead(childPid)
    } finally {
      if (abortTimer) clearTimeout(abortTimer)
      if (runId) runner.abort(runId)
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 20_000)
})

describe('incremental output decoding and PowerShell stderr', () => {
  it('preserves UTF-8 characters split across chunks', () => {
    const decoder = new IncrementalOutputDecoder()
    const bytes = Buffer.from('跨块中文')
    const output = decoder.write(bytes.subarray(0, 2))
      + decoder.write(bytes.subarray(2, 5))
      + decoder.write(bytes.subarray(5))
      + decoder.end()
    expect(output).toBe('跨块中文')
  })

  it('drops CLIXML progress while retaining decoded errors', () => {
    const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">'
      + '<Obj S="progress"><PR><AV>working</AV></PR></Obj>'
      + '<S S="Error">Write-Error : 中文失败_x000D__x000A_</S>'
      + '</Objs>'
    expect(normalizePowerShellStderr(clixml)).toBe('Write-Error : 中文失败\r\n')
    expect(normalizePowerShellStderr('#< CLIXML\n<Objs><Obj S="progress"></Obj></Objs>')).toBe('')
    expect(normalizePowerShellStderr('#< CLIXML\nnot xml')).toBe('#< CLIXML\nnot xml')
  })
})

const powershellTestHosts = process.platform === 'win32' ? windowsPowerShellHosts() : ['powershell.exe']

describe('live PowerShell result and parameter fidelity', () => {
  for (const host of powershellTestHosts) {
    const available = process.platform === 'win32'
    const env = { ...process.env, ARCKEEP_POWERSHELL: host }
    const label = path.basename(host)

    it.skipIf(!available)(`${label} reports cmdlet errors and preserves explicit exit codes`, async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), 'arckeep-powershell-result-'))
      const writeError = await runPlan(planShell('powershell', "Write-Error '中文失败-sentinel'", env), cwd)
      expect(writeError.code).toBe(1)
      expect(writeError.aborted).toBe(false)
      expect(writeError.stderr).toContain('中文失败-sentinel')
      expect(writeError.stderr).not.toContain('#< CLIXML')

      const missing = await runPlan(planShell('powershell', "Get-Item -LiteralPath './missing-adversarial-file'", env), cwd)
      expect(missing.code).toBe(1)
      expect(missing.stderr).toMatch(/missing-adversarial-file|Cannot find path/i)

      const success = await runPlan(planShell('powershell', "Write-Output 'success-sentinel'", env), cwd)
      expect(success.code).toBe(0)
      expect(success.stdout).toContain('success-sentinel')

      const explicitExit = await runPlan(planShell('powershell', 'exit 3', env), cwd)
      expect(explicitExit.code).toBe(3)
      rmSync(cwd, { recursive: true, force: true })
    }, 60_000)

    it.skipIf(!available)(`${label} preserves quoted cmdlet, script, and native arguments`, async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), 'arckeep-powershell-args-'))
      const payload = 'a"b 中文'
      const cmdlet = expandCommand('Write-Output {{payload}}', { payload }, 'powershell')
      const cmdletResult = await runPlan(planShell('powershell', cmdlet, env), cwd)
      expect(cmdletResult.code).toBe(0)
      expect(cmdletResult.stdout.trimEnd()).toBe(payload)

      const scriptFile = path.join(cwd, 'capture.ps1')
      writeFileSync(scriptFile, 'param([string]$value)\n[Console]::Out.Write($value)\n')
      const scriptCommand = expandCommand(`& ${quotePowerShellArg(scriptFile)} {{payload}}`, { payload }, 'powershell')
      const scriptResult = await runPlan(planShell('powershell', scriptCommand, env), cwd)
      expect(scriptResult.code).toBe(0)
      expect(scriptResult.stdout).toBe(payload)

      const nativeCommand = expandCommand('node -e "process.stdout.write(process.argv[1])" {{payload}}', { payload }, 'powershell')
      const nativeResult = await runPlan(planShell('powershell', nativeCommand, env), cwd)
      expect(nativeResult.code).toBe(0)
      expect(nativeResult.stdout, `${nativeCommand}\n${nativeResult.stderr}`).toBe(payload)
      rmSync(cwd, { recursive: true, force: true })
    }, 60_000)

    it.skipIf(!available)(`${label} resolves quoted parameters against nested, function, and module commands`, async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), 'arckeep-powershell-resolution-'))
      const payload = 'a"b 中文'

      const multipleCommand = expandCommand(
        'node -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" {{first}} {{second}}',
        { first: 'first', second: payload },
        'powershell'
      )
      const multiple = await runPlan(planShell('powershell', multipleCommand, env), cwd)
      expect(multiple.code, `${multipleCommand}\n${multiple.stderr}`).toBe(0)
      expect(multiple.stdout, `${multipleCommand}\n${multiple.stderr}`).toBe(JSON.stringify(['first', payload]))

      const blockCommand = expandCommand(
        'if ($true) { Write-Output prefix; node -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" {{value}} }',
        { value: payload },
        'powershell'
      )
      const block = await runPlan(planShell('powershell', blockCommand, env), cwd)
      expect(block.code, `${blockCommand}\n${block.stderr}`).toBe(0)
      expect(block.stdout.trimEnd().split(/\r?\n/), `${blockCommand}\n${block.stderr}`).toEqual([
        'prefix',
        JSON.stringify([payload])
      ])

      const functionCommand = expandCommand(
        'function EchoValue { param($p) [Console]::Out.Write($p) }; EchoValue {{value}}',
        { value: payload },
        'powershell'
      )
      const functionResult = await runPlan(planShell('powershell', functionCommand, env), cwd)
      expect(functionResult.code, `${functionCommand}\n${functionResult.stderr}`).toBe(0)
      expect(functionResult.stdout, `${functionCommand}\n${functionResult.stderr}`).toBe(payload)

      const moduleCommand = expandCommand(
        'Microsoft.PowerShell.Utility\\Write-Output {{value}}',
        { value: payload },
        'powershell'
      )
      const moduleResult = await runPlan(planShell('powershell', moduleCommand, env), cwd)
      expect(moduleResult.code, `${moduleCommand}\n${moduleResult.stderr}`).toBe(0)
      expect(moduleResult.stdout.trimEnd(), `${moduleCommand}\n${moduleResult.stderr}`).toBe(payload)

      const aliasCommand = expandCommand(
        'Set-Alias ArckeepProbeNode node; ArckeepProbeNode -e "process.stdout.write(process.argv[1])" {{value}}',
        { value: payload },
        'powershell'
      )
      const aliasResult = await runPlan(planShell('powershell', aliasCommand, env), cwd)
      expect(aliasResult.code, `${aliasCommand}\n${aliasResult.stderr}`).toBe(0)
      expect(aliasResult.stdout, `${aliasCommand}\n${aliasResult.stderr}`).toBe(payload)

      const marker = path.join(cwd, 'dynamic-command-ran')
      const dynamicCommand = expandCommand(
        `$exe = 'node'; & $exe -e "require('fs').writeFileSync(process.argv[1], 'ran')" ${quotePowerShellArg(marker)} {{value}}`,
        { value: payload },
        'powershell'
      )
      const dynamicResult = await runPlan(planShell('powershell', dynamicCommand, env), cwd)
      expect(dynamicResult.code, `${dynamicCommand}\n${dynamicResult.stderr}`).toBe(1)
      expect(dynamicResult.stderr, dynamicCommand).toContain('动态命令名')
      expect(existsSync(marker), dynamicCommand).toBe(false)

      const missingCommand = expandCommand('ArckeepMissingCommand {{value}}', { value: payload }, 'powershell')
      const missingResult = await runPlan(planShell('powershell', missingCommand, env), cwd)
      expect(missingResult.code, `${missingCommand}\n${missingResult.stderr}`).toBe(1)
      expect(missingResult.stderr, missingCommand).toContain('无法解析含双引号参数对应的 PowerShell 命令')
      rmSync(cwd, { recursive: true, force: true })
    }, 60_000)
  }
})
