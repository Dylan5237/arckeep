import { spawn, type ChildProcess } from 'node:child_process'
import { killProcessTree } from './tool-runner.js'
import { spawnWindowsJobRelay } from './process-ownership.js'
import type { TaskScope } from '../shared/task-scope.js'

export interface ManagedCommandOptions {
  signal?: AbortSignal
  tasks?: TaskScope
  timeoutMs?: number
  maxBuffer?: number
  label?: string
}

export type ManagedCommandContext = Pick<ManagedCommandOptions, 'signal' | 'tasks'>

export interface ManagedCommandResult {
  code: number
  stdout: string
  stderr: string
}

function cancellationReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('操作已取消')
  error.name = 'AbortError'
  return error
}

function timeoutError(): Error {
  const error = new Error('命令执行超时')
  error.name = 'TimeoutError'
  return error
}

/** Runs a command without a shell and owns its process tree until it exits. */
export function runManagedCommand(
  command: string,
  args: readonly string[],
  options: ManagedCommandOptions = {}
): Promise<ManagedCommandResult> {
  const signal = options.signal ?? options.tasks?.signal
  if (signal?.aborted) return Promise.reject(cancellationReason(signal))

  return new Promise((resolve, reject) => {
    let child: ChildProcess | undefined
    let settled = false
    let stopping = false
    let cleanupPromise: Promise<void> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let releaseOwner: (() => void) | undefined
    let ownerReleased = false
    const maxBuffer = options.maxBuffer ?? 1024 * 1024
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0

    const release = () => {
      if (ownerReleased) return
      ownerReleased = true
      releaseOwner?.()
    }
    const clearWaiters = () => {
      if (timeout !== undefined) clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (error?: Error, result?: ManagedCommandResult, releaseResource = true) => {
      if (settled) return
      settled = true
      clearWaiters()
      if (releaseResource) release()
      if (error) reject(error)
      else resolve(result ?? { code: 1, stdout: '', stderr: '' })
    }
    const cleanup = (): Promise<void> => {
      if (!child) return Promise.resolve()
      cleanupPromise ??= Promise.resolve().then(() => killProcessTree(child!))
      return cleanupPromise
    }
    const finishAfterStop = async (reason: Error) => {
      try {
        await cleanup()
        finish(reason)
      } catch (cleanupError) {
        if (options.tasks) {
          // The still-registered owner reports this failure independently during TaskScope.drain().
          finish(reason, undefined, false)
        } else {
          finish(new AggregateError([reason, cleanupError], '取消命令时清理子进程失败', { cause: reason }))
        }
      }
    }
    function onAbort(): void {
      if (settled || stopping || !signal) return
      stopping = true
      void finishAfterStop(cancellationReason(signal))
    }

    try {
      releaseOwner = options.tasks?.own(options.label ?? '受管命令子进程', cleanup)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }

      child = process.platform === 'win32'
        ? spawnWindowsJobRelay({ file: command, args: [...args], windowsVerbatimArguments: false }, process.cwd())
        : spawn(command, [...args], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true
        })
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stopping || settled) return
        stdoutBytes += chunk.length
        if (stdoutBytes > maxBuffer) {
          stopping = true
          const error = new Error('命令输出超过缓冲区限制')
          error.name = 'MaxBufferError'
          void finishAfterStop(error)
          return
        }
        stdoutChunks.push(chunk)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stopping || settled) return
        stderrBytes += chunk.length
        if (stderrBytes > maxBuffer) {
          stopping = true
          const error = new Error('命令错误输出超过缓冲区限制')
          error.name = 'MaxBufferError'
          void finishAfterStop(error)
          return
        }
        stderrChunks.push(chunk)
      })
      child.once('error', error => {
        if (stopping || settled) return
        finish(error)
      })
      child.once('close', (code, _signal) => {
        if (stopping || settled) return
        finish(undefined, {
          code: code ?? 1,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8')
        })
      })
      if (signal?.aborted) {
        onAbort()
        return
      }
      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          if (settled || stopping) return
          stopping = true
          void finishAfterStop(timeoutError())
        }, Math.max(0, options.timeoutMs))
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error('无法启动命令'))
    }
  })
}
