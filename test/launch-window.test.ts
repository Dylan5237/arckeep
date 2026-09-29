import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { shouldShowMainWindowOnReady } from '../src/main/launch-window.js'
import { settingsFilePath } from '../src/main/paths.js'
import { SettingsService } from '../src/main/settings-service.js'
import { loadSettings, parseSettings } from '../src/main/settings-store.js'
import type { HotkeyRegistrar } from '../src/main/hotkey.js'
import type { SecretBox } from '../src/main/token-store.js'

function xorBox(): SecretBox {
  return {
    encrypt: plain => Buffer.from(plain, 'utf8').toString('base64'),
    decrypt: payload => Buffer.from(payload, 'base64').toString('utf8')
  }
}

const registrar: HotkeyRegistrar = {
  register: () => true,
  isRegistered: () => false,
  unregister: () => {}
}

describe('startup window visibility', () => {
  it('shows the main window unless the setting hides it, and screenshots ignore the setting', () => {
    expect(shouldShowMainWindowOnReady({
      screenshot: false,
      screenshotShowsMainWindow: true,
      hideMainWindowOnLaunch: false
    })).toBe(true)
    expect(shouldShowMainWindowOnReady({
      screenshot: false,
      screenshotShowsMainWindow: false,
      hideMainWindowOnLaunch: true
    })).toBe(false)
    expect(shouldShowMainWindowOnReady({
      screenshot: true,
      screenshotShowsMainWindow: true,
      hideMainWindowOnLaunch: true
    })).toBe(true)
    expect(shouldShowMainWindowOnReady({
      screenshot: true,
      screenshotShowsMainWindow: false,
      hideMainWindowOnLaunch: false
    })).toBe(false)
  })

  it('defaults the setting off for existing settings files and persists a toggle', () => {
    expect(parseSettings({ version: 2, hotkey: 'Ctrl+Alt+Space' }).hideMainWindowOnLaunch).toBe(false)
    expect(parseSettings({ hideMainWindowOnLaunch: true }).hideMainWindowOnLaunch).toBe(true)
    expect(parseSettings({ hideMainWindowOnLaunch: 'yes' }).hideMainWindowOnLaunch).toBe(false)

    const file = settingsFilePath(mkdtempSync(path.join(tmpdir(), 'arckeep-launch-')))
    const service = new SettingsService({
      file,
      secretBox: xorBox(),
      registrar,
      onHotkey: () => {}
    })
    expect(service.getSettings().hideMainWindowOnLaunch).toBe(false)
    expect(service.setHideMainWindowOnLaunch(true)).toEqual({ ok: true, data: { hideMainWindowOnLaunch: true } })
    expect(loadSettings(file).hideMainWindowOnLaunch).toBe(true)
    expect(service.setHideMainWindowOnLaunch('yes')).toMatchObject({ ok: false })
    expect(loadSettings(file).hideMainWindowOnLaunch).toBe(true)
  })
})