import type { AppState, IpcResult } from '../shared/types.js'
import {
  readGhAuthToken,
  resolveGithubAuth,
  testGithubConnection,
  toPublicGithubAuth,
  type GhLookup
} from './github-auth.js'
import { applyHotkey, hotkeyConflictWarning, type HotkeyRegistrar } from './hotkey.js'
import { hotkeyRuntimeAfterApply, type HotkeyRuntime } from '../shared/hotkey-status.js'
import { normalizePat, normalizeWatchedRepos } from './ipc-validators.js'
import { loadSettings, saveSettings, type PersistedSettings } from './settings-store.js'
import { assertSerializedWithoutSecret, type SecretBox } from './token-store.js'

export interface SettingsServiceDeps {
  file: string
  secretBox: SecretBox
  registrar: HotkeyRegistrar
  onHotkey: () => void
  readGh?: () => Promise<GhLookup>
  fetchImpl?: typeof fetch
  log?: (message: string) => void
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
    const github = toPublicGithubAuth(await this.resolveAuth())
    return {
      watchedRepos: [...this.settings.watchedRepos],
      hotkey: this.runtime.field,
      activeHotkey: this.runtime.active,
      hotkeyWarning: this.runtime.warning,
      hotkeyUnavailable: this.runtime.banner,
      github
    }
  }

  setRepos(input: unknown): IpcResult<{ watchedRepos: string[] }> {
    try {
      const watchedRepos = normalizeWatchedRepos(input)
      this.settings.watchedRepos = watchedRepos
      this.persist()
      return { ok: true, data: { watchedRepos } }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '关注仓库无效' }
    }
  }

  setHotkey(input: unknown): IpcResult<{ hotkey: string }> {
    const attempted = typeof input === 'string' ? input : this.runtime.field
    const applied = applyHotkey(input, this.deps.registrar, this.deps.onHotkey, this.runtime.active)
    this.runtime = hotkeyRuntimeAfterApply(this.runtime, applied, attempted)
    if (!applied.ok) return { ok: false, error: applied.warning ?? '热键注册失败' }
    this.settings.hotkey = applied.hotkey
    this.persist()
    return { ok: true, data: { hotkey: applied.hotkey } }
  }

  setPat(input: unknown): IpcResult<{ patSaved: true }> {
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
    this.settings.patCiphertext = null
    this.persist()
    return { ok: true, data: { patSaved: false } }
  }

  async testConnection(pasted?: unknown): Promise<{ ok: true, login: string } | { ok: false, error: string }> {
    try {
      if (typeof pasted === 'string' && pasted.trim()) {
        const token = normalizePat(pasted)
        return await testGithubConnection({ token, fetchImpl: this.deps.fetchImpl })
      }
      const resolved = await this.resolveAuth()
      return await testGithubConnection({
        token: resolved.token,
        fetchImpl: this.deps.fetchImpl
      })
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '测试连接失败。请稍后重试。' }
    }
  }

  private persist(): void {
    saveSettings(this.deps.file, this.settings)
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

  private resolveAuth() {
    const readGh = this.deps.readGh ?? (() => readGhAuthToken(undefined, this.deps.log))
    return resolveGithubAuth({
      readGh,
      readPat: () => this.readPat(),
      patSaved: Boolean(this.settings.patCiphertext)
    })
  }
}
