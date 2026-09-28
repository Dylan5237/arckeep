export const HOTKEY_TRAY_CAPTURE = '快速捕获'
export const HOTKEY_TRAY_UNAVAILABLE = '快速捕获热键未生效'

export function hotkeyUnavailableMessage(combo: string): string {
  return `快速捕获热键 ${combo} 被其他程序占用，现在按它不会有反应`
}

export function activeHotkeyLabel(active: string | null): string {
  return active ? `当前生效：${active}` : '当前没有生效的热键'
}

export interface HotkeyRuntime {
  /** Value shown in the hotkey input. Not necessarily registered. */
  field: string
  /** Combo that is registered right now. */
  active: string | null
  /** Combo named by the banner. Null hides the banner. */
  banner: string | null
  warning: string | null
}

/**
 * Startup failure, a failed save that keeps the previous combo, and a
 * successful register. The banner stays until a register succeeds; it does
 * not expire on its own. A failed save keeps the typed combo in `field`.
 */
export function hotkeyRuntimeAfterApply(
  current: HotkeyRuntime,
  applied: { ok: boolean, hotkey: string, warning: string | null },
  attempted: string
): HotkeyRuntime {
  if (applied.ok) {
    return { field: applied.hotkey, active: applied.hotkey, banner: null, warning: null }
  }
  const conflict = conflictCombo(applied.warning)
  const active = current.active && applied.hotkey === current.active ? current.active : null
  const typed = attempted.trim()
  return {
    field: conflict ?? (typed || current.field),
    active,
    banner: conflict ?? current.banner,
    warning: applied.warning
  }
}

/** One system notification when startup fails and the main window is not on screen. */
export function shouldNotifyStartupHotkeyFailure(input: {
  banner: string | null
  windowVisible: boolean
  alreadySent: boolean
}): boolean {
  return !input.alreadySent && !input.windowVisible && input.banner !== null
}

const CONFLICT_SUFFIX = ' 已被其他程序占用'

export function conflictCombo(warning: string | null): string | null {
  if (!warning?.endsWith(CONFLICT_SUFFIX)) return null
  const combo = warning.slice(0, -CONFLICT_SUFFIX.length).trim()
  return combo.length > 0 ? combo : null
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
