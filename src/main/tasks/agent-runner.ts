import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { progressFromLine } from './agent-output.js'
import { shellCommandFile, type AgentInvocation } from './agent-command.js'

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024
const MAX_LOG_BYTES = 8 * 1024 * 1024

export interface AgentProcessResult {
  code: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
  spawnError: string | null
  stdout: string
  stderr: string
  producedOutput: boolean
  durationMs: number
}

export interface AgentProcessRequest {
  invocation: AgentInvocation
  cwd: string
  logFile: string
  timeoutMs: number
  signal: AbortSignal
  env: NodeJS.ProcessEnv
  onProgress?: (line: string) => void
}

function appendCapped(chunks: string[], size: { value: number }, text: string): void {
  if (size.value >= MAX_CAPTURE_BYTES) return
  const remaining = MAX_CAPTURE_BYTES - size.value
  const value = text.length > remaining ? text.slice(0, remaining) : text
  chunks.push(value)
  size.value += value.length
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32' && child.pid) {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    } else {
      child.kill('SIGKILL')
    }
  } catch {
    try { child.kill() } catch { /* already gone */ }
  }
}

/**
 * Runs one agent turn. The prompt goes over stdin; stdout/stderr are captured
 * with hard caps and mirrored into a private log file for the task UI.
 */
export function runAgentProcess(request: AgentProcessRequest): Promise<AgentProcessResult> {
  return new Promise(resolve => {
    const started = Date.now()
    mkdirSync(path.dirname(request.logFile), { recursive: true })
    let log: WriteStream | null = null
    let logBytes = 0
    try {
      log = createWriteStream(request.logFile, { flags: 'w', mode: 0o600 })
      log.on('error', () => { log = null })
    } catch {
      log = null
    }
    const writeLog = (prefix: string, line: string) => {
      if (!log || logBytes >= MAX_LOG_BYTES) return
      const payload = prefix + line + '\n'
      logBytes += Buffer.byteLength(payload)
      try { log.write(payload) } catch { log = null }
    }

    let settled = false
    let timedOut = false
    let aborted = request.signal.aborted
    let spawnError: string | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    const stdoutSize = { value: 0 }
    const stderrSize = { value: 0 }
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let stdoutPartial = ''
    let stderrPartial = ''

    let child: ChildProcess
    try {
      const file = request.invocation.shell ? shellCommandFile(request.invocation.file) : request.invocation.file
      child = spawn(file, request.invocation.args, {
        cwd: request.cwd,
        env: request.env,
        shell: request.invocation.shell,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法启动 Agent 进程'
      try { log?.end(message + '\n') } catch { /* ignore */ }
      resolve({
        code: null, signal: null, timedOut: false, aborted, spawnError: message,
        stdout: '', stderr: '', producedOutput: false, durationMs: Date.now() - started
      })
      return
    }

    const finish = (code: number | null, signal: string | null) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      stdoutPartial += stdoutDecoder.end()
      stderrPartial += stderrDecoder.end()
      if (stdoutPartial) {
        appendCapped(stdoutChunks, stdoutSize, stdoutPartial)
        writeLog('[out] ', stdoutPartial)
      }
      if (stderrPartial) {
        appendCapped(stderrChunks, stderrSize, stderrPartial)
        writeLog('[err] ', stderrPartial)
      }
      try { log?.end() } catch { /* ignore */ }
      const stdout = stdoutChunks.join('')
      const stderr = stderrChunks.join('')
      resolve({
        code,
        signal,
        timedOut,
        aborted,
        spawnError,
        stdout,
        stderr,
        producedOutput: stdout.trim().length > 0 || stderr.trim().length > 0,
        durationMs: Date.now() - started
      })
    }

    const onAbort = () => {
      aborted = true
      killTree(child)
    }
    if (aborted) onAbort()
    else request.signal.addEventListener('abort', onAbort, { once: true })

    if (request.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, request.timeoutMs)
    }

    child.once('error', error => {
      spawnError = error instanceof Error ? error.message : '无法启动 Agent 进程'
      finish(null, null)
    })
    child.once('close', (code, signal) => {
      request.signal.removeEventListener('abort', onAbort)
      finish(code, signal)
    })

    const handleStream = (
      chunk: Buffer,
      decoder: StringDecoder,
      kind: 'out' | 'err'
    ) => {
      let text: string
      try { text = decoder.write(chunk) } catch { text = chunk.toString('utf8') }
      if (!text) return
      if (kind === 'out') {
        appendCapped(stdoutChunks, stdoutSize, text)
      } else {
        appendCapped(stderrChunks, stderrSize, text)
      }
      const previous = kind === 'out' ? stdoutPartial : stderrPartial
      const combined = previous + text
      const lines = combined.split(/\r?\n/)
      const partial = lines.pop() ?? ''
      if (kind === 'out') stdoutPartial = partial
      else stderrPartial = partial
      for (const line of lines) {
        if (!line.trim()) continue
        writeLog(kind === 'out' ? '[out] ' : '[err] ', line)
        if (kind === 'out' && request.onProgress) {
          const progress = progressFromLine(line)
          if (progress) request.onProgress(progress)
        }
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => handleStream(chunk, stdoutDecoder, 'out'))
    child.stderr?.on('data', (chunk: Buffer) => handleStream(chunk, stderrDecoder, 'err'))
    if (child.stdin) {
      child.stdin.on('error', () => { /* Agent may close stdin early. */ })
      try {
        child.stdin.end(request.invocation.stdin, 'utf8')
      } catch {
        try { child.stdin.destroy() } catch { /* ignore */ }
      }
    }
  })
}
