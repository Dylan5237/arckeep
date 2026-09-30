import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
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

export class IncrementalOutputDecoder {
  private prefix = Buffer.alloc(0)
  private decoder: StringDecoder | null = null
  private offset = 0

  write(chunk: Buffer): string {
    if (this.decoder) {
      return this.decoder.write(chunk)
    }
    this.prefix = Buffer.concat([this.prefix, chunk])
    if (this.prefix.length < 4) return ''
    const decoder = this.initialize()
    const initial = this.prefix.subarray(this.offset)
    this.prefix = Buffer.alloc(0)
    return decoder.write(initial)
  }

  end(): string {
    const decoder = this.decoder ?? this.initialize()
    const initial = this.prefix.subarray(this.offset)
    this.prefix = Buffer.alloc(0)
    return decoder.end(initial)
  }

  private initialize(): StringDecoder {
    const bytes = this.prefix
    let encoding: 'utf8' | 'utf16le' = 'utf8'
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      encoding = 'utf16le'
      this.offset = 2
    } else if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      this.offset = 3
    } else if (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0) {
      encoding = 'utf16le'
    }
    this.decoder = new StringDecoder(encoding)
    return this.decoder
  }
}

export function decodeOutput(buffer: Buffer): string {
  const decoder = new IncrementalOutputDecoder()
  return decoder.write(buffer) + decoder.end()
}

function decodeClixmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/_x([\da-f]{4})_/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/** PowerShell 5.1 serializes redirected error/progress streams as CLIXML. */
export function normalizePowerShellStderr(stderr: string): string {
  const start = stderr.indexOf('#< CLIXML')
  if (start < 0) return stderr
  const xml = stderr.slice(start + '#< CLIXML'.length).trim()
  if (!xml.startsWith('<Objs') || !xml.endsWith('</Objs>')) return stderr
  const streams = [...xml.matchAll(/<S\b(?=[^>]*\bS="([^"]+)")[^>]*>([\s\S]*?)<\/S>/g)]
  const decoded = streams
    .filter(match => match[1]?.toLowerCase() !== 'progress')
    .map(match => decodeClixmlText(match[2] ?? ''))
    .join('')
  return stderr.slice(0, start) + decoded
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
  shell: ShellPlan['shell']
  aborted: boolean
  started: number
  capped: boolean
  finished: boolean
  outputBytes: number
  stdoutDecoder: IncrementalOutputDecoder
  stderrDecoder: IncrementalOutputDecoder
  powershellStderr: string
  powershellStderrTruncated: boolean
  outputsFinalized: boolean
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
      shell: plan.shell,
      aborted: false,
      started: Date.now(),
      capped: false,
      finished: false,
      outputBytes: 0,
      stdoutDecoder: new IncrementalOutputDecoder(),
      stderrDecoder: new IncrementalOutputDecoder(),
      powershellStderr: '',
      powershellStderrTruncated: false,
      outputsFinalized: false
    }
    this.runs.set(runId, active)
    const finish = (event: ToolRunEvent) => {
      if (active.finished) return
      active.finished = true
      this.runs.delete(runId)
      this.emit(event)
    }
    const emitText = (stream: 'stdout' | 'stderr', text: string) => {
      if (active.capped) return
      const room = MAX_OUTPUT - active.outputBytes
      if (text.length > room) {
        text = `${text.slice(0, Math.max(0, room))}\n输出已截断`
        active.capped = true
      }
      active.outputBytes += text.length
      if (text) this.emit({ type: 'output', runId, stream, text })
    }
    const finalizeOutputs = () => {
      if (active.outputsFinalized) return
      active.outputsFinalized = true
      const stdoutTail = active.stdoutDecoder.end()
      const stderrTail = active.stderrDecoder.end()
      emitText('stdout', stdoutTail)
      if (active.shell === 'powershell') {
        const decoded = normalizePowerShellStderr(active.powershellStderr + stderrTail)
        emitText('stderr', decoded + (active.powershellStderrTruncated ? '\n输出已截断' : ''))
      } else {
        emitText('stderr', stderrTail)
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => emitText('stdout', active.stdoutDecoder.write(chunk)))
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = active.stderrDecoder.write(chunk)
      if (active.shell === 'powershell') {
        const room = MAX_OUTPUT * 4 - active.powershellStderr.length
        if (text.length > room) {
          active.powershellStderr += text.slice(0, Math.max(0, room))
          active.powershellStderrTruncated = true
        } else {
          active.powershellStderr += text
        }
      } else emitText('stderr', text)
    })
    child.on('error', error => {
      finalizeOutputs()
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
      finalizeOutputs()
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
