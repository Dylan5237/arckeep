import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { parseGithubRemote } from '../../shared/claude-sessions.js'

const execFileAsync = promisify(execFile)
const SUCCESS_TTL_MS = 5 * 60 * 1000
const FAILURE_TTL_MS = 60 * 1000
const CONCURRENCY = 4

export interface ProjectIdentity {
  repo: string
  name: string
}

interface CacheEntry {
  at: number
  value: ProjectIdentity
}

const cache = new Map<string, CacheEntry>()

function fallback(cwd: string): ProjectIdentity {
  const base = path.basename(cwd) || 'project'
  const slug = base.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project'
  return { repo: 'local/' + slug, name: base }
}

async function resolveUncached(cwd: string, now: number): Promise<ProjectIdentity> {
  const key = path.resolve(cwd).toLowerCase()
  const cached = cache.get(key)
  if (cached) {
    const ttl = cached.value.repo.startsWith('local/') ? FAILURE_TTL_MS : SUCCESS_TTL_MS
    if (now - cached.at < ttl) return cached.value
  }
  let value = fallback(cwd)
  if (existsSync(cwd)) {
    try {
      const result = await execFileAsync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8', windowsHide: true, timeout: 3_000, maxBuffer: 4096
      })
      const repo = parseGithubRemote(result.stdout)
      if (repo) value = { repo, name: repo.split('/')[1] ?? repo }
    } catch {
      // Not a git checkout or no origin; keep the local label.
    }
  }
  cache.set(key, { at: now, value })
  return value
}

export async function projectIdentities(
  cwds: readonly string[],
  options: { now?: () => number } = {}
): Promise<Map<string, ProjectIdentity>> {
  const now = options.now?.() ?? Date.now()
  const unique = [...new Set(cwds.map(cwd => path.resolve(cwd)))]
  const result = new Map<string, ProjectIdentity>()
  let cursor = 0
  const workers = Array.from({ length: Math.min(CONCURRENCY, unique.length) }, async () => {
    while (cursor < unique.length) {
      const cwd = unique[cursor++]
      result.set(cwd, await resolveUncached(cwd, now))
    }
  })
  await Promise.all(workers)
  return result
}

export function clearProjectIdentityCache(): void {
  cache.clear()
}
