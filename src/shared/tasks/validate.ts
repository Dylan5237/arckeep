import {
  TASK_DECISION_TIMEOUT_HOURS,
  TASK_DEFAULT_MAX_COST_USD,
  TASK_DEFAULT_MAX_RUNS,
  TASK_DEFAULT_RETRIES,
  TASK_DEFAULT_RUN_TIMEOUT_MINUTES,
  TASK_LOG_TAIL_BYTES,
  TASK_MAX_ARTIFACTS,
  TASK_MAX_CHECKS,
  TASK_MAX_CONCURRENT,
  TASK_MAX_FEEDBACK_LENGTH,
  TASK_MAX_GOAL_LENGTH,
  TASK_MAX_TITLE_LENGTH,
  TASK_WAIT_TIMEOUT_HOURS,
  isTaskAgent,
  type CheckStatus,
  type DecisionStatus,
  type RunStatus,
  type Task,
  type TaskAcceptance,
  type TaskAgent,
  type TaskArtifact,
  type TaskAutonomy,
  type TaskCheck,
  type TaskContinuation,
  type TaskCreateInput,
  type TaskDecision,
  type TaskDecisionOption,
  type TaskDecisionReplyInput,
  type TaskEngineConfig,
  type TaskEventRecord,
  type TaskPriority,
  type TaskResult,
  type TaskRun,
  type TaskSource,
  type TaskStatus,
  type TaskUpdateInput,
  type TaskUsage,
  type TaskWait,
  type TaskWaitType
} from './types.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/
const OPTION_PATTERN = /^[A-Za-z0-9_-]{1,20}$/
const MAX_SUMMARY = 8_000
const MAX_TEXT = 4_000
const MAX_UNVERIFIED = 20
const MAX_EVENTS = 30
const MAX_FEEDBACK = 20
const MAX_DECISIONS_IN_FILE = 500
const MAX_TASKS_IN_FILE = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(input: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof input !== 'string') throw new Error(`${label}无效`)
  const value = input.trim()
  if (!allowEmpty && value.length === 0) throw new Error(`${label}不能为空`)
  if (value.length > max) throw new Error(`${label}不能超过 ${max} 个字符`)
  return value
}

function iso(input: unknown, label: string): string {
  if (typeof input !== 'string' || !Number.isFinite(Date.parse(input))) throw new Error(`${label}无效`)
  return new Date(input).toISOString()
}

function nullableIso(input: unknown, label: string): string | null {
  if (input === null || input === undefined) return null
  return iso(input, label)
}

export function normalizeTaskId(input: unknown): string {
  if (typeof input !== 'string' || !UUID_PATTERN.test(input)) throw new Error('任务编号无效')
  return input.toLowerCase()
}

export function normalizeTaskRepo(input: unknown): string | null {
  if (input === null || input === undefined || input === '') return null
  if (typeof input !== 'string') throw new Error('仓库标识无效')
  const value = input.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  if (!REPO_PATTERN.test(value)) throw new Error('仓库标识应为 owner/repo')
  return value
}

export function normalizeTaskCwd(input: unknown): string {
  if (typeof input !== 'string') throw new Error('工作目录无效')
  const value = input.trim().replace(/^"|"$/g, '')
  if (value.length === 0 || value.length > 2000) throw new Error('工作目录无效')
  if (value.includes('\0')) throw new Error('工作目录无效')
  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\/.test(value)
  const posixAbsolute = value.startsWith('/')
  if (!windowsAbsolute && !posixAbsolute) throw new Error('工作目录必须是绝对路径')
  return value
}

export function normalizeTaskTitle(input: unknown, goal: string): string {
  const fallback = goal.split(/\r?\n/, 1)[0]?.replace(/^[#>*\s-]+/, '').trim().slice(0, TASK_MAX_TITLE_LENGTH)
  if (input === null || input === undefined || input === '') return fallback || '未命名任务'
  return text(input, '任务标题', TASK_MAX_TITLE_LENGTH)
}

export function normalizeTaskGoal(input: unknown): string {
  return text(input, '任务目标', TASK_MAX_GOAL_LENGTH)
}

export function normalizeTaskAgent(input: unknown): TaskAgent {
  if (!isTaskAgent(input)) throw new Error('Agent 选择无效')
  return input
}

export function normalizeTaskAutonomy(input: unknown): TaskAutonomy {
  if (input !== 'read-only' && input !== 'edit' && input !== 'full') throw new Error('授权范围无效')
  return input
}

export function normalizeTaskPriority(input: unknown): TaskPriority {
  if (input !== 'high' && input !== 'normal' && input !== 'low') throw new Error('优先级无效')
  return input
}

export function normalizeTaskSource(input: unknown): TaskSource {
  if (input !== 'manual' && input !== 'idea' && input !== 'todo' && input !== 'waiting') throw new Error('任务来源无效')
  return input
}

export function normalizeTaskName(input: unknown, repo: string | null, cwd: string): string {
  if (input === null || input === undefined || input === '') {
    return repo?.split('/')[1] ?? cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? '项目'
  }
  return text(input, '项目名称', TASK_MAX_TITLE_LENGTH)
}

export function normalizeFeedback(input: unknown): string {
  return text(input, '反馈内容', TASK_MAX_FEEDBACK_LENGTH)
}

export function defaultEngineConfig(): TaskEngineConfig {
  return {
    defaultAgent: 'claude',
    maxConcurrent: 2,
    runTimeoutMinutes: TASK_DEFAULT_RUN_TIMEOUT_MINUTES,
    maxRunsPerTask: TASK_DEFAULT_MAX_RUNS,
    maxCostUsdPerTask: TASK_DEFAULT_MAX_COST_USD,
    retries: TASK_DEFAULT_RETRIES
  }
}

export function normalizeEngineConfig(input: unknown, fallback = defaultEngineConfig()): TaskEngineConfig {
  if (!isRecord(input)) return fallback
  const config: TaskEngineConfig = { ...fallback }
  if (isTaskAgent(input.defaultAgent)) config.defaultAgent = input.defaultAgent
  if (Number.isInteger(input.maxConcurrent) && Number(input.maxConcurrent) >= 1 && Number(input.maxConcurrent) <= TASK_MAX_CONCURRENT) {
    config.maxConcurrent = Number(input.maxConcurrent)
  }
  if (Number.isInteger(input.runTimeoutMinutes) && Number(input.runTimeoutMinutes) >= 5 && Number(input.runTimeoutMinutes) <= 240) {
    config.runTimeoutMinutes = Number(input.runTimeoutMinutes)
  }
  if (Number.isInteger(input.maxRunsPerTask) && Number(input.maxRunsPerTask) >= 1 && Number(input.maxRunsPerTask) <= 30) {
    config.maxRunsPerTask = Number(input.maxRunsPerTask)
  }
  if (typeof input.maxCostUsdPerTask === 'number' && Number.isFinite(input.maxCostUsdPerTask)
    && input.maxCostUsdPerTask >= 0.5 && input.maxCostUsdPerTask <= 200) {
    config.maxCostUsdPerTask = input.maxCostUsdPerTask
  }
  if (Number.isInteger(input.retries) && Number(input.retries) >= 0 && Number(input.retries) <= 5) {
    config.retries = Number(input.retries)
  }
  return config
}

export function normalizeTaskCreate(input: unknown): TaskCreateInput {
  if (!isRecord(input)) throw new Error('任务参数无效')
  const goal = normalizeTaskGoal(input.goal)
  const repo = normalizeTaskRepo(input.repo ?? null)
  const cwd = normalizeTaskCwd(input.cwd)
  const agent = input.agent === 'auto' || input.agent === undefined
    ? 'auto'
    : normalizeTaskAgent(input.agent)
  return {
    goal,
    title: input.title === null || input.title === undefined || input.title === '' ? null : normalizeTaskTitle(input.title, goal),
    repo,
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : null,
    cwd,
    agent,
    autonomy: normalizeTaskAutonomy(input.autonomy ?? 'edit'),
    priority: normalizeTaskPriority(input.priority ?? 'normal'),
    source: normalizeTaskSource(input.source ?? 'manual'),
    start: input.start === true
  }
}

export function normalizeTaskUpdate(input: unknown): TaskUpdateInput {
  if (!isRecord(input)) throw new Error('任务参数无效')
  const result: TaskUpdateInput = { id: normalizeTaskId(input.id) }
  if (input.goal !== undefined) result.goal = normalizeTaskGoal(input.goal)
  if (input.title !== undefined) result.title = normalizeTaskTitle(input.title, result.goal ?? '任务')
  if (input.repo !== undefined) result.repo = normalizeTaskRepo(input.repo)
  if (input.name !== undefined) result.name = text(input.name, '项目名称', TASK_MAX_TITLE_LENGTH)
  if (input.cwd !== undefined) result.cwd = normalizeTaskCwd(input.cwd)
  if (input.agent !== undefined) result.agent = input.agent === 'auto' ? 'auto' : normalizeTaskAgent(input.agent)
  if (input.autonomy !== undefined) result.autonomy = normalizeTaskAutonomy(input.autonomy)
  if (input.priority !== undefined) result.priority = normalizeTaskPriority(input.priority)
  if (Object.keys(result).length === 1) throw new Error('没有需要更新的任务字段')
  return result
}

export function normalizeDecisionReply(input: unknown): TaskDecisionReplyInput {
  if (!isRecord(input)) throw new Error('决定参数无效')
  const note = input.note === null || input.note === undefined || input.note === ''
    ? null
    : text(input.note, '补充说明', 2_000)
  return {
    decisionId: normalizeTaskId(input.decisionId),
    optionId: text(input.optionId, '决定选项', 20),
    note
  }
}

function normalizeUsage(input: unknown): TaskUsage {
  if (!isRecord(input)) return { costUsd: null, inputTokens: null, outputTokens: null }
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  return {
    costUsd: number(input.costUsd),
    inputTokens: number(input.inputTokens),
    outputTokens: number(input.outputTokens)
  }
}

const RUN_STATUSES: RunStatus[] = ['running', 'completed', 'failed', 'aborted', 'interrupted']

export function normalizeRunStatus(input: unknown): RunStatus {
  if (!RUN_STATUSES.includes(input as RunStatus)) throw new Error('运行状态无效')
  return input as RunStatus
}

export function normalizeStoredRun(input: unknown): TaskRun {
  if (!isRecord(input)) throw new Error('任务运行记录无效')
  const agent = normalizeTaskAgent(input.agent)
  const status = normalizeRunStatus(input.status)
  return {
    id: normalizeTaskId(input.id),
    taskId: normalizeTaskId(input.taskId),
    round: Number.isInteger(input.round) && Number(input.round) > 0 ? Number(input.round) : 1,
    agent,
    autonomy: normalizeTaskAutonomy(input.autonomy),
    sessionId: typeof input.sessionId === 'string' ? input.sessionId : null,
    resume: input.resume === true,
    startedAt: iso(input.startedAt, '运行开始时间'),
    endedAt: nullableIso(input.endedAt, '运行结束时间'),
    status,
    exitCode: typeof input.exitCode === 'number' && Number.isInteger(input.exitCode) ? input.exitCode : null,
    summary: typeof input.summary === 'string' ? input.summary.slice(0, MAX_SUMMARY) : null,
    protocolStatus: typeof input.protocolStatus === 'string' ? input.protocolStatus.slice(0, 40) : null,
    error: typeof input.error === 'string' ? input.error.slice(0, 2000) : null,
    usage: normalizeUsage(input.usage),
    logFile: typeof input.logFile === 'string' ? input.logFile : '',
    progress: typeof input.progress === 'string' ? input.progress.slice(0, 300) : null
  }
}

function normalizeWaitType(input: unknown): TaskWaitType {
  if (input !== 'timer' && input !== 'github_checks' && input !== 'github_pr') throw new Error('等待事件类型无效')
  return input
}

export function normalizeStoredWait(input: unknown): TaskWait | null {
  if (input === null || input === undefined) return null
  if (!isRecord(input)) throw new Error('等待事件数据无效')
  const type = normalizeWaitType(input.type)
  const repo = normalizeTaskRepo(input.repo ?? null)
  const pr = typeof input.pr === 'number' && Number.isInteger(input.pr) && input.pr > 0 ? input.pr : null
  if ((type === 'github_checks' || type === 'github_pr') && (!repo || !pr)) throw new Error('GitHub 等待事件缺少仓库或 PR 编号')
  const until = nullableIso(input.until, '等待时间')
  if (type === 'timer' && !until) throw new Error('定时等待缺少触发时间')
  return {
    type,
    reason: typeof input.reason === 'string' ? input.reason.slice(0, 1000) : '',
    until,
    repo,
    pr,
    createdAt: iso(input.createdAt, '等待创建时间'),
    timeoutAt: iso(input.timeoutAt, '等待超时时间'),
    lastCheckedAt: nullableIso(input.lastCheckedAt, '等待检查时间'),
    lastState: typeof input.lastState === 'string' ? input.lastState.slice(0, 80) : null,
    lastError: typeof input.lastError === 'string' ? input.lastError.slice(0, 1000) : null,
    firedAt: nullableIso(input.firedAt, '等待触发时间'),
    firedDetail: typeof input.firedDetail === 'string' ? input.firedDetail.slice(0, 2000) : null
  }
}

function normalizeArtifact(input: unknown, runId: string, index: number, cwd: string): TaskArtifact | null {
  if (!isRecord(input)) return null
  const kind = input.kind
  if (kind !== 'file' && kind !== 'dir' && kind !== 'url' && kind !== 'text') return null
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 200) : null
  if (kind === 'url') {
    if (typeof input.url !== 'string') return null
    let parsed: URL
    try { parsed = new URL(input.url.trim()) } catch { return null }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || input.url.length > 2000) return null
    return { id: `${runId}-a${index}`, runId, kind, label: label ?? parsed.hostname, path: null, url: parsed.href, text: null }
  }
  if (kind === 'text') {
    if (typeof input.text !== 'string' || input.text.trim().length === 0) return null
    return { id: `${runId}-a${index}`, runId, kind, label: label ?? '文本', path: null, url: null, text: input.text.slice(0, MAX_TEXT) }
  }
  if (typeof input.path !== 'string' || !input.path.trim() || input.path.length > 2000 || input.path.includes('\0')) return null
  const raw = input.path.trim().replace(/^"|"$/g, '')
  const absolute = /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\[^\\]+\\/.test(raw) || raw.startsWith('/')
  const separator = cwd.includes('\\') ? '\\' : '/'
  const relative = raw.replace(/^[\\/]+/, '').replace(/[\\/]+/g, separator)
  const resolved = absolute ? raw : cwd.replace(/[\\/]+$/, '') + separator + relative
  return { id: `${runId}-a${index}`, runId, kind, label: label ?? resolved.split(/[\\/]/).filter(Boolean).at(-1) ?? resolved, path: resolved, url: null, text: null }
}

function normalizeCheck(input: unknown): TaskCheck | null {
  if (!isRecord(input) || typeof input.name !== 'string' || !input.name.trim()) return null
  const raw = typeof input.status === 'string' ? input.status.toLowerCase() : ''
  const status: CheckStatus = ['passed', 'pass', 'success', 'succeeded', 'ok', '通过'].includes(raw)
    ? 'passed'
    : ['failed', 'fail', 'error', '失败'].includes(raw)
      ? 'failed'
      : ['not_run', 'not-run', 'skipped', 'skip', 'pending', '未运行'].includes(raw)
        ? 'not_run'
        : 'unknown'
  return {
    name: input.name.trim().slice(0, 200),
    status,
    detail: typeof input.detail === 'string' && input.detail.trim() ? input.detail.trim().slice(0, 1000) : null
  }
}

function unverifiedList(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return input.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim().slice(0, 1000))
    .slice(0, MAX_UNVERIFIED)
}

function normalizeDecisionOptions(input: unknown): TaskDecisionOption[] {
  if (!Array.isArray(input)) throw new Error('决定选项无效')
  const options: TaskDecisionOption[] = []
  for (const item of input) {
    if (!isRecord(item)) throw new Error('决定选项无效')
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!OPTION_PATTERN.test(id)) throw new Error('决定选项编号无效')
    if (options.some(option => option.id === id)) throw new Error('决定选项编号重复')
    options.push({
      id,
      label: text(item.label, '决定选项名称', 120),
      impact: typeof item.impact === 'string' ? item.impact.trim().slice(0, 500) : ''
    })
  }
  if (options.length < 1 || options.length > 6) throw new Error('决定选项数量无效')
  return options
}

export class AgentProtocolError extends Error {}

export interface AgentWaitPlan {
  type: TaskWaitType
  reason: string
  until: string | null
  repo: string | null
  pr: number | null
}

export interface AgentDecisionPlan {
  question: string
  whyYou: string
  recommendation: string | null
  options: TaskDecisionOption[]
  expiresAt: string | null
}

export interface AgentProtocolResult {
  status: 'done' | 'waiting' | 'needs_decision' | 'failed' | 'unknown'
  summary: string
  artifacts: TaskArtifact[]
  checks: TaskCheck[]
  unverified: string[]
  wait: AgentWaitPlan | null
  decision: AgentDecisionPlan | null
  warning: string | null
}

function protocolStatus(input: unknown): AgentProtocolResult['status'] {
  const value = typeof input === 'string' ? input.trim().toLowerCase().replace(/[-\s]+/g, '_') : ''
  if (['done', 'complete', 'completed', 'ok', 'success'].includes(value)) return 'done'
  if (['waiting', 'wait', 'pending'].includes(value)) return 'waiting'
  if (['needs_decision', 'decision', 'blocked'].includes(value)) return 'needs_decision'
  if (['failed', 'error', 'failure'].includes(value)) return 'failed'
  return 'unknown'
}

export function parseAgentResultBlock(textValue: string): unknown | null {
  const blocks = [...textValue.matchAll(/```arckeep-result[ \t]*\r?\n([\s\S]*?)```/gi)]
  const block = blocks.at(-1)
  if (!block?.[1]) return null
  if (block[1].length > 64 * 1024) return null
  try {
    return JSON.parse(block[1]) as unknown
  } catch {
    return null
  }
}

export function parseAgentProtocol(
  finalText: string,
  options: { runId: string, cwd: string, now?: Date }
): AgentProtocolResult {
  const runId = normalizeTaskId(options.runId)
  const now = options.now ?? new Date()
  const fallbackSummary = finalText.trim().slice(0, MAX_SUMMARY)
  const raw = parseAgentResultBlock(finalText)
  if (!isRecord(raw)) {
    return {
      status: 'unknown',
      summary: fallbackSummary,
      artifacts: [],
      checks: [],
      unverified: [],
      wait: null,
      decision: null,
      warning: 'Agent 未按协议输出 arckeep-result 结果块，无法确认等待、决定或验收证据'
    }
  }

  const warnings: string[] = []
  const status = protocolStatus(raw.status)
  if (status === 'unknown') warnings.push('结果块的状态无法识别')
  const summaryValue = typeof raw.summary === 'string' && raw.summary.trim()
    ? raw.summary.trim().slice(0, MAX_SUMMARY)
    : fallbackSummary
  const artifacts = (Array.isArray(raw.artifacts) ? raw.artifacts : [])
    .map((item, index) => normalizeArtifact(item, runId, index, options.cwd))
    .filter((item): item is TaskArtifact => item !== null)
    .slice(0, TASK_MAX_ARTIFACTS)
  if (Array.isArray(raw.artifacts) && raw.artifacts.length > TASK_MAX_ARTIFACTS) warnings.push('产物过多，仅保留前 ' + TASK_MAX_ARTIFACTS + ' 项')
  const checks = (Array.isArray(raw.checks) ? raw.checks : [])
    .map(normalizeCheck)
    .filter((item): item is TaskCheck => item !== null)
    .slice(0, TASK_MAX_CHECKS)
  const unverified = unverifiedList(raw.unverified)

  let wait: AgentWaitPlan | null = null
  if (raw.wait !== undefined && raw.wait !== null) {
    if (!isRecord(raw.wait)) {
      warnings.push('等待事件格式无效')
    } else {
      try {
        const type = normalizeWaitType(raw.wait.type)
        const reason = typeof raw.wait.reason === 'string' ? raw.wait.reason.trim().slice(0, 1000) : ''
        if (type === 'timer') {
          const until = iso(raw.wait.until, '等待触发时间')
          const untilMs = Date.parse(until)
          if (untilMs < now.getTime() - 60_000) throw new AgentProtocolError('等待触发时间已经过去')
          if (untilMs > now.getTime() + 60 * 24 * 60 * 60 * 1000) throw new AgentProtocolError('等待触发时间超过 60 天')
          wait = { type, reason, until, repo: null, pr: null }
        } else {
          const repo = normalizeTaskRepo(raw.wait.repo)
          const pr = typeof raw.wait.pr === 'number' && Number.isInteger(raw.wait.pr) && raw.wait.pr > 0 ? raw.wait.pr : null
          if (!repo || !pr) throw new AgentProtocolError('GitHub 等待事件缺少仓库或 PR 编号')
          wait = { type, reason, until: null, repo, pr }
        }
      } catch (error) {
        wait = null
        warnings.push(error instanceof Error ? error.message : '等待事件格式无效')
      }
    }
  }

  let decision: AgentDecisionPlan | null = null
  if (raw.decision !== undefined && raw.decision !== null) {
    if (!isRecord(raw.decision)) {
      warnings.push('决定请求格式无效')
    } else {
      try {
        const question = text(raw.decision.question, '决定问题', 4_000)
        const whyYou = typeof raw.decision.whyYou === 'string' ? raw.decision.whyYou.trim().slice(0, 4_000) : ''
        const recommendation = typeof raw.decision.recommendation === 'string' && raw.decision.recommendation.trim()
          ? raw.decision.recommendation.trim().slice(0, 2_000)
          : null
        const options = normalizeDecisionOptions(raw.decision.options)
        let expiresAt: string | null = null
        if (raw.decision.expiresAt !== undefined && raw.decision.expiresAt !== null) {
          expiresAt = iso(raw.decision.expiresAt, '决定过期时间')
        }
        decision = { question, whyYou, recommendation, options, expiresAt }
      } catch (error) {
        decision = null
        warnings.push(error instanceof Error ? error.message : '决定请求格式无效')
      }
    }
  }

  let effectiveStatus = status
  if (status === 'waiting' && !wait) {
    warnings.push('Agent 表示等待，但没有可执行的等待事件')
    effectiveStatus = 'unknown'
  }
  if (status === 'needs_decision' && !decision) {
    warnings.push('Agent 请求决定，但缺少结构化选项')
    effectiveStatus = 'unknown'
  }
  if (status === 'done' && (wait || decision)) {
    warnings.push('结果块同时给出了完成和等待/决定，按等待或决定处理')
    effectiveStatus = wait ? 'waiting' : 'needs_decision'
  }

  return {
    status: effectiveStatus,
    summary: summaryValue || (effectiveStatus === 'failed' ? 'Agent 报告执行失败' : ''),
    artifacts,
    checks,
    unverified,
    wait,
    decision,
    warning: warnings.length > 0 ? warnings.join('；') : null
  }
}

const TASK_STATUSES: TaskStatus[] = [
  'draft', 'queued', 'running', 'waiting', 'needs_decision', 'ready', 'done', 'paused', 'failed', 'cancelled'
]
const DECISION_STATUSES: DecisionStatus[] = ['pending', 'answered', 'expired', 'cancelled']
const ACCEPTANCE_STATUSES: TaskAcceptance['status'][] = ['pending', 'accepted', 'rework']

export function normalizeTaskStatus(input: unknown): TaskStatus {
  if (!TASK_STATUSES.includes(input as TaskStatus)) throw new Error('任务状态无效')
  return input as TaskStatus
}

function normalizeEventRecord(input: unknown): TaskEventRecord | null {
  if (!isRecord(input)) return null
  const kind = input.kind
  if (kind !== 'timer' && kind !== 'github_checks' && kind !== 'github_pr' && kind !== 'decision' && kind !== 'run' && kind !== 'manual') return null
  return {
    at: iso(input.at, '事件时间'),
    kind,
    detail: typeof input.detail === 'string' ? input.detail.slice(0, 1000) : ''
  }
}

export function normalizeStoredResult(input: unknown): TaskResult | null {
  if (input === null || input === undefined) return null
  if (!isRecord(input)) throw new Error('任务结果数据无效')
  const artifacts = (Array.isArray(input.artifacts) ? input.artifacts : [])
    .map((item, index) => normalizeArtifact(item, typeof input.runId === 'string' ? input.runId : 'unknown', index, ''))
    .filter((item): item is TaskArtifact => item !== null)
  return {
    runId: typeof input.runId === 'string' ? input.runId : '',
    receivedAt: iso(input.receivedAt, '结果时间'),
    summary: typeof input.summary === 'string' ? input.summary.slice(0, MAX_SUMMARY) : '',
    protocolStatus: typeof input.protocolStatus === 'string' ? input.protocolStatus.slice(0, 40) : 'unknown',
    artifacts,
    checks: (Array.isArray(input.checks) ? input.checks : []).map(normalizeCheck).filter((item): item is TaskCheck => item !== null),
    unverified: unverifiedList(input.unverified),
    protocolWarning: typeof input.protocolWarning === 'string' ? input.protocolWarning.slice(0, 2000) : null
  }
}

export function normalizeStoredDecision(input: unknown): TaskDecision {
  if (!isRecord(input)) throw new Error('决定数据无效')
  const status = DECISION_STATUSES.includes(input.status as DecisionStatus) ? input.status as DecisionStatus : null
  if (!status) throw new Error('决定状态无效')
  let answer: TaskDecision['answer'] = null
  if (isRecord(input.answer)) {
    answer = {
      optionId: text(input.answer.optionId, '决定选项', 20),
      note: typeof input.answer.note === 'string' ? input.answer.note.slice(0, 2_000) : null
    }
  }
  return {
    id: normalizeTaskId(input.id),
    taskId: normalizeTaskId(input.taskId),
    runId: normalizeTaskId(input.runId),
    question: text(input.question, '决定问题', 4_000),
    whyYou: typeof input.whyYou === 'string' ? input.whyYou.slice(0, 4_000) : '',
    recommendation: typeof input.recommendation === 'string' ? input.recommendation.slice(0, 2_000) : null,
    options: normalizeDecisionOptions(input.options),
    createdAt: iso(input.createdAt, '决定创建时间'),
    expiresAt: iso(input.expiresAt, '决定过期时间'),
    status,
    answeredAt: nullableIso(input.answeredAt, '决定回复时间'),
    answer
  }
}

function normalizeContinuation(input: unknown): TaskContinuation | null {
  if (input === null || input === undefined) return null
  if (!isRecord(input)) return null
  if (input.kind !== 'decision' && input.kind !== 'event' && input.kind !== 'manual') return null
  if (typeof input.title !== 'string' || typeof input.detail !== 'string') return null
  return {
    kind: input.kind,
    title: input.title.slice(0, 300),
    detail: input.detail.slice(0, 2_000)
  }
}

export function normalizeStoredTask(input: unknown): Task {
  if (!isRecord(input)) throw new Error('任务数据无效')
  const goal = normalizeTaskGoal(input.goal)
  const status = normalizeTaskStatus(input.status)
  const acceptanceStatus = ACCEPTANCE_STATUSES.includes((input.acceptance as TaskAcceptance | undefined)?.status as TaskAcceptance['status'])
    ? (input.acceptance as TaskAcceptance).status
    : 'pending'
  const acceptanceRecord = isRecord(input.acceptance) ? input.acceptance : {}
  const agent = normalizeTaskAgent(input.agent)
  const sessionAgent = isTaskAgent(input.sessionAgent) ? input.sessionAgent : null
  const sessionId = typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : null
  return {
    id: normalizeTaskId(input.id),
    title: normalizeTaskTitle(input.title, goal),
    goal,
    repo: normalizeTaskRepo(input.repo ?? null),
    name: normalizeTaskName(input.name, normalizeTaskRepo(input.repo ?? null), normalizeTaskCwd(input.cwd)),
    cwd: normalizeTaskCwd(input.cwd),
    agent,
    autonomy: normalizeTaskAutonomy(input.autonomy),
    priority: normalizeTaskPriority(input.priority),
    source: normalizeTaskSource(input.source),
    status,
    statusReason: typeof input.statusReason === 'string' ? input.statusReason.slice(0, 1000) : null,
    createdAt: iso(input.createdAt, '任务创建时间'),
    updatedAt: iso(input.updatedAt, '任务更新时间'),
    rounds: Number.isInteger(input.rounds) && Number(input.rounds) >= 0 ? Number(input.rounds) : 0,
    maxRuns: Number.isInteger(input.maxRuns) && Number(input.maxRuns) >= 1 && Number(input.maxRuns) <= 30
      ? Number(input.maxRuns)
      : TASK_DEFAULT_MAX_RUNS,
    maxCostUsd: typeof input.maxCostUsd === 'number' && Number.isFinite(input.maxCostUsd) && input.maxCostUsd >= 0
      ? input.maxCostUsd
      : TASK_DEFAULT_MAX_COST_USD,
    sessionId,
    sessionAgent,
    activeRunId: typeof input.activeRunId === 'string' && input.activeRunId ? input.activeRunId : null,
    lastRunId: typeof input.lastRunId === 'string' && input.lastRunId ? input.lastRunId : null,
    wait: normalizeStoredWait(input.wait),
    decisionId: typeof input.decisionId === 'string' && input.decisionId ? input.decisionId : null,
    continuation: normalizeContinuation(input.continuation),
    result: normalizeStoredResult(input.result),
    acceptance: {
      status: acceptanceStatus,
      note: typeof acceptanceRecord.note === 'string' ? acceptanceRecord.note.slice(0, 2_000) : null,
      at: nullableIso(acceptanceRecord.at, '验收时间')
    },
    feedback: Array.isArray(input.feedback)
      ? input.feedback.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map(item => item.slice(0, TASK_MAX_FEEDBACK_LENGTH)).slice(-MAX_FEEDBACK)
      : [],
    pausedFrom: TASK_STATUSES.includes(input.pausedFrom as TaskStatus) ? input.pausedFrom as TaskStatus : null,
    failureCount: Number.isInteger(input.failureCount) && Number(input.failureCount) >= 0 ? Number(input.failureCount) : 0,
    nextAttemptAt: nullableIso(input.nextAttemptAt, '下次尝试时间'),
    lastError: typeof input.lastError === 'string' ? input.lastError.slice(0, 2_000) : null,
    costUsd: typeof input.costUsd === 'number' && Number.isFinite(input.costUsd) && input.costUsd >= 0 ? input.costUsd : 0,
    inputTokens: typeof input.inputTokens === 'number' && Number.isFinite(input.inputTokens) && input.inputTokens >= 0 ? input.inputTokens : 0,
    outputTokens: typeof input.outputTokens === 'number' && Number.isFinite(input.outputTokens) && input.outputTokens >= 0 ? input.outputTokens : 0,
    events: (Array.isArray(input.events) ? input.events : []).map(normalizeEventRecord)
      .filter((item): item is TaskEventRecord => item !== null).slice(-MAX_EVENTS),
    deliveredAt: nullableIso(input.deliveredAt, '交付时间')
  }
}

export function normalizeEngineData(input: unknown): { tasks: Task[], decisions: TaskDecision[], runs: TaskRun[], config: TaskEngineConfig } {
  if (!isRecord(input)) throw new Error('任务数据文件格式无效')
  if (input.version !== 1) throw new Error('任务数据文件版本不支持，已保留原文件')
  if (!Array.isArray(input.tasks) || !Array.isArray(input.decisions)) throw new Error('任务数据文件格式无效')
  if (input.tasks.length > MAX_TASKS_IN_FILE || input.decisions.length > MAX_DECISIONS_IN_FILE) {
    throw new Error('任务数据文件条目过多')
  }
  const tasks = input.tasks.map(normalizeStoredTask)
  const decisions = input.decisions.map(normalizeStoredDecision)
  const runs = (Array.isArray(input.runs) ? input.runs : []).map(normalizeStoredRun).slice(-1000)
  if (new Set(tasks.map(item => item.id)).size !== tasks.length) throw new Error('任务数据编号重复')
  if (new Set(decisions.map(item => item.id)).size !== decisions.length) throw new Error('决定数据编号重复')
  return { tasks, decisions, runs, config: normalizeEngineConfig(input.config) }
}

export function defaultDecisionExpiry(now: Date): string {
  return new Date(now.getTime() + TASK_DECISION_TIMEOUT_HOURS * 60 * 60 * 1000).toISOString()
}

export function defaultWaitTimeout(now: Date): string {
  return new Date(now.getTime() + TASK_WAIT_TIMEOUT_HOURS * 60 * 60 * 1000).toISOString()
}

export { TASK_LOG_TAIL_BYTES }
