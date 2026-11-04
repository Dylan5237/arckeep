import type {
  Task,
  TaskCounts,
  TaskDecision,
  TaskEngineConfig,
  TaskEventRecord,
  TaskStatus,
  TaskWait
} from './types.js'

export function cwdKey(cwd: string): string {
  return cwd.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
}

export function isCwdBusy(tasks: readonly Task[], cwd: string, exceptTaskId?: string): boolean {
  const key = cwdKey(cwd)
  return tasks.some(task => task.status === 'running' && task.id !== exceptTaskId && cwdKey(task.cwd) === key)
}

function priorityRank(task: Task): number {
  return task.priority === 'high' ? 0 : task.priority === 'low' ? 2 : 1
}

/**
 * Chooses tasks that may start now. Running count includes runs started by a
 * previous selection in the same pump; same-directory tasks are serialized.
 */
export function nextTasksToStart(
  tasks: readonly Task[],
  config: TaskEngineConfig,
  now: Date
): string[] {
  const running = tasks.filter(task => task.status === 'running')
  let slots = config.maxConcurrent - running.length
  if (slots <= 0) return []
  const busy = new Set(running.map(task => cwdKey(task.cwd)))
  const candidates = tasks
    .filter(task => task.status === 'queued')
    .filter(task => task.nextAttemptAt === null || Date.parse(task.nextAttemptAt) <= now.getTime())
    .sort((left, right) => priorityRank(left) - priorityRank(right)
      || Date.parse(left.createdAt) - Date.parse(right.createdAt))
  const selected: string[] = []
  for (const task of candidates) {
    if (slots <= 0) break
    const key = cwdKey(task.cwd)
    if (busy.has(key)) continue
    busy.add(key)
    selected.push(task.id)
    slots -= 1
  }
  return selected
}

export function timerDue(wait: TaskWait, now: Date): boolean {
  return wait.type === 'timer' && wait.firedAt === null && wait.until !== null && Date.parse(wait.until) <= now.getTime()
}

export function waitExpired(wait: TaskWait, now: Date): boolean {
  return wait.firedAt === null && Date.parse(wait.timeoutAt) <= now.getTime()
}

export interface GithubObservation {
  /** Aggregate CI state for the PR head commit(s). */
  checks: 'pending' | 'success' | 'failure' | 'none' | 'unknown'
  /** PR lifecycle state. */
  pr: 'open' | 'closed' | 'merged' | 'unknown'
  headSha: string | null
  detail: string
}

export interface GithubWaitDecision {
  /** true when the task should be woken up. */
  fire: boolean
  /** New state to persist when not firing. */
  state: string | null
  /** Human-readable facts included in the continuation prompt. */
  detail: string
}

/** Fires on a real state change into a terminal condition, never on every poll. */
export function githubWaitDecision(wait: TaskWait, observation: GithubObservation): GithubWaitDecision {
  const previous = wait.lastState
  if (wait.type === 'github_pr') {
    if (observation.pr === 'merged' || observation.pr === 'closed') {
      return {
        fire: true,
        state: observation.pr,
        detail: `${observation.detail}；PR 状态：${observation.pr === 'merged' ? '已合并' : '已关闭'}`
      }
    }
    const state = `pr:${observation.pr};head:${observation.headSha ?? 'unknown'}`
    return { fire: false, state, detail: observation.detail }
  }
  if (observation.checks === 'success' || observation.checks === 'failure') {
    const state = `checks:${observation.checks};head:${observation.headSha ?? 'unknown'}`
    if (previous === state) return { fire: false, state, detail: observation.detail }
    return {
      fire: true,
      state,
      detail: `${observation.detail}；CI 汇总：${observation.checks === 'success' ? '全部通过' : '存在失败'}`
    }
  }
  return {
    fire: false,
    state: `checks:${observation.checks};head:${observation.headSha ?? 'unknown'}`,
    detail: observation.detail
  }
}

export function appendTaskEvent(task: Task, record: TaskEventRecord): TaskEventRecord[] {
  return [...task.events, record].slice(-30)
}

export function canPause(task: Task): boolean {
  return task.status === 'queued' || task.status === 'running' || task.status === 'waiting' || task.status === 'needs_decision'
}

export function canResumePaused(task: Task): boolean {
  return task.status === 'paused'
}

export function canCancel(task: Task): boolean {
  return ['draft', 'queued', 'running', 'waiting', 'needs_decision', 'ready', 'paused', 'failed'].includes(task.status)
}

export function canStartDraft(task: Task): boolean {
  return task.status === 'draft'
}

export function canRetry(task: Task): boolean {
  return task.status === 'failed' || task.status === 'cancelled'
}

export function canAccept(task: Task): boolean {
  return task.status === 'ready'
}

export function canReopen(task: Task): boolean {
  return task.status === 'ready' || task.status === 'done' || task.status === 'failed'
}

export function canEditTask(task: Task): boolean {
  return task.status !== 'running'
}

export function isBusyStatus(status: TaskStatus): boolean {
  return status === 'running'
}

export function countTasks(tasks: readonly Task[], decisions: readonly TaskDecision[]): TaskCounts {
  const count = (predicate: (task: Task) => boolean) => tasks.filter(predicate).length
  return {
    decisions: decisions.filter(item => item.status === 'pending').length,
    running: count(task => task.status === 'running'),
    waiting: count(task => task.status === 'waiting'),
    ready: count(task => task.status === 'ready'),
    draft: count(task => task.status === 'draft'),
    failed: count(task => task.status === 'failed'),
    active: count(task => ['queued', 'running', 'waiting', 'needs_decision'].includes(task.status))
  }
}

export function retryDelayMs(failureCount: number): number {
  const minutes = failureCount <= 1 ? 1 : failureCount === 2 ? 5 : 15
  return minutes * 60 * 1000
}

/** A run that ended without a usable session id and quickly is safe to retry automatically. */
export function isStartupFailure(input: {
  status: string
  sessionId: string | null
  durationMs: number
  producedOutput: boolean
}): boolean {
  if (input.status !== 'failed') return false
  if (input.sessionId) return false
  return !input.producedOutput || input.durationMs < 5_000
}

export function nextRunAt(task: Task): string | null {
  if (task.status === 'queued' && task.nextAttemptAt) return task.nextAttemptAt
  if (task.status === 'waiting' && task.wait) return task.wait.until
  return null
}

export function summarizeChecks(task: Task): { passed: number, failed: number, notRun: number, total: number } {
  const checks = task.result?.checks ?? []
  return {
    passed: checks.filter(item => item.status === 'passed').length,
    failed: checks.filter(item => item.status === 'failed').length,
    notRun: checks.filter(item => item.status === 'not_run' || item.status === 'unknown').length,
    total: checks.length
  }
}
