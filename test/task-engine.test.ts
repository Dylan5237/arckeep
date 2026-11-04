import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskEngine } from '../src/main/tasks/engine.js'
import type { AgentProcessRequest, AgentProcessResult } from '../src/main/tasks/agent-runner.js'
import type { GithubObservation } from '../src/shared/tasks/state.js'
import type { TaskAgentStatus, TaskWait } from '../src/shared/tasks/types.js'

const CWD_A = 'C:\\work\\alpha'
const CWD_B = 'C:\\work\\beta'
let directory = ''
let nowMs = Date.parse('2026-11-04T10:00:00.000Z')

interface PendingRun {
  request: AgentProcessRequest
  complete: (result: AgentProcessResult) => void
}

function result(overrides: Partial<AgentProcessResult> = {}): AgentProcessResult {
  return {
    code: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    spawnError: null,
    stdout: '',
    stderr: '',
    producedOutput: true,
    durationMs: 100,
    ...overrides
  }
}

function claudeOutput(request: AgentProcessRequest, text: string, cost = 0.01): string {
  const args = request.invocation.args
  const index = args.indexOf('--resume') >= 0 ? args.indexOf('--resume') : args.indexOf('--session-id')
  const sessionId = args[index + 1] ?? ''
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    result: text,
    is_error: false,
    total_cost_usd: cost,
    usage: { input_tokens: 10, output_tokens: 5 }
  })
}

function protocol(value: unknown): string {
  return '执行结束。\n\n```arckeep-result\n' + JSON.stringify(value) + '\n```'
}

function done(summary = '完成') {
  return protocol({
    status: 'done',
    summary,
    artifacts: [{ kind: 'file', label: '产物', path: 'C:\\work\\alpha\\out.txt' }],
    checks: [{ name: 'npm test', status: 'passed', detail: '退出码 0' }],
    unverified: []
  })
}

function waitingTimer(until: string) {
  return protocol({
    status: 'waiting',
    summary: '等待复查',
    wait: { type: 'timer', until, reason: '定时复查' }
  })
}

function decision() {
  return protocol({
    status: 'needs_decision',
    summary: '有两个方案',
    decision: {
      question: '用哪个方案？',
      whyYou: '涉及产品取舍',
      recommendation: 'A',
      options: [
        { id: 'A', label: '方案 A', impact: '改动小' },
        { id: 'B', label: '方案 B', impact: '改动大' }
      ],
      expiresAt: new Date(nowMs + 3_600_000).toISOString()
    }
  })
}

function makeEngine(options: {
  config?: Partial<{ maxConcurrent: number; retries: number; maxRunsPerTask: number; maxCostUsdPerTask: number }>
  observeGithub?: (wait: TaskWait) => Promise<GithubObservation>
  file?: string
  pending?: PendingRun[]
} = {}) {
  const file = options.file ?? path.join(directory, 'tasks.json')
  const runsDir = path.join(directory, 'runs')
  const pending = options.pending ?? []
  const runAgent = vi.fn((request: AgentProcessRequest) => new Promise<AgentProcessResult>(resolve => {
    let settled = false
    const complete = (value: AgentProcessResult) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    pending.push({ request, complete })
    request.signal.addEventListener('abort', () => complete(result({ aborted: true, code: null, producedOutput: false, durationMs: 10 })), { once: true })
  }))
  const agents: TaskAgentStatus[] = [
    { agent: 'claude', available: true, version: 'test', command: 'claude.exe' },
    { agent: 'codex', available: true, version: 'test', command: 'codex.cmd' }
  ]
  const engine = new TaskEngine({
    file,
    runsDir,
    now: () => new Date(nowMs),
    detectAgents: async () => agents,
    resolveDirectory: async value => value,
    getGithubToken: async () => 'token',
    runAgent,
    observeGithub: async (wait) => options.observeGithub
      ? options.observeGithub(wait)
      : { checks: 'pending', pr: 'open', headSha: 'abc', detail: '等待' },
    autoTick: false,
    log: () => {}
  })
  return { engine, pending, runAgent, file }
}

async function settle(times = 12): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

async function startEngine(engine: TaskEngine): Promise<void> {
  await engine.start()
  await engine.refreshAgents()
}

function byId(engine: TaskEngine, id: string) {
  return engine.snapshot().tasks.find(task => task.id === id)!
}

async function createTask(engine: TaskEngine, overrides: Record<string, unknown> = {}) {
  return engine.create({
    goal: '完成一个真实任务',
    repo: 'example/demo',
    cwd: CWD_A,
    agent: 'claude',
    autonomy: 'edit',
    priority: 'normal',
    source: 'manual',
    start: true,
    ...overrides
  })
}

afterEach(async () => {
  nowMs = Date.parse('2026-11-04T10:00:00.000Z')
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
  vi.restoreAllMocks()
})

describe('task engine', () => {
  it('runs a task, records evidence, and only marks it done after explicit acceptance', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-engine-done-'))
    const { engine, pending } = makeEngine()
    await startEngine(engine)
    const task = await createTask(engine)
    expect(task.status).toBe('running')
    expect(pending).toHaveLength(1)
    expect(pending[0].request.cwd).toBe(CWD_A)
    expect(pending[0].request.invocation.stdin).toContain('完成一个真实任务')
    expect(pending[0].request.invocation.stdin).toContain('arckeep-result')

    pending[0].complete(result({ stdout: claudeOutput(pending[0].request, done()) }))
    await settle()
    const finished = byId(engine, task.id)
    expect(finished.status).toBe('ready')
    expect(finished.result?.checks[0].status).toBe('passed')
    expect(finished.sessionId).toBeTruthy()
    expect(finished.lastRunId).toBeTruthy()

    const accepted = engine.accept(task.id, '看过了')
    expect(accepted.status).toBe('done')
    expect(accepted.acceptance.status).toBe('accepted')
    expect(accepted.deliveredAt).toBeTruthy()
    await engine.close()
  })

  it('resumes the same agent session with feedback instead of starting from zero', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-engine-feedback-'))
    const { engine, pending } = makeEngine()
    await startEngine(engine)
    const task = await createTask(engine)
    pending[0].complete(result({ stdout: claudeOutput(pending[0].request, done()) }))
    await settle()
    const firstSession = byId(engine, task.id).sessionId
    engine.reopen(task.id, '按钮位置再往左一点')
    await settle()
    expect(pending).toHaveLength(2)
    const second = pending[1].request
    expect(second.invocation.args).toContain('--resume')
    expect(second.invocation.args[second.invocation.args.indexOf('--resume') + 1]).toBe(firstSession)
    expect(second.invocation.stdin).toContain('按钮位置再往左一点')
    expect(second.invocation.stdin).toContain('不要从零重做')
    await engine.close()
  })

  it('waits on a timer, releases the process, then wakes and verifies before continuing', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-engine-timer-'))
    const { engine, pending } = makeEngine()
    await startEngine(engine)
    const task = await createTask(engine)
    const until = new Date(nowMs + 3_600_000).toISOString()
    pending[0].complete(result({ stdout: claudeOutput(pending[0].request, waitingTimer(until)) }))
    await settle()
    expect(byId(engine, task.id).status).toBe('waiting')
    expect(byId(engine, task.id).wait?.until).toBe(until)
    expect(pending).toHaveLength(1)

    nowMs += 2 * 3_600_000
    await engine.refreshEvents()
    await settle()
    const awakened = byId(engine, task.id)
    expect(awakened.status).toBe('running')
    expect(pending).toHaveLength(2)
    expect(pending[1].request.invocation.stdin).toContain('定时提醒到期')
    expect(pending[1].request.invocation.stdin).toContain('先核对')
    pending[1].complete(result({ stdout: claudeOutput(pending[1].request, done('复查完成')) }))
    await settle()
    expect(byId(engine, task.id).status).toBe('ready')
    await engine.close()
  })

  it('does not auto-resume a paused task when its wait becomes due', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-engine-pause-'))
    const { engine, pending } = makeEngine()
    await startEngine(engine)
    const task = await createTask(engine)
    const until = new Date(nowMs + 60_000).toISOString()
    pending[0].complete(result({ stdout: claudeOutput(pending[0].request, waitingTimer(until)) }))
    await settle()
    engine.pause(task.id)
    nowMs += 3_600_000
    await engine.refreshEvents()
    await settle()
    expect(byId(engine, task.id).status).toBe('paused')
    expect(pending).toHaveLength(1)
    engine.resume(task.id)
    await engine.refreshEvents()
    await settle()
    expect(pending).toHaveLength(2)
    expect(byId(engine, task.id).status).toBe('running')
    await engine.close()
  })

  it('binds a decision reply to the current request and resumes with the chosen option', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-engine-decision-'))
    const { engine, pending } = makeEngine()
    await startEngine(engine)
    const task = await createTask(engine)
    pending[0].complete(result({ stdout: claudeOutput(pending[0].request, decision()) }))
    await settle()
    const waiting = byId(engine, task.id)
    expect(waiting.status).toBe('needs_decision')
    const decisionId = waiting.decisionId!
    expect(engine.snapshot().decisions).toHaveLength(1)
    expect(engine.snapshot().decisions[0].question).toBe('用哪个方案？')

    const queued = engine.replyDecision({ decisionId, optionId: 'B', note: '先按 B 做' })
    expect(['queued', 'running']).toContain(queued.status)
    expect(() => engine.replyDecision({ decisionId, optionId: 'A' })).toThrow('已经回复')
    await settle()
    expect(pending).toHaveLength(2)
    expect(pending[1].request.invocation.stdin).toContain('用户决定')
    expect(pending[1].request.invocation.stdin).toContain('方案 B')
    expect(pending[1].request.invocation.stdin).toContain('先按 B 做')
    pending[1].complete(result({ stdout: claudeOutput(pending[1].request, done('按 B 完成')) }))
    await settle()
    expect(byId(engine, task.id).status).toBe('ready')
    await engine.close()
  })

  it('rejects expired decisions and stops the task safely', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-engine-decision-expiry-'))
    const { engine, pending } = makeEngine()
    await startEngine(engine)
    const task = await createTask(engine)
    pending[0].complete(result({ stdout: claudeOutput(pending[0].request, decision()) }))
    await settle()
    const decisionId = byId(engine, task.id).decisionId!
    nowMs += 2 * 3_600_000
    await engine.refreshEvents()
    await settle()
    const expired = byId(engine, task.id)
    expect(expired.status).toBe('failed')
    expect(expired.statusReason).toContain('过期')
    expect(() => engine.replyDecision({ decisionId, optionId: 'A' })).toThrow('过期')
    await engine.close()
  })

  it('serializes tasks in one directory and respects the concurrency cap', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-engine-concurrency-'))
    const { engine, pending } = makeEngine()
    await startEngine(engine)
    await engine.updateConfig({ maxConcurrent: 2 })
    const first = await createTask(engine, { goal: 'A 目录任务 1', cwd: CWD_A })
    const second = await createTask(engine, { goal: 'A 目录任务 2', cwd: CWD_A })
    const third = await createTask(engine, { goal: 'B 目录任务', cwd: CWD_B })
    await settle()
    expect(pending).toHaveLength(2)
    expect(byId(engine, first.id).status).toBe('running')
    expect(byId(engine, second.id).status).toBe('queued')
    expect(byId(engine, third.id).status).toBe('running')
    pending[0].complete(result({ stdout: claudeOutput(pending[0].request, done()) }))
    await settle()
    expect(pending).toHaveLength(3)
    expect(byId(engine, second.id).status).toBe('running')
    await engine.close()
  })

  it('pauses a task interrupted by an application restart instead of pretending it still runs', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-engine-recovery-'))
    const pending: PendingRun[] = []
    const file = path.join(directory, 'tasks.json')
    const first = makeEngine({ pending, file })
    await startEngine(first.engine)
    const task = await createTask(first.engine)
    expect(byId(first.engine, task.id).status).toBe('running')
    expect(JSON.parse(readFileSync(file, 'utf8')).tasks[0].status).toBe('running')

    const second = makeEngine({ file })
    await startEngine(second.engine)
    const recovered = byId(second.engine, task.id)
    expect(recovered.status).toBe('paused')
    expect(recovered.statusReason).toContain('核对')
    expect(recovered.activeRunId).toBeNull()
    expect(second.pending).toHaveLength(0)
    await first.engine.close()
    await second.engine.close()
  })

  it('retries only startup failures, then stops at the configured retry limit', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-engine-retry-'))
    const { engine, pending } = makeEngine()
    await startEngine(engine)
    await engine.updateConfig({ retries: 1 })
    const task = await createTask(engine)
    pending[0].complete(result({ code: null, spawnError: 'ENOENT', producedOutput: false, durationMs: 5 }))
    await settle()
    const retryQueued = byId(engine, task.id)
    expect(retryQueued.status).toBe('queued')
    expect(retryQueued.nextAttemptAt).toBeTruthy()
    expect(engine.snapshot().counts.running).toBe(0)

    nowMs += 2 * 60_000
    await engine.refreshEvents()
    await settle()
    expect(pending).toHaveLength(2)
    pending[1].complete(result({ code: null, spawnError: 'ENOENT', producedOutput: false, durationMs: 5 }))
    await settle()
    expect(byId(engine, task.id).status).toBe('failed')
    expect(byId(engine, task.id).failureCount).toBe(2)
    await engine.close()
  })

  it('wakes on a real GitHub checks change exactly once', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-engine-github-'))
    let calls = 0
    const observations: GithubObservation[] = []
    const { engine, pending } = makeEngine({
      observeGithub: async () => {
        calls += 1
        const observation: GithubObservation = calls === 1
          ? { checks: 'pending', pr: 'open', headSha: 'abc', detail: 'CI 还在运行' }
          : { checks: 'success', pr: 'open', headSha: 'abc', detail: 'CI 全部通过' }
        observations.push(observation)
        return observation
      }
    })
    await startEngine(engine)
    const task = await createTask(engine)
    pending[0].complete(result({
      stdout: claudeOutput(pending[0].request, protocol({
        status: 'waiting',
        summary: '等待 CI',
        wait: { type: 'github_checks', repo: 'example/demo', pr: 9, reason: '等 CI' }
      }))
    }))
    await settle()
    expect(byId(engine, task.id).status).toBe('waiting')

    await engine.refreshEvents(true)
    await settle()
    expect(byId(engine, task.id).status).toBe('waiting')
    expect(byId(engine, task.id).wait?.lastState).toContain('pending')

    await engine.refreshEvents(true)
    await settle()
    expect(byId(engine, task.id).status).toBe('running')
    expect(pending).toHaveLength(2)
    expect(pending[1].request.invocation.stdin).toContain('CI 全部通过')
    await engine.refreshEvents(true)
    expect(pending).toHaveLength(2)
    pending[1].complete(result({ stdout: claudeOutput(pending[1].request, done('CI 后完成')) }))
    await settle()
    expect(byId(engine, task.id).status).toBe('ready')
    expect(observations).toHaveLength(2)
    await engine.close()
  })

  it('enforces run-count and cost limits before starting another round', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-engine-limits-'))
    const { engine, pending } = makeEngine()
    await startEngine(engine)
    await engine.updateConfig({ maxRunsPerTask: 1, maxCostUsdPerTask: 0.5 })
    const task = await createTask(engine)
    pending[0].complete(result({ stdout: claudeOutput(pending[0].request, done(), 0.8) }))
    await settle()
    expect(byId(engine, task.id).status).toBe('ready')
    expect(byId(engine, task.id).costUsd).toBeCloseTo(0.8)
    engine.reopen(task.id, '再改一点')
    await settle()
    const stopped = byId(engine, task.id)
    expect(stopped.status).toBe('failed')
    expect(stopped.statusReason).toMatch(/上限/)
    expect(pending).toHaveLength(1)
    await engine.close()
  })
})
