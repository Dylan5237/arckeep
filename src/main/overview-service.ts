import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { sortOverviewRows } from '../shared/overview/classify.js'
import type { OverviewRow, OverviewSnapshot } from '../shared/overview/types.js'
import { loadOverview } from '../overview/load.js'
import { resolveWaitingToken } from '../waiting/token.js'
import type { GhLookup } from './github-auth.js'
import type { SettingsService } from './settings-service.js'

interface CacheFile {
  version: 1
  refreshedAt: string | null
  rows: OverviewRow[]
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return null
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, file)
}

function loadCache(file: string): { rows: OverviewRow[], refreshedAt: string | null } {
  const raw = readJson(file)
  if (!raw || typeof raw !== 'object') return { rows: [], refreshedAt: null }
  const record = raw as Partial<CacheFile>
  const rows = Array.isArray(record.rows) ? record.rows : []
  return {
    rows,
    refreshedAt: typeof record.refreshedAt === 'string' ? record.refreshedAt : null
  }
}

function mergeRows(fresh: OverviewRow[], previous: OverviewRow[]): OverviewRow[] {
  const seen = new Set(fresh.map(row => row.name.toLowerCase()))
  const kept = previous.filter(row => !seen.has(row.name.toLowerCase()))
  return sortOverviewRows([...fresh, ...kept])
}

export class OverviewService {
  private rows: OverviewRow[]
  private refreshedAt: string | null
  private snapshot: OverviewSnapshot

  constructor(
    private readonly settings: SettingsService,
    private readonly cacheFile: string,
    private readonly deps: {
      env?: NodeJS.ProcessEnv
      readGh?: () => Promise<GhLookup>
      fetchImpl?: typeof fetch
      now?: () => Date
      log?: (message: string) => void
    } = {}
  ) {
    const cached = loadCache(cacheFile)
    this.rows = cached.rows
    this.refreshedAt = cached.refreshedAt
    this.snapshot = {
      rows: this.rows,
      refreshedAt: this.refreshedAt,
      refreshing: false,
      auth: 'ok',
      rateLimitResetAt: null,
      sourceErrors: [],
      notices: []
    }
  }

  current(): OverviewSnapshot {
    return this.snapshot
  }

  async refresh(): Promise<OverviewSnapshot> {
    const stored = this.settings.getSettings()
    const env = this.deps.env ?? process.env
    const now = this.deps.now?.() ?? new Date()
    const access = await resolveWaitingToken({
      readGh: this.deps.readGh,
      envToken: env.GITHUB_TOKEN ?? null,
      readSaved: () => this.settings.readSavedPat()
    })
    if (!access.token) {
      this.snapshot = {
        rows: this.rows,
        refreshedAt: this.refreshedAt,
        refreshing: false,
        auth: 'missing',
        rateLimitResetAt: null,
        sourceErrors: [],
        notices: []
      }
      return this.snapshot
    }
    const result = await loadOverview({
      token: access.token,
      config: stored.overview,
      watchedRepos: stored.watchedRepos,
      now,
      fetchImpl: this.deps.fetchImpl
    })
    if (result.auth === 'invalid') {
      this.rows = []
      this.snapshot = {
        rows: [],
        refreshedAt: this.refreshedAt,
        refreshing: false,
        auth: 'invalid',
        rateLimitResetAt: null,
        sourceErrors: result.errors,
        notices: result.notices
      }
      return this.snapshot
    }
    if (result.fresh) {
      this.rows = result.rows
      if (!result.rateLimitResetAt) this.refreshedAt = now.toISOString()
    } else {
      this.rows = mergeRows(result.rows, this.rows)
    }
    this.persist()
    this.snapshot = {
      rows: this.rows,
      refreshedAt: this.refreshedAt,
      refreshing: false,
      auth: 'ok',
      rateLimitResetAt: result.rateLimitResetAt,
      sourceErrors: result.errors,
      notices: result.notices
    }
    if (result.errors.length > 0) {
      this.deps.log?.(result.errors.map(error => `${error.source}: ${error.message}`).join('; '))
    }
    return this.snapshot
  }

  private persist(): void {
    const payload: CacheFile = { version: 1, refreshedAt: this.refreshedAt, rows: this.rows }
    writeJson(this.cacheFile, payload)
  }
}
