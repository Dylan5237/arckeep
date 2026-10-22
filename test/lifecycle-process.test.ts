import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it } from 'vitest'
import type { ActionPreview, ToolRunEvent } from '../src/shared/tools/types.js'
import { spawnWindowsJobRelay } from '../src/main/process-ownership.js'
import { createToolRehearsals } from '../src/main/tool-rehearse.js'
import { killProcessTree, runPlan, ToolRunner } from '../src/main/tool-runner.js'
import type { ShellPlan } from '../src/main/tool-launch.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function waitForMarker(file: string, timeoutMs = 5_000): Promise<{ parentPid: number, childPid: number }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as { parentPid: number, childPid: number }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('isolated process fixture did not write its marker')
}

async function waitForExit(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch { return }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`isolated process ${pid} did not exit before its deadline`)
}

function neverDonePreview(): ActionPreview {
  return {
    actionId: 'lifecycle-fixture',
    title: 'isolated lifecycle fixture',
    type: 'run-command',
    text: 'node lifecycle-fixture',
    dryRun: 'node lifecycle-fixture',
    shell: 'git-bash',
    cwd: tmpdir()
  }
}

describe('managed process lifecycle', () => {
  it.skipIf(process.platform !== 'win32')('cancels a long command owned by the first bootstrap launch', async () => {
    const cwd = tempDir('arckeep-lifecycle-cold-cancel-')
    const marker = path.join(cwd, 'long-command.json')
    const fixture = [
      "const fs = require('node:fs')",
      'fs.writeFileSync(process.argv[1], JSON.stringify({ parentPid: process.pid, childPid: process.pid }))',
      'setInterval(() => {}, 1000)'
    ].join(';')
    const plan: ShellPlan = {
      shell: 'git-bash',
      script: fixture,
      file: process.execPath,
      args: ['-e', fixture, marker],
      windowsVerbatimArguments: false
    }
    let resolveDone!: (event: ToolRunEvent) => void
    const done = new Promise<ToolRunEvent>(resolve => { resolveDone = resolve })
    const runner = new ToolRunner(event => { if (event.type === 'done') resolveDone(event) })
    let runId: string | undefined
    let completionTimer: NodeJS.Timeout | undefined
    try {
      runId = runner.start(plan, cwd)
      const { childPid } = await waitForMarker(marker)
      expect(runner.abort(runId)).toBe(true)
      const completion = await Promise.race([
        done,
        new Promise<never>((_resolve, reject) => {
          completionTimer = setTimeout(() => reject(new Error('cold relay cancellation exceeded its deadline')), 12_000)
        })
      ])
      expect(completion.aborted).toBe(true)
      await waitForExit(childPid, 5_000)
    } finally {
      if (completionTimer) clearTimeout(completionTimer)
      await runner.abortAll().catch(() => {})
    }
  }, 30_000)

  it('cancels a process tree after its command parent exits', async () => {
    const cwd = tempDir('arckeep-lifecycle-tree-')
    const marker = path.join(cwd, 'processes.json')
    let plan: ShellPlan
    if (process.platform === 'win32') {
      const descendant = [
        "setTimeout(() => process.stdout.write('descendant-stdout-after-parent-exit'), 500)",
        'setTimeout(() => process.exit(0), 8000)'
      ].join(';')
      const fixture = [
        "const { spawn } = require('node:child_process')",
        "const fs = require('node:fs')",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { detached: true, stdio: 'inherit' })`,
        'child.unref()',
        'fs.writeFileSync(process.argv[1], JSON.stringify({ parentPid: process.pid, childPid: child.pid }))',
        'process.exit(0)'
      ].join(';')
      plan = {
        shell: 'git-bash',
        script: fixture,
        file: process.execPath,
        args: ['-e', fixture, marker],
        windowsVerbatimArguments: false
      }
    } else {
      const fixture = [
        "const { spawn } = require('node:child_process')",
        "const fs = require('node:fs')",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 8000)'], { stdio: 'inherit' })",
        'child.unref()',
        'fs.writeFileSync(process.argv[1], JSON.stringify({ parentPid: process.pid, childPid: child.pid }))',
        'process.exit(0)'
      ].join(';')
      plan = {
        shell: 'git-bash',
        script: fixture,
        file: process.execPath,
        args: ['-e', fixture, marker],
        windowsVerbatimArguments: false
      }
    }
    let resolveDone!: (event: ToolRunEvent) => void
    const done = new Promise<ToolRunEvent>(resolve => { resolveDone = resolve })
    let completionReceived = false
    let output = ''
    const runner = new ToolRunner(event => {
      if (event.type === 'output') output += event.text ?? ''
      if (event.type === 'done') {
        completionReceived = true
        resolveDone(event)
      }
    })
    let runId: string | undefined
    let completionTimer: NodeJS.Timeout | undefined
    try {
      runId = runner.start(plan, cwd)
      const { parentPid, childPid } = await waitForMarker(marker)
      await waitForExit(parentPid)
      await waitForExit(parentPid, 100)
      expect(completionReceived).toBe(false)
      expect(() => process.kill(childPid, 0)).not.toThrow()
      if (process.platform === 'win32') {
        const outputDeadline = Date.now() + 3_000
        while (!output.includes('descendant-stdout-after-parent-exit') && Date.now() < outputDeadline) {
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        expect(output).toContain('descendant-stdout-after-parent-exit')
      }
      expect(runner.abort(runId)).toBe(true)
      const completion = await Promise.race([
        done,
        new Promise<never>((_resolve, reject) => {
          completionTimer = setTimeout(() => reject(new Error('process tree cleanup exceeded its deadline')), 2_000)
        })
      ])
      expect(completion.aborted).toBe(true)
      await waitForExit(childPid)
    } finally {
      if (completionTimer) clearTimeout(completionTimer)
      await runner.abortAll().catch(() => {})
      if (runId) runner.abort(runId)
    }
  }, 20_000)

  it.skipIf(process.platform !== 'win32')('compiles the owner once, then preserves stdin, output, and arguments through direct EXE launches', async () => {
    const cwd = tempDir('arckeep-lifecycle-relay-reuse-')
    const commands: Array<{ args: string[], code: number, stdout: string, stderr: string }> = [
      {
        args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '', '空格 参数', '双"引号', '尾\\'],
        code: 0,
        stdout: JSON.stringify(['', '空格 参数', '双"引号', '尾\\']),
        stderr: ''
      },
      {
        args: ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('stdin-eof'))"],
        code: 0,
        stdout: 'stdin-eof',
        stderr: ''
      },
      {
        args: ['-e', "process.stdout.write('stdout:雪'); process.stderr.write('stderr:✓'); process.exit(23)"],
        code: 23,
        stdout: 'stdout:雪',
        stderr: 'stderr:✓'
      }
    ]
    const durations: number[] = []
    for (const command of commands) {
      const plan: ShellPlan = {
        shell: 'git-bash',
        script: '',
        file: process.execPath,
        args: command.args,
        windowsVerbatimArguments: false
      }
      const started = performance.now()
      const result = await runPlan(plan, cwd)
      durations.push(performance.now() - started)
      expect(result.code, JSON.stringify(result)).toBe(command.code)
      expect(result.stdout, JSON.stringify(result)).toBe(command.stdout)
      expect(result.stderr, JSON.stringify(result)).toBe(command.stderr)
    }
    expect(durations.slice(1).every(duration => duration < 900), JSON.stringify(durations)).toBe(true)
  }, 30_000)

  it.skipIf(process.platform !== 'win32')('reports a fixed not-found result for a missing managed executable', async () => {
    const cwd = tempDir('arckeep-lifecycle-missing-exe-')
    const plan: ShellPlan = {
      shell: 'git-bash',
      script: '',
      file: path.join(cwd, 'missing-gh.exe'),
      args: ['--version'],
      windowsVerbatimArguments: false
    }
    const result = await runPlan(plan, cwd)
    expect(result.code).toBe(127)
    expect(result.stderr.trim()).toBe('ARCKEEP_RELAY_EXECUTABLE_NOT_FOUND')
  }, 15_000)

  it.skipIf(process.platform !== 'win32')('terminates an owned command tree when its application parent exits', async () => {
    const cwd = tempDir('arckeep-lifecycle-parent-exit-')
    const marker = path.join(cwd, 'owner-process.json')
    const controllerScript = [
      "const fs = require('node:fs')",
      'const marker = process.argv[1]',
      'const deadline = Date.now() + 8000',
      'const timer = setInterval(() => { if (fs.existsSync(marker) || Date.now() >= deadline) { clearInterval(timer); process.exit(0) } }, 20)'
    ].join(';')
    const parent = spawn(process.execPath, ['-e', controllerScript, marker], {
      cwd,
      windowsHide: true,
      stdio: 'ignore'
    })
    const targetScript = [
      "const fs = require('node:fs')",
      'fs.writeFileSync(process.argv[1], JSON.stringify({ parentPid: process.pid, childPid: process.pid }))',
      'setInterval(() => {}, 1000)'
    ].join(';')
    const plan: ShellPlan = {
      shell: 'git-bash',
      script: '',
      file: process.execPath,
      args: ['-e', targetScript, marker],
      windowsVerbatimArguments: false
    }
    const parentPid = parent.pid
    if (!parentPid) throw new Error('isolated parent fixture did not start')
    const relay = spawnWindowsJobRelay(plan, cwd, process.env, parentPid)
    let relayClosed = false
    relay.once('close', () => { relayClosed = true })
    let childPid: number | undefined
    try {
      childPid = (await waitForMarker(marker)).childPid
      await waitForExit(parentPid, 5_000)
      await waitForExit(childPid, 5_000)
      const deadline = Date.now() + 5_000
      while (!relayClosed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
      expect(relayClosed).toBe(true)
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill()
      if (!relayClosed) await killProcessTree(relay).catch(() => {})
      if (childPid) await waitForExit(childPid).catch(() => {})
    }
  }, 20_000)

  it('bounds cancellation when a runner never emits done and coalesces repeats', async () => {
    let abortCalls = 0
    const rehearsals = createToolRehearsals({
      platform: 'linux',
      cwdExists: () => true,
      timeoutMs: 250,
      cancelTimeoutMs: 40,
      createRunner: () => ({
        start: () => 'pending',
        abortAll: () => { abortCalls += 1 }
      })
    })
    const pending = rehearsals.rehearse('never-done', neverDonePreview())
    void pending.then(() => undefined, () => undefined)
    const first = rehearsals.cancel('never-done')
    const second = rehearsals.cancel('never-done')
    await expect(Promise.all([first, second])).rejects.toThrow(/等待任务结束超时/)
    expect(abortCalls).toBe(1)
  })

  it('bounds cancelAll when process cleanup itself does not settle', async () => {
    const rehearsals = createToolRehearsals({
      platform: 'linux',
      cwdExists: () => true,
      timeoutMs: 250,
      cancelTimeoutMs: 40,
      createRunner: () => ({
        start: () => 'pending',
        abortAll: () => new Promise<void>(() => {})
      })
    })
    const pending = rehearsals.rehearse('stuck-cleanup', neverDonePreview())
    void pending.then(() => undefined, () => undefined)
    await expect(rehearsals.cancelAll()).rejects.toThrow(/进程清理超时/)
  })
})
