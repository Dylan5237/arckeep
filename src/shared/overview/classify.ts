import { laterIso, waitingDays } from '../waiting/days.js'
import type {
  CiState,
  OverviewConfig,
  OverviewGroup,
  OverviewPullRequest,
  OverviewRepoFacts,
  OverviewRow,
  OverviewStallBasis,
  OverviewWarning,
  OverviewWarningKind
} from './types.js'

const PUSH_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE'])

const WARNING_ORDER: OverviewWarningKind[] = ['卡住', '停滞', '空仓', '陈旧']

export function mapCiState(rollup: string | null | undefined): CiState {
  if (!rollup) return 'none'
  const value = rollup.toUpperCase()
  if (value === 'SUCCESS') return 'success'
  if (value === 'FAILURE' || value === 'ERROR') return 'failure'
  if (value === 'PENDING' || value === 'EXPECTED') return 'pending'
  return 'none'
}

export function isEmptyRepo(facts: Pick<OverviewRepoFacts, 'isEmpty' | 'sizeKb' | 'hasDefaultBranchCommit'>): boolean {
  if (facts.isEmpty) return true
  if (facts.sizeKb === 0) return true
  if (!facts.hasDefaultBranchCommit) return true
  return false
}

/**
 * Auto mode lists every repository the viewer can push to. Age only decides the
 * group. Archived repositories stay out unless requested.
 * `config` and `now` remain in the signature so callers can keep passing the
 * same rule clock; they do not drop a repository for sitting between the two windows.
 */
export function inAutoScope(
  repo: { isEmpty?: boolean, pushedAt?: string | null, archived?: boolean },
  _config: OverviewConfig,
  _now: Date,
  includeArchived = false
): boolean {
  if (repo.archived) return includeArchived
  return true
}

/** Push access for auto mode: owner, collaborator, or organization member who can push. */
export function hasOverviewPushAccess(permission: string | null | undefined): boolean {
  return typeof permission === 'string' && PUSH_PERMISSIONS.has(permission)
}

export function stallBasisOf(facts: Pick<OverviewRepoFacts, 'lastCommitAt' | 'lastIssueActivityAt'>): OverviewStallBasis {
  const lastCommitAt = facts.lastCommitAt
  const lastIssueActivityAt = facts.lastIssueActivityAt ?? null
  if (lastCommitAt && lastIssueActivityAt) {
    const commitMs = Date.parse(lastCommitAt)
    const issueMs = Date.parse(lastIssueActivityAt)
    if (Number.isFinite(commitMs) && Number.isFinite(issueMs) && commitMs === issueMs) {
      return { at: lastCommitAt, source: 'tie', lastCommitAt, lastIssueActivityAt }
    }
  }
  const at = laterIso(lastCommitAt, lastIssueActivityAt)
  const source = at && lastIssueActivityAt && at === lastIssueActivityAt && at !== lastCommitAt
    ? 'issue'
    : at
      ? 'commit'
      : 'none'
  return { at, source, lastCommitAt, lastIssueActivityAt }
}

/**
 * Active when the newer of the default-branch commit and issue/PR activity is
 * within `staleRepoDays` (that exact age still counts as active). Older than
 * that, the row is 陈旧. Missing activity stays active so a new empty repo is visible.
 */
export function overviewGroup(
  facts: Pick<OverviewRepoFacts, 'archived' | 'error' | 'lastCommitAt' | 'lastIssueActivityAt'>,
  config: OverviewConfig,
  now: Date
): OverviewGroup {
  if (facts.archived) return 'archived'
  if (facts.error) return 'active'
  const at = stallBasisOf(facts).at
  if (!at) return 'active'
  if (waitingDays(at, now) > config.staleRepoDays) return 'stale'
  return 'active'
}

export function isReviewStuck(pr: OverviewPullRequest, config: OverviewConfig, now: Date): boolean {
  if (pr.isDraft) return false
  if (pr.approvedReviewCount > 0) return false
  if (pr.reviewDecision === 'APPROVED' || pr.reviewDecision === 'CHANGES_REQUESTED') return false
  return waitingDays(pr.createdAt, now) >= config.reviewWaitDays
}

function isGithubUrl(url: string): boolean {
  return url.startsWith('https://github.com/') || url.startsWith('https://www.github.com/')
}

function warning(input: {
  kind: OverviewWarningKind
  label: string
  days: number | null
  hint: string
  urls: string[]
}): OverviewWarning {
  const targets = [...new Set(input.urls.filter(isGithubUrl))]
  return {
    kind: input.kind,
    label: input.label,
    days: input.days,
    hint: input.hint,
    targets: targets.map(url => ({ url }))
  }
}

function reviewLabel(days: number, extra: number): string {
  const base = `卡住：PR 等 review ${days} 天`
  return extra > 0 ? `${base}，等 ${extra} 个` : base
}

export function classifyRepo(
  facts: OverviewRepoFacts,
  config: OverviewConfig,
  now: Date
): OverviewRow {
  const group = overviewGroup(facts, config, now)
  const stallBasis = stallBasisOf(facts)
  const base: OverviewRow = {
    name: facts.name,
    url: facts.url,
    lastCommitAt: facts.lastCommitAt,
    openPrCount: facts.openPrCount,
    ciState: facts.error ? 'unknown' : facts.ciState,
    warnings: [],
    group,
    stallBasis,
    archived: false,
    error: facts.error
  }
  if (facts.error) return base
  if (facts.archived) {
    return { ...base, archived: true, group: 'archived', warnings: [] }
  }

  const empty = isEmptyRepo(facts)
  const stale = group === 'stale'
  const stalledDays = stallBasis.at ? waitingDays(stallBasis.at, now) : 0
  const stalled = group === 'active' && !empty && Boolean(stallBasis.at) && stalledDays >= config.staleDays
  const stuck = facts.pullRequests
    .filter(pr => isReviewStuck(pr, config, now))
    .map(pr => ({ pr, days: waitingDays(pr.createdAt, now) }))
    .sort((left, right) => right.days - left.days || left.pr.number - right.pr.number)

  const warnings: OverviewWarning[] = []
  if (facts.ciState === 'failure') {
    warnings.push(warning({
      kind: '卡住',
      label: '卡住：CI 失败',
      days: null,
      hint: '默认分支最近一次检查失败',
      urls: [facts.ciFailureUrl || `${facts.url.replace(/\/$/, '')}/actions`]
    }))
  }
  const longest = stuck[0]
  if (longest) {
    warnings.push(warning({
      kind: '卡住',
      label: reviewLabel(longest.days, stuck.length - 1),
      days: longest.days,
      hint: `超过 ${config.reviewWaitDays} 天没有 review`,
      urls: [longest.pr.url]
    }))
  }
  if (stalled) {
    warnings.push(warning({
      kind: '停滞',
      label: `停滞 ${stalledDays} 天`,
      days: stalledDays,
      hint: `默认分支提交和 Issue/PR 活动都超过 ${config.staleDays} 天`,
      urls: [facts.url]
    }))
  }
  if (empty) {
    warnings.push(warning({
      kind: '空仓',
      label: '空仓',
      days: null,
      hint: '仓库没有提交，或体积为 0',
      urls: [facts.url]
    }))
  }
  if (stale && stallBasis.at) {
    warnings.push(warning({
      kind: '陈旧',
      label: '陈旧',
      days: waitingDays(stallBasis.at, now),
      hint: `提交和 Issue/PR 活动超过 ${config.staleRepoDays} 天`,
      urls: [facts.url]
    }))
  }
  warnings.sort((left, right) => WARNING_ORDER.indexOf(left.kind) - WARNING_ORDER.indexOf(right.kind))
  return { ...base, warnings }
}

export function isStaleGroup(row: OverviewRow): boolean {
  return row.group === 'stale'
}

function severity(row: OverviewRow): number {
  if (row.error) return 50
  if (row.warnings.some(item => item.kind === '卡住')) return 0
  if (row.warnings.some(item => item.kind === '停滞')) return 1
  if (row.warnings.some(item => item.kind === '空仓')) return 2
  if (row.ciState === 'failure') return 3
  return 10
}

function timeValue(iso: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY
  const value = Date.parse(iso)
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
}

function byName(left: OverviewRow, right: OverviewRow): number {
  return left.name.localeCompare(right.name)
}

const ATTENTION_KINDS = new Set<OverviewWarningKind>(['卡住', '停滞', '空仓'])

export function countsAsAttention(row: OverviewRow): boolean {
  if (row.archived || row.group === 'stale') return false
  if (row.error) return true
  return row.warnings.some(item => ATTENTION_KINDS.has(item.kind))
}

export function overviewCounts(rows: readonly OverviewRow[]): { repos: number, attention: number } {
  let repos = 0
  let attention = 0
  for (const row of rows) {
    if (row.archived) continue
    repos += 1
    if (countsAsAttention(row)) attention += 1
  }
  return { repos, attention }
}

export function selectOverviewRows(rows: readonly OverviewRow[], includeArchived: boolean): OverviewRow[] {
  if (includeArchived) return [...rows]
  return rows.filter(row => !row.archived)
}

function byCommitThenName(left: OverviewRow, right: OverviewRow): number {
  const time = timeValue(left.lastCommitAt ?? null) - timeValue(right.lastCommitAt ?? null)
  if (time !== 0) return time
  return byName(left, right)
}

export function sortOverviewRows(rows: readonly OverviewRow[]): OverviewRow[] {
  const archived = rows.filter(row => row.group === 'archived' || row.archived).sort(byName)
  const rest = rows.filter(row => row.group !== 'archived' && !row.archived)
  const active = rest.filter(row => row.group !== 'stale')
  const stale = rest.filter(row => row.group === 'stale')
  active.sort((left, right) => {
    const rank = severity(left) - severity(right)
    if (rank !== 0) return rank
    const time = timeValue(left.lastCommitAt) - timeValue(right.lastCommitAt)
    if (time !== 0) return time
    return byName(left, right)
  })
  stale.sort(byCommitThenName)
  return [...active, ...stale, ...archived]
}

export function classifyOverview(
  facts: readonly OverviewRepoFacts[],
  config: OverviewConfig,
  now: Date
): OverviewRow[] {
  return sortOverviewRows(facts.map(item => classifyRepo(item, config, now)))
}
