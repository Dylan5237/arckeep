export const OVERVIEW_WARNING_KINDS = ['卡住', '停滞', '空仓', '陈旧'] as const

export type OverviewWarningKind = (typeof OVERVIEW_WARNING_KINDS)[number]

/** Active list, the collapsed 陈旧 group, or 已归档. Every non-archived repo is one of the first two. */
export const OVERVIEW_GROUPS = ['active', 'stale', 'archived'] as const

export type OverviewGroup = (typeof OVERVIEW_GROUPS)[number]

/** Which timestamp produced the stall age. `tie` means commit and issue activity are the same instant. */
export type OverviewStallSource = 'commit' | 'issue' | 'tie' | 'none'

export interface OverviewStallBasis {
  /** Newer of the default-branch commit and issue/PR activity. Null when neither exists. */
  at: string | null
  source: OverviewStallSource
  lastCommitAt: string | null
  lastIssueActivityAt: string | null
}

export type CiState = 'success' | 'failure' | 'pending' | 'none' | 'unknown'

export interface OverviewConfig {
  /**
   * Days before 停滞. Both the default-branch commit and the latest issue/PR
   * activity must be at least this old. The chip uses the newer of the two.
   */
  staleDays: number
  /** Days an open non-draft pull request can wait for review before 卡住. */
  reviewWaitDays: number
  /**
   * Days since the newest of the default-branch commit, issue/PR activity,
   * repository pushedAt, and repository createdAt before a repo leaves the
   * active list for the 陈旧 group. Missing timestamps are skipped. Age equal
   * to this value stays active; only a greater age is 陈旧. A repo with no
   * timestamps at all stays active.
   */
  staleRepoDays: number
  maxScopeRepos: number
  /** When false, GitHub archived repositories are omitted entirely. */
  showArchived: boolean
}

export interface OverviewWarningTarget {
  url: string
}

export interface OverviewWarning {
  kind: OverviewWarningKind
  /** Chip text, for example 「停滞 14 天」 or 「卡住：PR 等 review 8 天，等 2 个」. */
  label: string
  /** Elapsed days behind the label. Null when the warning is not a day count. */
  days: number | null
  /** Tooltip: the configured threshold, not the elapsed time. */
  hint: string
  targets: OverviewWarningTarget[]
}

export interface OverviewPullRequest {
  number: number
  title: string
  url: string
  isDraft: boolean
  createdAt: string
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  approvedReviewCount: number
}

/** Facts collected from GitHub before warning rules run. */
export interface OverviewRepoFacts {
  name: string
  url: string
  isEmpty: boolean
  /** GitHub diskUsage in kilobytes. Null when the field was absent. */
  sizeKb: number | null
  hasDefaultBranchCommit: boolean
  pushedAt: string | null
  /** Repository createdAt. Used when the repo has never been pushed or edited. */
  createdAt: string | null
  /** Default-branch commit time. Not a push to some other branch. */
  lastCommitAt: string | null
  /**
   * Latest issue or pull request create, update, or comment.
   * Null when the repository has no issue/PR activity.
   */
  lastIssueActivityAt: string | null
  openPrCount: number
  ciState: CiState
  /** Link to the failing Actions run when ciState is failure. */
  ciFailureUrl: string | null
  pullRequests: OverviewPullRequest[]
  /** GitHub isArchived. Archived repos never receive overview warnings. */
  archived: boolean
  error: string | null
}

export interface OverviewRow {
  name: string
  url: string
  lastCommitAt: string | null
  openPrCount: number
  ciState: CiState
  warnings: OverviewWarning[]
  /** Active list, 陈旧, or 已归档. */
  group: OverviewGroup
  /** Why the stall age is what it is. Present even when the row is not 停滞. */
  stallBasis: OverviewStallBasis
  archived: boolean
  error: string | null
  /** UI only. True when the row was loaded because it is on the watch list. Omitted from JSON. */
  fromWatchList?: boolean
}

export type OverviewAuth = 'ok' | 'missing' | 'invalid'

export interface OverviewSourceError {
  source: string
  message: string
}

export interface OverviewSnapshot {
  rows: OverviewRow[]
  refreshedAt: string | null
  refreshing: boolean
  auth: OverviewAuth
  rateLimitResetAt: string | null
  sourceErrors: OverviewSourceError[]
  notices: string[]
}
