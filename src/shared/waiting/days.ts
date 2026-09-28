const DAY_MS = 86_400_000

/** Whole days between an event and now. Future events count as zero. */
export function waitingDays(eventIso: string, now: Date): number {
  const eventMs = Date.parse(eventIso)
  if (!Number.isFinite(eventMs)) return 0
  const elapsed = now.getTime() - eventMs
  if (elapsed <= 0) return 0
  return Math.floor(elapsed / DAY_MS)
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS)
}

/**
 * Empty repositories and repositories with no push for more than 30 days
 * stay off this page (they belong on the project overview).
 * A missing push time is not treated as stale.
 */
export function repoIsOnWaitingPage(
  repo: { isEmpty: boolean, pushedAt: string | null },
  now: Date
): boolean {
  if (repo.isEmpty) return false
  if (!repo.pushedAt) return true
  return waitingDays(repo.pushedAt, now) <= 30
}

export function laterIso(left: string | null, right: string | null): string | null {
  if (!left) return right
  if (!right) return left
  const l = Date.parse(left)
  const r = Date.parse(right)
  if (!Number.isFinite(l)) return right
  if (!Number.isFinite(r)) return left
  return l >= r ? left : right
}

export function earlierIso(left: string | null, right: string | null): string | null {
  if (!left) return right
  if (!right) return left
  const l = Date.parse(left)
  const r = Date.parse(right)
  if (!Number.isFinite(l)) return right
  if (!Number.isFinite(r)) return left
  return l <= r ? left : right
}
