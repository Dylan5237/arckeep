export const TASK_MAX_GOAL_LENGTH = 20_000
export const TASK_MAX_TITLE_LENGTH = 200
export const TASK_MAX_FEEDBACK_LENGTH = 8_000
export const TASK_MAX_RUNS = 30
export const TASK_MAX_CONCURRENT = 4
export const TASK_DEFAULT_RUN_TIMEOUT_MINUTES = 45
export const TASK_DEFAULT_MAX_RUNS = 12
export const TASK_DEFAULT_MAX_COST_USD = 10
export const TASK_DEFAULT_RETRIES = 2
export const TASK_WAIT_TIMEOUT_HOURS = 168
export const TASK_DECISION_TIMEOUT_HOURS = 24
export const TASK_LOG_TAIL_BYTES = 8 * 1024
export const TASK_MAX_ARTIFACTS = 40
export const TASK_MAX_CHECKS = 40

export type TaskAgent = 'claude' | 'codex'
export type TaskAutonomy = 'read-only' | 'edit' | 'full'
export type TaskPriority = 'high' | 'normal' | 'low'
export type TaskSource = 'manual' | 'idea' | 'todo' | 'waiting'

export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'waiting'
  | 'needs_decision'
  | 'ready'
  | 'done'
  | 'paused'
  | 'failed'
  | 'cancelled'

export type RunStatus = 'running' | 'completed' | 'failed' | 'aborted' | 'interrupted'

export type ArtifactKind = 'file' | 'dir' | 'url' | 'text'

export interface TaskArtifact {
  id: string
  runId: string
  kind: ArtifactKind
  label: string
  /** Present for file/dir artifacts. Absolute after normalization. */
  path: string | null
  /** Present for url artifacts. */
  url: string | null
  /** Present for text artifacts. */
  text: string | null
  exists?: boolean | null
}

export type CheckStatus = 'passed' | 'failed' | 'not_run' | 'unknown'

export interface TaskCheck {
  name: string
  status: CheckStatus
  detail: string | null
}

export type TaskWaitType = 'timer' | 'github_checks' | 'github_pr'

export interface TaskWait {
  type: TaskWaitType
  reason: string
  /** ISO timestamp for timer waits and for the overall wait deadline on all waits. */
  until: string | null
  repo: string | null
  pr: number | null
  createdAt: string
  timeoutAt: string
  lastCheckedAt: string | null
  lastState: string | null
  lastError: string | null
  /** Event payload observed when the wait fired, kept for the continuation prompt. */
  firedAt: string | null
  firedDetail: string | null
}

export interface TaskDecisionOption {
  id: string
  label: string
  impact: string
}

export type DecisionStatus = 'pending' | 'answered' | 'expired' | 'cancelled'

export interface TaskDecision {
  id: string
  taskId: string
  runId: string
  question: string
  whyYou: string
  recommendation: string | null
  options: TaskDecisionOption[]
  createdAt: string
  expiresAt: string
  status: DecisionStatus
  answeredAt: string | null
  answer: { optionId: string, note: string | null } | null
}

export interface TaskUsage {
  costUsd: number | null
  inputTokens: number | null
  outputTokens: number | null
}

export interface TaskRun {
  id: string
  taskId: string
  round: number
  agent: TaskAgent
  autonomy: TaskAutonomy
  sessionId: string | null
  resume: boolean
  startedAt: string
  endedAt: string | null
  status: RunStatus
  exitCode: number | null
  summary: string | null
  protocolStatus: string | null
  error: string | null
  usage: TaskUsage
  logFile: string
  /** Last meaningful output line, used by the UI while the run is active. */
  progress: string | null
}

export interface TaskResult {
  runId: string
  receivedAt: string
  summary: string
  protocolStatus: string
  artifacts: TaskArtifact[]
  checks: TaskCheck[]
  unverified: string[]
  protocolWarning: string | null
}

export interface TaskAcceptance {
  status: 'pending' | 'accepted' | 'rework'
  note: string | null
  at: string | null
}

export interface TaskEventRecord {
  at: string
  kind: TaskWaitType | 'decision' | 'run' | 'manual'
  detail: string
}

export interface TaskContinuation {
  kind: 'decision' | 'event' | 'manual'
  title: string
  detail: string
}

export interface Task {
  id: string
  title: string
  goal: string
  repo: string | null
  name: string
  cwd: string
  agent: TaskAgent
  autonomy: TaskAutonomy
  priority: TaskPriority
  source: TaskSource
  status: TaskStatus
  statusReason: string | null
  createdAt: string
  updatedAt: string
  rounds: number
  maxRuns: number
  maxCostUsd: number
  sessionId: string | null
  sessionAgent: TaskAgent | null
  activeRunId: string | null
  lastRunId: string | null
  wait: TaskWait | null
  decisionId: string | null
  continuation: TaskContinuation | null
  result: TaskResult | null
  acceptance: TaskAcceptance
  feedback: string[]
  pausedFrom: TaskStatus | null
  failureCount: number
  nextAttemptAt: string | null
  lastError: string | null
  costUsd: number
  inputTokens: number
  outputTokens: number
  events: TaskEventRecord[]
  deliveredAt: string | null
}

export interface TaskEngineConfig {
  defaultAgent: TaskAgent
  maxConcurrent: number
  runTimeoutMinutes: number
  maxRunsPerTask: number
  maxCostUsdPerTask: number
  retries: number
}

export interface TaskEngineData {
  version: 1
  config: TaskEngineConfig
  tasks: Task[]
  decisions: TaskDecision[]
  runs: TaskRun[]
}

export interface TaskAgentStatus {
  agent: TaskAgent
  available: boolean
  version: string | null
  command: string | null
}

export interface TaskCounts {
  decisions: number
  running: number
  waiting: number
  ready: number
  draft: number
  failed: number
  active: number
}

export interface TaskSnapshot {
  tasks: Task[]
  decisions: TaskDecision[]
  config: TaskEngineConfig
  agents: TaskAgentStatus[]
  agentsReady: boolean
  counts: TaskCounts
  now: string
  githubReady: boolean
  engineError: string | null
}

export interface TaskRunView extends TaskRun {
  logTail: string
}

export interface TaskDetail {
  task: Task
  runs: TaskRunView[]
  decisions: TaskDecision[]
  nextRunAt: string | null
}

export interface TaskCreateInput {
  goal: string
  title: string | null
  repo: string | null
  name: string | null
  cwd: string
  agent: TaskAgent | 'auto'
  autonomy: TaskAutonomy
  priority: TaskPriority
  source: TaskSource
  start: boolean
}

export interface TaskUpdateInput {
  id: string
  title?: string
  goal?: string
  repo?: string | null
  name?: string
  cwd?: string
  agent?: TaskAgent | 'auto'
  autonomy?: TaskAutonomy
  priority?: TaskPriority
}

export interface TaskDecisionReplyInput {
  decisionId: string
  optionId: string
  note?: string | null
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  draft: '待确认范围',
  queued: '排队中',
  running: '执行中',
  waiting: '等待事件',
  needs_decision: '等我决定',
  ready: '待验收',
  done: '已验收',
  paused: '已暂停',
  failed: '失败',
  cancelled: '已取消'
}

export const TASK_AGENT_LABELS: Record<TaskAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex'
}

export const TASK_AUTONOMY_LABELS: Record<TaskAutonomy, string> = {
  'read-only': '只读分析',
  edit: '可改文件与运行本地命令',
  full: '完全自主（含网络/推送能力）'
}

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  high: '高',
  normal: '普通',
  low: '低'
}

export function isTaskAgent(value: unknown): value is TaskAgent {
  return value === 'claude' || value === 'codex'
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && Object.hasOwn(TASK_STATUS_LABELS, value)
}

export function isTerminalTaskStatus(value: TaskStatus): boolean {
  return value === 'done' || value === 'cancelled'
}

export function isTaskActive(value: TaskStatus): boolean {
  return value === 'queued' || value === 'running' || value === 'waiting' || value === 'needs_decision'
}
