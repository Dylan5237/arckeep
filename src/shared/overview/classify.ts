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
  const activity = activityAt(facts)
  const stalledDays = activity ? waitingDays(activity, now) : 0
  const stalled = !empty && !stale && Boolean(activity) && stalledDays >= config.staleDays
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
      hint: `超过 ${config.staleDays} 天没有新提交`,
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
  const staleByPush = Boolean(facts.pushedAt) && waitingDays(facts.pushedAt as string, now) >= config.staleRepoDays
  if (stale || (empty && staleByPush)) {
    warnings.push(warning({
      kind: '陈旧',
      label: '陈旧',
      days: facts.pushedAt ? waitingDays(facts.pushedAt, now) : null,
      hint: `超过 ${config.staleRepoDays} 天没有推送`,
      urls: [facts.url]
    }))
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
