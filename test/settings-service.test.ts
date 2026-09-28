import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { type HotkeyRegistrar } from '../src/main/hotkey.js'
import { settingsFilePath, todosFilePath, userDataDir } from '../src/main/paths.js'
import { SettingsService } from '../src/main/settings-service.js'
import { loadSettings } from '../src/main/settings-store.js'
import type { SecretBox } from '../src/main/token-store.js'
import { DEFAULT_HOTKEY } from '../src/shared/types.js'

function xorBox(): SecretBox {
  return {
    encrypt(plain: string) {
      const xored = Uint8Array.from(Buffer.from(plain, 'utf8'), byte => byte ^ 0x5a)
      return Buffer.from(xored).toString('base64')
    },
    decrypt(payload: string) {
      const xored = Uint8Array.from(Buffer.from(payload, 'base64'), byte => byte ^ 0x5a)
      return Buffer.from(xored).toString('utf8')
    }
  }
}

class FakeShortcuts implements HotkeyRegistrar {
  readonly registered = new Set<string>()
  readonly blocked = new Set<string>()

  register(accelerator: string): boolean {
    if (this.blocked.has(accelerator)) return false
    this.registered.add(accelerator)
    return true
  }

  isRegistered(accelerator: string): boolean {
    return this.registered.has(accelerator)
  }

  unregister(accelerator: string): void {
    this.registered.delete(accelerator)
  }
}

function tempFile(): string {
  return settingsFilePath(mkdtempSync(path.join(tmpdir(), 'arckeep-settings-')))
}

describe('settings persistence', () => {
  it('keeps watched repos and the hotkey across a restart', () => {
    const file = tempFile()
    const shortcuts = new FakeShortcuts()
    const first = new SettingsService({
      file,
      secretBox: xorBox(),
      registrar: shortcuts,
      onHotkey: () => {},
      readGh: async () => ({ ok: false, reason: 'not-installed' })
    })
    first.init()
    expect(first.setRepos(['Dylan5237/arckeep', 'Dylan5237/kcc-workbench']).ok).toBe(true)
    expect(first.setHotkey('Ctrl+Shift+A').ok).toBe(true)

    const reloaded = loadSettings(file)
    expect(reloaded.watchedRepos).toEqual(['Dylan5237/arckeep', 'Dylan5237/kcc-workbench'])
    expect(reloaded.hotkey).toBe('Ctrl+Shift+A')

    const second = new SettingsService({
      file,
      secretBox: xorBox(),
      registrar: new FakeShortcuts(),
      onHotkey: () => {},
      readGh: async () => ({ ok: false, reason: 'not-installed' })
    })
    second.init()
    expect(second.getSettings()).toMatchObject({
      watchedRepos: ['Dylan5237/arckeep', 'Dylan5237/kcc-workbench'],
      hotkey: 'Ctrl+Shift+A'
    })
  })

  it('registers the new hotkey, drops the old one, and registers the saved combo after restart', () => {
    const file = tempFile()
    const shortcuts = new FakeShortcuts()
    const first = new SettingsService({
      file,
      secretBox: xorBox(),
      registrar: shortcuts,
      onHotkey: () => {},
      readGh: async () => ({ ok: false, reason: 'not-installed' })
    })
    first.init()
    expect(shortcuts.registered.has(DEFAULT_HOTKEY)).toBe(true)
    expect(first.setHotkey('Ctrl+Alt+K').ok).toBe(true)
    expect(shortcuts.registered.has(DEFAULT_HOTKEY)).toBe(false)
    expect(shortcuts.registered.has('Ctrl+Alt+K')).toBe(true)
    expect(loadSettings(file).hotkey).toBe('Ctrl+Alt+K')

    const restarted = new FakeShortcuts()
    const second = new SettingsService({
      file,
      secretBox: xorBox(),
      registrar: restarted,
      onHotkey: () => {},
      readGh: async () => ({ ok: false, reason: 'not-installed' })
    })
    second.init()
    expect(restarted.registered.has('Ctrl+Alt+K')).toBe(true)
    expect(restarted.registered.has(DEFAULT_HOTKEY)).toBe(false)
    expect(second.getSettings().hotkey).toBe('Ctrl+Alt+K')
  })

  it('stores an empty repo list as auto mode and starts from the default hotkey', () => {
    const file = tempFile()
    const service = new SettingsService({
      file,
      secretBox: xorBox(),
      registrar: new FakeShortcuts(),
      onHotkey: () => {},
      readGh: async () => ({ ok: false, reason: 'not-installed' })
    })
    service.init()
    expect(service.getSettings().hotkey).toBe(DEFAULT_HOTKEY)
    expect(service.setRepos([]).ok).toBe(true)
    expect(loadSettings(file).watchedRepos).toEqual([])
  })

  it('surfaces a settings warning when register succeeds but isRegistered does not', async () => {
    const file = tempFile()
    const service = new SettingsService({
      file,
      secretBox: xorBox(),
      registrar: {
        register: () => true,
        isRegistered: () => false,
        unregister: () => {}
      },
      onHotkey: () => {},
      readGh: async () => ({ ok: false, reason: 'not-installed' })
    })
    service.init()
    const state = await service.getState()
    expect(state.hotkeyWarning).toBe('Ctrl+Alt+Space 已被其他程序占用')
  })

  it('reports a hotkey conflict without replacing the saved accelerator', async () => {
    const file = tempFile()
    const shortcuts = new FakeShortcuts()
    const service = new SettingsService({
      file,
      secretBox: xorBox(),
      registrar: shortcuts,
      onHotkey: () => {},
      readGh: async () => ({ ok: false, reason: 'not-installed' })
    })
    service.init()
    shortcuts.blocked.add('Ctrl+Alt+K')
    const result = service.setHotkey('Ctrl+Alt+K')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe('Ctrl+Alt+K 已被其他程序占用')
    expect(loadSettings(file).hotkey).toBe(DEFAULT_HOTKEY)
    const state = await service.getState()
    expect(state.hotkeyWarning).toBe('Ctrl+Alt+K 已被其他程序占用')
    expect(state.hotkey).toBe(DEFAULT_HOTKEY)
  })

  it('uses gh CLI when it is logged in, and a saved PAT otherwise', async () => {
    const file = tempFile()
    const ghToken = 'ghp_cliTokenValue12345'
    const pat = 'ghp_pastedPatValue54321'
    const service = new SettingsService({
      file,
      secretBox: xorBox(),
      registrar: new FakeShortcuts(),
      onHotkey: () => {},
      readGh: async () => ({ ok: true, token: ghToken }),
      fetchImpl: async (_input, init) => {
        const header = new Headers(init?.headers).get('authorization') ?? ''
        const login = header.includes(ghToken) ? 'Dylan5237' : 'other'
        return new Response(JSON.stringify({ login }), { status: 200 })
      }
    })
    expect(service.setPat(pat).ok).toBe(true)
    expect(readFileSync(file, 'utf8').includes(pat.slice(0, 8))).toBe(false)
    const state = await service.getState()
    expect(state.github).toEqual({
      source: 'gh-cli',
      sourceLabel: '来源：gh CLI',
      patSaved: true
    })
    await expect(service.testConnection()).resolves.toEqual({ ok: true, login: 'Dylan5237' })

    const fallback = new SettingsService({
      file,
      secretBox: xorBox(),
      registrar: new FakeShortcuts(),
      onHotkey: () => {},
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      fetchImpl: async () => new Response(JSON.stringify({ login: 'Dylan5237' }), { status: 200 })
    })
    const fallbackState = await fallback.getState()
    expect(fallbackState.github.sourceLabel).toBe('来源：本机 PAT')
    await expect(fallback.testConnection()).resolves.toEqual({ ok: true, login: 'Dylan5237' })
  })

  it('returns a GitHub error instead of throwing when the token is rejected', async () => {
    const file = tempFile()
    const service = new SettingsService({
      file,
      secretBox: xorBox(),
      registrar: new FakeShortcuts(),
      onHotkey: () => {},
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      fetchImpl: async () => new Response('nope', { status: 401 })
    })
    expect(service.setPat('ghp_wrongTokenValue000').ok).toBe(true)
    const result = await service.testConnection()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/HTTP 401/)
  })
})

describe('user data path', () => {
  it('uses the Arckeep directory under %APPDATA%', () => {
    const appData = 'C:\\Users\\Dylan\\AppData\\Roaming'
    expect(userDataDir(appData, path.win32.join)).toBe('C:\\Users\\Dylan\\AppData\\Roaming\\Arckeep')
    expect(settingsFilePath(userDataDir(appData, path.win32.join), path.win32.join))
      .toBe('C:\\Users\\Dylan\\AppData\\Roaming\\Arckeep\\settings.json')
    expect(todosFilePath(userDataDir(appData, path.win32.join), path.win32.join))
      .toBe('C:\\Users\\Dylan\\AppData\\Roaming\\Arckeep\\todos.jsonl')
  })
})
