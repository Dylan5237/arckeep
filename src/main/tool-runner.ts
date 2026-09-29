import { spawn, type ChildProcess } from 'node:child_process'
import type { ToolRunEvent } from '../shared/tools/types.js'
import type { ShellPlan } from './tool-launch.js'

const MAX_OUTPUT = 200_000

export function terminationCommand(
  pid: number,
  platform: NodeJS.Platform
): { file: string, args: string[] } | { group: true } {
  if (platform === 'win32') return { file: 'taskkill.exe', args: ['/PID', String(pid), '/T', '/F'] }
  return { group: true }
}

export function decodeOutput(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le')
  }
  if (buffer.length >= 4 && buffer[1] === 0 && buffer[3] === 0) return buffer.toString('utf16le')
  return buffer.toString('utf8')
}

export async function killProcessTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): Promise<void> {
  const pid = child.pid
  if (!pid) return
  const plan = terminationCommand(pid, platform)
  if ('group' in plan) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try { child.kill('SIGKILL') } catch { /* already exited */ }
    }
    return
  }
  await new Promise<void>(resolve => {
    const killer = spawn(plan.file, plan.args, { windowsHide: true, stdio: 'ignore' })
    const finish = () => resolve()
    killer.on('exit', finish)
    killer.on('error', () => {
      try { child.kill() } catch { /* already exited */ }
      finish()
    })
  })
}

interface ActiveRun {
  child: ChildProcess
  aborted: boolean
  started: number
  capped: boolean
  finished: boolean
  outputBytes: number
}

export class ToolRunner {
  private readonly runs = new Map<string, ActiveRun>()
  private sequence = 0

  constructor(private readonly emit: (event: ToolRunEvent) => void) {}

  start(plan: ShellPlan, cwd: string): string {
    if ([...this.runs.values()].length >= 1) throw new Error('已经有命令在运行')
    const runId = `run-${Date.now().toString(36)}-${this.sequence}`
    this.sequence += 1
    const child = spawn(plan.file, plan.args, {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const active: ActiveRun = {
      child,
      aborted: false,
      started: Date.now(),
      capped: false,
      finished: false,
      outputBytes: 0
    }
    this.runs.set(runId, active)
    const finish = (event: ToolRunEvent) => {
      if (active.finished) return
      active.finished = true
      this.runs.delete(runId)
      this.emit(event)
    }
    const push = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      if (active.capped) return
      let text = decodeOutput(chunk)
      const room = MAX_OUTPUT - active.outputBytes
      if (text.length > room) {
        text = `${text.slice(0, Math.max(0, room))}\n输出已截断`
        active.capped = true
      }
      active.outputBytes += text.length
      if (text) this.emit({ type: 'output', runId, stream, text })
    }
    child.stdout?.on('data', (chunk: Buffer) => push('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer) => push('stderr', chunk))
    child.on('error', error => {
      finish({
        type: 'done',
        runId,
        exitCode: null,
        durationMs: Date.now() - active.started,
        aborted: active.aborted,
        error: error.message
      })
    })
    child.on('close', (code, signal) => {
      finish({
        type: 'done',
        runId,
        exitCode: active.aborted ? null : code,
        durationMs: Date.now() - active.started,
        aborted: active.aborted,
        error: signal && !active.aborted ? `信号 ${signal}` : undefined
      })
    })
    return runId
  }

  abort(runId: string): boolean {
    const active = this.runs.get(runId)
    if (!active) return false
    active.aborted = true
    void killProcessTree(active.child)
    return true
  }

  abortAll(): void {
    for (const runId of [...this.runs.keys()]) this.abort(runId)
  }
}

export function runPlan(
  plan: ShellPlan,
  cwd: string,
  timeoutMs = 20_000
): Promise<{ code: number | null, stdout: string, stderr: string, aborted: boolean, error?: string }> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const runner = new ToolRunner(event => {
      if (event.type === 'output') {
        if (event.stream === 'stderr') stderr += event.text ?? ''
        else stdout += event.text ?? ''
        return
      }
      clearTimeout(timer)
      resolve({
        code: event.exitCode ?? null,
        stdout,
        stderr,
        aborted: Boolean(event.aborted),
        error: event.error
      })
    })
    const timer = setTimeout(() => {
      runner.abortAll()
    }, timeoutMs)
    try {
      runner.start(plan, cwd)
    } catch (error) {
      clearTimeout(timer)
      reject(error)
    }
  })
}
