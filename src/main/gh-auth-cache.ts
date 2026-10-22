import { readGhAuthToken, type GhLookup, type GithubAuthTaskOptions } from './github-auth.js'

/** Successes and failures are reused so navigation never re-spawns the CLI; an explicit connection test invalidates. */
const SUCCESS_TTL_MS = 5 * 60_000
const FAILURE_TTL_MS = 5 * 60_000

export type GhAuthReader = (
  context?: GithubAuthTaskOptions,
  log?: (message: string) => void
) => Promise<GhLookup>

export interface GhAuthCacheOptions {
  read?: GhAuthReader
  now?: () => number
  successTtlMs?: number
  failureTtlMs?: number
}

export interface GhAuthCache {
  read: GhAuthReader
  invalidate: () => void
}

interface CacheEntry {
  lookup: Promise<GhLookup>
  expiresAt: number
}

/**
 * Shares one `gh auth token` lookup across navigation-driven state reads.
 * Concurrent callers reuse the in-flight promise; later callers reuse the
 * resolved value until the TTL lapses.
 */
export function createGhAuthCache(options: GhAuthCacheOptions = {}): GhAuthCache {
  const read = options.read ?? (
    (context, log) => readGhAuthToken(undefined, log ?? (() => {}), context)
  )
  const now = options.now ?? Date.now
  const successTtlMs = options.successTtlMs ?? SUCCESS_TTL_MS
  const failureTtlMs = options.failureTtlMs ?? FAILURE_TTL_MS
  let entry: CacheEntry | null = null

  return {
    read(context = {}, log = () => {}) {
      const at = now()
      if (entry && at < entry.expiresAt) return entry.lookup
      const lookup = read(context, log)
      const created: CacheEntry = { lookup, expiresAt: at + successTtlMs }
      entry = created
      void lookup.then(result => {
        if (entry !== created) return
        created.expiresAt = now() + (result.ok ? successTtlMs : failureTtlMs)
      }, () => {
        if (entry === created) entry = null
      })
      return lookup
    },
    invalidate() {
      entry = null
    }
  }
}

const sharedCache = createGhAuthCache()

export const readGhAuthTokenCached: GhAuthReader = sharedCache.read

export function invalidateGhAuthTokenCache(): void {
  sharedCache.invalidate()
}
