import { describe, expect, it } from 'vitest'
import { applyHotkey, normalizeAccelerator, type HotkeyRegistrar } from '../src/main/hotkey.js'
import { DEFAULT_HOTKEY } from '../src/shared/types.js'

class FakeShortcuts implements HotkeyRegistrar {
  readonly registered = new Map<string, () => void>()
  readonly blocked = new Set<string>()

  register(accelerator: string, callback: () => void): boolean {
    if (this.blocked.has(accelerator)) return false
    this.registered.set(accelerator, callback)
    return true
  }

  isRegistered(accelerator: string): boolean {
    return this.registered.has(accelerator)
  }

  unregister(accelerator: string): void {
    this.registered.delete(accelerator)
  }
}

describe('normalizeAccelerator', () => {
  it('keeps the default Ctrl+Alt+Space', () => {
    expect(normalizeAccelerator(DEFAULT_HOTKEY)).toBe('Ctrl+Alt+Space')
    expect(normalizeAccelerator(' ctrl+alt+space ')).toBe('Ctrl+Alt+Space')
  })

  it('rejects accelerators without a modifier', () => {
    expect(() => normalizeAccelerator('Space')).toThrow(/修饰键/)
    expect(() => normalizeAccelerator('Shift+A')).toThrow(/Ctrl、Alt 或 Super/)
  })
})

describe('applyHotkey', () => {
  it('warns and restores the previous accelerator when registration conflicts', () => {
    const shortcuts = new FakeShortcuts()
    const first = applyHotkey(DEFAULT_HOTKEY, shortcuts, () => {}, null)
    expect(first.ok).toBe(true)
    shortcuts.blocked.add('Ctrl+Alt+K')

    const conflict = applyHotkey('Ctrl+Alt+K', shortcuts, () => {}, first.hotkey)
    expect(conflict.ok).toBe(false)
    expect(conflict.warning).toMatch(/冲突/)
    expect(conflict.hotkey).toBe(DEFAULT_HOTKEY)
    expect(shortcuts.registered.has(DEFAULT_HOTKEY)).toBe(true)
    expect(shortcuts.registered.has('Ctrl+Alt+K')).toBe(false)
  })

  it('warns when register() returns true but isRegistered() is false', () => {
    const shortcuts = new FakeShortcuts()
    shortcuts.register = () => true
    shortcuts.isRegistered = () => false
    const result = applyHotkey('Ctrl+Alt+K', shortcuts, () => {}, null)
    expect(result.ok).toBe(false)
    expect(result.warning).toMatch(/冲突/)
  })

  it('does not unregister the current accelerator when the input is invalid', () => {
    const shortcuts = new FakeShortcuts()
    applyHotkey(DEFAULT_HOTKEY, shortcuts, () => {}, null)
    const invalid = applyHotkey('nope', shortcuts, () => {}, DEFAULT_HOTKEY)
    expect(invalid.ok).toBe(false)
    expect(invalid.warning).toMatch(/修饰键|无效/)
    expect(shortcuts.registered.has(DEFAULT_HOTKEY)).toBe(true)
  })
})
