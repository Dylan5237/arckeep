import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { partitionDismissals, ignoreDraft, restoreDraft, snoozeDraft } from '../shared/waiting/snooze.js'
import { createWaitingClock, type WaitingClock } from '../shared/waiting/clock.js'
import type {
  DismissalMap,
  TodoWaitingProvider,
  WaitingDraft,
  WaitingSnapshot
} from '../shared/waiting/types.js'
import type { IpcResult } from '../shared/types.js'
import { collectWaiting, emptyWaitingMemory, type WaitingMemory } from '../waiting/collect.js'
import type { GitRunner } from '../waiting/local-git.js'
import { resolveWaitingToken } from '../waiting/token.js'
import type { GhLookup } from './github-auth.js'
import { testHooksEnabled } from './test-hooks.js'
import type { SettingsService } from './settings-service.js'
import { pendingTodoProvider } from '../shared/waiting/todo-source.js'

interface CacheFile {
  version: 1
  refreshedAt: string | null
  memory: WaitingMemory
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

function loadMemory(file: string): { memory: WaitingMemory, refreshedAt: string | null } {
  const raw = readJson(file)
  if (!raw || typeof raw !== 'object') return { memory: emptyWaitingMemory(), refreshedAt: null }
  const record = raw as Partial<CacheFile>
  if (!record.memory || typeof record.memory !== 'object') return { memory: emptyWaitingMemory(), refreshedAt: null }
  return {
    memory: { ...emptyWaitingMemory(), ...record.memory },
    refreshedAt: typeof record.refreshedAt === 'string' ? record.refreshedAt : null
  }
}

function loadDismissals(file: string): DismissalMap {
  const raw = readJson(file)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as DismissalMap
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
  todosAvailable: boolean
}): { snapshot: WaitingSnapshot, dismissals: DismissalMap } {
  const visible = partitionDismissals(input.drafts, input.dismissals, input.now, input.showIgnored)
  return {
    dismissals: visible.map,
    snapshot: {
      rows: visible.rows,
      refreshedAt: input.refreshedAt,
      refreshing: input.refreshing,
      auth: input.auth,
      rateLimitResetAt: input.rateLimitResetAt,
      sourceErrors: input.sourceErrors,
      showIgnored: input.showIgnored,
      hiddenCount: visible.hiddenCount,
      todosAvailable: input.todosAvailable
    }
  }
}

export class WaitingService {
  private memory: WaitingMemory
  private dismissals: DismissalMap
  private refreshedAt: string | null
  private drafts: WaitingDraft[] = []
  private snapshot: WaitingSnapshot
  private readonly clock: WaitingClock

  constructor(
    private readonly settings: SettingsService,
    private readonly files: { cache: string, dismissals: string },
    private readonly deps: {
      env?: NodeJS.ProcessEnv
      readGh?: () => Promise<GhLookup>
      fetchImpl?: typeof fetch
      git?: GitRunner
      todos?: TodoWaitingProvider
      clock?: WaitingClock
      log?: (message: string) => void
    } = {}
  ) {
    const cached = loadMemory(files.cache)
    this.memory = cached.memory
    this.refreshedAt = cached.refreshedAt
    this.dismissals = loadDismissals(files.dismissals)
    this.clock = deps.clock ?? createWaitingClock()
    this.snapshot = {
      rows: [],
      refreshedAt: this.refreshedAt,
      refreshing: false,
      auth: 'ok',
      rateLimitResetAt: null,
      sourceErrors: [],
      showIgnored: settings.getSettings().waiting.showIgnored,
      hiddenCount: 0,
      todosAvailable: (deps.todos ?? pendingTodoProvider).available
    }
  }

  current(): WaitingSnapshot {
    return this.snapshot
  }

  async refresh(): Promise<WaitingSnapshot> {
    const stored = this.settings.getSettings()
    const env = this.deps.env ?? process.env
    const access = await resolveWaitingToken({
      readGh: this.deps.readGh,
      envToken: env.GITHUB_TOKEN ?? null,
      readSaved: () => this.settings.readSavedPat()
    })
    const result = await collectWaiting({
      token: access.token,
      config: stored.waiting,
      watchedRepos: stored.watchedRepos,
      now: this.clock.now(),
      memory: this.memory,
      fetchImpl: this.deps.fetchImpl,
      git: this.deps.git,
      todos: this.deps.todos ?? pendingTodoProvider
    })
    this.memory = result.memory
    this.drafts = result.drafts
    if (!result.rateLimitResetAt && result.auth === 'ok') this.refreshedAt = this.clock.now().toISOString()
    this.persistCache()
    const painted = snapshotOf({
      drafts: this.drafts,
      dismissals: this.dismissals,
      now: this.clock.now(),
      showIgnored: stored.waiting.showIgnored,
      refreshedAt: this.refreshedAt,
      refreshing: false,
      auth: result.auth,
      rateLimitResetAt: result.rateLimitResetAt,
      sourceErrors: result.errors,
      todosAvailable: result.todosAvailable
    })
    this.dismissals = painted.dismissals
    this.persistDismissals()
    this.snapshot = painted.snapshot
    if (result.errors.length > 0) {
      this.deps.log?.(result.errors.map(error => `${error.source}: ${error.message}`).join('; '))
    }
    return this.snapshot
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
      refreshing: false,
      auth: this.snapshot.auth,
      rateLimitResetAt: this.snapshot.rateLimitResetAt,
      sourceErrors: this.snapshot.sourceErrors,
      todosAvailable: this.snapshot.todosAvailable
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
    const payload: CacheFile = { version: 1, refreshedAt: this.refreshedAt, memory: this.memory }
    writeJson(this.files.cache, payload)
  }

  private persistDismissals(): void {
    writeJson(this.files.dismissals, this.dismissals)
  }
}
