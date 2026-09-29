import { TOOL_SCREENSHOT_SCENES, toolScreenshotExpectation } from './screenshot-tools.js'
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
  'todos-narrow',
  'waiting',
  'waiting-empty',
  'waiting-no-token',
  'waiting-invalid-token',
  'waiting-loading',
  'waiting-rate-limit',
  'waiting-narrow',
  'waiting-hover',
  'waiting-ignore',
  'waiting-watch',
  'waiting-hidden',
  'waiting-family',
  'overview',
  'overview-collapsed',
  'overview-archived',
  'overview-empty',
  'overview-auto-empty',
  'overview-no-token',
  'overview-invalid-token',
  'overview-loading',
  'overview-row-error',
  'overview-narrow',
  'overview-chip-hover',
  ...TOOL_SCREENSHOT_SCENES
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
  if (scene === 'waiting-narrow' || scene === 'overview-narrow') return { width: 800, height: 1680 }
  if (scene === 'tools-narrow' || scene === 'narrow' || scene === 'todos-narrow') return { width: 800, height: 760 }
  if (scene === 'tools') return { width: 1120, height: 760 }
  if (scene === 'tools-running' || scene === 'tools-success' || scene === 'tools-failed' || scene === 'tools-aborted') {
    return { width: 1120, height: 900 }
  }
  if (scene === 'tools-preview' || scene === 'tools-preview-failed' || scene === 'tools-params' || scene === 'tools-copied') {
    return { width: 1120, height: 860 }
  }
  if (scene === 'tools-invalid') return { width: 1120, height: 980 }
  if (scene === 'waiting-hover' || scene === 'waiting-ignore' || scene === 'overview-chip-hover') return { width: 1180, height: 900 }
  if (scene === 'waiting-hidden') return { width: 1180, height: 980 }
  if (scene === 'waiting-watch' || scene === 'waiting-family') return { width: 1180, height: 720 }
  if (scene === 'overview-archived') return { width: 1180, height: 820 }
  if (scene === 'waiting' || scene === 'waiting-rate-limit' || scene === 'overview' || scene === 'overview-collapsed') return { width: 1180, height: 1680 }
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
  return scene === 'signed-out'
    || scene === 'invalid-token'
    || scene === 'connected'
    || scene === 'hotkey-conflict'
    || scene === 'hotkey-save-conflict'
    || scene === 'tools-invalid'
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

export function screenshotStartPage(scene: ScreenshotScene): 'inbox' | 'projects' | 'settings' | 'tools' | 'todos' {
  if (screenshotOpensSettings(scene)) return 'settings'
  if (scene.startsWith('overview')) return 'projects'
  if (screenshotOpensTodos(scene)) return 'todos'
  if (scene.startsWith('tools')) return 'tools'
  return 'inbox'
}

export function screenshotReadyText(scene: ScreenshotScene): string {
  const toolText = toolScreenshotExpectation(scene)
  if (toolText) return toolText
  if (scene === 'connected') return MOCK_GITHUB_LOGIN
  if (scene === 'invalid-token') return 'HTTP 401'
  if (scene === 'signed-out') return '未配置'
  if (scene === 'hotkey-conflict') return '已被其他程序占用'
  if (scene === 'waiting' || scene === 'waiting-narrow' || scene === 'waiting-hover') return '验收北区截图'
  if (scene === 'waiting-watch') return '不会把别人的 open PR'
  if (scene === 'waiting-hidden') return '已忽略的仓库'
  if (scene === 'waiting-family') return '含 2 个子项'
  if (scene === 'waiting-empty') return '没有等你处理的事项'
  if (scene === 'waiting-no-token') return '未配置 GitHub 认证'
  if (scene === 'waiting-invalid-token') return 'GitHub 认证无效或已过期'
  if (scene === 'waiting-loading') return '正在刷新'
  if (scene === 'waiting-rate-limit') return '速率限制'
  if (scene === 'overview' || scene === 'overview-narrow' || scene === 'overview-collapsed') return 'harbor/lumen'
  if (scene === 'overview-archived') return '已归档'
  if (scene === 'overview-empty' || scene === 'overview-auto-empty') return '还没有可显示的仓库'
  if (scene === 'overview-chip-hover') return '卡住：CI 失败'
  if (scene === 'overview-no-token') return '未配置 GitHub 认证'
  if (scene === 'overview-invalid-token') return 'GitHub 认证无效或已过期'
  if (scene === 'overview-loading') return '正在刷新'
  if (scene === 'overview-row-error') return '仓库不存在或无权访问'
  return '等我处理'
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
