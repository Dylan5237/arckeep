import { primaryAction } from './action.js'
import { waitingDays } from './days.js'
import type { WaitingDraft } from './types.js'

/** Same GitHub issue or pull request, ignoring host case, www, and trailing slash. */
export function issueUrlKey(url: string): string | null {
  try {
    const parsed = new URL(url.trim())
    const host = parsed.host.toLowerCase().replace(/^www\./, '')
    let path = parsed.pathname.replace(/\/+$/, '')
    if (!path) return null
    if (host === 'github.com') path = path.toLowerCase()
    return `https://${host}${path}`
  } catch {
    return null
  }
}

function keyOf(draft: WaitingDraft): string {
  if (draft.type === 'issue' || draft.type === 'pr') {
    const url = issueUrlKey(draft.url)
    if (url) return `url:${url}`
    if (draft.number !== null) return `gh:${draft.repo.toLowerCase()}#${draft.number}`
  }
  return draft.id
}

function preferTitle(current: WaitingDraft, incoming: WaitingDraft): string {
  if (current.type === 'status-doc' && incoming.type !== 'status-doc') return incoming.title
  if (incoming.type === 'status-doc') return current.title
  return current.title || incoming.title
}

/**
 * One row per issue/PR. Reasons merge. A sub-issue keeps its own number,
 * so it is never folded into the parent row.
 */
export function dedupeDrafts(drafts: readonly WaitingDraft[], now: Date): WaitingDraft[] {
  const order: string[] = []
  const merged = new Map<string, WaitingDraft>()
  for (const draft of drafts) {
    const key = keyOf(draft)
    const existing = merged.get(key)
    if (!existing) {
      order.push(key)
      merged.set(key, {
        ...draft,
        id: key,
        reasons: [...draft.reasons],
        reasonDetails: draft.reasonDetails.map(detail => ({ ...detail }))
      })
      continue
    }
    for (const detail of draft.reasonDetails) {
      if (!existing.reasonDetails.some(item => item.reason === detail.reason)) {
        existing.reasonDetails.push({ ...detail })
        existing.reasons.push(detail.reason)
      }
    }
    const incomingUpdated = Date.parse(draft.updatedAt)
    const currentUpdated = Date.parse(existing.updatedAt)
    if (Number.isFinite(incomingUpdated) && (!Number.isFinite(currentUpdated) || incomingUpdated > currentUpdated)) {
      existing.updatedAt = draft.updatedAt
    }
    existing.title = preferTitle(existing, draft)
    if (existing.type === 'status-doc' && draft.type !== 'status-doc') {
      existing.type = draft.type
      existing.url = draft.url || existing.url
      existing.number = draft.number
    }
    if (!existing.url) existing.url = draft.url
    if (existing.number == null && draft.number != null) existing.number = draft.number
    if (!existing.repo && draft.repo) existing.repo = draft.repo
    if (existing.parentNumber == null && draft.parentNumber != null) existing.parentNumber = draft.parentNumber
  }
  for (const draft of merged.values()) {
    applyLongestWait(draft, now)
    draft.action = primaryAction(draft.type, draft.reasons)
  }
  return order.map(key => merged.get(key)).filter((draft): draft is WaitingDraft => Boolean(draft))
}

function applyLongestWait(draft: WaitingDraft, now: Date): void {
  let days = 0
  let estimated = true
  let seen = false
  for (const detail of draft.reasonDetails) {
    if (!detail.at) continue
    const value = waitingDays(detail.at, now)
    if (!seen || value > days || (value === days && estimated && !detail.estimated)) {
      days = value
      estimated = detail.estimated
      seen = true
    }
  }
  if (!seen) {
    draft.waitingDays = 0
    draft.daysEstimated = true
    return
  }
  draft.waitingDays = days
  draft.daysEstimated = estimated
}

export function sortDrafts(drafts: readonly WaitingDraft[]): WaitingDraft[] {
  return [...drafts].sort((left, right) => {
    if (right.waitingDays !== left.waitingDays) return right.waitingDays - left.waitingDays
    const repo = left.repo.localeCompare(right.repo)
    if (repo !== 0) return repo
    return (left.number ?? 0) - (right.number ?? 0) || left.title.localeCompare(right.title)
  })
}
