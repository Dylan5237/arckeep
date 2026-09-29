import { describe, expect, it } from 'vitest'
import { hotkeyFailureRequested } from '../src/main/test-hooks.js'
import {
  activeHotkeyLabel,
  hotkeyRuntimeAfterApply,
  hotkeyUnavailableMessage,
  shouldNotifyStartupHotkeyFailure,
  trayMenuEntries,
  trayToolTip,
  type HotkeyRuntime
} from '../src/shared/hotkey-status.js'
import { DEFAULT_HOTKEY } from '../src/shared/types.js'

const idle: HotkeyRuntime = { field: DEFAULT_HOTKEY, active: null, banner: null, warning: null }

describe('hotkey availability', () => {
  it('fails at startup, keeps the old hotkey on a later save failure, and clears the banner on success', () => {
    const startup = hotkeyRuntimeAfterApply(idle, {
      ok: false,
      hotkey: DEFAULT_HOTKEY,
      warning: `${DEFAULT_HOTKEY} 已被其他程序占用`
    }, DEFAULT_HOTKEY)
    expect(startup).toMatchObject({
      field: DEFAULT_HOTKEY,
      active: null,
      banner: DEFAULT_HOTKEY
    })
    expect(hotkeyUnavailableMessage(startup.banner ?? '')).toBe(
      '快速捕获热键 Ctrl+Alt+Space 被其他程序占用，现在按它不会有反应'
    )
    expect(activeHotkeyLabel(startup.active)).toBe('当前没有生效的热键')

    const registered = hotkeyRuntimeAfterApply(startup, {
      ok: true,
      hotkey: DEFAULT_HOTKEY,
      warning: null
    }, DEFAULT_HOTKEY)
    expect(registered.banner).toBeNull()
    expect(registered.active).toBe(DEFAULT_HOTKEY)

    const saveFailed = hotkeyRuntimeAfterApply(registered, {
      ok: false,
      hotkey: DEFAULT_HOTKEY,
      warning: 'Ctrl+Alt+K 已被其他程序占用'
    }, 'Ctrl+Alt+K')
    expect(saveFailed).toMatchObject({
      field: 'Ctrl+Alt+K',
      active: DEFAULT_HOTKEY,
      banner: null,
      warning: 'Ctrl+Alt+K 已被其他程序占用'
    })
    expect(activeHotkeyLabel(saveFailed.active)).toBe('当前生效：Ctrl+Alt+Space')

    const saved = hotkeyRuntimeAfterApply(saveFailed, {
      ok: true,
      hotkey: 'Ctrl+Shift+K',
      warning: null
    }, 'Ctrl+Shift+K')
    expect(saved).toEqual({
      field: 'Ctrl+Shift+K',
      active: 'Ctrl+Shift+K',
      banner: null,
      warning: null
    })
  })

  it('shows the banner only when the failed save leaves nothing registered', () => {
    const blocked: HotkeyRuntime = {
      field: DEFAULT_HOTKEY,
      active: null,
      banner: DEFAULT_HOTKEY,
      warning: `${DEFAULT_HOTKEY} 已被其他程序占用`
    }
    expect(hotkeyRuntimeAfterApply(blocked, {
      ok: false,
      hotkey: DEFAULT_HOTKEY,
      warning: 'Ctrl+Alt+K 已被其他程序占用'
    }, 'Ctrl+Alt+K')).toMatchObject({
      field: 'Ctrl+Alt+K',
      active: null,
      banner: 'Ctrl+Alt+K',
      warning: 'Ctrl+Alt+K 已被其他程序占用'
    })
  })

  it('does not treat a validation error as a newly occupied combo', () => {
    const live: HotkeyRuntime = { field: DEFAULT_HOTKEY, active: DEFAULT_HOTKEY, banner: null, warning: null }
    expect(hotkeyRuntimeAfterApply(live, {
      ok: false,
      hotkey: DEFAULT_HOTKEY,
      warning: '热键无效'
    }, 'nope')).toMatchObject({
      field: 'nope',
      active: DEFAULT_HOTKEY,
      banner: null
    })
  })

  it('sends one tray-only notification and skips it when the window is already visible', () => {
    const blocked = { banner: DEFAULT_HOTKEY, windowVisible: false, alreadySent: false }
    expect(shouldNotifyStartupHotkeyFailure(blocked)).toBe(true)
    expect(shouldNotifyStartupHotkeyFailure({ ...blocked, windowVisible: true })).toBe(false)
    expect(shouldNotifyStartupHotkeyFailure({ ...blocked, alreadySent: true })).toBe(false)
    expect(shouldNotifyStartupHotkeyFailure({ ...blocked, banner: null })).toBe(false)
  })

  it('disables the tray capture item and names the combo in the tooltip', () => {
    expect(trayMenuEntries(null).map(entry => [entry.label, entry.enabled])).toEqual([
      ['打开', true],
      ['快速捕获', true],
      ['退出', true]
    ])
    expect(trayToolTip(null)).toBe('Arckeep')
    const blocked = trayMenuEntries(DEFAULT_HOTKEY)
    expect(blocked[1]).toEqual({ label: '快速捕获热键未生效', enabled: false, role: 'unavailable' })
    expect(trayToolTip(DEFAULT_HOTKEY)).toBe(
      '快速捕获热键 Ctrl+Alt+Space 被其他程序占用，现在按它不会有反应'
    )
  })

  it('requests a startup registration failure only when test hooks are exactly enabled', () => {
    expect(hotkeyFailureRequested({}, ['--arckeep-test=hotkey-fail'])).toBe(false)
    expect(hotkeyFailureRequested({ ARCKEEP_TEST_HOOKS: 'true' }, ['--arckeep-test=hotkey-fail'])).toBe(false)
    expect(hotkeyFailureRequested({ ARCKEEP_TEST_HOOKS: '1' }, ['--arckeep-test=capture'])).toBe(false)
    expect(hotkeyFailureRequested({ ARCKEEP_TEST_HOOKS: '1' }, ['Arckeep.exe', '--arckeep-test=hotkey-fail'])).toBe(true)
  })
})
