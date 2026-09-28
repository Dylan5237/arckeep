import { parseWaitingConfig } from '../shared/waiting/rules.js'
import type { WaitingConfig } from '../shared/waiting/types.js'
import type { AppState, IpcResult } from '../shared/types.js'
import { validateToolShelfText } from './tool-validate.js'
import {
  readGhAuthToken,
  resolveGithubAuth,
  testGithubConnection,
  toPublicGithubAuth,
  type GhLookup
} from './github-auth.js'
import { applyHotkey, type HotkeyRegistrar } from './hotkey.js'
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
  private hotkeyWarning: string | null = null
  private activeHotkey: string | null = null

  constructor(private readonly deps: SettingsServiceDeps) {
    this.settings = loadSettings(deps.file)
  }

  init(): void {
    const applied = applyHotkey(this.settings.hotkey, this.deps.registrar, this.deps.onHotkey, null)
    if (!applied.ok) {
      this.activeHotkey = null
      this.hotkeyWarning = applied.warning
      return
    }
    this.activeHotkey = applied.hotkey
    this.hotkeyWarning = null
    if (applied.hotkey !== this.settings.hotkey) {
      this.settings.hotkey = applied.hotkey
      this.persist()
    }
  }

  getSettings(): PersistedSettings {
    return { ...this.settings, watchedRepos: [...this.settings.watchedRepos] }
  }

  async getState(): Promise<AppState> {
    const github = toPublicGithubAuth(await this.resolveAuth())
    return {
      watchedRepos: [...this.settings.watchedRepos],
      hotkey: this.settings.hotkey,
      hotkeyWarning: this.hotkeyWarning,
      github,
      waiting: this.settings.waiting,
      toolShelfJson: this.settings.toolShelfJson
    }
  }

  setToolShelfJson(input: unknown): IpcResult<{ toolShelfJson: string }> {
    if (typeof input !== 'string') return { ok: false, error: '工具架配置必须是 JSON 文本' }
    const validated = validateToolShelfText(input)
    if (!validated.ok) return { ok: false, error: validated.error }
    this.settings.toolShelfJson = input
    this.persist()
    return { ok: true, data: { toolShelfJson: input } }
  }

  setWaiting(input: unknown): IpcResult<{ waiting: WaitingConfig }> {
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
    this.settings.waiting = { ...this.settings.waiting, showIgnored: show }
    this.persist()
    return this.settings.waiting
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
    const applied = applyHotkey(input, this.deps.registrar, this.deps.onHotkey, this.activeHotkey)
    if (!applied.ok) {
      this.hotkeyWarning = applied.warning
      return { ok: false, error: applied.warning ?? '热键注册失败' }
    }
    this.activeHotkey = applied.hotkey
    this.hotkeyWarning = null
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

  private resolveAuth() {
    const readGh = this.deps.readGh ?? (() => readGhAuthToken(undefined, this.deps.log))
    return resolveGithubAuth({
      readGh,
      readPat: () => this.readPat(),
      patSaved: Boolean(this.settings.patCiphertext)
    })
  }
}
