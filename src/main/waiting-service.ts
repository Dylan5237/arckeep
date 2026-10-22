import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { assembleWaiting, mergeRecords } from '../shared/waiting/assemble.js'
import { effectiveHiddenRepos, partitionDismissals, hideRepo as rememberRepo, ignoreDraft, readDismissalState, restoreDraft, snoozeDraft, unhideRepo as forgetRepo, writeDismissalState } from '../shared/waiting/snooze.js'
import { createWaitingClock, type WaitingClock } from '../shared/waiting/clock.js'
import type {
  DismissalMap,
  TodoWaitingProvider,
  WaitingDraft,
  WaitingConfig,
  SourceError,
  WaitingSnapshot
} from '../shared/waiting/types.js'
import type { IpcResult } from '../shared/types.js'
import { collectWaiting, emptyWaitingMemory, type WaitingMemory } from '../waiting/collect.js'
import { loadUnpushedBranches, type GitRunner } from '../waiting/local-git.js'
import { resolveWaitingToken, waitingTokenIdentityHash, type WaitingTokenVia } from '../waiting/token.js'
import type { GhLookup } from './github-auth.js'
import { testHooksEnabled } from './test-hooks.js'
import type { SettingsService } from './settings-service.js'
import { pendingTodoProvider } from '../shared/waiting/todo-source.js'
import { ApoCommentService } from './apo-comment-service.js'
import type { ApoCommentOutcome } from '../shared/waiting/apo-actions.js'
import { abortable, isCancellation, throwIfCancelled, TaskScope } from '../shared/task-scope.js'
import { cachedRepoFetchWindow, type RepoFetchWindow } from '../shared/repo-fetch-window.js'

interface CacheFile {
  version: 1
  repoFetchWindow?: RepoFetchWindow
  refreshedAt: string | null
  configKey?: string | null
  identityHash?: string | null
  memory: WaitingMemory
}

interface RefreshInputs {
  repoFetchWindow: RepoFetchWindow
  config: WaitingConfig
  watchedRepos: string[]
  patCiphertext: string | null
  envToken: string | null
}

interface RefreshRequest {
  repoFetchWindow: RepoFetchWindow
  key: string
  config: WaitingConfig
  watchedRepos: string[]
  token: string | null
  identityHash: string | null
}

interface RefreshFlight {
  key: string
  remote: boolean
  promise: Promise<WaitingSnapshot>
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

function loadMemory(file: string): {
  memory: WaitingMemory
  refreshedAt: string | null
  configKey: string | null
  identityHash: string | null
} {
  const raw = readJson(file)
  if (!raw || typeof raw !== 'object') {
    return { memory: emptyWaitingMemory(), refreshedAt: null, configKey: null, identityHash: null }
  }
  const record = raw as Partial<CacheFile>
  if (!record.memory || typeof record.memory !== 'object') {
    return { memory: emptyWaitingMemory(), refreshedAt: null, configKey: null, identityHash: null }
  }
  return {
    memory: { ...emptyWaitingMemory(), ...record.memory },
    refreshedAt: typeof record.refreshedAt === 'string' ? record.refreshedAt : null,
    configKey: typeof record.configKey === 'string' ? record.configKey : null,
    identityHash: typeof record.identityHash === 'string' ? record.identityHash : null
  }
}

function loadDismissals(file: string): {
  items: DismissalMap
  hiddenRepos: string[]
  revealedParked: string[]
  maybeWhenEmpty: boolean | null
  maybeWhenListed: boolean | null
} {
  return readDismissalState(readJson(file))
}

const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

function withoutGithubMemory(memory: WaitingMemory): WaitingMemory {
  return {
    ...memory,
    assignee: [],
    reviewRequested: [],
    mentions: [],
    openPrs: [],
    humanIssues: [],
    statusDocs: []
  }
}

function withCachedGithubMemory(local: WaitingMemory, cached: WaitingMemory): WaitingMemory {
  return {
    ...local,
    assignee: cached.assignee,
    reviewRequested: cached.reviewRequested,
    mentions: cached.mentions,
    openPrs: cached.openPrs,
    humanIssues: cached.humanIssues,
    statusDocs: cached.statusDocs
  }
}

function snapshotOf(input: {
  drafts: WaitingDraft[]
  dismissals: DismissalMap
  now: Date
  showIgnored: boolean
  refreshedAt: string | null
  refreshing: boolean
  auth: WaitingSnapshot['auth']
  rateLimitResetAt: string | null
  sourceErrors: WaitingSnapshot['sourceErrors']
  notices: WaitingSnapshot['notices']
  todosAvailable: boolean
  hiddenRepos: readonly string[]
  parkedRepos: readonly string[]
  revealedParked: readonly string[]
  maybeWhenEmpty: boolean | null
  maybeWhenListed: boolean | null
}): { snapshot: WaitingSnapshot, dismissals: DismissalMap } {
  const hiddenRepos = effectiveHiddenRepos(input.hiddenRepos, input.parkedRepos, input.revealedParked)
  const visible = partitionDismissals(input.drafts, input.dismissals, input.now, input.showIgnored, hiddenRepos)
  return {
    dismissals: visible.map,
    snapshot: {
      rows: visible.rows,
      refreshedAt: input.refreshedAt,
      refreshing: input.refreshing,
      auth: input.auth,
      rateLimitResetAt: input.rateLimitResetAt,
      sourceErrors: input.sourceErrors,
      notices: input.notices,
      showIgnored: input.showIgnored,
      hiddenCount: visible.hiddenCount,
      hiddenRepos,
      todosAvailable: input.todosAvailable,
      maybeWhenEmpty: input.maybeWhenEmpty,
      maybeWhenListed: input.maybeWhenListed
    }
  }
}

export class WaitingService {
  private dataRepoFetchWindow: RepoFetchWindow
  private readonly tasks: TaskScope
  private readonly apoComments: ApoCommentService
  private memory: WaitingMemory
  private cachedMemory: WaitingMemory | null
  private cachedRefreshedAt: string | null
  private dismissals: DismissalMap
  private hiddenRepos: string[]
  private revealedParked: string[]
  private maybeWhenEmpty: boolean | null
  private maybeWhenListed: boolean | null
  private parkedRepos: string[] = []
  private refreshedAt: string | null
  private drafts: WaitingDraft[] = []
  private snapshot: WaitingSnapshot
  private readonly clock: WaitingClock
  private activeRefresh: RefreshFlight | null = null
  private successfulRefresh: SuccessfulRefresh | null = null
  private persistedConfigKey: string | null = null
  private persistedIdentityHash: string | null = null
  private currentIdentityHash: string | null = null
  private identityActivated = false
  private authFlight: { key: string, promise: Promise<{ token: string | null, via: WaitingTokenVia }> } | null = null

  constructor(
    private readonly settings: SettingsService,
    private readonly files: { cache: string, dismissals: string },
    private readonly deps: {
      env?: NodeJS.ProcessEnv
      readGh?: (options?: { signal?: AbortSignal, tasks?: TaskScope }) => Promise<GhLookup>
      fetchImpl?: typeof fetch
      git?: GitRunner
      todos?: TodoWaitingProvider
      clock?: WaitingClock
      log?: (message: string) => void
      tasks?: TaskScope
    } = {}
  ) {
    this.tasks = deps.tasks ?? new TaskScope()
    const cachedWindow = readJson(files.cache) as { repoFetchWindow?: unknown } | null
    this.dataRepoFetchWindow = cachedRepoFetchWindow(cachedWindow?.repoFetchWindow)
    this.apoComments = new ApoCommentService({
      file: path.join(path.dirname(files.cache), 'apo-comment-receipts.json'),
      tasks: this.tasks,
      fetchImpl: deps.fetchImpl,
      resolveToken: async signal => {
        const request = await this.captureRefreshRequest(signal)
        if (request.identityHash !== this.currentIdentityHash) throw new Error('GitHub 认证已变化，请刷新列表后处理')
        return request.token
      }
    })
    const cached = loadMemory(files.cache)
    this.cachedMemory = cached.memory
    this.memory = withoutGithubMemory(cached.memory)
    this.cachedRefreshedAt = cached.refreshedAt
    this.refreshedAt = null
    this.persistedConfigKey = cached.configKey
    this.persistedIdentityHash = cached.identityHash
    const storedDismissals = loadDismissals(files.dismissals)
    this.dismissals = storedDismissals.items
    this.hiddenRepos = storedDismissals.hiddenRepos
    this.revealedParked = storedDismissals.revealedParked
    this.maybeWhenEmpty = storedDismissals.maybeWhenEmpty
    this.maybeWhenListed = storedDismissals.maybeWhenListed
    this.clock = deps.clock ?? createWaitingClock()
    const stored = settings.getSettings()
    this.drafts = this.assembleMemory(this.memory, stored.waiting, this.clock.now(), 'missing')
    this.parkedRepos = this.parkedFrom(this.drafts)
    const painted = snapshotOf({
      drafts: this.drafts,
      dismissals: this.dismissals,
      now: this.clock.now(),
      showIgnored: stored.waiting.showIgnored,
      refreshedAt: this.refreshedAt,
      refreshing: false,
      auth: 'unknown',
      rateLimitResetAt: null,
      sourceErrors: [],
      notices: [],
      todosAvailable: (deps.todos ?? pendingTodoProvider).available,
      hiddenRepos: this.hiddenRepos,
      parkedRepos: this.parkedRepos,
      revealedParked: this.revealedParked,
      maybeWhenEmpty: this.maybeWhenEmpty,
      maybeWhenListed: this.maybeWhenListed
    })
    this.dismissals = painted.dismissals
    this.snapshot = { ...painted.snapshot, repoFetchWindow: this.dataRepoFetchWindow }
  }

  current(): WaitingSnapshot {
    if (!this.identityActivated) this.snapshot = { ...this.snapshot, repoFetchWindow: this.settings.getSettings().repoFetchWindow }
    this.snapshot = this.withCommentStates(this.snapshot)
    return this.snapshot
  }

  commentApo(rowId: unknown, actionId: unknown, checkOnly = false): Promise<IpcResult<ApoCommentOutcome>> {
    if (typeof rowId !== 'string' || rowId.length > 500 || typeof actionId !== 'string' || actionId.length > 3000) {
      return Promise.resolve({ ok: false, error: '快捷评论参数无效' })
    }
    const row = this.snapshot.rows.find(item => item.id === rowId && item.tier === 'strong' && !item.ignored
      && (item.type === 'issue' || item.type === 'pr'))
    const action = row?.quickActions?.find(item => item.id === actionId)
    if (!action || this.snapshot.auth !== 'ok') return Promise.resolve({ ok: false, error: '找不到当前评论请求，请刷新列表' })
    return checkOnly ? this.apoComments.check(action) : this.apoComments.submit(action)
  }

  replyDecision(rowId: unknown, actionId: unknown, choice: unknown, reason: unknown, checkOnly = false): Promise<IpcResult<ApoCommentOutcome>> {
    if (typeof rowId !== 'string' || rowId.length > 500 || typeof actionId !== 'string' || actionId.length > 3000
      || (reason !== undefined && (typeof reason !== 'string' || reason.length > 2000))) {
      return Promise.resolve({ ok: false, error: '决策回复参数无效' })
    }
    const row = this.snapshot.rows.find(item => item.id === rowId && item.tier === 'strong' && !item.ignored
      && (item.type === 'issue' || item.type === 'pr'))
    const action = row?.decisionActions?.find(item => item.id === actionId)
    if (!action || this.snapshot.auth !== 'ok') return Promise.resolve({ ok: false, error: '找不到当前决策请求，请刷新列表' })
    return checkOnly ? this.apoComments.checkReply(action) : this.apoComments.reply(action, choice, reason)
  }

  private withCommentStates(snapshot: WaitingSnapshot): WaitingSnapshot {
    return { ...snapshot, rows: snapshot.rows.map(row => ({ ...row,
      quickActions: row.quickActions?.map(action => ({ ...action, state: this.apoComments.state(action) })),
      decisionActions: row.decisionActions?.map(action => ({ ...action, state: this.apoComments.replyState(action) }))
    })) }
  }

  observedGithubRepos(): string[] {
    const names = new Set<string>()
    const groups = [
      this.memory.assignee,
      this.memory.reviewRequested,
      this.memory.mentions,
      this.memory.openPrs,
      this.memory.humanIssues
    ]
    for (const group of groups) {
      for (const record of group) {
        if (record.repo) names.add(record.repo)
      }
    }
    for (const doc of this.memory.statusDocs) {
      if (doc.repo) names.add(doc.repo)
    }
    for (const branch of this.memory.branches) {
      if (branch.repo) names.add(branch.repo)
    }
    return [...names]
  }

  observedLocalLinks(): Array<{ github: string, path: string }> {
    const seen = new Set<string>()
    const links: Array<{ github: string, path: string }> = []
    for (const branch of this.memory.branches) {
      if (!branch.repo || !branch.dir) continue
      const key = `${branch.repo}\0${branch.dir}`
      if (seen.has(key)) continue
      seen.add(key)
      links.push({ github: branch.repo, path: branch.dir })
    }
    return links
  }

  refresh(force = true): Promise<WaitingSnapshot> {
    if (!this.tasks.isClosing) {
      this.snapshot = {
        ...this.snapshot,
        refreshing: true,
        auth: this.snapshot.auth === 'ok' ? 'ok' : 'unknown',
        sourceErrors: this.snapshot.auth === 'missing' || this.snapshot.auth === 'invalid' ? [] : this.snapshot.sourceErrors
      }
    }
    return this.tasks.run(signal => this.requestRefresh(force, signal), '待办刷新').then(snapshot => this.withCommentStates(snapshot)).catch(error => {
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

  private async requestRefresh(force: boolean, signal: AbortSignal): Promise<WaitingSnapshot> {
    throwIfCancelled(signal)
    let request = await this.captureRefreshRequest(signal)
    while (true) {
      throwIfCancelled(signal)
      const active = this.activeRefresh
      if (active) {
        if (active.key === request.key && (!force || active.remote)) return abortable(active.promise, signal)
        await abortable(active.promise.catch(() => undefined), signal)
        throwIfCancelled(signal)
        request = await this.captureRefreshRequest(signal)
        continue
      }
      this.activateIdentity(request)
      if (this.isCoolingDown()) return this.startCachedRefresh(request, signal, true)
      if (this.snapshot.rateLimitResetAt) {
        this.snapshot = { ...this.snapshot, rateLimitResetAt: null }
      }
      if (!force && this.hasFreshSuccess(request.key)) return this.startCachedRefresh(request, signal)
      return this.startRefresh(request, signal)
    }
  }

  private captureRefreshInputs(): RefreshInputs {
    const stored = this.settings.getSettings()
    const watchedRepos = [...stored.watchedRepos]
    const config = JSON.parse(JSON.stringify(stored.waiting)) as WaitingConfig
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
      .update(JSON.stringify({ watchedRepos: inputs.watchedRepos, repoFetchWindow: inputs.repoFetchWindow, config: inputs.config, identityHash }))
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

  private restoreSuccessfulRefresh(request: RefreshRequest): void {
    const configKey = this.persistedConfigKey
    if (!request.identityHash || !configKey || !this.refreshedAt || configKey !== request.key) return
    const completedAt = Date.parse(this.refreshedAt)
    const age = this.clock.now().getTime() - completedAt
    if (Number.isFinite(completedAt) && age >= 0 && age < SUCCESS_CACHE_TTL_MS) {
      this.successfulRefresh = { key: configKey, completedAt }
    }
  }

  private hasFreshSuccess(key: string): boolean {
    if (!this.successfulRefresh || this.successfulRefresh.key !== key) return false
    const age = this.clock.now().getTime() - this.successfulRefresh.completedAt
    return age >= 0 && age < SUCCESS_CACHE_TTL_MS
  }

  private isCoolingDown(): boolean {
    const resetAt = this.snapshot.rateLimitResetAt
    if (!resetAt) return false
    const resetTime = Date.parse(resetAt)
    return Number.isFinite(resetTime) && resetTime > this.clock.now().getTime()
  }

  private activateIdentity(request: RefreshRequest): void {
    const sameActiveIdentity = this.identityActivated && this.currentIdentityHash === request.identityHash
    const sameWindow = this.dataRepoFetchWindow === request.repoFetchWindow
    if (sameActiveIdentity && sameWindow) return

    const matchesCachedIdentity = !this.identityActivated
      && request.identityHash !== null
      && this.persistedIdentityHash === request.identityHash
      && this.cachedMemory !== null
    const cachedMemory = this.cachedMemory
    if (sameActiveIdentity) {
      // Direct assignments, review requests, mentions and local inputs remain
      // valid when only the broad repository scan changes its time window.
    } else if (matchesCachedIdentity && cachedMemory) {
      this.memory = withCachedGithubMemory(this.memory, cachedMemory)
      this.refreshedAt = this.cachedRefreshedAt
    } else {
      this.memory = withoutGithubMemory(this.memory)
      this.refreshedAt = null
      this.persistedConfigKey = null
      this.successfulRefresh = null
    }
    if (!sameWindow) {
      this.memory = { ...this.memory, openPrs: [], humanIssues: [] }
      this.refreshedAt = null
      this.persistedConfigKey = null
      this.successfulRefresh = null
    }
    this.dataRepoFetchWindow = request.repoFetchWindow
    this.cachedMemory = null
    this.cachedRefreshedAt = null
    this.currentIdentityHash = request.identityHash
    this.persistedIdentityHash = request.identityHash
    this.identityActivated = true

    const auth: WaitingSnapshot['auth'] = request.token ? 'ok' : 'missing'
    this.drafts = this.assembleMemory(this.memory, request.config, this.clock.now(), auth)
    this.parkedRepos = this.parkedFrom(this.drafts)
    this.snapshot = this.paintSnapshot({
      config: request.config,
      now: this.clock.now(),
      auth,
      rateLimitResetAt: sameActiveIdentity ? this.snapshot.rateLimitResetAt : null,
      sourceErrors: sameActiveIdentity ? this.snapshot.sourceErrors : [],
      notices: [],
      todosAvailable: (this.deps.todos ?? pendingTodoProvider).available,
      refreshing: this.snapshot.refreshing
    })
    if (matchesCachedIdentity) this.restoreSuccessfulRefresh(request)
  }

  private startRefresh(request: RefreshRequest, signal: AbortSignal): Promise<WaitingSnapshot> {
    const previousSuccessful = this.successfulRefresh
    const previousConfigKey = this.persistedConfigKey
    this.successfulRefresh = null
    this.persistedConfigKey = null
    return this.startFlight(request, true, signal, currentSignal =>
      this.executeRefresh(request, currentSignal, previousSuccessful, previousConfigKey))
  }

  private startCachedRefresh(request: RefreshRequest, signal: AbortSignal, preserveRateLimit = false): Promise<WaitingSnapshot> {
    return this.startFlight(request, false, signal, currentSignal =>
      this.rebuildCachedSnapshot(request, currentSignal, preserveRateLimit))
  }

  private startFlight(
    request: RefreshRequest,
    remote: boolean,
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<WaitingSnapshot>
  ): Promise<WaitingSnapshot> {
    this.snapshot = { ...this.snapshot, refreshing: true }
    const operation = run(signal)
    const promise = operation.finally(() => {
      if (this.activeRefresh?.promise === promise) this.activeRefresh = null
    })
    this.activeRefresh = { key: request.key, remote, promise }
    return promise
  }

  private async executeRefresh(
    request: RefreshRequest,
    signal: AbortSignal,
    previousSuccessful: SuccessfulRefresh | null,
    previousConfigKey: string | null
  ): Promise<WaitingSnapshot> {
    try {
      throwIfCancelled(signal)
      const result = await abortable(collectWaiting({
        token: request.token,
        config: request.config,
        watchedRepos: request.watchedRepos,
        repoFetchWindow: request.repoFetchWindow,
        now: this.clock.now(),
        memory: this.memory,
        fetchImpl: this.deps.fetchImpl,
        git: this.deps.git,
        todos: this.deps.todos ?? pendingTodoProvider,
        signal,
        tasks: this.tasks
      }), signal)
      throwIfCancelled(signal)
      const memory = result.errors.some(error => error.source === '本地没推送')
        && request.config.sources.localBranches
        ? { ...result.memory, branches: this.memory.branches }
        : result.memory
      this.memory = memory
      this.drafts = memory === result.memory
        ? result.drafts
        : this.assembleMemory(memory, request.config, this.clock.now(), result.auth)
      this.parkedRepos = this.parkedFrom(this.drafts, result.parkedRepos)
      const successful = result.auth === 'ok' && !result.rateLimitResetAt && result.errors.length === 0
      if (successful) this.refreshedAt = this.clock.now().toISOString()
      this.persistedConfigKey = successful ? request.key : null
      this.persistCache()
      const painted = this.paintSnapshot({
        config: request.config,
        now: this.clock.now(),
        auth: result.auth,
        rateLimitResetAt: result.rateLimitResetAt,
        sourceErrors: result.errors,
        notices: result.notices,
        todosAvailable: result.todosAvailable,
        refreshing: false
      })
      this.persistDismissals()
      this.snapshot = painted
      if (result.errors.length > 0) {
        this.deps.log?.(result.errors.map(error => `${error.source}: ${error.message}`).join('; '))
      }
      if (successful) this.successfulRefresh = { key: request.key, completedAt: this.clock.now().getTime() }
      return this.snapshot
    } catch (error) {
      if (isCancellation(error)) {
        this.successfulRefresh = previousSuccessful
        this.persistedConfigKey = previousConfigKey
        throw error
      }
      this.persistedConfigKey = null
      try {
        this.persistCache()
      } catch {
        // Preserve the refresh failure; the next request still bypasses the in-memory cache.
      }
      throw error
    } finally {
      if (this.snapshot.refreshing) this.snapshot = { ...this.snapshot, refreshing: false }
    }
  }

  private async rebuildCachedSnapshot(
    request: RefreshRequest,
    signal: AbortSignal,
    preserveRateLimit = false
  ): Promise<WaitingSnapshot> {
    try {
      throwIfCancelled(signal)
      const memory: WaitingMemory = { ...this.memory }
      const localErrors: SourceError[] = []
      const todos = this.deps.todos ?? pendingTodoProvider

      if (request.config.sources.localBranches) {
        try {
          const local = await abortable(loadUnpushedBranches(request.config.localRepoDirs, this.deps.git, {
            signal,
            tasks: this.tasks
          }), signal)
          throwIfCancelled(signal)
          memory.branches = local.errors.length > 0 ? this.memory.branches : local.hits
          localErrors.push(...local.errors)
        } catch (error) {
          if (isCancellation(error)) throw error
          localErrors.push({ source: '本地没推送', message: error instanceof Error ? error.message : '本地仓库读取失败' })
        }
      } else {
        memory.branches = []
      }

      if (!request.config.sources.todos) {
        memory.todos = []
      } else if (todos.available) {
        try {
          throwIfCancelled(signal)
          memory.todos = await abortable(Promise.resolve().then(() => todos.listWaitingOnMe()), signal)
          throwIfCancelled(signal)
        } catch (error) {
          if (isCancellation(error)) throw error
          localErrors.push({ source: '待办', message: error instanceof Error ? error.message : '待办读取失败' })
        }
      }

      throwIfCancelled(signal)
      const now = this.clock.now()
      this.memory = memory
      this.drafts = this.assembleMemory(memory, request.config, now, request.token ? 'ok' : 'missing')
      this.parkedRepos = this.parkedFrom(this.drafts)
      const retainedErrors = preserveRateLimit
        ? this.snapshot.sourceErrors.filter(error => error.source !== '待办' && error.source !== '本地没推送')
        : []
      const errors = [...retainedErrors, ...localErrors]
      if (errors.length > 0) this.persistedConfigKey = null
      this.persistCache()
      const painted = this.paintSnapshot({
        config: request.config,
        now,
        auth: request.token ? 'ok' : 'missing',
        rateLimitResetAt: this.snapshot.rateLimitResetAt,
        sourceErrors: errors,
        notices: this.snapshot.notices,
        todosAvailable: todos.available,
        refreshing: false
      })
      this.persistDismissals()
      this.snapshot = painted
      if (errors.length > 0) {
        this.deps.log?.(errors.map(error => `${error.source}: ${error.message}`).join('; '))
      }
      return this.snapshot
    } catch (error) {
      if (isCancellation(error)) throw error
      this.persistedConfigKey = null
      try {
        this.persistCache()
      } catch {
        // Preserve the local refresh failure and let the short TTL expire normally.
      }
      throw error
    } finally {
      if (this.snapshot.refreshing) this.snapshot = { ...this.snapshot, refreshing: false }
    }
  }

  private assembleMemory(
    memory: WaitingMemory,
    config: WaitingConfig,
    now: Date,
    auth: WaitingSnapshot['auth']
  ): WaitingDraft[] {
    const records = auth === 'missing'
      ? []
      : mergeRecords([
        ...memory.assignee,
        ...memory.reviewRequested,
        ...memory.mentions,
        ...memory.openPrs,
        ...memory.humanIssues
      ])
    return assembleWaiting({
      records,
      statusDocs: auth === 'missing' ? [] : memory.statusDocs,
      branches: memory.branches,
      todos: memory.todos,
      config,
      now
    })
  }

  private parkedFrom(drafts: readonly WaitingDraft[], initial: readonly string[] = []): string[] {
    const repos = [...initial]
    for (const draft of drafts) {
      if (draft.parked && !repos.some(repo => repo.toLowerCase() === draft.repo.toLowerCase())) {
        repos.push(draft.repo)
      }
    }
    return repos
  }

  private paintSnapshot(input: {
    config: WaitingConfig
    now: Date
    auth: WaitingSnapshot['auth']
    rateLimitResetAt: string | null
    sourceErrors: SourceError[]
    notices: string[]
    todosAvailable: boolean
    refreshing: boolean
  }): WaitingSnapshot {
    const painted = snapshotOf({
      drafts: this.drafts,
      dismissals: this.dismissals,
      now: input.now,
      showIgnored: input.config.showIgnored,
      refreshedAt: this.refreshedAt,
      refreshing: input.refreshing,
      auth: input.auth,
      rateLimitResetAt: input.rateLimitResetAt,
      sourceErrors: input.sourceErrors,
      notices: input.notices,
      todosAvailable: input.todosAvailable,
      hiddenRepos: this.hiddenRepos,
      parkedRepos: this.parkedRepos,
      revealedParked: this.revealedParked,
      maybeWhenEmpty: this.maybeWhenEmpty,
      maybeWhenListed: this.maybeWhenListed
    })
    this.dismissals = painted.dismissals
    return { ...painted.snapshot, repoFetchWindow: this.identityActivated ? this.dataRepoFetchWindow : this.settings.getSettings().repoFetchWindow }
  }

  snooze(id: unknown, days: unknown): IpcResult<WaitingSnapshot> {
    const itemId = this.itemId(id)
    if (!itemId.ok) return itemId
    if (days !== 1 && days !== 3 && days !== 7) return { ok: false, error: '延后天数只能是 1、3 或 7' }
    const draft = this.drafts.find(item => item.id === itemId.data)
    if (!draft) return { ok: false, error: '找不到这一条' }
    this.dismissals = snoozeDraft(this.dismissals, draft.id, days, this.clock.now())
    return { ok: true, data: this.repaint() }
  }

  ignore(id: unknown): IpcResult<WaitingSnapshot> {
    const itemId = this.itemId(id)
    if (!itemId.ok) return itemId
    const draft = this.drafts.find(item => item.id === itemId.data)
    if (!draft) return { ok: false, error: '找不到这一条' }
    this.dismissals = ignoreDraft(this.dismissals, draft)
    return { ok: true, data: this.repaint() }
  }

  restore(id: unknown): IpcResult<WaitingSnapshot> {
    const itemId = this.itemId(id)
    if (!itemId.ok) return itemId
    this.dismissals = restoreDraft(this.dismissals, itemId.data)
    return { ok: true, data: this.repaint() }
  }

  hideRepo(repo: unknown): IpcResult<WaitingSnapshot> {
    if (typeof repo !== 'string' || !REPO_NAME.test(repo)) return { ok: false, error: '仓库名无效' }
    this.hiddenRepos = rememberRepo(this.hiddenRepos, repo)
    this.revealedParked = forgetRepo(this.revealedParked, repo)
    return { ok: true, data: this.repaint() }
  }

  unhideRepo(repo: unknown): IpcResult<WaitingSnapshot> {
    if (typeof repo !== 'string' || !REPO_NAME.test(repo)) return { ok: false, error: '仓库名无效' }
    this.hiddenRepos = forgetRepo(this.hiddenRepos, repo)
    if (this.parkedRepos.some(item => item.toLowerCase() === repo.toLowerCase())) {
      this.revealedParked = rememberRepo(this.revealedParked, repo)
    }
    return { ok: true, data: this.repaint() }
  }

  setMaybeSectionOpen(open: unknown): IpcResult<WaitingSnapshot> {
    if (typeof open !== 'boolean') return { ok: false, error: '展开状态无效' }
    const mainCount = this.snapshot.rows.filter(row => row.tier !== 'weak').length
    if (mainCount === 0) this.maybeWhenEmpty = open
    else this.maybeWhenListed = open
    return { ok: true, data: this.repaint() }
  }

  setShowIgnored(value: unknown): IpcResult<WaitingSnapshot> {
    if (typeof value !== 'boolean') return { ok: false, error: '显示已忽略的值无效' }
    this.settings.patchShowIgnored(value)
    return { ok: true, data: this.repaint() }
  }

  advanceDays(days: unknown): IpcResult<WaitingSnapshot> {
    const env = this.deps.env ?? process.env
    if (!testHooksEnabled(env)) return { ok: false, error: '测试钩子未开启' }
    const amount = typeof days === 'number' ? days : Number(days)
    try {
      this.clock.advanceDays(amount)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '模拟天数无效' }
    }
    return { ok: true, data: this.repaint() }
  }

  private repaint(): WaitingSnapshot {
    const stored = this.settings.getSettings()
    const painted = snapshotOf({
      drafts: this.drafts,
      dismissals: this.dismissals,
      now: this.clock.now(),
      showIgnored: stored.waiting.showIgnored,
      refreshedAt: this.refreshedAt,
      refreshing: this.snapshot.refreshing,
        auth: this.snapshot.auth,
      rateLimitResetAt: this.snapshot.rateLimitResetAt,
      sourceErrors: this.snapshot.sourceErrors,
      notices: this.snapshot.notices,
      todosAvailable: this.snapshot.todosAvailable,
      hiddenRepos: this.hiddenRepos,
      parkedRepos: this.parkedRepos,
      revealedParked: this.revealedParked,
      maybeWhenEmpty: this.maybeWhenEmpty,
      maybeWhenListed: this.maybeWhenListed
    })
    this.dismissals = painted.dismissals
    this.persistDismissals()
    this.snapshot = painted.snapshot
    return this.snapshot
  }

  private itemId(value: unknown): IpcResult<string> {
    if (typeof value !== 'string' || value.length < 1 || value.length > 500) return { ok: false, error: '条目无效' }
    return { ok: true, data: value }
  }

  private persistCache(): void {
    const payload: CacheFile = {
      version: 1,
      repoFetchWindow: this.dataRepoFetchWindow,
      refreshedAt: this.refreshedAt,
      configKey: this.persistedConfigKey,
      identityHash: this.persistedIdentityHash,
      memory: this.memory
    }
    writeJson(this.files.cache, payload)
  }

  private persistDismissals(): void {
    writeJson(this.files.dismissals, writeDismissalState({
      items: this.dismissals,
      hiddenRepos: this.hiddenRepos,
      revealedParked: this.revealedParked,
      maybeWhenEmpty: this.maybeWhenEmpty,
      maybeWhenListed: this.maybeWhenListed
    }))
  }
}
