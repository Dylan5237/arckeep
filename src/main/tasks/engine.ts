import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  appendTaskEvent,
  canAccept,
  canCancel,
  canEditTask,
  canPause,
  canResumePaused,
  canRetry,
  canStartDraft,
  countTasks,
  cwdKey,
  githubWaitDecision,
  isStartupFailure,
  nextTasksToStart,
  retryDelayMs,
  timerDue,
  waitExpired,
  type GithubObservation
} from '../../shared/tasks/state.js'
import {
  defaultDecisionExpiry,
  defaultEngineConfig,
  defaultWaitTimeout,
  normalizeDecisionReply,
  normalizeEngineConfig,
  normalizeFeedback,
  normalizeTaskCreate,
  normalizeTaskName,
  normalizeTaskTitle,
  normalizeTaskUpdate,
  parseAgentProtocol
} from '../../shared/tasks/validate.js'
import {
  TASK_LOG_TAIL_BYTES,
  TASK_MAX_TITLE_LENGTH,
  type Task,
  type TaskAgent,
  type TaskAgentStatus,
  type TaskContinuation,
  type TaskDecision,
  type TaskDetail,
  type TaskEngineConfig,
  type TaskRun,
  type TaskRunView,
  type TaskSnapshot,
  type TaskWait
} from '../../shared/tasks/types.js'
import { buildContinuationContext, buildTaskPrompt } from '../../shared/tasks/prompt.js'
import { buildAgentInvocation as buildInvocation } from './agent-command.js'
import { parseClaudeStream, parseCodexStream, type ParsedAgentOutput } from './agent-output.js'
import { runAgentProcess, type AgentProcessRequest, type AgentProcessResult } from './agent-runner.js'
import { observeGithubWait } from './github-events.js'
import { TaskStore } from './store.js'

const TICK_MS = 3_000
const GITHUB_POLL_MS = 60_000
const CLOSE_WAIT_MS = 8_000

interface ActiveRun {
  runId: string
  controller: AbortController
  pauseRequested: boolean
  cancelRequested: boolean
  lastProgressEmit: number
}

export interface TaskEngineDeps {
  file: string
  runsDir: string
  now?: () => Date
  id?: () => string
  log?: (message: string) => void
  onChange?: (payload: { taskId: string | null, reason: string }) => void
  notify?: (payload: { title: string, body: string, taskId: string }) => void
  resolveDirectory?: (input: string) => Promise<string>
  detectAgents?: () => Promise<TaskAgentStatus[]>
  getGithubToken?: () => Promise<string | null>
  fetchImpl?: typeof fetch
  runAgent?: (request: AgentProcessRequest) => Promise<AgentProcessResult>
  observeGithub?: (wait: TaskWait, options: { token: string, fetchImpl?: typeof fetch, signal?: AbortSignal }) => Promise<GithubObservation>
  env?: NodeJS.ProcessEnv
  /** Tests drive ticks explicitly. Production leaves the timer running. */
  autoTick?: boolean
}

function defaultResolveDirectory(input: string): Promise<string> {
  return realpath(input).then(async resolved => {
    const details = await stat(resolved)
    if (!details.isDirectory()) throw new Error('所选路径不是目录')
    return resolved
  }).catch(() => {
    throw new Error('工作目录不存在或不可访问')
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function commandNeedsShell(file: string): boolean {
  return /\.(cmd|bat)$/i.test(file)
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + '…' : value
}

function isGithubWait(wait: TaskWait | null): wait is TaskWait {
  return Boolean(wait && (wait.type === 'github_checks' || wait.type === 'github_pr'))
}

export class TaskEngine {
  private readonly store: TaskStore
  private readonly deps: TaskEngineDeps
  private readonly runsDir: string
  private tasks: Task[] = []
  private decisions: TaskDecision[] = []
  private runs: TaskRun[] = []
  private config: TaskEngineConfig = defaultEngineConfig()
  private engineError: string | null = null
  private fatal = false
  private closed = false
  private agentsReady = false
  private agentStatuses: TaskAgentStatus[] = []
  private githubAuth: 'unknown' | 'ready' | 'missing' = 'unknown'
  private timer: ReturnType<typeof setInterval> | null = null
  private tickBusy = false
  private pollBusy = false
  private lastGithubPollAt = 0
  private githubBackoffUntil = 0
  private readonly active = new Map<string, ActiveRun>()
  private readonly now: () => Date
  private readonly makeId: () => string
  private readonly runAgent: (request: AgentProcessRequest) => Promise<AgentProcessResult>
  private readonly observeGithub: typeof observeGithubWait

  constructor(deps: TaskEngineDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => new Date())
    this.makeId = deps.id ?? randomUUID
    this.runAgent = deps.runAgent ?? runAgentProcess
    this.observeGithub = deps.observeGithub ?? observeGithubWait
    this.runsDir = path.resolve(deps.runsDir)
    this.store = new TaskStore({ file: deps.file, now: this.now })
    const loadError = this.store.loadErrorValue()
    if (loadError) {
      this.fatal = true
      this.engineError = /[㐀-鿿]/u.test(loadError.message)
        ? loadError.message
        : '任务数据文件损坏或无法读取，已保留原文件'
      return
    }
    const data = this.store.getData()
    this.tasks = data.tasks
    this.decisions = data.decisions
    this.runs = data.runs
    this.config = data.config
  }

  async start(): Promise<void> {
    if (this.fatal || this.closed) return
    this.repairOnBoot()
    if (this.deps.autoTick !== false && this.timer === null) {
      this.timer = setInterval(() => { void this.tick(false) }, TICK_MS)
      this.timer.unref?.()
    }
    void this.loadAgentStatuses()
    void this.tick(true)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    for (const active of this.active.values()) active.controller.abort()
    const deadline = Date.now() + CLOSE_WAIT_MS
    while (this.active.size > 0 && Date.now() < deadline) await sleep(100)
    const now = this.nowIso()
    for (const [taskId, active] of this.active) {
      const task = this.tasks.find(item => item.id === taskId)
      const run = this.runs.find(item => item.id === active.runId)
      if (run && run.status === 'running') {
        run.status = 'interrupted'
        run.endedAt = now
        run.error = '应用退出时运行尚未结束'
      }
      if (task && task.status === 'running') {
        task.status = 'paused'
        task.pausedFrom = 'running'
        task.statusReason = '应用退出时运行被中断，请核对现场后继续'
        task.activeRunId = null
        task.events = appendTaskEvent(task, { at: now, kind: 'run', detail: '应用退出，运行被中断' })
      }
    }
    this.active.clear()
    this.persistQuiet()
  }

  private async loadAgentStatuses(): Promise<void> {
    if (this.agentsReady) return
    await this.detectAgentStatuses(false)
  }

  async refreshAgents(): Promise<TaskAgentStatus[]> {
    this.assertWritable()
    await this.detectAgentStatuses(true)
    return this.agentStatuses.map(item => ({ ...item }))
  }

  private async detectAgentStatuses(force: boolean): Promise<void> {
    if (this.agentsReady && !force) return
    try {
      this.agentStatuses = this.deps.detectAgents ? await this.deps.detectAgents() : []
    } catch (error) {
      this.deps.log?.('Agent 检测失败：' + (error instanceof Error ? error.message : String(error)))
      this.agentStatuses = []
    }
    this.agentsReady = true
    this.emit(null, 'agents-ready')
    this.pump()
  }

  private nowIso(): string {
    return this.now().toISOString()
  }

  private requireTask(id: string): Task {
    const task = this.tasks.find(item => item.id === id)
    if (!task) throw new Error('找不到这个任务')
    return task
  }

  private findDecision(id: string): TaskDecision | null {
    return this.decisions.find(item => item.id === id) ?? null
  }

  private assertWritable(): void {
    if (this.fatal) throw new Error(this.engineError ?? '任务数据不可用')
    if (this.closed) throw new Error('应用正在退出，不能修改任务')
  }

  private persist(): void {
    if (this.fatal) return
    this.trim()
    this.store.save({
      version: 1,
      config: this.config,
      tasks: this.tasks,
      decisions: this.decisions,
      runs: this.runs
    })
  }

  private persistQuiet(): void {
    try { this.persist() } catch (error) {
      this.deps.log?.('任务数据保存失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  private emit(taskId: string | null, reason: string): void {
    if (this.closed) return
    try { this.deps.onChange?.({ taskId, reason }) } catch { /* UI update must not break the engine. */ }
  }

  private notify(title: string, body: string, taskId: string): void {
    if (this.closed) return
    try { this.deps.notify?.({ title, body: truncate(body, 200), taskId }) } catch { /* OS notification unavailable. */ }
  }

  private trim(): void {
    if (this.tasks.length > 500) {
      const keep = [...this.tasks].sort((left, right) => {
        const activeRank = (task: Task) => ['running', 'queued', 'waiting', 'needs_decision', 'draft', 'paused'].includes(task.status) ? 0 : 1
        return activeRank(left) - activeRank(right) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
      }).slice(0, 500)
      this.tasks = this.tasks.filter(task => keep.includes(task))
    }
    if (this.decisions.length > 500) {
      this.decisions = [...this.decisions].sort((left, right) => {
        const pendingRank = (decision: TaskDecision) => decision.status === 'pending' ? 0 : 1
        return pendingRank(left) - pendingRank(right) || Date.parse(right.createdAt) - Date.parse(left.createdAt)
      }).slice(0, 500)
    }
    if (this.runs.length > 1000) this.runs = this.runs.slice(-1000)
  }

  private chooseAgent(requested: TaskAgent | 'auto'): TaskAgent {
    if (requested !== 'auto') {
      const status = this.agentStatuses.find(item => item.agent === requested)
      if (this.agentsReady && status && !status.available) {
        throw new Error('未找到 ' + (requested === 'claude' ? 'Claude Code' : 'Codex') + ' CLI，请先安装并确认在 PATH 中')
      }
      return requested
    }
    const available = this.agentStatuses.filter(item => item.available).map(item => item.agent)
    if (available.includes(this.config.defaultAgent)) return this.config.defaultAgent
    if (available.length > 0) return available[0]
    return this.config.defaultAgent
  }

  async create(input: unknown): Promise<Task> {
    this.assertWritable()
    const request = normalizeTaskCreate(input)
    const cwd = await (this.deps.resolveDirectory ?? defaultResolveDirectory)(request.cwd)
    const agent = this.chooseAgent(request.agent)
    const now = this.nowIso()
    const task: Task = {
      id: this.newId(),
      title: request.title ?? normalizeTaskTitle(null, request.goal),
      goal: request.goal,
      repo: request.repo,
      name: normalizeTaskName(request.name, request.repo, cwd),
      cwd,
      agent,
      autonomy: request.autonomy,
      priority: request.priority,
      source: request.source,
      status: request.start ? 'queued' : 'draft',
      statusReason: request.start ? '已排队，等待执行' : '待确认执行范围',
      createdAt: now,
      updatedAt: now,
      rounds: 0,
      maxRuns: this.config.maxRunsPerTask,
      maxCostUsd: this.config.maxCostUsdPerTask,
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
      events: [{ at: now, kind: 'manual', detail: request.start ? '任务已创建并排队' : '任务已创建，等待确认范围' }],
      deliveredAt: null
    }
    if (task.title.length > TASK_MAX_TITLE_LENGTH) task.title = task.title.slice(0, TASK_MAX_TITLE_LENGTH)
    this.tasks.push(task)
    this.persist()
    this.emit(task.id, 'created')
    if (request.start) this.pump()
    return this.taskView(task)
  }

  async update(input: unknown): Promise<Task> {
    this.assertWritable()
    const patch = normalizeTaskUpdate(input)
    const task = this.requireTask(patch.id)
    if (!canEditTask(task)) throw new Error('任务正在运行，暂停后才能修改范围')
    if (patch.cwd !== undefined) {
      const cwd = await (this.deps.resolveDirectory ?? defaultResolveDirectory)(patch.cwd)
      if (cwdKey(cwd) !== cwdKey(task.cwd)) {
        task.cwd = cwd
        task.sessionId = null
        task.sessionAgent = null
      }
    }
    if (patch.goal !== undefined) task.goal = patch.goal
    if (patch.title !== undefined) task.title = patch.title
    if (patch.repo !== undefined) task.repo = patch.repo
    if (patch.name !== undefined) task.name = patch.name
    if (patch.agent !== undefined) {
      const agent = this.chooseAgent(patch.agent)
      if (agent !== task.agent) {
        task.agent = agent
        task.sessionId = null
        task.sessionAgent = null
      }
    }
    if (patch.autonomy !== undefined) task.autonomy = patch.autonomy
    if (patch.priority !== undefined) task.priority = patch.priority
    task.updatedAt = this.nowIso()
    task.events = appendTaskEvent(task, { at: task.updatedAt, kind: 'manual', detail: '任务范围已更新' })
    this.persist()
    this.emit(task.id, 'updated')
    return this.taskView(task)
  }

  startTask(id: string): Task {
    this.assertWritable()
    const task = this.requireTask(id)
    if (!canStartDraft(task)) {
      if (task.status === 'queued') return this.taskView(task)
      throw new Error('只有待确认范围的任务可以开始')
    }
    task.status = 'queued'
    task.statusReason = '已排队，等待执行'
    task.updatedAt = this.nowIso()
    task.events = appendTaskEvent(task, { at: task.updatedAt, kind: 'manual', detail: '用户确认范围并开始执行' })
    this.persist()
    this.emit(task.id, 'started')
    this.pump()
    return this.taskView(task)
  }

  pause(id: string): Task {
    this.assertWritable()
    const task = this.requireTask(id)
    if (!canPause(task)) throw new Error('这个任务当前不能暂停')
    const previous = task.status
    task.pausedFrom = previous
    task.status = 'paused'
    task.updatedAt = this.nowIso()
    if (previous === 'running') {
      task.statusReason = '已暂停，正在停止当前运行'
      const active = this.active.get(task.id)
      if (active) {
        active.pauseRequested = true
        active.controller.abort()
      }
    } else {
      task.statusReason = '已暂停；恢复前不会因事件自动执行'
      task.activeRunId = null
    }
    task.events = appendTaskEvent(task, { at: task.updatedAt, kind: 'manual', detail: '任务已暂停' })
    this.persist()
    this.emit(task.id, 'paused')
    return this.taskView(task)
  }

  resume(id: string): Task {
    this.assertWritable()
    const task = this.requireTask(id)
    if (!canResumePaused(task)) throw new Error('这个任务没有暂停')
    if (this.active.has(task.id)) throw new Error('上一轮还在停止中，请稍后再继续')
    const previous = task.pausedFrom
    task.pausedFrom = null
    task.updatedAt = this.nowIso()
    if (previous === 'waiting' && task.wait && task.wait.firedAt === null) {
      task.status = 'waiting'
      task.statusReason = '已恢复，继续等待事件'
    } else if (previous === 'needs_decision' && task.decisionId) {
      const decision = this.findDecision(task.decisionId)
      if (decision && decision.status === 'pending') {
        task.status = 'needs_decision'
        task.statusReason = '已恢复，继续等待你的决定'
      } else {
        task.status = 'queued'
        task.statusReason = '决定已失效，重新评估任务'
      }
    } else {
      task.status = 'queued'
      task.statusReason = '已恢复，等待执行'
    }
    task.events = appendTaskEvent(task, { at: task.updatedAt, kind: 'manual', detail: '任务已恢复' })
    this.persist()
    this.emit(task.id, 'resumed')
    this.pump()
    return this.taskView(task)
  }

  cancel(id: string): Task {
    this.assertWritable()
    const task = this.requireTask(id)
    if (!canCancel(task)) throw new Error('这个任务当前不能取消')
    const now = this.nowIso()
    if (task.decisionId) {
      const decision = this.findDecision(task.decisionId)
      if (decision && decision.status === 'pending') {
        decision.status = 'cancelled'
        decision.answeredAt = now
      }
      task.decisionId = null
    }
    const active = this.active.get(task.id)
    if (active) {
      active.cancelRequested = true
      active.controller.abort()
      task.status = 'cancelled'
      task.statusReason = '已取消，正在停止当前运行'
    } else {
      task.status = 'cancelled'
      task.statusReason = '已取消'
      task.activeRunId = null
      task.wait = null
      task.nextAttemptAt = null
    }
    task.updatedAt = now
    task.events = appendTaskEvent(task, { at: now, kind: 'manual', detail: '任务已取消' })
    this.persist()
    this.emit(task.id, 'cancelled')
    return this.taskView(task)
  }

  retry(id: string): Task {
    this.assertWritable()
    const task = this.requireTask(id)
    if (!canRetry(task)) throw new Error('这个任务当前不能重新执行')
    task.status = 'queued'
    task.statusReason = '已重新排队；继续前先核对工作目录真实现场'
    task.failureCount = 0
    task.nextAttemptAt = null
    task.lastError = null
    task.continuation = this.manualContinuation('重新执行', '上一次运行未正常结束。继续前先核对工作目录中的真实现场，避免重复有副作用的操作。')
    task.updatedAt = this.nowIso()
    task.events = appendTaskEvent(task, { at: task.updatedAt, kind: 'manual', detail: '用户要求重新执行' })
    this.persist()
    this.emit(task.id, 'retried')
    this.pump()
    return this.taskView(task)
  }

  accept(id: string, note?: unknown): Task {
    this.assertWritable()
    const task = this.requireTask(id)
    if (!canAccept(task)) throw new Error('只有待验收的任务可以验收')
    const textValue = typeof note === 'string' ? note.trim().slice(0, 2_000) : null
    const now = this.nowIso()
    task.status = 'done'
    task.statusReason = '已由你验收通过'
    task.acceptance = { status: 'accepted', note: textValue || null, at: now }
    task.deliveredAt = now
    task.updatedAt = now
    task.events = appendTaskEvent(task, { at: now, kind: 'manual', detail: '用户验收通过' })
    this.persist()
    this.emit(task.id, 'accepted')
    return this.taskView(task)
  }

  reopen(id: string, feedback?: unknown): Task {
    this.assertWritable()
    const task = this.requireTask(id)
    if (!['ready', 'done', 'failed'].includes(task.status)) throw new Error('这个任务当前不能提交反馈')
    const note = feedback === undefined || feedback === null || feedback === '' ? null : normalizeFeedback(feedback)
    if (note) task.feedback = [...task.feedback, note].slice(-20)
    task.status = 'queued'
    task.statusReason = note ? '已收到反馈，继续修改原任务' : '继续原任务'
    task.acceptance = { status: 'rework', note, at: this.nowIso() }
    task.failureCount = 0
    task.nextAttemptAt = null
    task.lastError = null
    task.continuation = this.manualContinuation(
      note ? '用户反馈返修' : '继续原任务',
      note ?? '用户要求继续原任务；先核对现场再继续。'
    )
    task.updatedAt = this.nowIso()
    task.events = appendTaskEvent(task, { at: task.updatedAt, kind: 'manual', detail: note ? '用户提交反馈，继续修改' : '用户要求继续任务' })
    this.persist()
    this.emit(task.id, 'reopened')
    this.pump()
    return this.taskView(task)
  }

  replyDecision(input: unknown): Task {
    this.assertWritable()
    const reply = normalizeDecisionReply(input)
    const decision = this.findDecision(reply.decisionId)
    if (!decision) throw new Error('找不到这个决定')
    const now = this.now()
    if (decision.status === 'answered') throw new Error('这个决定已经回复过了')
    if (decision.status === 'expired' || Date.parse(decision.expiresAt) <= now.getTime()) {
      if (decision.status === 'pending') {
        decision.status = 'expired'
        decision.answeredAt = now.toISOString()
        this.persist()
      }
      throw new Error('这个决定已过期，请让 Agent 重新确认')
    }
    if (decision.status !== 'pending') throw new Error('这个决定已失效')
    const task = this.requireTask(decision.taskId)
    if (task.status !== 'needs_decision' || task.decisionId !== decision.id) {
      throw new Error('这个决定已不是任务当前等待的请求，请刷新后重试')
    }
    const option = decision.options.find(item => item.id === reply.optionId)
    if (!option) throw new Error('决定选项无效')
    const at = now.toISOString()
    decision.status = 'answered'
    decision.answeredAt = at
    decision.answer = { optionId: option.id, note: reply.note ?? null }
    task.decisionId = null
    task.status = 'queued'
    task.statusReason = '已收到你的决定，继续执行'
    task.continuation = {
      kind: 'decision',
      title: '用户决定',
      detail: '问题：' + decision.question + '\n选择：' + option.label + (reply.note ? '\n补充说明：' + reply.note : '')
    }
    task.updatedAt = at
    task.events = appendTaskEvent(task, { at, kind: 'decision', detail: '用户选择：' + option.label })
    this.persist()
    this.emit(task.id, 'decision-answered')
    this.pump()
    return this.taskView(task)
  }

  async refreshEvents(force = false): Promise<TaskSnapshot> {
    this.assertWritable()
    await this.tick(force)
    return this.snapshot()
  }

  async updateConfig(input: unknown): Promise<TaskEngineConfig> {
    this.assertWritable()
    this.config = normalizeEngineConfig(input, this.config)
    this.persist()
    this.emit(null, 'config')
    this.pump()
    return { ...this.config }
  }

  setGithubAuth(ready: boolean): void {
    this.githubAuth = ready ? 'ready' : 'missing'
  }

  deleteTask(id: string): void {
    this.assertWritable()
    const task = this.requireTask(id)
    if (task.status === 'running') throw new Error('运行中的任务不能删除，请先暂停或取消')
    this.tasks = this.tasks.filter(item => item.id !== id)
    this.decisions = this.decisions.filter(item => item.taskId !== id)
    const taskRuns = this.runs.filter(item => item.taskId === id)
    this.runs = this.runs.filter(item => item.taskId !== id)
    for (const run of taskRuns) {
      try { rmSync(path.join(this.runsDir, run.id + '.log'), { force: true }) } catch { /* log may be gone */ }
    }
    this.persist()
    this.emit(id, 'deleted')
  }

  snapshot(): TaskSnapshot {
    if (this.fatal) {
      return {
        tasks: [], decisions: [], config: this.config, agents: [], agentsReady: false,
        counts: countTasks([], []), now: this.nowIso(), githubReady: false, engineError: this.engineError
      }
    }
    return {
      tasks: this.tasks.map(task => this.taskView(task)).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
      decisions: this.decisions.filter(item => item.status === 'pending').map(item => ({ ...item })),
      config: { ...this.config },
      agents: this.agentStatuses.map(item => ({ ...item })),
      agentsReady: this.agentsReady,
      counts: countTasks(this.tasks, this.decisions),
      now: this.nowIso(),
      githubReady: this.githubAuth === 'ready',
      engineError: this.engineError
    }
  }

  detail(id: string): TaskDetail {
    if (this.fatal) throw new Error(this.engineError ?? '任务数据不可用')
    const task = this.requireTask(id)
    const taskRuns = this.runs.filter(item => item.taskId === id)
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .slice(0, 50)
      .map(run => this.runView(run))
    const view = this.taskView(task)
    view.result = view.result
      ? {
          ...view.result,
          artifacts: view.result.artifacts.map(artifact => ({
            ...artifact,
            exists: artifact.path ? existsSync(artifact.path) : null
          }))
        }
      : null
    const decisions = this.decisions.filter(item => item.taskId === id)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, 20)
      .map(item => ({ ...item }))
    return {
      task: view,
      runs: taskRuns,
      decisions,
      nextRunAt: this.nextRunAtFor(task)
    }
  }

  private nextRunAtFor(task: Task): string | null {
    if (task.status === 'queued' && task.nextAttemptAt) return task.nextAttemptAt
    if (task.status === 'waiting' && task.wait) return task.wait.until ?? task.wait.lastCheckedAt
    return null
  }

  private taskView(task: Task): Task {
    return structuredClone(task)
  }

  private runView(run: TaskRun): TaskRunView {
    return { ...structuredClone(run), logTail: this.readLogTail(run.id) }
  }

  private readLogTail(runId: string): string {
    try {
      const file = path.join(this.runsDir, runId + '.log')
      const info = statSync(file)
      const start = Math.max(0, info.size - TASK_LOG_TAIL_BYTES)
      const content = readFileSync(file)
      return content.subarray(start).toString('utf8')
    } catch {
      return ''
    }
  }

  private newId(): string {
    const value = this.makeId()
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new Error('任务编号生成失败')
    }
    return value.toLowerCase()
  }

  private manualContinuation(title: string, detail: string): TaskContinuation {
    return { kind: 'manual', title, detail }
  }

  private agentStatus(agent: TaskAgent): TaskAgentStatus | null {
    return this.agentStatuses.find(item => item.agent === agent) ?? null
  }

  private repairOnBoot(): void {
    if (this.fatal || this.tasks.length === 0 && this.runs.length === 0 && this.decisions.length === 0) return
    const now = this.nowIso()
    let changed = false
    for (const decision of this.decisions) {
      if (decision.status !== 'pending') continue
      if (Date.parse(decision.expiresAt) <= this.now().getTime()) {
        decision.status = 'expired'
        decision.answeredAt = now
        changed = true
      }
    }
    for (const run of this.runs) {
      if (run.status !== 'running') continue
      run.status = 'interrupted'
      run.endedAt = now
      run.error = '上次应用退出或异常结束时，这一轮没有正常结束'
      changed = true
    }
    for (const task of this.tasks) {
      if (task.status === 'running') {
        task.status = 'paused'
        task.pausedFrom = 'running'
        task.statusReason = '上次运行异常中断；请先核对工作目录真实现场，再继续'
        task.activeRunId = null
        task.events = appendTaskEvent(task, { at: now, kind: 'run', detail: '启动恢复：上次运行中断，任务已暂停' })
        changed = true
      }
      if (task.activeRunId) {
        const run = this.runs.find(item => item.id === task.activeRunId)
        if (!run || run.status !== 'running') {
          task.activeRunId = null
          changed = true
        }
      }
      if (task.status === 'needs_decision') {
        const decision = task.decisionId ? this.findDecision(task.decisionId) : null
        if (!decision || decision.status === 'expired' || decision.status === 'cancelled') {
          task.status = 'failed'
          task.statusReason = '决定请求已失效，任务停止，需要重新开始'
          task.decisionId = null
          task.lastError = '决定请求已失效'
          task.events = appendTaskEvent(task, { at: now, kind: 'decision', detail: '启动恢复：决定请求已失效' })
          changed = true
        } else if (decision.status === 'answered') {
          task.status = 'queued'
          task.statusReason = '启动恢复：决定已回复，继续执行'
          task.decisionId = null
          task.continuation = {
            kind: 'decision',
            title: '用户决定',
            detail: '问题：' + decision.question + '\n选择：' + (decision.answer?.optionId ?? '')
          }
          task.events = appendTaskEvent(task, { at: now, kind: 'decision', detail: '启动恢复：决定已回复，重新排队' })
          changed = true
        }
      }
      if (task.status === 'waiting' && task.wait?.firedAt) {
        task.status = 'queued'
        task.statusReason = '启动恢复：等待事件已触发，继续执行'
        task.wait = null
        changed = true
      }
      if (task.status === 'waiting' && !task.wait) {
        task.status = 'failed'
        task.statusReason = '等待事件丢失，任务停止，请重新开始'
        task.lastError = '等待事件丢失'
        changed = true
      }
    }
    if (changed) {
      this.persist()
      this.deps.log?.('任务状态已在启动时修复')
    }
  }

  private async tick(forceGithub: boolean): Promise<void> {
    if (this.fatal || this.closed || this.tickBusy) return
    this.tickBusy = true
    try {
      const now = this.now()
      const at = now.toISOString()
      let changed = false
      for (const decision of this.decisions) {
        if (decision.status !== 'pending' || Date.parse(decision.expiresAt) > now.getTime()) continue
        decision.status = 'expired'
        decision.answeredAt = at
        changed = true
        const task = this.tasks.find(item => item.id === decision.taskId)
        if (task && task.status === 'needs_decision' && task.decisionId === decision.id) {
          task.status = 'failed'
          task.statusReason = '决定请求已过期，任务停止，需要重新开始'
          task.decisionId = null
          task.lastError = '决定请求已过期'
          task.updatedAt = at
          task.events = appendTaskEvent(task, { at: task.updatedAt, kind: 'decision', detail: '决定请求已过期' })
        }
      }
      for (const task of this.tasks) {
        if (task.status !== 'needs_decision') continue
        const decision = task.decisionId ? this.findDecision(task.decisionId) : null
        if (decision && decision.status === 'pending') continue
        task.status = 'failed'
        task.statusReason = '决定请求已失效，任务停止，请重新开始'
        task.decisionId = null
        task.lastError = '决定请求已失效'
        task.updatedAt = at
        task.events = appendTaskEvent(task, { at, kind: 'decision', detail: '决定请求已失效' })
        changed = true
      }
      for (const task of this.tasks) {
        if (task.status !== 'waiting' || !task.wait || task.wait.firedAt) continue
        if (waitExpired(task.wait, now)) {
          this.failWait(task, now, '等待超过 ' + Math.round((Date.parse(task.wait.timeoutAt) - Date.parse(task.wait.createdAt)) / 3_600_000) + ' 小时仍未完成')
          changed = true
          continue
        }
        if (timerDue(task.wait, now)) {
          this.fireWait(task, now, '定时提醒到期', this.timerDetail(task.wait))
          changed = true
        }
      }
      if (changed) this.persist()
      this.pump()
      const githubWaits = this.tasks.some(task => task.status === 'waiting' && isGithubWait(task.wait))
      if (githubWaits && (forceGithub || now.getTime() - this.lastGithubPollAt >= GITHUB_POLL_MS)
        && (forceGithub || now.getTime() >= this.githubBackoffUntil)) {
        if (forceGithub) await this.pollGithub(now)
        else void this.pollGithub(now)
      }
    } finally {
      this.tickBusy = false
    }
  }

  private timerDetail(wait: TaskWait): string {
    return wait.reason + (wait.until ? '（原定 ' + wait.until + '）' : '')
  }

  private fireWait(task: Task, now: Date, title: string, detail: string): void {
    const wait = task.wait
    if (!wait) return
    const at = now.toISOString()
    wait.firedAt = at
    wait.firedDetail = detail
    wait.lastCheckedAt = at
    task.wait = null
    task.status = 'queued'
    task.statusReason = '事件已触发，等待执行'
    task.nextAttemptAt = null
    task.continuation = { kind: 'event', title, detail }
    task.updatedAt = at
    task.events = appendTaskEvent(task, { at, kind: wait.type, detail: title + '：' + detail })
    this.emit(task.id, 'event-fired')
  }

  private failWait(task: Task, now: Date, reason: string): void {
    const wait = task.wait
    const at = now.toISOString()
    task.wait = null
    task.status = 'failed'
    task.statusReason = reason
    task.lastError = reason
    task.updatedAt = at
    task.events = appendTaskEvent(task, { at, kind: wait?.type ?? 'manual', detail: '等待失败：' + reason + (wait?.lastError ? '；' + wait.lastError : '') })
    this.notify('Arckeep 任务等待失败', task.title + '：' + reason, task.id)
  }

  private async pollGithub(now: Date): Promise<void> {
    if (this.pollBusy || this.closed || this.fatal) return
    const waiting = this.tasks.filter(task => task.status === 'waiting' && isGithubWait(task.wait))
    if (waiting.length === 0) return
    this.pollBusy = true
    this.lastGithubPollAt = now.getTime()
    let changed = false
    try {
      let token: string | null = null
      try {
        token = this.deps.getGithubToken ? await this.deps.getGithubToken() : null
      } catch (error) {
        this.deps.log?.('读取 GitHub 认证失败：' + (error instanceof Error ? error.message : String(error)))
      }
      if (!token) {
        this.githubAuth = 'missing'
        for (const task of waiting) {
          if (task.wait) {
            task.wait.lastCheckedAt = this.nowIso()
            task.wait.lastError = '未配置 GitHub 认证，无法查询 PR/CI'
            changed = true
          }
        }
        return
      }
      this.githubAuth = 'ready'
      for (const task of waiting) {
        if (this.closed) break
        const current = this.tasks.find(item => item.id === task.id)
        if (!current || current.status !== 'waiting' || !isGithubWait(current.wait)) continue
        const wait = current.wait
        try {
          const observation = await this.observeGithub(wait, { token, fetchImpl: this.deps.fetchImpl })
          const fresh = this.tasks.find(item => item.id === task.id)
          if (!fresh || fresh.status !== 'waiting' || fresh.wait !== wait) continue
          const decision = githubWaitDecision(wait, observation)
          wait.lastCheckedAt = this.nowIso()
          wait.lastError = null
          if (decision.state) wait.lastState = decision.state
          changed = true
          if (decision.fire) {
            this.fireWait(fresh, this.now(), 'GitHub 事件已变化', decision.detail)
            this.persist()
            this.emit(fresh.id, 'github-fired')
            this.pump()
          }
        } catch (error) {
          const fresh = this.tasks.find(item => item.id === task.id)
          if (!fresh || fresh.status !== 'waiting' || !fresh.wait) continue
          fresh.wait.lastCheckedAt = this.nowIso()
          fresh.wait.lastError = error instanceof Error ? error.message : 'GitHub 事件查询失败'
          changed = true
          if (typeof error === 'object' && error !== null && 'retryAfterMs' in error) {
            const retry = Number((error as { retryAfterMs?: unknown }).retryAfterMs)
            if (Number.isFinite(retry) && retry > 0) this.githubBackoffUntil = Date.now() + retry
          }
        }
      }
    } finally {
      this.pollBusy = false
      if (changed) {
        this.persistQuiet()
        this.emit(null, 'github-poll')
      }
    }
  }

  private pump(): void {
    if (this.closed || this.fatal || !this.agentsReady) return
    const selected = nextTasksToStart(this.tasks, this.config, this.now())
    for (const id of selected) {
      const task = this.tasks.find(item => item.id === id)
      if (task) this.startRun(task)
    }
  }

  private checkLimits(task: Task): string | null {
    if (task.rounds >= task.maxRuns) return '已达到运行轮次上限（' + task.maxRuns + ' 轮），任务停止'
    if (task.maxCostUsd > 0 && task.costUsd >= task.maxCostUsd) {
      return '已达到任务费用上限（$' + task.maxCostUsd.toFixed(2) + '），任务停止'
    }
    return null
  }

  private startRun(task: Task): void {
    if (this.closed || task.status !== 'queued' || task.activeRunId) return
    if (!this.agentsReady) return
    const status = this.agentStatus(task.agent)
    if (!status || !status.available || !status.command) {
      this.failTask(task, '未找到 ' + (task.agent === 'claude' ? 'Claude Code' : 'Codex') + ' CLI，请先安装并确认在 PATH 中', 'manual')
      return
    }
    const limit = this.checkLimits(task)
    if (limit) {
      this.failTask(task, limit, 'manual')
      return
    }

    const runId = this.newId()
    const resume = Boolean(task.sessionId && task.sessionAgent === task.agent)
    const sessionId = resume && task.sessionId ? task.sessionId : task.agent === 'claude' ? this.newId() : null
    const now = this.nowIso()
    task.rounds += 1
    task.status = 'running'
    task.statusReason = '执行中（第 ' + task.rounds + ' 轮）'
    task.activeRunId = runId
    task.lastRunId = runId
    task.nextAttemptAt = null
    task.updatedAt = now
    const run: TaskRun = {
      id: runId,
      taskId: task.id,
      round: task.rounds,
      agent: task.agent,
      autonomy: task.autonomy,
      sessionId,
      resume,
      startedAt: now,
      endedAt: null,
      status: 'running',
      exitCode: null,
      summary: null,
      protocolStatus: null,
      error: null,
      usage: { costUsd: null, inputTokens: null, outputTokens: null },
      logFile: path.join(this.runsDir, runId + '.log'),
      progress: null
    }
    this.runs.push(run)
    task.events = appendTaskEvent(task, { at: now, kind: 'run', detail: '开始第 ' + task.rounds + ' 轮（' + (task.agent === 'claude' ? 'Claude Code' : 'Codex') + '）' })

    const continuation = buildContinuationContext({
      feedback: null,
      event: task.continuation?.kind === 'event' ? { title: task.continuation.title, detail: task.continuation.detail } : null,
      decisionAnswer: task.continuation?.kind === 'decision'
        ? this.decisionAnswerContext(task.continuation.detail)
        : null
    })
    const prompt = buildTaskPrompt(task, this.runsDir, continuation)
    this.persist()
    this.emit(task.id, 'run-started')

    const controller = new AbortController()
    const active: ActiveRun = {
      runId,
      controller,
      pauseRequested: false,
      cancelRequested: false,
      lastProgressEmit: 0
    }
    this.active.set(task.id, active)
    const invocation = buildInvocation({
      agent: task.agent,
      file: status.command,
      sessionId: sessionId ?? '',
      resume,
      autonomy: task.autonomy,
      prompt,
      shell: commandNeedsShell(status.command)
    })
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.deps.env,
      ARCKEEP_TASK_ID: task.id,
      ARCKEEP_RUN_ID: runId,
      ARCKEEP_WORKDIR: task.cwd,
      NO_COLOR: '1',
      FORCE_COLOR: '0'
    }
    delete env.ELECTRON_RUN_AS_NODE
    void this.runAgent({
      invocation,
      cwd: task.cwd,
      logFile: run.logFile,
      timeoutMs: this.config.runTimeoutMinutes * 60_000,
      signal: controller.signal,
      env,
      onProgress: line => {
        const live = this.runs.find(item => item.id === runId)
        if (!live || live.status !== 'running') return
        live.progress = truncate(line, 280)
        const current = Date.now()
        if (current - active.lastProgressEmit >= 1_500) {
          active.lastProgressEmit = current
          this.emit(task.id, 'run-progress')
        }
      }
    }).then(result => this.finishRun(task.id, runId, result)).catch(error => {
      this.finishRun(task.id, runId, {
        code: null,
        signal: null,
        timedOut: false,
        aborted: true,
        spawnError: error instanceof Error ? error.message : 'Agent 运行失败',
        stdout: '',
        stderr: '',
        producedOutput: false,
        durationMs: 0
      })
    })
  }

  private decisionAnswerContext(detail: string): { question: string, option: string, note: string | null } {
    const question = /(?:^|\n)问题：(.*?)(?:\n|$)/.exec(detail)?.[1]?.trim() ?? '之前的问题'
    const option = /(?:^|\n)选择：(.*?)(?:\n|$)/.exec(detail)?.[1]?.trim() ?? '已选择'
    const note = /(?:^|\n)补充说明：(.*?)(?:\n|$)/.exec(detail)?.[1]?.trim() ?? null
    return { question, option, note }
  }

  private finishRun(taskId: string, runId: string, result: AgentProcessResult): void {
    const active = this.active.get(taskId)
    if (active && active.runId !== runId) return
    this.active.delete(taskId)
    const task = this.tasks.find(item => item.id === taskId)
    const run = this.runs.find(item => item.id === runId)
    if (!task || !run) return
    const now = this.now()
    const at = now.toISOString()
    const parsed: ParsedAgentOutput = run.agent === 'claude'
      ? parseClaudeStream(result.stdout)
      : parseCodexStream(result.stdout)
    run.endedAt = at
    run.exitCode = result.code
    run.usage = parsed.usage
    run.progress = null
    task.activeRunId = null
    if (parsed.sessionId) {
      task.sessionId = parsed.sessionId
      task.sessionAgent = run.agent
      run.sessionId = parsed.sessionId
    } else if (task.agent === 'claude' && run.sessionId && (result.code === 0 || result.timedOut)) {
      task.sessionId = run.sessionId
      task.sessionAgent = 'claude'
    }
    if (parsed.usage.costUsd !== null) task.costUsd += parsed.usage.costUsd
    if (parsed.usage.inputTokens !== null) task.inputTokens += parsed.usage.inputTokens
    if (parsed.usage.outputTokens !== null) task.outputTokens += parsed.usage.outputTokens
    task.updatedAt = at

    const abortedByUser = active?.cancelRequested === true || task.status === 'cancelled'
    const pausedByUser = active?.pauseRequested === true || task.status === 'paused'
    if (abortedByUser) {
      run.status = 'aborted'
      run.error = '用户取消'
      run.summary = '本轮已取消'
      task.status = 'cancelled'
      task.statusReason = '已取消'
      task.continuation = null
      task.events = appendTaskEvent(task, { at, kind: 'run', detail: '第 ' + run.round + ' 轮已取消' })
      this.persist()
      this.emit(task.id, 'run-finished')
      this.pump()
      return
    }
    if (pausedByUser) {
      run.status = 'aborted'
      run.error = '用户暂停'
      run.summary = '本轮已暂停'
      if (task.status !== 'paused') {
        task.status = 'paused'
        task.pausedFrom = 'running'
      }
      task.statusReason = '已暂停；恢复时先核对现场'
      task.continuation = null
      task.events = appendTaskEvent(task, { at, kind: 'run', detail: '第 ' + run.round + ' 轮因暂停中止' })
      this.persist()
      this.emit(task.id, 'run-finished')
      return
    }
    if (this.closed || result.aborted) {
      run.status = 'interrupted'
      run.error = '应用退出或运行被中断'
      task.status = 'paused'
      task.pausedFrom = 'running'
      task.statusReason = '应用退出时运行被中断，请核对现场后继续'
      task.continuation = this.manualContinuation('运行中断', '上次运行被中断，可能留下了部分改动。继续前先核对工作目录真实现场，避免重复写入。')
      task.events = appendTaskEvent(task, { at, kind: 'run', detail: '第 ' + run.round + ' 轮被中断' })
      this.persistQuiet()
      return
    }

    const protocol = parseAgentProtocol(parsed.finalText, { runId, cwd: task.cwd, now })
    const storedResult: NonNullable<Task['result']> = {
      runId,
      receivedAt: at,
      summary: protocol.summary,
      protocolStatus: protocol.status,
      artifacts: protocol.artifacts,
      checks: protocol.checks,
      unverified: protocol.unverified,
      protocolWarning: protocol.warning
    }
    task.result = storedResult
    run.protocolStatus = protocol.status
    run.summary = protocol.summary || null

    const stderrTail = result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ').slice(0, 600)
    const processError = result.spawnError
      ?? (result.timedOut ? '运行超过 ' + this.config.runTimeoutMinutes + ' 分钟，已停止；可能有未完成的写入，继续前先核对现场' : null)
      ?? parsed.error
      ?? (result.code !== null && result.code !== 0
        ? 'Agent 退出码 ' + String(result.code) + (stderrTail ? '：' + stderrTail : '')
        : null)

    if (processError) {
      run.status = 'failed'
      run.error = processError.slice(0, 2_000)
      task.lastError = run.error
      task.failureCount += 1
      const startupFailure = isStartupFailure({
        status: 'failed',
        sessionId: parsed.sessionId,
        durationMs: result.durationMs,
        producedOutput: result.producedOutput
      })
      const retryable = !result.timedOut && !task.sessionId && startupFailure && task.failureCount <= this.config.retries
      task.continuation = this.manualContinuation('上次运行失败', '上次运行报错：' + run.error + '。继续前先核对现场，避免重复写入。')
      if (retryable) {
        const delay = retryDelayMs(task.failureCount)
        task.status = 'queued'
        task.nextAttemptAt = new Date(now.getTime() + delay).toISOString()
        task.statusReason = '启动失败，' + Math.round(delay / 60_000) + ' 分钟后自动重试（第 ' + task.failureCount + ' 次）'
        run.summary = '启动失败，等待自动重试'
      } else {
        task.status = 'failed'
        task.statusReason = run.error
        this.notify('Arckeep 任务失败', task.title + '：' + run.error, task.id)
      }
      task.events = appendTaskEvent(task, { at, kind: 'run', detail: '第 ' + run.round + ' 轮失败：' + run.error })
      this.persist()
      this.emit(task.id, 'run-finished')
      this.pump()
      return
    }

    if (protocol.status === 'failed') {
      run.status = 'failed'
      run.error = protocol.summary || 'Agent 报告本轮失败'
      task.status = 'failed'
      task.statusReason = protocol.summary || 'Agent 报告本轮失败'
      task.lastError = run.error
      task.failureCount += 1
      task.continuation = this.manualContinuation('上次运行失败', '上次运行报错：' + run.error + '。继续前先核对现场。')
      task.events = appendTaskEvent(task, { at, kind: 'run', detail: '第 ' + run.round + ' 轮失败：' + run.error })
      this.notify('Arckeep 任务失败', task.title + '：' + run.error, task.id)
      this.persist()
      this.emit(task.id, 'run-finished')
      this.pump()
      return
    }

    task.failureCount = 0
    task.lastError = null
    if (protocol.status === 'waiting' && protocol.wait) {
      run.status = 'completed'
      const wait: TaskWait = {
        type: protocol.wait.type,
        reason: protocol.wait.reason || '等待外部事件',
        until: protocol.wait.until,
        repo: protocol.wait.repo,
        pr: protocol.wait.pr,
        createdAt: at,
        timeoutAt: defaultWaitTimeout(now),
        lastCheckedAt: null,
        lastState: null,
        lastError: null,
        firedAt: null,
        firedDetail: null
      }
      task.wait = wait
      task.status = 'waiting'
      task.statusReason = '等待：' + wait.reason
      task.continuation = null
      task.events = appendTaskEvent(task, { at, kind: 'run', detail: '第 ' + run.round + ' 轮结束，等待：' + wait.reason })
    } else if (protocol.status === 'needs_decision' && protocol.decision) {
      run.status = 'completed'
      try {
        const expiresAt = protocol.decision.expiresAt && Date.parse(protocol.decision.expiresAt) > now.getTime()
          ? new Date(Math.min(Date.parse(protocol.decision.expiresAt), now.getTime() + 30 * 24 * 3_600_000)).toISOString()
          : defaultDecisionExpiry(now)
        const decision: TaskDecision = {
          id: this.newId(),
          taskId: task.id,
          runId,
          question: protocol.decision.question,
          whyYou: protocol.decision.whyYou,
          recommendation: protocol.decision.recommendation,
          options: protocol.decision.options,
          createdAt: at,
          expiresAt,
          status: 'pending',
          answeredAt: null,
          answer: null
        }
        this.decisions.push(decision)
        task.decisionId = decision.id
        task.status = 'needs_decision'
        task.statusReason = '需要你决定：' + decision.question
        task.continuation = null
        task.events = appendTaskEvent(task, { at, kind: 'decision', detail: '第 ' + run.round + ' 轮请求决定：' + decision.question })
        this.notify('Arckeep 需要你决定', task.title + '：' + decision.question, task.id)
      } catch (error) {
        run.status = 'completed'
        task.status = 'ready'
        task.statusReason = '执行结束，但决定请求格式无效，请核对结果'
        task.result = {
          ...storedResult,
          protocolWarning: [storedResult.protocolWarning, error instanceof Error ? error.message : '决定请求无效'].filter(Boolean).join('；')
        }
        task.continuation = null
        this.notify('Arckeep 任务待验收', task.title, task.id)
      }
    } else {
      run.status = 'completed'
      task.status = 'ready'
      task.statusReason = protocol.status === 'unknown'
        ? '执行结束，但缺少结构化结果，请核对后再验收'
        : '执行结束，待你验收'
      task.continuation = null
      task.events = appendTaskEvent(task, { at, kind: 'run', detail: '第 ' + run.round + ' 轮结束，待验收' })
      this.notify('Arckeep 任务待验收', task.title, task.id)
    }
    this.persist()
    this.emit(task.id, 'run-finished')
    this.pump()
  }

  private failTask(task: Task, reason: string, kind: 'manual' | 'run'): void {
    const at = this.nowIso()
    task.status = 'failed'
    task.statusReason = reason
    task.lastError = reason
    task.activeRunId = null
    task.updatedAt = at
    task.events = appendTaskEvent(task, { at, kind, detail: reason })
    this.persist()
    this.emit(task.id, 'failed')
    this.notify('Arckeep 任务失败', task.title + '：' + reason, task.id)
  }
}
