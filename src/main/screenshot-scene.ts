import { SettingsService } from './settings-service.js'
import type { SecretBox } from './token-store.js'

export const SCREENSHOT_SCENES = [
  'nav',
  'signed-out',
  'invalid-token',
  'connected',
  'hotkey-conflict',
  'narrow'
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
  if (scene === 'narrow') return { width: 800, height: 760 }
  if (scene === 'nav') return { width: 1120, height: 760 }
  return { width: 1120, height: 900 }
}

export function screenshotOpensSettings(scene: ScreenshotScene): boolean {
  return scene !== 'nav' && scene !== 'narrow'
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
        if (scene === 'hotkey-conflict') return false
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
