import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { sortOverviewRows } from '../shared/overview/classify.js'
import type { OverviewRow, OverviewSnapshot } from '../shared/overview/types.js'
import { loadOverview } from '../overview/load.js'
import { resolveWaitingToken, waitingTokenIdentityHash, type WaitingTokenVia } from '../waiting/token.js'
import type { GhLookup } from './github-auth.js'
import type { SettingsService } from './settings-service.js'
import { abortable, isCancellation, throwIfCancelled, TaskScope } from '../shared/task-scope.js'
import { isCommandCenterRead, retainCommandCenter } from '../shared/overview/command-center-types.js'
import { cachedRepoFetchWindow, type RepoFetchWindow } from '../shared/repo-fetch-window.js'

interface CacheFile {
  version: 2
  repoFetchWindow?: RepoFetchWindow
  refreshedAt: string | null
  configKey?: string | null
  identityHash?: string | null
  rows: OverviewRow[]
}

interface RefreshInputs {
  repoFetchWindow: RepoFetchWindow
  config: NonNullable<ReturnType<SettingsService['getSettings']>['overview']>
  watchedRepos: string[]
  patCiphertext: string | null
  envToken: string | null
}

interface RefreshRequest {
  repoFetchWindow: RepoFetchWindow
  key: string
  config: RefreshInputs['config']
  watchedRepos: string[]
  token: string | null
  identityHash: string | null
}

interface RefreshFlight {
  key: string
  promise: Promise<OverviewSnapshot>
}

interface SuccessfulRefresh {
  key: string
  completedAt: number
}

const SUCCESS_CACHE_TTL_MS = 60_000

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

function loadCache(file: string): {
  repoFetchWindow: RepoFetchWindow
  rows: OverviewRow[]
  refreshedAt: string | null
  configKey: string | null
  identityHash: string | null
} {
  const raw = readJson(file)
  if (!raw || typeof raw !== 'object') return { repoFetchWindow: 'all', rows: [], refreshedAt: null, configKey: null, identityHash: null }
  const record = raw as Partial<CacheFile>
  const rawRows = Array.isArray(record.rows) ? record.rows.filter(row => row && typeof row === 'object' && typeof row.name === 'string') : []
  const rows = rawRows.map(row => ({ ...row, commandCenter: isCommandCenterRead(row.commandCenter, row.name) ? row.commandCenter : undefined }))
  return {
    repoFetchWindow: cachedRepoFetchWindow(record.repoFetchWindow),
    rows,
    refreshedAt: typeof record.refreshedAt === 'string' ? record.refreshedAt : null,
    configKey: rows.some(row => !row.commandCenter) ? null : typeof record.configKey === 'string' ? record.configKey : null,
    identityHash: typeof record.identityHash === 'string' ? record.identityHash : null
  }
}

function mergeRows(fresh: OverviewRow[], previous: OverviewRow[], checkedAt: string): OverviewRow[] {
  const seen = new Set(fresh.map(row => row.name.toLowerCase()))
  const kept = previous.filter(row => !seen.has(row.name.toLowerCase())).map(row => ({
    ...row, commandCenter: retainCommandCenter(row.commandCenter, '本次未完成读取，显示上次记录', checkedAt)
  }))
  return sortOverviewRows([...fresh, ...kept])
}

export class OverviewService {
  private dataRepoFetchWindow: RepoFetchWindow
  private readonly tasks: TaskScope
  private rows: OverviewRow[]
  private refreshedAt: string | null
  private cachedRows: OverviewRow[]
  private cachedRefreshedAt: string | null
  private persistedConfigKey: string | null
  private persistedIdentityHash: string | null
  private currentIdentityHash: string | null = null
  private identityActivated = false
  private snapshot: OverviewSnapshot
  private activeRefresh: RefreshFlight | null = null
  private successfulRefresh: SuccessfulRefresh | null = null
  private authFlight: { key: string, promise: Promise<{ token: string | null, via: WaitingTokenVia }> } | null = null

  constructor(
    private readonly settings: SettingsService,
    private readonly cacheFile: string,
    private readonly deps: {
      env?: NodeJS.ProcessEnv
      readGh?: (options?: { signal?: AbortSignal, tasks?: TaskScope }) => Promise<GhLookup>
      fetchImpl?: typeof fetch
      now?: () => Date
      log?: (message: string) => void
      tasks?: TaskScope
    } = {}
  ) {
    this.tasks = deps.tasks ?? new TaskScope()
    const cached = loadCache(cacheFile)
    this.dataRepoFetchWindow = cached.repoFetchWindow
    this.rows = []
    this.refreshedAt = null
    this.cachedRows = cached.rows
    this.cachedRefreshedAt = cached.refreshedAt
    this.persistedConfigKey = cached.configKey
    this.persistedIdentityHash = cached.identityHash
    this.snapshot = {
      repoFetchWindow: this.dataRepoFetchWindow,
      rows: this.rows,
      refreshedAt: this.refreshedAt,
      refreshing: false,
      auth: 'unknown',
      rateLimitResetAt: null,
      sourceErrors: [],
      notices: []
    }
  }

  current(): OverviewSnapshot {
    if (!this.identityActivated) this.snapshot = { ...this.snapshot, repoFetchWindow: this.settings.getSettings().repoFetchWindow }
    return this.snapshot
  }

  refresh(force = true): Promise<OverviewSnapshot> {
    if (!this.tasks.isClosing) {
      this.snapshot = {
        ...this.snapshot,
        refreshing: true,
        auth: this.snapshot.auth === 'ok' ? 'ok' : 'unknown',
        sourceErrors: this.snapshot.auth === 'missing' || this.snapshot.auth === 'invalid' ? [] : this.snapshot.sourceErrors
      }
    }
    return this.tasks.run(signal => this.requestRefresh(force, signal), '总览刷新').catch(error => {
      if (!this.activeRefresh && this.snapshot.refreshing) this.snapshot = { ...this.snapshot, refreshing: false }
      throw error
    })
  }

  close(): void {
    this.tasks.close()
  }

  shutdown(timeoutMs = 12_000): Promise<void> {
    return this.tasks.drain(timeoutMs)
  }

  private async requestRefresh(force: boolean, signal: AbortSignal): Promise<OverviewSnapshot> {
    throwIfCancelled(signal)
    let request = await this.captureRefreshRequest(signal)
    while (true) {
      throwIfCancelled(signal)
      const active = this.activeRefresh
      if (active) {
        if (active.key === request.key) return abortable(active.promise, signal)
        await abortable(active.promise.catch(() => undefined), signal)
        throwIfCancelled(signal)
        request = await this.captureRefreshRequest(signal)
        continue
      }
      this.activateIdentity(request)
      if (this.isCoolingDown()) {
        this.snapshot = { ...this.snapshot, refreshing: false }
        return this.snapshot
      }
      if (this.snapshot.rateLimitResetAt) {
        this.snapshot = { ...this.snapshot, rateLimitResetAt: null }
      }
      if (!force && this.hasFreshSuccess(request.key)) {
        this.snapshot = { ...this.snapshot, refreshing: false }
        return this.snapshot
      }
      return this.startRefresh(request, signal)
    }
  }

  private captureRefreshInputs(): RefreshInputs {
    const stored = this.settings.getSettings()
    const watchedRepos = [...stored.watchedRepos]
    const config = JSON.parse(JSON.stringify(stored.overview)) as RefreshRequest['config']
    const patCiphertext = stored.patCiphertext
    const env = this.deps.env ?? process.env
    return { config, watchedRepos, repoFetchWindow: stored.repoFetchWindow, patCiphertext, envToken: env.GITHUB_TOKEN ?? null }
  }

  private async captureRefreshRequest(signal: AbortSignal): Promise<RefreshRequest> {
    const inputs = this.captureRefreshInputs()
    const authInputKey = createHash('sha256')
      .update(JSON.stringify({ envToken: inputs.envToken, patCiphertext: inputs.patCiphertext }))
      .digest('hex')
    let accessPromise: Promise<{ token: string | null, via: WaitingTokenVia }>
    if (this.authFlight?.key === authInputKey) {
      accessPromise = this.authFlight.promise
    } else {
      const operation = resolveWaitingToken({
        readGh: this.deps.readGh,
        envToken: inputs.envToken,
        signal,
        tasks: this.tasks,
        readSaved: () => this.settings.getSettings().patCiphertext === inputs.patCiphertext
          ? this.settings.readSavedPat()
          : null
      })
      const promise = operation.finally(() => {
        if (this.authFlight?.promise === promise) this.authFlight = null
      })
      this.authFlight = { key: authInputKey, promise }
      accessPromise = promise
    }
    const access = await abortable(accessPromise, signal)
    throwIfCancelled(signal)
    if (JSON.stringify(inputs) !== JSON.stringify(this.captureRefreshInputs())) {
      return this.captureRefreshRequest(signal)
    }
    const identityHash = waitingTokenIdentityHash(access)
    const key = createHash('sha256')
      .update(JSON.stringify({ viewSchema: 2, watchedRepos: inputs.watchedRepos, repoFetchWindow: inputs.repoFetchWindow, config: inputs.config, identityHash }))
      .digest('hex')
    return {
      key,
      repoFetchWindow: inputs.repoFetchWindow,
      config: inputs.config,
      watchedRepos: inputs.watchedRepos,
      token: access.token,
      identityHash
    }
  }

  private hasFreshSuccess(key: string): boolean {
    if (!this.successfulRefresh || this.successfulRefresh.key !== key) return false
    const age = (this.deps.now?.() ?? new Date()).getTime() - this.successfulRefresh.completedAt
    return age >= 0 && age < SUCCESS_CACHE_TTL_MS
  }

  private isCoolingDown(): boolean {
    const resetAt = this.snapshot.rateLimitResetAt
    if (!resetAt) return false
    const resetTime = Date.parse(resetAt)
    const now = (this.deps.now?.() ?? new Date()).getTime()
    return Number.isFinite(resetTime) && resetTime > now
  }

  private restoreSuccessfulRefresh(request: RefreshRequest): void {
    const configKey = this.persistedConfigKey
    if (!request.identityHash || !configKey || !this.refreshedAt || configKey !== request.key) return
    const completedAt = Date.parse(this.refreshedAt)
    const age = (this.deps.now?.() ?? new Date()).getTime() - completedAt
    if (Number.isFinite(completedAt) && age >= 0 && age < SUCCESS_CACHE_TTL_MS) {
      this.successfulRefresh = { key: configKey, completedAt }
    }
  }

  private activateIdentity(request: RefreshRequest): void {
    const sameActiveIdentity = this.identityActivated && this.currentIdentityHash === request.identityHash
    const sameWindow = this.dataRepoFetchWindow === request.repoFetchWindow
    if (sameActiveIdentity && sameWindow) return

    const matchesCachedIdentity = !this.identityActivated
      && request.identityHash !== null
      && this.persistedIdentityHash === request.identityHash
    this.rows = matchesCachedIdentity && sameWindow ? this.cachedRows : []
    this.refreshedAt = matchesCachedIdentity && sameWindow ? this.cachedRefreshedAt : null
    this.dataRepoFetchWindow = request.repoFetchWindow
    this.cachedRows = []
    this.cachedRefreshedAt = null
    this.currentIdentityHash = request.identityHash
    this.persistedIdentityHash = request.identityHash
    this.identityActivated = true
    if (!matchesCachedIdentity || !sameWindow) {
      this.persistedConfigKey = null
      this.successfulRefresh = null
    } else {
      this.restoreSuccessfulRefresh(request)
    }
    this.snapshot = {
      ...this.snapshot,
      repoFetchWindow: request.repoFetchWindow,
      rows: this.rows,
      refreshedAt: this.refreshedAt,
      auth: request.token ? 'ok' : 'missing',
      rateLimitResetAt: sameActiveIdentity ? this.snapshot.rateLimitResetAt : null,
      sourceErrors: sameActiveIdentity ? this.snapshot.sourceErrors : [],
      notices: []
    }
  }

  private startRefresh(request: RefreshRequest, signal: AbortSignal): Promise<OverviewSnapshot> {
    const previousSuccessful = this.successfulRefresh
    this.successfulRefresh = null
    this.snapshot = { ...this.snapshot, refreshing: true }
    const operation = this.executeRefresh(request, signal, previousSuccessful)
    const promise = operation.finally(() => {
      if (this.activeRefresh?.promise === promise) this.activeRefresh = null
    })
    this.activeRefresh = { key: request.key, promise }
    return promise
  }

  private async executeRefresh(
    request: RefreshRequest,
    signal: AbortSignal,
    previousSuccessful: SuccessfulRefresh | null
  ): Promise<OverviewSnapshot> {
    try {
      throwIfCancelled(signal)
      if (!request.token) {
        this.persist(this.rows, this.refreshedAt, null, request.identityHash)
        this.snapshot = {
          repoFetchWindow: request.repoFetchWindow,
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
      const queriedAt = this.deps.now?.() ?? new Date()
      const result = await abortable(loadOverview({
        token: request.token,
        config: request.config,
        watchedRepos: request.watchedRepos,
        repoFetchWindow: request.repoFetchWindow,
        now: queriedAt,
        fetchImpl: this.deps.fetchImpl,
        signal
      }), signal)
      throwIfCancelled(signal)
      if (result.auth === 'invalid') {
        this.persist([], this.refreshedAt, null, request.identityHash)
        this.rows = []
        this.snapshot = {
          repoFetchWindow: request.repoFetchWindow,
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

      const previousRows = new Map(this.rows.map(row => [row.name.toLowerCase(), row]))
      const readRows = result.rows.map(row => {
        if (row.commandCenter?.kind !== 'unavailable') return row
        return { ...row, commandCenter: retainCommandCenter(previousRows.get(row.name.toLowerCase())?.commandCenter, row.commandCenter.message, row.commandCenter.checkedAt) }
      })
      const nextRows = result.fresh ? readRows : mergeRows(readRows, this.rows, queriedAt.toISOString())
      const hasErrors = result.errors.length > 0 || result.rows.some(row => Boolean(row.error) || row.commandCenter?.kind === 'unavailable')
      const successful = result.fresh && !result.rateLimitResetAt && !hasErrors
      const completedAt = this.deps.now?.() ?? new Date()
      const nextRefreshedAt = successful ? completedAt.toISOString() : this.refreshedAt
      this.persist(nextRows, nextRefreshedAt, successful ? request.key : null, request.identityHash)
      this.rows = nextRows
      this.refreshedAt = nextRefreshedAt
      this.snapshot = {
        repoFetchWindow: request.repoFetchWindow,
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
      if (successful) this.successfulRefresh = { key: request.key, completedAt: completedAt.getTime() }
      return this.snapshot
    } catch (error) {
      if (isCancellation(error)) {
        this.successfulRefresh = previousSuccessful
        throw error
      }
      try {
        this.persist(this.rows, this.refreshedAt, null, request.identityHash)
      } catch {
        // Preserve the refresh failure; the next request still bypasses the in-memory cache.
      }
      throw error
    } finally {
      if (this.snapshot.refreshing) this.snapshot = { ...this.snapshot, refreshing: false }
    }
  }

  private persist(
    rows: OverviewRow[],
    refreshedAt: string | null,
    configKey: string | null,
    identityHash: string | null
  ): void {
    const payload: CacheFile = { version: 2, repoFetchWindow: this.dataRepoFetchWindow, refreshedAt, configKey, identityHash, rows }
    writeJson(this.cacheFile, payload)
  }
}
