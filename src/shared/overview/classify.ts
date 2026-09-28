import { waitingDays } from '../waiting/days.js'
import type {
  CiState,
  OverviewConfig,
  OverviewPullRequest,
  OverviewRepoFacts,
  OverviewRow,
  OverviewWarning,
  OverviewWarningKind
} from './types.js'

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

/** Auto mode keeps recent pushes, empty repos, and repos already old enough to be 陈旧. */
export function inAutoScope(
  repo: { isEmpty: boolean, pushedAt: string | null },
  config: OverviewConfig,
  now: Date
): boolean {
  if (repo.isEmpty) return true
  if (!repo.pushedAt) return false
  const age = waitingDays(repo.pushedAt, now)
  if (age >= config.staleRepoDays) return true
  return age <= config.autoPushWindowDays
}

export function isReviewStuck(pr: OverviewPullRequest, config: OverviewConfig, now: Date): boolean {
  if (pr.isDraft) return false
  if (pr.approvedReviewCount > 0) return false
  if (pr.reviewDecision === 'APPROVED' || pr.reviewDecision === 'CHANGES_REQUESTED') return false
  return waitingDays(pr.createdAt, now) >= config.reviewWaitDays
}

function activityAt(facts: OverviewRepoFacts): string | null {
  return facts.lastCommitAt ?? facts.pushedAt
}

function warning(kind: OverviewWarningKind, urls: string[]): OverviewWarning {
  const targets = [...new Set(urls.filter(url => url.startsWith('https://github.com/') || url.startsWith('https://www.github.com/')))]
  return { kind, targets: targets.map(url => ({ url })) }
}

export function classifyRepo(facts: OverviewRepoFacts, config: OverviewConfig, now: Date): OverviewRow {
  const base: OverviewRow = {
    name: facts.name,
    url: facts.url,
    lastCommitAt: facts.lastCommitAt,
    openPrCount: facts.openPrCount,
    ciState: facts.error ? 'unknown' : facts.ciState,
    warnings: [],
    error: facts.error
  }
  if (facts.error) return base

  const empty = isEmptyRepo(facts)
  const stale = !empty && Boolean(facts.pushedAt) && waitingDays(facts.pushedAt as string, now) >= config.staleRepoDays
  const stalled = !empty && !stale && Boolean(activityAt(facts)) && waitingDays(activityAt(facts) as string, now) >= config.staleDays
  const stuck = facts.pullRequests
    .filter(pr => isReviewStuck(pr, config, now))
    .sort((left, right) => left.number - right.number)

  const warnings: OverviewWarning[] = []
  if (stuck.length > 0) warnings.push(warning('卡住', stuck.map(pr => pr.url)))
  if (stalled) warnings.push(warning('停滞', [facts.url]))
  if (empty) warnings.push(warning('空仓', [facts.url]))
  if (stale || (empty && facts.pushedAt && waitingDays(facts.pushedAt, now) >= config.staleRepoDays)) {
    warnings.push(warning('陈旧', [facts.url]))
  }
  warnings.sort((left, right) => WARNING_ORDER.indexOf(left.kind) - WARNING_ORDER.indexOf(right.kind))
  return { ...base, warnings }
}

export function isStaleGroup(row: OverviewRow): boolean {
  return row.warnings.some(item => item.kind === '陈旧')
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

export function sortOverviewRows(rows: readonly OverviewRow[]): OverviewRow[] {
  const active = rows.filter(row => !isStaleGroup(row))
  const stale = rows.filter(row => isStaleGroup(row))
  active.sort((left, right) => {
    const rank = severity(left) - severity(right)
    if (rank !== 0) return rank
    const time = timeValue(left.lastCommitAt) - timeValue(right.lastCommitAt)
    if (time !== 0) return time
    return byName(left, right)
  })
  stale.sort((left, right) => {
    const time = timeValue(left.lastCommitAt ?? null) - timeValue(right.lastCommitAt ?? null)
    if (time !== 0) return time
    return byName(left, right)
  })
  return [...active, ...stale]
}

export function classifyOverview(
  facts: readonly OverviewRepoFacts[],
  config: OverviewConfig,
  now: Date
): OverviewRow[] {
  return sortOverviewRows(facts.map(item => classifyRepo(item, config, now)))
}
