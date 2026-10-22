import { parseOverviewConfig } from '../shared/overview/rules.js'
import type { OverviewConfig } from '../shared/overview/types.js'
import { parseWaitingConfig } from '../shared/waiting/rules.js'
import type { WaitingConfig } from '../shared/waiting/types.js'
import type { AppState, IpcResult } from '../shared/types.js'
import { isCancellation, throwIfCancelled, type TaskScope } from '../shared/task-scope.js'
import { validateToolShelfText } from './tool-validate.js'
import {
  resolveGithubAuth,
  testGithubConnection,
  toPublicGithubAuth,
  type GithubAuthTaskOptions,
  type GhLookup
} from './github-auth.js'
import { invalidateGhAuthTokenCache, readGhAuthTokenCached } from './gh-auth-cache.js'
import { applyHotkey, hotkeyConflictWarning, type HotkeyRegistrar } from './hotkey.js'
import { hotkeyRuntimeAfterApply, type HotkeyRuntime } from '../shared/hotkey-status.js'
import { normalizePat, normalizeWatchedRepos } from './ipc-validators.js'
import { loadSettings, saveSettings, type PersistedSettings } from './settings-store.js'
import { assertSerializedWithoutSecret, type SecretBox } from './token-store.js'
import { parseRepoFetchWindow, type RepoFetchWindow } from '../shared/repo-fetch-window.js'

export interface SettingsServiceDeps {
  file: string
  secretBox: SecretBox
  registrar: HotkeyRegistrar
  onHotkey: () => void
  readGh?: (options?: GithubAuthTaskOptions) => Promise<GhLookup>
  fetchImpl?: typeof fetch
  log?: (message: string) => void
  tasks?: TaskScope
}

export class SettingsService {
  private settings: PersistedSettings
  private runtime: HotkeyRuntime

  constructor(private readonly deps: SettingsServiceDeps) {
    this.settings = loadSettings(deps.file)
    this.runtime = {
      field: this.settings.hotkey,
      active: null,
      banner: null,
      warning: null
    }
  }

  init(): void {
    this.assertOpen()
    const attempted = this.settings.hotkey
    const applied = applyHotkey(attempted, this.deps.registrar, this.deps.onHotkey, null)
    this.runtime = hotkeyRuntimeAfterApply(this.runtime, applied, attempted)
    if (!applied.ok) return
    if (applied.hotkey !== this.settings.hotkey) {
      this.settings.hotkey = applied.hotkey
      this.persist()
    }
  }

  hotkeyUnavailableCombo(): string | null {
    return this.runtime.banner
  }

  /** Test hook: drop the registered combo so the banner and tray show the failure. */
  simulateRegistrationFailure(): string {
    this.assertOpen()
    if (this.runtime.active) {
      try {
        this.deps.registrar.unregister(this.runtime.active)
      } catch {
        // Already gone.
      }
    }
    this.runtime = hotkeyRuntimeAfterApply(
      { ...this.runtime, active: null },
      {
        ok: false,
        hotkey: this.settings.hotkey,
        warning: hotkeyConflictWarning(this.settings.hotkey)
      },
      this.settings.hotkey
    )
    return this.runtime.banner ?? this.settings.hotkey
  }

  getSettings(): PersistedSettings {
    return { ...this.settings, watchedRepos: [...this.settings.watchedRepos] }
  }

  async getState(): Promise<AppState> {
    const tasks = this.deps.tasks
    return tasks
      ? tasks.run(signal => this.buildState(signal), '读取应用状态')
      : this.buildState()
  }

  private async buildState(signal?: AbortSignal): Promise<AppState> {
    const github = toPublicGithubAuth(await this.resolveAuth({ signal, tasks: this.deps.tasks }))
    return {
      watchedRepos: [...this.settings.watchedRepos],
      repoFetchWindow: this.settings.repoFetchWindow,
      hotkey: this.runtime.field,
      activeHotkey: this.runtime.active,
      hotkeyWarning: this.runtime.warning,
      hotkeyUnavailable: this.runtime.banner,
      github,
      waiting: this.settings.waiting,
      overview: this.settings.overview,
      toolShelfJson: this.settings.toolShelfJson,
      hideMainWindowOnLaunch: this.settings.hideMainWindowOnLaunch
    }
  }

  setRepoFetchWindow(input: unknown): IpcResult<{ repoFetchWindow: RepoFetchWindow }> {
    this.assertOpen()
    try {
      if (input === undefined) throw new Error('请选择仓库时间范围')
      const repoFetchWindow = parseRepoFetchWindow(input)
      const next = { ...this.settings, repoFetchWindow }
      saveSettings(this.deps.file, next)
      this.settings = next
      return { ok: true, data: { repoFetchWindow } }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '仓库时间范围保存失败' }
    }
  }

  setOverview(input: unknown): IpcResult<{ overview: OverviewConfig }> {
    this.assertOpen()
    try {
      const overview = parseOverviewConfig(input)
      this.settings.overview = overview
      this.persist()
      return { ok: true, data: { overview } }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '项目总览的规则无效' }
    }
  }

  setToolShelfJson(input: unknown): IpcResult<{ toolShelfJson: string }> {
    this.assertOpen()
    if (typeof input !== 'string') return { ok: false, error: '工具架配置必须是 JSON 文本' }
    const validated = validateToolShelfText(input)
    if (!validated.ok) return { ok: false, error: validated.error }
    this.settings.toolShelfJson = input
    this.persist()
    return { ok: true, data: { toolShelfJson: input } }
  }

  setWaiting(input: unknown): IpcResult<{ waiting: WaitingConfig }> {
    this.assertOpen()
    try {
      const waiting = parseWaitingConfig(input, { validatePatterns: true })
      this.settings.waiting = waiting
      this.persist()
      return { ok: true, data: { waiting } }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '等我处理的规则无效' }
    }
  }

  patchShowIgnored(show: boolean): WaitingConfig {
    this.assertOpen()
    this.settings.waiting = { ...this.settings.waiting, showIgnored: show }
    this.persist()
    return this.settings.waiting
  }

  setRepos(input: unknown): IpcResult<{ watchedRepos: string[] }> {
    this.assertOpen()
    try {
      const watchedRepos = normalizeWatchedRepos(input)
      this.settings.watchedRepos = watchedRepos
      this.persist()
      return { ok: true, data: { watchedRepos } }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '关注仓库无效' }
    }
  }

  setHideMainWindowOnLaunch(input: unknown): IpcResult<{ hideMainWindowOnLaunch: boolean }> {
    this.assertOpen()
    if (typeof input !== 'boolean') return { ok: false, error: '启动时隐藏主窗口必须是布尔值' }
    this.settings.hideMainWindowOnLaunch = input
    this.persist()
    return { ok: true, data: { hideMainWindowOnLaunch: input } }
  }

  setHotkey(input: unknown): IpcResult<{ hotkey: string }> {
    this.assertOpen()
    const attempted = typeof input === 'string' ? input : this.runtime.field
    const applied = applyHotkey(input, this.deps.registrar, this.deps.onHotkey, this.runtime.active)
    this.runtime = hotkeyRuntimeAfterApply(this.runtime, applied, attempted)
    if (!applied.ok) return { ok: false, error: applied.warning ?? '热键注册失败' }
    this.settings.hotkey = applied.hotkey
    this.persist()
    return { ok: true, data: { hotkey: applied.hotkey } }
  }

  setPat(input: unknown): IpcResult<{ patSaved: true }> {
    this.assertOpen()
    let token: string
    try {
      token = normalizePat(input)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'PAT 无效' }
    }
    let ciphertext: string
    try {
      ciphertext = this.deps.secretBox.encrypt(token)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '无法加密 token' }
    }
    const next: PersistedSettings = { ...this.settings, patCiphertext: ciphertext }
    try {
      assertSerializedWithoutSecret(JSON.stringify(next), token)
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '已拒绝明文保存 token' }
    }
    this.settings = next
    this.persist()
    return { ok: true, data: { patSaved: true } }
  }

  clearPat(): IpcResult<{ patSaved: false }> {
    this.assertOpen()
    this.settings.patCiphertext = null
    this.persist()
    return { ok: true, data: { patSaved: false } }
  }

  async testConnection(pasted?: unknown): Promise<{ ok: true, login: string } | { ok: false, error: string }> {
    const tasks = this.deps.tasks
    return tasks
      ? tasks.run(signal => this.runConnectionTest(pasted, signal), '测试 GitHub 连接')
      : this.runConnectionTest(pasted)
  }

  private async runConnectionTest(pasted: unknown, signal?: AbortSignal): Promise<{ ok: true, login: string } | { ok: false, error: string }> {
    try {
      throwIfCancelled(signal)
      if (typeof pasted === 'string' && pasted.trim()) {
        const token = normalizePat(pasted)
        return await testGithubConnection({ token, fetchImpl: this.deps.fetchImpl, signal })
      }
      // An explicit connection test must observe a fresh `gh auth login`.
      invalidateGhAuthTokenCache()
      const resolved = await this.resolveAuth({ signal, tasks: this.deps.tasks })
      return await testGithubConnection({
        token: resolved.token,
        fetchImpl: this.deps.fetchImpl,
        signal
      })
    } catch (error) {
      if (isCancellation(error)) throw error
      return { ok: false, error: error instanceof Error ? error.message : '测试连接失败。请稍后重试。' }
    }
  }

  private persist(): void {
    this.assertOpen()
    saveSettings(this.deps.file, this.settings)
  }

  readSavedPat(): string | null {
    return this.readPat()
  }

  private readPat(): string | null {
    if (!this.settings.patCiphertext) return null
    try {
      const token = this.deps.secretBox.decrypt(this.settings.patCiphertext)
      return token || null
    } catch (error) {
      this.deps.log?.(error instanceof Error ? error.message : '无法解密已保存的 token')
      return null
    }
  }

  private resolveAuth(options: GithubAuthTaskOptions = {}) {
    const readGh = this.deps.readGh ?? (context => readGhAuthTokenCached(context, this.deps.log))
    return resolveGithubAuth({
      readGh,
      readPat: () => this.readPat(),
      patSaved: Boolean(this.settings.patCiphertext),
      ...options
    })
  }

  private assertOpen(): void {
    this.deps.tasks?.assertOpen()
  }
}
