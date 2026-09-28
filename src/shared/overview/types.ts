export const OVERVIEW_WARNING_KINDS = ['卡住', '停滞', '空仓', '陈旧'] as const

export type OverviewWarningKind = (typeof OVERVIEW_WARNING_KINDS)[number]

export type CiState = 'success' | 'failure' | 'pending' | 'none' | 'unknown'

export interface OverviewConfig {
  /** Days since the last commit before an active repo is marked 停滞. */
  staleDays: number
  /** Days an open non-draft pull request can wait for review before 卡住. */
  reviewWaitDays: number
  /** Days since pushedAt before a repo is 陈旧 and moves into the collapsed group. */
  staleRepoDays: number
  /**
   * Auto mode (empty watch list): include repos pushed within this many days,
   * plus empty repos and repos already past staleRepoDays.
   */
  autoPushWindowDays: number
  maxScopeRepos: number
}

export interface OverviewWarningTarget {
  url: string
}

export interface OverviewWarning {
  kind: OverviewWarningKind
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
  lastCommitAt: string | null
  openPrCount: number
  ciState: CiState
  pullRequests: OverviewPullRequest[]
  error: string | null
}

export interface OverviewRow {
  name: string
  url: string
  lastCommitAt: string | null
  openPrCount: number
  ciState: CiState
  warnings: OverviewWarning[]
  error: string | null
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
