export const REPO_FETCH_WINDOWS = ['3d', '7d', '15d', '30d', 'all'] as const
export type RepoFetchWindow = (typeof REPO_FETCH_WINDOWS)[number]
export const DEFAULT_REPO_FETCH_WINDOW: RepoFetchWindow = '7d'

export function parseRepoFetchWindow(value: unknown): RepoFetchWindow {
  if (value === undefined) return DEFAULT_REPO_FETCH_WINDOW
  if (typeof value === 'string' && REPO_FETCH_WINDOWS.includes(value as RepoFetchWindow)) return value as RepoFetchWindow
  throw new Error('仓库时间范围只能选近 3 天、7 天、15 天、30 天或全部')
}

/** Caches written before this feature contain a full-range scan. */
export function cachedRepoFetchWindow(value: unknown): RepoFetchWindow {
  try { return value === undefined ? 'all' : parseRepoFetchWindow(value) } catch { return 'all' }
}

export function repoFetchWindowLabel(window: RepoFetchWindow): string {
  return window === 'all' ? '全部仓库' : `近 ${window.slice(0, -1)} 天推送的仓库`
}

export function repoPushCutoff(window: RepoFetchWindow, now: Date): number | null {
  if (window === 'all') return null
  const current = now.getTime()
  if (!Number.isFinite(current)) throw new Error('仓库查询时间无效')
  return current - Number(window.slice(0, -1)) * 86_400_000
}

function pushedTime(node: unknown): number {
  if (!node || typeof node !== 'object') return NaN
  if ('pushedAt' in node && node.pushedAt === null) return NaN
  if (!('pushedAt' in node) || typeof node.pushedAt !== 'string' || !Number.isFinite(Date.parse(node.pushedAt))) {
    throw new Error('GitHub 返回的仓库推送时间不完整，已保留上次结果')
  }
  return Date.parse(node.pushedAt)
}

export function repoPushedInWindow(node: unknown, cutoff: number | null): boolean {
  return cutoff === null || pushedTime(node) >= cutoff
}

/** The caller requests PUSHED_AT DESC; stop pagination at the first dated older repo. */
export function recentRepoPage<T>(nodes: readonly T[], cutoff: number | null): { nodes: T[], reachedCutoff: boolean } {
  if (cutoff === null) return { nodes: [...nodes], reachedCutoff: false }
  const selected: T[] = []
  for (const node of nodes) {
    const pushed = pushedTime(node)
    if (Number.isFinite(pushed) && pushed < cutoff) return { nodes: selected, reachedCutoff: true }
    // Never-pushed repositories do not belong to a finite push window. An
    // absent timestamp is also insufficient evidence to stop the ordered list.
    if (pushed >= cutoff) selected.push(node)
  }
  return { nodes: selected, reachedCutoff: false }
}
