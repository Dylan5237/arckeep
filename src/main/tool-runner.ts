import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { ToolRunEvent } from '../shared/tools/types.js'
import type { ShellPlan } from './tool-launch.js'

const MAX_OUTPUT = 200_000
const OUTPUT_RESERVE = 8_192
const TERMINATION_TIMEOUT_MS = 10_000

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function remainingTime(deadline: number): number {
  return Math.max(0, deadline - Date.now())
}

async function waitForChildClose(child: ChildProcess, timeoutMs: number, pid: number): Promise<void> {
  if (hasExited(child) || timeoutMs <= 0) {
    if (hasExited(child)) return
    throw new Error(`等待进程 ${pid} 退出超时`)
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('close', onClose)
      if (error) reject(error)
      else resolve()
    }
    const onClose = () => finish()
    const timer = setTimeout(() => finish(new Error(`等待进程 ${pid} 退出超时`)), timeoutMs)
    child.once('close', onClose)
    if (hasExited(child)) finish()
  })
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function combineErrors(errors: unknown[], message: string): Error {
  if (errors.length === 1 && errors[0] instanceof Error) return errors[0]
  return new AggregateError(errors, message)
}

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

/** Emits plain diagnostics and complete CLIXML stream records without waiting for close. */
export class PowerShellStderrDecoder {
  private pending = ''
  private mode: 'plain' | 'header' | 'xml' = 'plain'

  write(text: string): string {
    this.pending += text
    let output = ''
    for (;;) {
      if (this.mode === 'plain') {
        const start = this.pending.indexOf('#< CLIXML')
        if (start < 0) {
          const keep = this.suffixLength(['#< CLIXML'])
          output += this.pending.slice(0, this.pending.length - keep)
          this.pending = this.pending.slice(this.pending.length - keep)
          break
        }
        output += this.pending.slice(0, start)
        this.pending = this.pending.slice(start + '#< CLIXML'.length)
        this.mode = 'header'
      }
      if (this.mode === 'header') {
        const header = this.pending.trimStart()
        if ('<Objs'.startsWith(header)) break
        if (!header.startsWith('<Objs')) {
          output += '#< CLIXML' + this.pending
          this.pending = ''
          this.mode = 'plain'
          break
        }
        const end = header.indexOf('>')
        if (end < 0) break
        this.pending = header.slice(end + 1)
        this.mode = 'xml'
      }
      if (this.mode === 'xml') {
        const endDocument = this.pending.indexOf('</Objs>')
        const startRecord = this.pending.search(/<S(?:\s|>)/)
        if (endDocument >= 0 && (startRecord < 0 || endDocument < startRecord)) {
          this.pending = this.pending.slice(endDocument + '</Objs>'.length)
          this.mode = 'plain'
          continue
        }
        if (startRecord < 0) {
          const keep = this.suffixLength(['<S', '</Objs>'])
          this.pending = this.pending.slice(this.pending.length - keep)
          break
        }
        this.pending = this.pending.slice(startRecord)
        const endRecord = this.pending.indexOf('</S>')
        if (endRecord < 0) break
        const record = this.pending.slice(0, endRecord + '</S>'.length)
        output += normalizePowerShellStderr(`#< CLIXML\n<Objs>${record}</Objs>`)
        this.pending = this.pending.slice(endRecord + '</S>'.length)
      }
    }
    if (this.pending.length > MAX_OUTPUT * 4) {
      output += this.pending.slice(0, MAX_OUTPUT) + '\n输出已截断'
      this.pending = ''
      this.mode = 'plain'
    }
    return output
  }

  end(text = ''): string {
    const output = this.write(text)
    const tail = this.mode === 'plain' ? this.pending
      : this.mode === 'header' ? '#< CLIXML' + this.pending : this.pending
    this.pending = ''
    this.mode = 'plain'
    return output + tail
  }

  private suffixLength(tokens: string[]): number {
    let keep = 0
    for (const token of tokens) {
      for (let size = 1; size < token.length; size += 1) {
        if (this.pending.endsWith(token.slice(0, size))) keep = Math.max(keep, size)
      }
    }
    return keep
  }
}

export async function killProcessTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): Promise<void> {
  const pid = child.pid
  if (!pid) return
  if (hasExited(child)) return
  const deadline = Date.now() + TERMINATION_TIMEOUT_MS
  const plan = terminationCommand(pid, platform)
  if ('group' in plan) {
    let signalError: unknown
    try {
      process.kill(-pid, 'SIGKILL')
    } catch (groupError) {
      try {
        child.kill('SIGKILL')
      } catch (childError) {
        signalError = new AggregateError([groupError, childError], `无法终止进程组 ${pid}`)
      }
    }
    try {
      await waitForChildClose(child, remainingTime(deadline), pid)
    } catch (error) {
      if (signalError) throw combineErrors([signalError, error], `终止进程组 ${pid} 失败`)
      throw error
    }
    return
  }
  let killer: ChildProcess
  try {
    killer = spawn(plan.file, plan.args, { windowsHide: true, stdio: 'ignore' })
  } catch (error) {
    throw new Error(`无法启动 ${plan.file} 清理进程 ${pid}: ${describeError(error)}`, { cause: error })
  }
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        killer.removeListener('exit', onExit)
        killer.removeListener('error', onError)
        if (error) reject(error)
        else resolve()
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (code === 0) finish()
        else finish(new Error(`${plan.file} 清理进程 ${pid} 失败 (exit=${String(code)}, signal=${String(signal)})`))
      }
      const onError = (error: Error) => finish(new Error(`无法启动 ${plan.file} 清理进程 ${pid}: ${error.message}`, { cause: error }))
      const timer = setTimeout(() => {
        try { killer.kill() } catch { /* report the cleanup timeout below */ }
        finish(new Error(`${plan.file} 清理进程 ${pid} 超时`))
      }, remainingTime(deadline))
      killer.once('exit', onExit)
      killer.once('error', onError)
    })
  } catch (error) {
    let fallbackError: unknown
    if (!hasExited(child)) {
      try {
        child.kill()
      } catch (killError) {
        fallbackError = killError
      }
      try {
        await waitForChildClose(child, remainingTime(deadline), pid)
      } catch (closeError) {
        throw combineErrors([error, ...(fallbackError ? [fallbackError] : []), closeError], `清理进程树 ${pid} 失败`)
      }
    }
    throw error
  }
  await waitForChildClose(child, remainingTime(deadline), pid)
}

interface ActiveRun {
  child: ChildProcess
  shell: ShellPlan['shell']
  termination?: Promise<void>
  aborted: boolean
  started: number
  capped: Record<'stdout' | 'stderr', boolean>
  finished: boolean
  outputBytes: number
  streamBytes: Record<'stdout' | 'stderr', number>
  stdoutDecoder: IncrementalOutputDecoder
  stderrDecoder: IncrementalOutputDecoder
  powershellStderr: PowerShellStderrDecoder
  outputsFinalized: boolean
}

export class ToolRunner {
  private readonly runs = new Map<string, ActiveRun>()
  private readonly terminations = new Set<Promise<void>>()
  private readonly terminationErrors: unknown[] = []
  private drainPromise: Promise<void> | undefined
  private sequence = 0
  private closing = false

  constructor(
    private readonly emit: (event: ToolRunEvent) => void,
    private readonly terminateProcessTree: (child: ChildProcess) => Promise<void> = child => killProcessTree(child)
  ) {}

  private terminate(active: ActiveRun): void {
    if (active.termination) return
    const termination = Promise.resolve()
      .then(() => this.terminateProcessTree(active.child))
      .catch(error => {
        this.terminationErrors.push(error)
        throw error
      })
      .finally(() => this.terminations.delete(termination))
    active.termination = termination
    this.terminations.add(termination)
    // abort() is intentionally synchronous; preserve failures for the next awaited drain.
    void termination.catch(() => {})
  }

  start(plan: ShellPlan, cwd: string): string {
    if (this.closing) throw new Error('应用正在关闭，不能启动新命令')
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
      capped: { stdout: false, stderr: false },
      finished: false,
      outputBytes: 0,
      streamBytes: { stdout: 0, stderr: 0 },
      stdoutDecoder: new IncrementalOutputDecoder(),
      stderrDecoder: new IncrementalOutputDecoder(),
      powershellStderr: new PowerShellStderrDecoder(),
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
      if (!text || active.capped[stream]) return
      const room = Math.min(MAX_OUTPUT - active.outputBytes, MAX_OUTPUT - OUTPUT_RESERVE - active.streamBytes[stream])
      const kept = Math.min(text.length, Math.max(0, room))
      if (text.length > room) {
        text = `${text.slice(0, kept)}\n输出已截断`
        active.capped[stream] = true
      }
      active.outputBytes += kept
      active.streamBytes[stream] += kept
      if (text) this.emit({ type: 'output', runId, stream, text })
    }
    const finalizeOutputs = () => {
      if (active.outputsFinalized) return
      active.outputsFinalized = true
      const stdoutTail = active.stdoutDecoder.end()
      const stderrTail = active.stderrDecoder.end()
      emitText('stdout', stdoutTail)
      if (active.shell === 'powershell') {
        emitText('stderr', active.powershellStderr.end(stderrTail))
      } else {
        emitText('stderr', stderrTail)
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => emitText('stdout', active.stdoutDecoder.write(chunk)))
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = active.stderrDecoder.write(chunk)
      if (active.shell === 'powershell') {
        emitText('stderr', active.powershellStderr.write(text))
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
    this.terminate(active)
    return true
  }

  async abortAll(): Promise<void> {
    for (const runId of [...this.runs.keys()]) this.abort(runId)
    await this.waitForTermination()
  }

  close(): void {
    this.closing = true
  }

  waitForTermination(): Promise<void> {
    if (this.drainPromise) return this.drainPromise
    const drain = (async () => {
      while (this.terminations.size > 0) {
        const results = await Promise.allSettled([...this.terminations])
        for (const result of results) {
          if (result.status === 'rejected' && !this.terminationErrors.includes(result.reason)) {
            this.terminationErrors.push(result.reason)
          }
        }
      }
      if (this.terminationErrors.length > 0) {
        const errors = this.terminationErrors.splice(0)
        throw combineErrors(errors, '清理命令进程树失败')
      }
    })()
    this.drainPromise = drain
    void drain.finally(() => {
      if (this.drainPromise === drain) this.drainPromise = undefined
    }).catch(() => {})
    return drain
  }
}

export function runPlan(
  plan: ShellPlan,
  cwd: string,
  timeoutMs = 20_000,
  createRunner: (emit: (event: ToolRunEvent) => void) => ToolRunner = emit => new ToolRunner(emit)
): Promise<{ code: number | null, stdout: string, stderr: string, aborted: boolean, error?: string }> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let doneEvent: ToolRunEvent | undefined
    const runner = createRunner(event => {
      if (event.type === 'output') {
        if (event.stream === 'stderr') stderr += event.text ?? ''
        else stdout += event.text ?? ''
        return
      }
      clearTimeout(timer)
      doneEvent = event
      void finish()
    })
    const finish = async (terminationError?: unknown) => {
      if (settled) return
      try {
        await runner.waitForTermination()
      } catch (error) {
        terminationError = terminationError === undefined
          ? error
          : combineErrors([terminationError, error], '命令进程树清理失败')
      }
      if (settled) return
      settled = true
      resolve({
        code: doneEvent?.exitCode ?? null,
        stdout,
        stderr,
        aborted: Boolean(doneEvent?.aborted) || terminationError !== undefined,
        error: [doneEvent?.error, ...(terminationError === undefined ? [] : [describeError(terminationError)])]
          .filter(Boolean)
          .join('; ') || undefined
      })
    }
    const timer = setTimeout(() => {
      void runner.abortAll().then(() => {
        if (!doneEvent) void finish(new Error(`命令运行超过 ${timeoutMs}ms`))
      }, error => {
        if (!doneEvent) void finish(error)
      })
    }, timeoutMs)
    try {
      runner.start(plan, cwd)
    } catch (error) {
      settled = true
      clearTimeout(timer)
      reject(error)
    }
  })
}
