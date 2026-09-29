import { primaryAction } from './action.js'
import { addDays } from './days.js'
import { annotateIssueFamily } from './sub-issues.js'
import type { DismissalMap, DismissalRecord, WaitingDraft, WaitingRow } from './types.js'

export interface DismissalState {
  items: DismissalMap
  hiddenRepos: string[]
}

export function emptyDismissals(): DismissalMap {
  return {}
}

export function snoozeDraft(map: DismissalMap, id: string, days: 1 | 3 | 7, now: Date): DismissalMap {
  const current = map[id] ?? { snoozeUntil: null, ignored: false, ignoredUpdatedAt: null }
  return {
    ...map,
    [id]: { ...current, snoozeUntil: addDays(now, days).toISOString() }
  }
}

export function ignoreDraft(map: DismissalMap, draft: WaitingDraft): DismissalMap {
  return {
    ...map,
    [draft.id]: {
      snoozeUntil: null,
      ignored: true,
      ignoredUpdatedAt: draft.updatedAt
    }
  }
}

export function restoreDraft(map: DismissalMap, id: string): DismissalMap {
  if (!map[id]) return map
  const next = { ...map }
  delete next[id]
  return next
}

function isNewer(updatedAt: string, seen: string | null): boolean {
  if (!seen) return false
  const next = Date.parse(updatedAt)
  const previous = Date.parse(seen)
  if (!Number.isFinite(next) || !Number.isFinite(previous)) return updatedAt !== seen
  return next > previous
}

function hiddenRepoSet(repos: readonly string[]): Set<string> {
  return new Set(repos.map(repo => repo.toLowerCase()))
}

export function hideRepo(repos: readonly string[], repo: string): string[] {
  const key = repo.toLowerCase()
  if (repos.some(item => item.toLowerCase() === key)) return [...repos]
  return [...repos, repo]
}

export function unhideRepo(repos: readonly string[], repo: string): string[] {
  const key = repo.toLowerCase()
  return repos.filter(item => item.toLowerCase() !== key)
}

export function partitionDismissals(
  drafts: readonly WaitingDraft[],
  map: DismissalMap,
  now: Date,
  showIgnored: boolean,
  hiddenRepos: readonly string[] = []
): { rows: WaitingRow[], hiddenCount: number, map: DismissalMap } {
  let nextMap = map
  const hidden = hiddenRepoSet(hiddenRepos)
  const rows: WaitingRow[] = []
  let hiddenCount = 0
  for (const draft of drafts) {
    if (hidden.has(draft.repo.toLowerCase())) {
      hiddenCount += 1
      continue
    }
    let record: DismissalRecord | undefined = nextMap[draft.id]
    if (record?.ignored && isNewer(draft.updatedAt, record.ignoredUpdatedAt)) {
      nextMap = restoreDraft(nextMap, draft.id)
      record = undefined
    }
    const snoozed = Boolean(record?.snoozeUntil && Date.parse(record.snoozeUntil) > now.getTime())
    const ignored = Boolean(record?.ignored)
    if (snoozed || (ignored && !showIgnored)) {
      hiddenCount += 1
      continue
    }
    rows.push({
      id: draft.id,
      repo: draft.repo,
      number: draft.number,
      type: draft.type,
      title: draft.title,
      url: draft.url,
      reasons: [...draft.reasons],
      action: draft.action || primaryAction(draft.type, draft.reasons),
      waitingDays: draft.waitingDays,
      daysEstimated: draft.daysEstimated,
      updatedAt: draft.updatedAt,
      ignored,
      parentNumber: draft.parentNumber,
      parent: draft.parent,
      childCount: 0
    })
  }
  const listed = annotateIssueFamily(rows)
  return {
    rows: listed.map((row, index) => ({ ...row, ignored: rows[index]?.ignored ?? false })),
    hiddenCount,
    map: nextMap
  }
}

export function readDismissalState(raw: unknown): DismissalState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { items: {}, hiddenRepos: [] }
  const record = raw as Record<string, unknown>
  if (record.version === 2 && record.items && typeof record.items === 'object' && !Array.isArray(record.items)) {
    const hiddenRepos = Array.isArray(record.hiddenRepos)
      ? record.hiddenRepos.filter((repo): repo is string => typeof repo === 'string' && repo.includes('/'))
      : []
    return { items: record.items as DismissalMap, hiddenRepos }
  }
  return { items: raw as DismissalMap, hiddenRepos: [] }
}

export function writeDismissalState(state: DismissalState): { version: 2, items: DismissalMap, hiddenRepos: string[] } {
  return { version: 2, items: state.items, hiddenRepos: [...state.hiddenRepos] }
}
