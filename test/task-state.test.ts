import { describe, expect, it } from 'vitest'
import {
  githubWaitDecision,
  isCwdBusy,
  isStartupFailure,
  nextTasksToStart,
  retryDelayMs,
  timerDue,
  waitExpired
} from '../src/shared/tasks/state.js'
import { defaultEngineConfig } from '../src/shared/tasks/validate.js'
import type { Task, TaskWait } from '../src/shared/tasks/types.js'

function task(overrides: Partial<Task>): Task {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    title: 't',
    goal: 'g',
    repo: null,
    name: 'n',
    cwd: 'C:\\work\\a',
    agent: 'claude',
    autonomy: 'edit',
    priority: 'normal',
    source: 'manual',
    status: 'queued',
    statusReason: null,
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
    rounds: 0,
    maxRuns: 12,
    maxCostUsd: 10,
    sessionId: null,
    sessionAgent: null,
    activeRunId: null,
    lastRunId: null,
    wait: null,
    decisionId: null,
    continuation: null,
    result: null,
    acceptance: { status: 'pending', note: null, at: null },
    feedback: [],
    pausedFrom: null,
    failureCount: 0,
    nextAttemptAt: null,
    lastError: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    events: [],
    deliveredAt: null,
    ...overrides
  }
}

function wait(overrides: Partial<TaskWait> = {}): TaskWait {
  return {
    type: 'timer',
    reason: '等',
    until: '2026-11-04T01:00:00.000Z',
    repo: null,
    pr: null,
    createdAt: '2026-11-04T00:00:00.000Z',
    timeoutAt: '2026-11-11T00:00:00.000Z',
    lastCheckedAt: null,
    lastState: null,
    lastError: null,
    firedAt: null,
    firedDetail: null,
    ...overrides
  }
}

describe('task queue state', () => {
  it('starts high priority first and never two tasks in the same directory', () => {
    const tasks = [
      task({ id: '00000000-0000-4000-8000-000000000001', cwd: 'C:\\work\\a', priority: 'low' }),
      task({ id: '00000000-0000-4000-8000-000000000002', cwd: 'C:\\work\\a', priority: 'high' }),
      task({ id: '00000000-0000-4000-8000-000000000003', cwd: 'C:\\work\\b', priority: 'normal' })
    ]
    const config = { ...defaultEngineConfig(), maxConcurrent: 2 }
    const selected = nextTasksToStart(tasks, config, new Date('2026-11-04T00:00:00.000Z'))
    expect(selected).toEqual(['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'])
    expect(isCwdBusy([task({ status: 'running', cwd: 'c:/WORK/a/' })], 'C:\\work\\a')).toBe(true)
  })

  it('honours the concurrency cap and skips tasks whose retry is not due', () => {
    const tasks = [
      task({ id: '00000000-0000-4000-8000-000000000001', status: 'running', cwd: 'C:\\work\\a' }),
      task({ id: '00000000-0000-4000-8000-000000000002', cwd: 'C:\\work\\b', nextAttemptAt: '2026-11-04T01:00:00.000Z' })
    ]
    expect(nextTasksToStart(tasks, { ...defaultEngineConfig(), maxConcurrent: 1 }, new Date('2026-11-04T00:00:00.000Z'))).toEqual([])
    expect(nextTasksToStart(tasks, { ...defaultEngineConfig(), maxConcurrent: 2 }, new Date('2026-11-04T00:00:00.000Z'))).toEqual([])
    expect(nextTasksToStart(tasks, { ...defaultEngineConfig(), maxConcurrent: 2 }, new Date('2026-11-04T02:00:00.000Z'))).toEqual(['00000000-0000-4000-8000-000000000002'])
  })

  it('detects timer waits and wait timeouts separately', () => {
    expect(timerDue(wait(), new Date('2026-11-04T02:00:00.000Z'))).toBe(true)
    expect(timerDue(wait({ firedAt: '2026-11-04T01:00:00.000Z' }), new Date('2026-11-04T02:00:00.000Z'))).toBe(false)
    expect(waitExpired(wait({ timeoutAt: '2026-11-04T00:30:00.000Z' }), new Date('2026-11-04T02:00:00.000Z'))).toBe(true)
  })

  it('wakes once on a terminal CI state and does not repeat on identical polls', () => {
    const pending = githubWaitDecision(wait({ type: 'github_checks', repo: 'a/b', pr: 1 }), {
      checks: 'pending', pr: 'open', headSha: 'abc', detail: '等待'
    })
    expect(pending.fire).toBe(false)
    const success = githubWaitDecision(wait({ type: 'github_checks', repo: 'a/b', pr: 1, lastState: pending.state }), {
      checks: 'success', pr: 'open', headSha: 'abc', detail: '通过'
    })
    expect(success.fire).toBe(true)
    const repeated = githubWaitDecision(wait({
      type: 'github_checks', repo: 'a/b', pr: 1, lastState: success.state
    }), { checks: 'success', pr: 'open', headSha: 'abc', detail: '通过' })
    expect(repeated.fire).toBe(false)
  })

  it('wakes a PR wait when the PR closes or merges', () => {
    expect(githubWaitDecision(wait({ type: 'github_pr', repo: 'a/b', pr: 1 }), {
      checks: 'unknown', pr: 'merged', headSha: 'abc', detail: 'PR'
    }).fire).toBe(true)
    expect(githubWaitDecision(wait({ type: 'github_pr', repo: 'a/b', pr: 1 }), {
      checks: 'unknown', pr: 'open', headSha: 'abc', detail: 'PR'
    }).fire).toBe(false)
  })

  it('only auto-retries startup-like failures', () => {
    expect(isStartupFailure({ status: 'failed', sessionId: null, durationMs: 100, producedOutput: false })).toBe(true)
    expect(isStartupFailure({ status: 'failed', sessionId: 'x', durationMs: 100, producedOutput: false })).toBe(false)
    expect(isStartupFailure({ status: 'failed', sessionId: null, durationMs: 60_000, producedOutput: true })).toBe(false)
    expect(retryDelayMs(1)).toBe(60_000)
    expect(retryDelayMs(2)).toBe(300_000)
    expect(retryDelayMs(3)).toBe(900_000)
  })
})
