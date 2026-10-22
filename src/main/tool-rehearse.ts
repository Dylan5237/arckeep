import { existsSync, statSync } from 'node:fs'
import type { ShellPlan } from './tool-launch.js'
import { planShell } from './tool-launch.js'
import { runPlan, ToolRunner } from './tool-runner.js'
import type { ToolRunEvent } from '../shared/tools/types.js'
import {
  summarizeDryRun,
  unavailableRehearsal
} from '../shared/tools/rehearsal.js'
import { withDeadline } from '../shared/task-scope.js'
import type { ActionPreview, Rehearsal } from '../shared/tools/types.js'

export interface RehearseRunResult {
  code: number | null
  stdout: string
  stderr: string
  aborted: boolean
  error?: string
}

export interface RehearseDeps {
  platform?: NodeJS.Platform
  cwdExists?: (cwd: string) => boolean
  run?: (plan: ShellPlan, cwd: string) => Promise<RehearseRunResult>
}

interface RehearsalRunner {
  start(plan: ShellPlan, cwd: string): string
  abortAll(): void | Promise<void>
  waitForTermination?(): Promise<void>
}

interface ActiveRehearsal {
  runner: RehearsalRunner
  promise: Promise<RehearseRunResult>
}

export interface ToolRehearsals {
  close(): void
  rehearse(requestId: string, preview: ActionPreview): Promise<Rehearsal>
  cancel(requestId: string): Promise<void>
  cancelAll(): Promise<void>
}

export interface ToolRehearsalManagerOptions {
  platform?: NodeJS.Platform
  cwdExists?: (cwd: string) => boolean
  createRunner?: (emit: (event: ToolRunEvent) => void) => RehearsalRunner
  timeoutMs?: number
  cancelTimeoutMs?: number
  now?: () => number
}

function failed(summary: string): Rehearsal {
  return { status: 'failed', summary: summary.startsWith('预演失败') ? summary : `预演失败：${summary}`, canConfirm: false }
}

function throwFailures(results: PromiseSettledResult<unknown>[], message: string): void {
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, message)
}

function directoryExists(cwd: string): boolean {
  try {
    return existsSync(cwd) && statSync(cwd).isDirectory()
  } catch {
    return false
  }
}

/**
 * Run the configured dry-run command and attach a summary.
 * Confirm stays disarmed when that command fails. The real command is not started here.
 */
export async function rehearsePreview(preview: ActionPreview, deps: RehearseDeps = {}): Promise<Rehearsal> {
  if (preview.type !== 'run-command' || !preview.dryRun) {
    if (preview.type !== 'run-command') {
      return { status: 'unavailable', summary: preview.text, canConfirm: true }
    }
    return unavailableRehearsal(preview.cwd ?? '', preview.text)
  }
  const platform = deps.platform ?? process.platform
  if (!preview.shell || !preview.cwd) return failed('命令缺少 shell 或工作目录')
  if (preview.shell === 'cmd' && platform !== 'win32') return failed('cmd 只能在 Windows 上运行')
  if (preview.shell === 'powershell' && platform !== 'win32') return failed('PowerShell 只能在 Windows 上运行')
  const cwdExists = deps.cwdExists ?? directoryExists
  if (!cwdExists(preview.cwd)) return failed('工作目录不存在')
  try {
    const plan = planShell(preview.shell, preview.dryRun, process.env, platform)
    const run = deps.run ?? ((item, cwd) => runPlan(item, cwd))
    const result = await run(plan, preview.cwd)
    return summarizeDryRun({
      cwd: preview.cwd,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      aborted: result.aborted,
      error: result.error
    })
  } catch (error) {
    return failed(error instanceof Error ? error.message : '无法预演')
  }
}

/** Owns pending dry-runs so navigation and process shutdown can cancel and await them. */
export function createToolRehearsals(options: ToolRehearsalManagerOptions = {}): ToolRehearsals {
  const active = new Map<string, ActiveRehearsal>()
  const cancellations = new Map<string, Promise<void>>()
  const cancelled = new Map<string, number>()
  const now = options.now ?? Date.now
  const createRunner = options.createRunner ?? (emit => new ToolRunner(emit))
  const timeoutMs = options.timeoutMs ?? 20_000
  const cancelTimeoutMs = options.cancelTimeoutMs ?? 12_000
  let closing = false

  async function cancelPending(pending: ActiveRehearsal, deadline: number, requestId: string): Promise<void> {
    const remainingForCleanup = Math.max(0, deadline - Date.now())
    await withDeadline(
      Promise.resolve(pending.runner.abortAll()),
      remainingForCleanup,
      `取消预演 ${requestId} 时等待进程清理超时`
    )
    const remainingForRun = Math.max(0, deadline - Date.now())
    await withDeadline(
      pending.promise,
      remainingForRun,
      `取消预演 ${requestId} 时等待任务结束超时`
    )
  }

  function cancelRequest(requestId: string, pending: ActiveRehearsal): Promise<void> {
    const existing = cancellations.get(requestId)
    if (existing) return existing
    const operation = cancelPending(pending, Date.now() + cancelTimeoutMs, requestId).finally(() => {
      if (cancellations.get(requestId) === operation) cancellations.delete(requestId)
    })
    cancellations.set(requestId, operation)
    return operation
  }

  function pruneCancelled(): void {
    const cutoff = now() - 60_000
    for (const [id, cancelledAt] of cancelled) {
      if (cancelledAt < cutoff) cancelled.delete(id)
    }
    while (cancelled.size > 64) {
      const oldest = cancelled.keys().next().value as string | undefined
      if (!oldest) break
      cancelled.delete(oldest)
    }
  }

  function run(requestId: string, plan: ShellPlan, cwd: string): Promise<RehearseRunResult> {
    if (closing) return Promise.reject(new Error('应用正在关闭，不能启动新预演'))
    pruneCancelled()
    if (cancelled.has(requestId)) {
      return Promise.resolve({ code: null, stdout: '', stderr: '', aborted: true, error: '预演已取消' })
    }
    if (active.has(requestId)) return Promise.reject(new Error('预演请求重复'))
    let stdout = ''
    let stderr = ''
    let resolveRun: (result: RehearseRunResult) => void = () => {}
    let rejectRun: (error: unknown) => void = () => {}
    const runner = createRunner(event => {
      if (event.type === 'output') {
        if (event.stream === 'stderr') stderr += event.text ?? ''
        else stdout += event.text ?? ''
        return
      }
      clearTimeout(timer)
      const result = {
        code: event.exitCode ?? null,
        stdout,
        stderr,
        aborted: Boolean(event.aborted),
        error: event.error
      }
      void Promise.resolve(runner.waitForTermination?.())
        .then(() => resolveRun(result), rejectRun)
    })
    const promise = new Promise<RehearseRunResult>((resolve, reject) => {
      resolveRun = resolve
      rejectRun = reject
    }).finally(() => {
      clearTimeout(timer)
      if (active.get(requestId)?.runner === runner) active.delete(requestId)
    })
    active.set(requestId, { runner, promise })
    const timer = setTimeout(() => {
      void Promise.resolve(runner.abortAll()).catch(rejectRun)
    }, timeoutMs)
    try {
      runner.start(plan, cwd)
    } catch (error) {
      clearTimeout(timer)
      rejectRun(error)
    }
    return promise
  }

  return {
    close() { closing = true },
    async rehearse(requestId, preview) {
      if (closing) return failed('应用正在关闭，不能启动新预演')
      pruneCancelled()
      if (cancelled.has(requestId)) return failed('预演已取消，请重新预览')
      return rehearsePreview(preview, {
        platform: options.platform,
        cwdExists: options.cwdExists,
        run: (plan, cwd) => run(requestId, plan, cwd)
      })
    },
    async cancel(requestId) {
      pruneCancelled()
      cancelled.set(requestId, now())
      const pending = active.get(requestId)
      if (!pending) return
      await cancelRequest(requestId, pending)
    },
    async cancelAll() {
      pruneCancelled()
      const pending = [...active.entries()]
      const waits: Promise<unknown>[] = []
      for (const [id, rehearsal] of pending) {
        cancelled.set(id, now())
        waits.push(cancelRequest(id, rehearsal))
      }
      const results = await Promise.allSettled(waits)
      throwFailures(results, '关闭时清理预演进程失败')
    }
  }
}
