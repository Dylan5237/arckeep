import { describe, expect, it } from 'vitest'
import { hotkeyFailureRequested } from '../src/main/test-hooks.js'
import {
  hotkeyUnavailableMessage,
  trayMenuEntries,
  trayToolTip,
  unavailableComboAfterApply
} from '../src/shared/hotkey-status.js'
import { DEFAULT_HOTKEY } from '../src/shared/types.js'

describe('hotkey availability', () => {
  it('names the occupied combo at startup and clears it after a successful register', () => {
    const failed = unavailableComboAfterApply(null, {
      ok: false,
      hotkey: DEFAULT_HOTKEY,
      warning: `${DEFAULT_HOTKEY} 已被其他程序占用`
    }, null)
    expect(failed).toBe(DEFAULT_HOTKEY)
    expect(hotkeyUnavailableMessage(failed ?? '')).toBe('Ctrl+Alt+Space 已被其他程序占用，快速捕获暂不可用')

    expect(unavailableComboAfterApply(failed, {
      ok: true,
      hotkey: 'Ctrl+Alt+K',
      warning: null
    }, null)).toBeNull()
  })

  it('keeps capture available when a conflicting save restores the previous combo', () => {
    expect(unavailableComboAfterApply(null, {
      ok: false,
      hotkey: DEFAULT_HOTKEY,
      warning: 'Ctrl+Alt+K 已被其他程序占用'
    }, DEFAULT_HOTKEY)).toBeNull()
  })

  it('does not treat a validation error as an occupied combo', () => {
    expect(unavailableComboAfterApply('Ctrl+Alt+K', {
      ok: false,
      hotkey: 'Ctrl+Alt+K',
      warning: '热键无效'
    }, null)).toBe('Ctrl+Alt+K')
    expect(unavailableComboAfterApply(null, {
      ok: false,
      hotkey: DEFAULT_HOTKEY,
      warning: '热键无效'
    }, DEFAULT_HOTKEY)).toBeNull()
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
    expect(trayToolTip(DEFAULT_HOTKEY)).toBe('Ctrl+Alt+Space 已被其他程序占用，快速捕获暂不可用')
  })

  it('requests a startup registration failure only when test hooks are exactly enabled', () => {
    expect(hotkeyFailureRequested({}, ['--arckeep-test=hotkey-fail'])).toBe(false)
    expect(hotkeyFailureRequested({ ARCKEEP_TEST_HOOKS: 'true' }, ['--arckeep-test=hotkey-fail'])).toBe(false)
    expect(hotkeyFailureRequested({ ARCKEEP_TEST_HOOKS: '1' }, ['--arckeep-test=capture'])).toBe(false)
    expect(hotkeyFailureRequested({ ARCKEEP_TEST_HOOKS: '1' }, ['Arckeep.exe', '--arckeep-test=hotkey-fail'])).toBe(true)
  })
})
