export const WAITING_REASONS = {
  assignee: '指派',
  review: '请求 review',
  mention: '提及',
  todo: '待办',
  statusDoc: '状态文档',
  openPr: '待你审/合',
  human: '要人动手',
  local: '没推送'
} as const

export type WaitingReason = (typeof WAITING_REASONS)[keyof typeof WAITING_REASONS]

export type WaitingItemType = 'issue' | 'pr' | 'todo' | 'local-branch' | 'status-doc'

export type GithubSourceName = 'assignee' | 'reviewRequested' | 'mentions' | 'openPrs' | 'humanIssues'

/** Blanket「待你审/合」for every open PR, or only repos the user can push to. */
export type OpenPrScope = 'maintain' | 'watching'

/** Bare @mentions are noise unless the user opts into keeping all of them. */
export type MentionPolicy = 'action-or-recent' | 'any'

export type RepoAccess = 'maintain' | 'watch' | 'unknown'

export interface WaitingSources {
  assignee: boolean
  reviewRequested: boolean
  mentions: boolean
  todos: boolean
  statusDocs: boolean
  openPrs: boolean
  humanIssues: boolean
  localBranches: boolean
}

export interface StatusDocRule {
  repo: string
  target: string
  pattern: string
}

export interface WaitingConfig {
  sources: WaitingSources
  humanKeywords: string[]
  humanLabels: string[]
  resolvedSignals: string[]
  statusDocRules: StatusDocRule[]
  localRepoDirs: string[]
  /** Owned + watched repositories included in the repo-scope batch. */
  maxScopeRepos: number
  /**
   * maintain: open non-draft PRs only in repos the user owns or can push to,
   * excluding forks of someone else's repo. watching: also list every open PR
   * in repos the user only watches.
   */
  openPrScope: OpenPrScope
  /** any: every @mention. action-or-recent: drop a bare mention in an old body. */
  mentionPolicy: MentionPolicy
  /** A mention in a comment newer than this still counts without an action signal. */
  mentionRecentDays: number
  showIgnored: boolean
}

/** One GitHub issue or PR after a batched query, before reasons are merged. */
export interface GithubRecord {
  kind: 'issue' | 'pr'
  repo: string
  repoIsEmpty: boolean
  repoPushedAt: string | null
  number: number
  title: string
  url: string
  body: string
  createdAt: string
  updatedAt: string
  isDraft: boolean
  labels: string[]
  comments: { body: string, createdAt: string }[]
  parentNumber: number | null
  assignedAt: string | null
  reviewRequestedAt: string | null
  mentionedAt: string | null
  lastPushedAt: string | null
  labelEvents: { name: string, at: string }[]
  fromAssignee: boolean
  fromReview: boolean
  fromMention: boolean
  fromAuthor: boolean
  fromOpenPr: boolean
  inScopeRepo: boolean
  repoAccess: RepoAccess
  authorLogin: string
  viewerLogin: string
  isFork: boolean
  viewerOwnsRepo: boolean
}

export interface StatusDocHit {
  repo: string
  target: string
  line: number
  text: string
  url: string
  issueNumber: number | null
  eventAt: string | null
}

export interface LocalBranchHit {
  dir: string
  repo: string
  branch: string
  ahead: number
  subject: string
  committedAt: string
  url: string
}

export interface TodoWaitingItem {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  url: string
}

/**
 * Todos marked「等我」. Issue #4 owns the real list; until it lands the
 * provider stays unavailable and returns nothing.
 */
export interface TodoWaitingProvider {
  readonly available: boolean
  listWaitingOnMe(): Promise<TodoWaitingItem[]>
}

export interface ReasonDetail {
  reason: string
  at: string | null
  estimated: boolean
}

/** Which generic rule kept this row, plus a short excerpt of the original text. */
export interface WaitingSignal {
  rule: string
  excerpt: string
}

export interface WaitingDraft {
  id: string
  repo: string
  number: number | null
  type: WaitingItemType
  title: string
  url: string
  reasons: string[]
  /** What to do. `reasons` stays the list of how the row was found. */
  action: string
  waitingDays: number
  daysEstimated: boolean
  updatedAt: string
  reasonDetails: ReasonDetail[]
  /** Parent issue number when this row is a sub-issue. */
  parentNumber: number | null
  /** Parent issue URL, or the parent number when a URL cannot be built. */
  parent: string | number | null
  /** Qualifying child issues included in this same result. */
  childCount: number
  /** Why this row is waiting. Existing fields stay; this one is extra. */
  signal: WaitingSignal
}

export interface WaitingJsonRow {
  repo: string
  number: number | null
  type: WaitingItemType
  title: string
  url: string
  reasons: string[]
  action?: string
  waitingDays: number
  daysEstimated: boolean
  parent?: string | number | null
  childCount?: number
  signal?: WaitingSignal
}

export interface WaitingRow {
  id: string
  repo: string
  number: number | null
  type: WaitingItemType
  title: string
  url: string
  reasons: string[]
  action: string
  waitingDays: number
  daysEstimated: boolean
  updatedAt: string
  ignored: boolean
  parentNumber: number | null
  parent: string | number | null
  childCount: number
}

export interface SourceError {
  source: string
  message: string
}

export type WaitingAuth = 'ok' | 'missing' | 'invalid'

export interface WaitingSnapshot {
  rows: WaitingRow[]
  refreshedAt: string | null
  refreshing: boolean
  auth: WaitingAuth
  rateLimitResetAt: string | null
  sourceErrors: SourceError[]
  notices: string[]
  showIgnored: boolean
  hiddenCount: number
  hiddenRepos: string[]
  todosAvailable: boolean
}

export interface DismissalRecord {
  snoozeUntil: string | null
  ignored: boolean
  ignoredUpdatedAt: string | null
}

export type DismissalMap = Record<string, DismissalRecord>
