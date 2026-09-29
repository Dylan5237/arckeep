import { primaryAction } from './action.js'
import { addDays } from './days.js'
import { annotateIssueFamily } from './sub-issues.js'
import type { DismissalMap, DismissalRecord, WaitingDraft, WaitingRow } from './types.js'

export interface DismissalState {
  items: DismissalMap
  hiddenRepos: string[]
  revealedParked: string[]
  maybeWhenEmpty: boolean | null
  maybeWhenListed: boolean | null
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
      if (!showIgnored) hiddenCount += 1
      continue
    }
    let record: DismissalRecord | undefined = nextMap[draft.id]
    if (record?.ignored && isNewer(draft.updatedAt, record.ignoredUpdatedAt)) {
      nextMap = restoreDraft(nextMap, draft.id)
      record = undefined
    }
    const snoozed = Boolean(record?.snoozeUntil && Date.parse(record.snoozeUntil) > now.getTime())
    const ignored = Boolean(record?.ignored)
    const deferred = snoozed || ignored
    if (deferred) hiddenCount += 1
    if (deferred && !showIgnored) continue
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
      ignored: deferred,
      parentNumber: draft.parentNumber,
      parent: draft.parent,
      childCount: 0,
      signalText: draft.tier === 'weak' ? draft.signal.excerpt.trim() : (draft.signal.excerpt || draft.signal.rule),
      tier: draft.tier
    })
  }
  const listed = annotateIssueFamily(rows)
  return {
    rows: listed.map((row, index) => ({ ...row, ignored: rows[index]?.ignored ?? false })),
    hiddenCount,
    map: nextMap
  }
}

function repoNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((repo): repo is string => typeof repo === 'string' && repo.includes('/'))
}

function optionalFlag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

export function readDismissalState(raw: unknown): DismissalState {
  const empty = { items: {}, hiddenRepos: [], revealedParked: [], maybeWhenEmpty: null, maybeWhenListed: null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const record = raw as Record<string, unknown>
  if (record.version === 2 && record.items && typeof record.items === 'object' && !Array.isArray(record.items)) {
    return {
      items: record.items as DismissalMap,
      hiddenRepos: repoNames(record.hiddenRepos),
      revealedParked: repoNames(record.revealedParked),
      maybeWhenEmpty: optionalFlag(record.maybeWhenEmpty),
      maybeWhenListed: optionalFlag(record.maybeWhenListed)
    }
  }
  return { ...empty, items: raw as DismissalMap }
}

export function writeDismissalState(state: Omit<DismissalState, 'revealedParked' | 'maybeWhenEmpty' | 'maybeWhenListed'> & {
  revealedParked?: string[]
  maybeWhenEmpty?: boolean | null
  maybeWhenListed?: boolean | null
}): { version: 2, items: DismissalMap, hiddenRepos: string[], revealedParked: string[], maybeWhenEmpty: boolean | null, maybeWhenListed: boolean | null } {
  return {
    version: 2,
    items: state.items,
    hiddenRepos: [...state.hiddenRepos],
    revealedParked: [...(state.revealedParked ?? [])],
    maybeWhenEmpty: state.maybeWhenEmpty ?? null,
    maybeWhenListed: state.maybeWhenListed ?? null
  }
}

export function effectiveHiddenRepos(userHidden: readonly string[], parked: readonly string[], revealed: readonly string[]): string[] {
  const shown = new Set(revealed.map(repo => repo.toLowerCase()))
  const names = new Map<string, string>()
  for (const repo of userHidden) names.set(repo.toLowerCase(), repo)
  for (const repo of parked) {
    if (!shown.has(repo.toLowerCase())) names.set(repo.toLowerCase(), repo)
  }
  return [...names.values()]
}
