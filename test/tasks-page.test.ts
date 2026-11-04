// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderTasks, renderTaskSettings } from '../src/renderer/tasks-page.js'
import type {
  Task,
  TaskAgentStatus,
  TaskDecision,
  TaskDetail,
  TaskEngineConfig,
  TaskSnapshot
} from '../src/shared/tasks/types.js'
import type { ArckeepApi, IpcResult } from '../src/shared/types.js'

const NOW = '2026-11-04T10:00:00.000Z'
const BASE_TASK: Task = {
  id: '123e4567-e89b-42d3-a456-426614174001',
  title: '给登录页加校验',
  goal: '给登录页加邮箱格式校验，并补充测试。',
  repo: 'example/demo',
  name: 'Demo',
  cwd: 'C:\\work\\demo',
  agent: 'claude',
  autonomy: 'edit',
  priority: 'normal',
  source: 'manual',
  status: 'ready',
  statusReason: '执行结束，待你验收',
  createdAt: '2026-11-04T09:00:00.000Z',
  updatedAt: '2026-11-04T09:30:00.000Z',
  rounds: 1,
  maxRuns: 12,
  maxCostUsd: 10,
  sessionId: '123e4567-e89b-42d3-a456-426614174099',
  sessionAgent: 'claude',
  activeRunId: null,
  lastRunId: '123e4567-e89b-42d3-a456-426614174002',
  wait: null,
  decisionId: null,
  continuation: null,
  result: {
    runId: '123e4567-e89b-42d3-a456-426614174002',
    receivedAt: '2026-11-04T09:30:00.000Z',
    summary: '已添加校验函数和测试。',
    protocolStatus: 'done',
    artifacts: [{
      id: 'a1', runId: '123e4567-e89b-42d3-a456-426614174002', kind: 'file',
      label: '校验实现', path: 'C:\\work\\demo\\login.ts', url: null, text: null, exists: true
    }],
    checks: [{ name: 'npm test', status: 'passed', detail: '退出码 0' }],
    unverified: ['真机浏览器未验证'],
    protocolWarning: null
  },
  acceptance: { status: 'pending', note: null, at: null },
  feedback: [],
  pausedFrom: null,
  failureCount: 0,
  nextAttemptAt: null,
  lastError: null,
  costUsd: 0.2,
  inputTokens: 100,
  outputTokens: 20,
  events: [{ at: '2026-11-04T09:30:00.000Z', kind: 'run', detail: '第 1 轮结束，待验收' }],
  deliveredAt: null
}

const CONFIG: TaskEngineConfig = {
  defaultAgent: 'claude',
  maxConcurrent: 2,
  runTimeoutMinutes: 45,
  maxRunsPerTask: 12,
  maxCostUsdPerTask: 10,
  retries: 2
}

const AGENTS: TaskAgentStatus[] = [
  { agent: 'claude', available: true, version: '2.1.302', command: 'claude.exe' },
  { agent: 'codex', available: true, version: '0.164.0', command: 'codex.cmd' }
]

function decision(overrides: Partial<TaskDecision> = {}): TaskDecision {
  return {
    id: '123e4567-e89b-42d3-a456-426614174010',
    taskId: BASE_TASK.id,
    runId: '123e4567-e89b-42d3-a456-426614174002',
    question: '登录校验用哪种提示？',
    whyYou: '涉及产品文案',
    recommendation: 'A',
    options: [
      { id: 'A', label: '行内提示', impact: '改动小' },
      { id: 'B', label: '弹窗提示', impact: '更打扰' }
    ],
    createdAt: NOW,
    expiresAt: '2026-11-05T10:00:00.000Z',
    status: 'pending',
    answeredAt: null,
    answer: null,
    ...overrides
  }
}

function makeHarness(tasks: Task[] = [BASE_TASK], decisions: TaskDecision[] = []) {
  let currentTasks = tasks.map(task => ({ ...task }))
  let currentDecisions = decisions.map(item => ({ ...item }))
  const api = {
    getKnownRepos: vi.fn(async () => [
      { id: 'example/demo', label: 'Demo', github: 'example/demo', path: 'C:\\work\\demo', sources: ['watched'] }
    ]),
    getTaskSnapshot: vi.fn(async (): Promise<IpcResult<TaskSnapshot>> => ({
      ok: true,
      data: {
        tasks: currentTasks,
        decisions: currentDecisions.filter(item => item.status === 'pending'),
        config: CONFIG,
        agents: AGENTS,
        agentsReady: true,
        counts: { decisions: currentDecisions.length, running: 0, waiting: 0, ready: 1, draft: 0, failed: 0, active: 0 },
        now: NOW,
        githubReady: true,
        engineError: null
      }
    })),
    getTaskDetail: vi.fn(async (id: string): Promise<IpcResult<TaskDetail>> => {
      const task = currentTasks.find(item => item.id === id)
      if (!task) return { ok: false, error: '找不到这个任务' }
      return {
        ok: true,
        data: {
          task,
          runs: task.lastRunId ? [{
            id: task.lastRunId,
            taskId: task.id,
            round: 1,
            agent: task.agent,
            autonomy: task.autonomy,
            sessionId: task.sessionId,
            resume: false,
            startedAt: '2026-11-04T09:20:00.000Z',
            endedAt: '2026-11-04T09:30:00.000Z',
            status: 'completed',
            exitCode: 0,
            summary: '完成',
            protocolStatus: 'done',
            error: null,
            usage: { costUsd: 0.2, inputTokens: 100, outputTokens: 20 },
            logFile: 'C:\\logs\\run.log',
            progress: null,
            logTail: '日志内容'
          }] : [],
          decisions: currentDecisions.filter(item => item.taskId === id),
          nextRunAt: null
        }
      }
    }),
    createTask: vi.fn(async (input: Parameters<ArckeepApi['createTask']>[0]): Promise<IpcResult<Task>> => {
      const task: Task = {
        ...BASE_TASK,
        id: '123e4567-e89b-42d3-a456-426614174020',
        title: input.title ?? input.goal.slice(0, 40),
        goal: input.goal,
        repo: input.repo,
        cwd: input.cwd,
        agent: input.agent === 'auto' ? 'claude' : input.agent,
        autonomy: input.autonomy,
        priority: input.priority,
        source: input.source,
        status: input.start ? 'queued' : 'draft',
        statusReason: input.start ? '已排队' : '待确认执行范围',
        result: null,
        rounds: 0,
        sessionId: null,
        lastRunId: null,
        updatedAt: NOW
      }
      currentTasks = [task, ...currentTasks]
      return { ok: true, data: task }
    }),
    startTask: vi.fn(async (id: string) => ({ ok: true as const, data: currentTasks.find(item => item.id === id)! })),
    pauseTask: vi.fn(async (id: string) => ({ ok: true as const, data: currentTasks.find(item => item.id === id)! })),
    resumeTask: vi.fn(async (id: string) => ({ ok: true as const, data: currentTasks.find(item => item.id === id)! })),
    cancelTask: vi.fn(async (id: string) => ({ ok: true as const, data: currentTasks.find(item => item.id === id)! })),
    retryTask: vi.fn(async (id: string) => ({ ok: true as const, data: currentTasks.find(item => item.id === id)! })),
    acceptTask: vi.fn(async (id: string, note?: string) => ({
      ok: true as const,
      data: { ...currentTasks.find(item => item.id === id)!, acceptance: { status: 'accepted' as const, note: note ?? null, at: NOW } }
    })),
    reopenTask: vi.fn(async (id: string, feedback?: string) => ({
      ok: true as const,
      data: { ...currentTasks.find(item => item.id === id)!, feedback: feedback ? [feedback] : [] }
    })),
    deleteTask: vi.fn(async () => ({ ok: true as const, data: { id: 'deleted' } })),
    replyTaskDecision: vi.fn(async (input: Parameters<ArckeepApi['replyTaskDecision']>[0]): Promise<IpcResult<Task>> => {
      const target = currentDecisions.find(item => item.id === input.decisionId)
      if (!target) return { ok: false, error: '找不到这个决定' }
      target.status = 'answered'
      currentDecisions = currentDecisions.map(item => item.id === target.id ? target : item)
      return { ok: true, data: currentTasks[0] }
    }),
    refreshTaskEvents: vi.fn(async () => api.getTaskSnapshot()),
    setTaskConfig: vi.fn(async (input: TaskEngineConfig) => ({ ok: true as const, data: input })),
    refreshTaskAgents: vi.fn(async () => ({ ok: true as const, data: AGENTS })),
    pickTaskDirectory: vi.fn(async () => ({ ok: true as const, data: { cancelled: false as const, path: 'C:\\work\\demo' } })),
    openTaskArtifact: vi.fn(async () => ({ ok: true as const, data: true as const })),
    openTaskTerminal: vi.fn(async () => ({ ok: true as const, data: true as const })),
    revealTaskRun: vi.fn(async () => ({ ok: true as const, data: true as const })),
    onTasksChanged: vi.fn(() => () => {}),
    onTasksNavigate: vi.fn(() => () => {})
  }
  return { api, currentTasks, currentDecisions }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes(text))
  if (!found) throw new Error('Missing button: ' + text)
  return found
}

let dispose: (() => void) | null = null
afterEach(() => {
  dispose?.()
  dispose = null
  document.body.replaceChildren()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('tasks page', () => {
  it('shows decisions first and replies with the selected option and note', async () => {
    const harness = makeHarness([{ ...BASE_TASK, status: 'needs_decision', statusReason: '需要你决定' }], [decision()])
    window.arckeep = harness.api as unknown as ArckeepApi
    const host = document.createElement('main')
    document.body.append(host)
    dispose = await renderTasks(host, {})
    await settle()
    expect(host.querySelector('.task-decision-section')?.textContent).toContain('登录校验用哪种提示？')
    expect(host.querySelector('.task-decision-section')?.textContent).toContain('建议：A')
    const note = host.querySelector<HTMLInputElement>('.task-decision-card input[type="text"]')!
    note.value = '按行内做'
    host.querySelectorAll<HTMLButtonElement>('.task-decision-option')[1].click()
    await settle()
    expect(harness.api.replyTaskDecision).toHaveBeenCalledWith({
      decisionId: '123e4567-e89b-42d3-a456-426614174010',
      optionId: 'B',
      note: '按行内做'
    })
  })

  it('creates a task from the composer with the selected repository and directory', async () => {
    const harness = makeHarness([])
    window.arckeep = harness.api as unknown as ArckeepApi
    const host = document.createElement('main')
    document.body.append(host)
    dispose = await renderTasks(host, {})
    await settle()
    host.querySelector<HTMLTextAreaElement>('[aria-label="任务目标"]')!.value = '修复登录校验并加测试'
    const repo = host.querySelector<HTMLSelectElement>('[aria-label="关联仓库"]')!
    repo.value = 'example/demo'
    repo.dispatchEvent(new Event('change'))
    expect(host.textContent).toContain('C:\\work\\demo')
    button(host, '创建并开始').click()
    await settle()
    expect(harness.api.createTask).toHaveBeenCalledWith(expect.objectContaining({
      goal: '修复登录校验并加测试',
      repo: 'example/demo',
      cwd: 'C:\\work\\demo',
      agent: 'auto',
      autonomy: 'edit',
      source: 'manual',
      start: true
    }))
  })

  it('remembers the last directory and advanced options for the next task', async () => {
    localStorage.setItem('arckeep.task-defaults.v1', JSON.stringify({
      cwd: 'C:\\work\\demo',
      repo: 'example/demo',
      agent: 'codex',
      autonomy: 'full',
      priority: 'high'
    }))
    const harness = makeHarness([])
    window.arckeep = harness.api as unknown as ArckeepApi
    const host = document.createElement('main')
    document.body.append(host)
    dispose = await renderTasks(host, {})
    await settle()
    expect(host.querySelector<HTMLSelectElement>('[aria-label="常用工作目录"]')!.value).toBe('C:\\work\\demo')
    expect(host.querySelector<HTMLSelectElement>('[aria-label="执行 Agent"]')!.value).toBe('codex')
    expect(host.querySelector<HTMLSelectElement>('[aria-label="授权范围"]')!.value).toBe('full')
    expect(host.querySelector<HTMLSelectElement>('[aria-label="优先级"]')!.value).toBe('high')

    host.querySelector<HTMLTextAreaElement>('[aria-label="任务目标"]')!.value = '继续上次的工作'
    button(host, '创建并开始').click()
    await settle()
    expect(harness.api.createTask).toHaveBeenCalledWith(expect.objectContaining({
      cwd: 'C:\\work\\demo',
      agent: 'codex',
      autonomy: 'full',
      priority: 'high'
    }))
  })

  it('opens artifacts and submits acceptance feedback from the task detail', async () => {
    const harness = makeHarness()
    window.arckeep = harness.api as unknown as ArckeepApi
    const host = document.createElement('main')
    document.body.append(host)
    dispose = await renderTasks(host, { taskId: BASE_TASK.id })
    await settle()
    expect(host.textContent).toContain('已添加校验函数和测试。')
    expect(host.textContent).toContain('尚未验证')
    host.querySelector<HTMLButtonElement>('.task-artifact')!.click()
    await settle()
    expect(harness.api.openTaskArtifact).toHaveBeenCalledWith(BASE_TASK.id, 'a1')

    button(host, '接管').click()
    await settle()
    expect(harness.api.openTaskTerminal).toHaveBeenCalledWith(BASE_TASK.id)

    const acceptNote = host.querySelector<HTMLInputElement>('[aria-label="验收备注"]')!
    acceptNote.value = '可以'
    acceptNote.dispatchEvent(new Event('input'))
    button(host, '验收通过').click()
    await settle()
    expect(harness.api.acceptTask).toHaveBeenCalledWith(BASE_TASK.id, '可以')

    const feedback = host.querySelector<HTMLTextAreaElement>('[aria-label="任务反馈"]')!
    feedback.value = '提示文案改成中文'
    feedback.dispatchEvent(new Event('input'))
    button(host, '提交修改').click()
    await settle()
    expect(harness.api.reopenTask).toHaveBeenCalledWith(BASE_TASK.id, '提示文案改成中文')
  })

  it('renders a stale decision error instead of pretending the reply succeeded', async () => {
    const harness = makeHarness([{ ...BASE_TASK, status: 'needs_decision' }], [decision()])
    harness.api.replyTaskDecision = vi.fn(async () => ({ ok: false as const, error: '这个决定已过期，请让 Agent 重新确认' }))
    window.arckeep = harness.api as unknown as ArckeepApi
    const host = document.createElement('main')
    document.body.append(host)
    dispose = await renderTasks(host, {})
    await settle()
    host.querySelectorAll<HTMLButtonElement>('.task-decision-option')[0].click()
    await settle()
    expect(host.querySelector('.task-page-error')?.textContent).toContain('已过期')
  })

  it('settings show detected agents and save the concurrency limits', async () => {
    const harness = makeHarness([])
    window.arckeep = harness.api as unknown as ArckeepApi
    const card = await renderTaskSettings()
    document.body.append(card)
    expect(card.textContent).toContain('2.1.302')
    expect(card.textContent).toContain('0.164.0')
    const concurrency = card.querySelector<HTMLInputElement>('[aria-label="同时执行任务数"]')!
    concurrency.value = '3'
    button(card, '保存任务设置').click()
    await settle()
    expect(harness.api.setTaskConfig).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrent: 3 }))
  })
})
