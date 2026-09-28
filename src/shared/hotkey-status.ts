export const HOTKEY_TRAY_CAPTURE = '快速捕获'
export const HOTKEY_TRAY_UNAVAILABLE = '快速捕获热键未生效'

export function hotkeyUnavailableMessage(combo: string): string {
  return `${combo} 已被其他程序占用，快速捕获暂不可用`
}

const CONFLICT_SUFFIX = ' 已被其他程序占用'

export function conflictCombo(warning: string | null): string | null {
  if (!warning?.endsWith(CONFLICT_SUFFIX)) return null
  const combo = warning.slice(0, -CONFLICT_SUFFIX.length).trim()
  return combo.length > 0 ? combo : null
}

/**
 * Combo named by the startup banner, or null when a hotkey is registered.
 * A failed save that restores the previous combo clears the banner.
 * A validation error does not invent a new occupied combo.
 */
export function unavailableComboAfterApply(
  previousUnavailable: string | null,
  applied: { ok: boolean, hotkey: string, warning: string | null },
  previouslyRegistered: string | null
): string | null {
  if (applied.ok) return null
  if (previouslyRegistered && applied.hotkey === previouslyRegistered) return null
  return conflictCombo(applied.warning) ?? previousUnavailable
}

export interface TrayMenuEntry {
  label: string
  enabled: boolean
  role: 'open' | 'capture' | 'unavailable' | 'quit'
}

export function trayMenuEntries(unavailableCombo: string | null): TrayMenuEntry[] {
  return [
    { label: '打开', enabled: true, role: 'open' },
    unavailableCombo
      ? { label: HOTKEY_TRAY_UNAVAILABLE, enabled: false, role: 'unavailable' }
      : { label: HOTKEY_TRAY_CAPTURE, enabled: true, role: 'capture' },
    { label: '退出', enabled: true, role: 'quit' }
  ]
}

export function trayToolTip(unavailableCombo: string | null): string {
  return unavailableCombo ? hotkeyUnavailableMessage(unavailableCombo) : 'Arckeep'
}
