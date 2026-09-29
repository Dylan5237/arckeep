import { classifyOverview } from './classify.js'
import { defaultOverviewConfig } from './rules.js'
import type { CiState, OverviewPullRequest, OverviewRepoFacts, OverviewRow } from './types.js'

const SAMPLE_NOW = new Date('2026-09-28T12:00:00.000Z')

function ago(days: number): string {
  return new Date(SAMPLE_NOW.getTime() - days * 86_400_000).toISOString()
}

function pull(owner: string, repo: string, number: number, days: number, draft = false): OverviewPullRequest {
  return {
    number,
    title: `等待 review 的改动 ${number}`,
    url: `https://github.com/${owner}/${repo}/pull/${number}`,
    isDraft: draft,
    createdAt: ago(days),
    reviewDecision: draft ? null : 'REVIEW_REQUIRED',
    approvedReviewCount: 0
  }
}

function repo(input: {
  owner: string
  name: string
  days?: number
  createdDays?: number
  empty?: boolean
  sizeKb?: number | null
  commit?: boolean
  ci?: CiState
  pulls?: OverviewPullRequest[]
  openPrCount?: number
  error?: string
  archived?: boolean
}): OverviewRepoFacts {
  const full = `${input.owner}/${input.name}`
  const empty = input.empty === true
  const hasCommit = input.commit !== false && !empty
  return {
    name: full,
    url: `https://github.com/${full}`,
    isEmpty: empty,
    sizeKb: input.sizeKb === undefined ? (empty ? 0 : 128) : input.sizeKb,
    hasDefaultBranchCommit: hasCommit,
    pushedAt: input.days === undefined ? null : ago(input.days),
    createdAt: input.createdDays !== undefined
      ? ago(input.createdDays)
      : input.days === undefined ? null : ago(input.days),
    lastCommitAt: hasCommit && input.days !== undefined ? ago(input.days) : null,
    lastIssueActivityAt: null,
    openPrCount: input.openPrCount ?? input.pulls?.length ?? 0,
    ciState: input.ci ?? (empty ? 'none' : 'success'),
    ciFailureUrl: input.ci === 'failure' ? `https://github.com/${full}/actions/runs/100${input.name.length}` : null,
    pullRequests: input.pulls ?? [],
    archived: input.archived === true,
    error: input.error ?? null
  }
}

/** Synthetic rows for screenshots. Names are fictional and are not detection rules. */
export function sampleOverviewFacts(): OverviewRepoFacts[] {
  const active: OverviewRepoFacts[] = [
    repo({ owner: 'harbor', name: 'lumen', days: 1, ci: 'success', pulls: [pull('harbor', 'lumen', 18, 1)] }),
    repo({ owner: 'harbor', name: 'keel', days: 6, ci: 'failure', pulls: [pull('harbor', 'keel', 9, 6)] }),
    repo({ owner: 'harbor', name: 'atlas', days: 4, ci: 'pending', pulls: [pull('harbor', 'atlas', 4, 5)] }),
    repo({ owner: 'northline', name: 'ferry', days: 8, ci: 'failure', pulls: [pull('northline', 'ferry', 3, 8), pull('northline', 'ferry', 7, 2)] }),
    repo({ owner: 'paperlane', name: 'margin', days: 20, ci: 'none' }),
    repo({ owner: 'paperlane', name: 'folio', days: 16, ci: 'success' }),
    repo({ owner: 'harbor', name: 'drift', days: 30, ci: 'failure' }),
    repo({ owner: 'northline', name: 'berth', days: 18, ci: 'pending' }),
    repo({ owner: 'keel', name: 'ledger', days: 22, ci: 'none' }),
    repo({ owner: 'harbor', name: 'blank', empty: true, days: 2, ci: 'none' }),
    repo({ owner: 'northline', name: 'vacant', empty: true, sizeKb: 0, commit: false, createdDays: 900, ci: 'none' }),
    repo({ owner: 'paperlane', name: 'unborn', days: 4, sizeKb: 40, commit: false, ci: 'none' }),
    repo({ owner: 'harbor', name: 'signal', days: 2, ci: 'failure' }),
    repo({ owner: 'northline', name: 'pilot', days: 1, ci: 'success' }),
    repo({ owner: 'paperlane', name: 'quire', days: 3, ci: 'pending' }),
    repo({ owner: 'keel', name: 'harbor-notes', days: 5, ci: 'success' }),
    repo({ owner: 'harbor', name: 'wick', days: 2, ci: 'none' }),
    repo({ owner: 'northline', name: 'spar', days: 9, ci: 'success', pulls: [pull('northline', 'spar', 2, 1, true)] })
  ]
  const staleOwners = ['harbor', 'northline', 'paperlane', 'keel']
  const staleNames = ['archive', 'old-map', 'cellar', 'mothballed', 'attic', 'dust', 'crate', 'trunk', 'loft', 'vault', 'shelf', 'bin', 'cask', 'hold']
  const stale = staleNames.map((name, index) => repo({
    owner: staleOwners[index % staleOwners.length] ?? 'harbor',
    name,
    days: 120 + index * 15,
    ci: index % 4 === 0 ? 'failure' : 'none'
  }))
  return [...active, ...stale]
}

export function sampleOverviewRows(): OverviewRow[] {
  return classifyOverview(sampleOverviewFacts(), defaultOverviewConfig(), SAMPLE_NOW)
}

export function sampleOverviewArchivedRows(): OverviewRow[] {
  const facts = [
    repo({ owner: 'harbor', name: 'lumen', days: 1, ci: 'success' }),
    repo({ owner: 'harbor', name: 'keel', days: 6, ci: 'failure', pulls: [pull('harbor', 'keel', 9, 6)] }),
    repo({ owner: 'paperlane', name: 'margin', days: 20, ci: 'none' }),
    repo({
      owner: 'harbor',
      name: 'mothball',
      days: 400,
      ci: 'failure',
      archived: true,
      pulls: [pull('harbor', 'mothball', 2, 40)]
    }),
    repo({ owner: 'paperlane', name: 'shell', empty: true, archived: true, ci: 'none' }),
    repo({ owner: 'northline', name: 'closed', days: 200, archived: true, ci: 'none' })
  ]
  return classifyOverview(facts, { ...defaultOverviewConfig(), showArchived: true }, SAMPLE_NOW)
}

export function sampleOverviewErrorRows(): OverviewRow[] {
  const facts = [
    repo({ owner: 'harbor', name: 'lumen', days: 1, ci: 'success' }),
    repo({ owner: 'harbor', name: 'keel', days: 6, ci: 'failure', pulls: [pull('harbor', 'keel', 9, 6)] }),
    repo({ owner: 'paperlane', name: 'folio', days: 16, ci: 'success' }),
    repo({ owner: 'harbor', name: 'blank', empty: true, ci: 'none' }),
    repo({ owner: 'northline', name: 'missing', error: '仓库不存在或无权访问' })
  ]
  return classifyOverview(facts, defaultOverviewConfig(), SAMPLE_NOW).map(row => (
    row.error ? { ...row, fromWatchList: true } : row
  ))
}
