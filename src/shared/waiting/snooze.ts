import { addDays } from './days.js'
import type { DismissalMap, DismissalRecord, WaitingDraft, WaitingRow } from './types.js'

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

export function partitionDismissals(
  drafts: readonly WaitingDraft[],
  map: DismissalMap,
  now: Date,
  showIgnored: boolean
): { rows: WaitingRow[], hiddenCount: number, map: DismissalMap } {
  let nextMap = map
  const rows: WaitingRow[] = []
  let hiddenCount = 0
  for (const draft of drafts) {
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
      waitingDays: draft.waitingDays,
      daysEstimated: draft.daysEstimated,
      updatedAt: draft.updatedAt,
      ignored
    })
  }
  return { rows, hiddenCount, map: nextMap }
}
