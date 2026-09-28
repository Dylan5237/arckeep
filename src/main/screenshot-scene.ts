import { SettingsService } from './settings-service.js'
import type { SecretBox } from './token-store.js'

export const SCREENSHOT_SCENES = [
  'nav',
  'signed-out',
  'invalid-token',
  'connected',
  'hotkey-conflict',
  'hotkey-banner',
  'hotkey-save-conflict',
  'narrow',
  'capture-empty',
  'capture-opened',
  'capture-filled',
  'capture-draft',
  'capture-saved',
  'todos',
  'todos-empty',
  'todos-filter',
  'todos-delete',
  'todos-narrow'
] as const

export type ScreenshotScene = (typeof SCREENSHOT_SCENES)[number]

/** Visible login in the connected screenshot. Not a GitHub account we control. */
export const MOCK_GITHUB_LOGIN = 'mock-user'

/**
 * Stand-in strings for screenshot fixtures. They are not GitHub tokens and must
 * never be sent to api.github.com. The connected fixture stays in memory; the
 * expired one is encrypted before it touches the temp settings file.
 */
export const MOCK_EXPIRED_TOKEN = 'zzfakeexpiredpatvalue'
export const MOCK_GH_TOKEN = 'zzmockgithubcredential'

export function parseScreenshotScene(value: string | undefined): ScreenshotScene {
  if (value && (SCREENSHOT_SCENES as readonly string[]).includes(value)) {
    return value as ScreenshotScene
  }
  return 'nav'
}

export function screenshotWindowSize(scene: ScreenshotScene): { width: number, height: number } {
  if (scene === 'narrow' || scene === 'todos-narrow') return { width: 800, height: 760 }
  if (scene === 'nav' || scene === 'todos-empty') return { width: 1120, height: 760 }
  if (scene === 'todos' || scene === 'todos-filter' || scene === 'todos-delete') {
    return { width: 1120, height: 1100 }
  }
  if (scene === 'capture-empty' || scene === 'capture-opened' || scene === 'capture-filled' || scene === 'capture-draft' || scene === 'capture-saved') {
    return { width: 800, height: 600 }
  }
  if (scene === 'hotkey-banner' || scene === 'hotkey-save-conflict') {
    return { width: 1120, height: 760 }
  }
  return { width: 1120, height: 900 }
}

export function screenshotOpensSettings(scene: ScreenshotScene): boolean {
  return scene === 'signed-out' || scene === 'invalid-token' || scene === 'connected' || scene === 'hotkey-conflict' || scene === 'hotkey-save-conflict'
}

export function screenshotOpensTodos(scene: ScreenshotScene): boolean {
  return scene === 'todos'
    || scene === 'todos-empty'
    || scene === 'todos-filter'
    || scene === 'todos-delete'
    || scene === 'todos-narrow'
}

export function screenshotShowsMainWindow(scene: ScreenshotScene): boolean {
  return scene !== 'capture-empty'
    && scene !== 'capture-opened'
    && scene !== 'capture-filled'
    && scene !== 'capture-draft'
    && scene !== 'capture-saved'
}

function fixtureSecretBox(): SecretBox {
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

export function createScreenshotSettings(scene: ScreenshotScene, file: string): SettingsService {
  const held = new Set<string>()
  const service = new SettingsService({
    file,
    secretBox: fixtureSecretBox(),
    registrar: {
      register: (accelerator: string) => {
        if (scene === 'hotkey-conflict' || scene === 'hotkey-banner') return false
        if (scene === 'hotkey-save-conflict' && accelerator === 'Ctrl+Alt+K') return false
        held.add(accelerator)
        return true
      },
      isRegistered: (accelerator: string) => held.has(accelerator),
      unregister: (accelerator: string) => { held.delete(accelerator) }
    },
    onHotkey: () => {},
    readGh: async () => {
      if (scene === 'connected') return { ok: true, token: MOCK_GH_TOKEN }
      return { ok: false, reason: 'not-installed' }
    },
    fetchImpl: async () => {
      if (scene === 'connected') {
        return new Response(JSON.stringify({ login: MOCK_GITHUB_LOGIN }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response('rejected', { status: 401 })
    },
    log: () => {}
  })
  service.init()
  if (scene === 'invalid-token') {
    const saved = service.setPat(MOCK_EXPIRED_TOKEN)
    if (!saved.ok) throw new Error(saved.error)
  }
  if (scene === 'connected') {
    const repos = service.setRepos(['example/demo'])
    if (!repos.ok) throw new Error(repos.error)
  }
  return service
}
