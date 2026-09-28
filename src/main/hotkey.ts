import { DEFAULT_HOTKEY } from '../shared/types.js'

const MODIFIERS = ['CommandOrControl', 'Command', 'Cmd', 'Ctrl', 'Alt', 'Shift', 'Super', 'Meta'] as const

const NAMED_KEYS = new Set([
  'Space', 'Tab', 'Esc', 'Escape', 'Enter', 'Return', 'Backspace', 'Delete', 'Insert',
  'Home', 'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right', 'Plus', 'Minus'
])

export interface HotkeyRegistrar {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export interface HotkeyApplyResult {
  ok: boolean
  hotkey: string
  warning: string | null
}

export function normalizeAccelerator(input: unknown): string {
  if (typeof input !== 'string') throw new Error('热键无效')
  const raw = input.trim()
  if (!raw || raw.length > 80) throw new Error('热键无效')
  const parts = raw.split('+').map(part => part.trim()).filter(Boolean)
  if (parts.length < 2) throw new Error('热键至少需要一个修饰键和一个主键')

  const keyRaw = parts[parts.length - 1] ?? ''
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(keyRaw)
  const namedKey = [...NAMED_KEYS].find(name => name.toLowerCase() === keyRaw.toLowerCase())
  let key: string
  if (functionKey) key = `F${functionKey[1]}`
  else if (/^[a-z0-9]$/i.test(keyRaw)) key = keyRaw.toUpperCase()
  else if (namedKey) key = namedKey
  else throw new Error('热键主键无效')

  const mods: string[] = []
  for (const part of parts.slice(0, -1)) {
    const canonical = MODIFIERS.find(modifier => modifier.toLowerCase() === part.toLowerCase())
    if (!canonical) throw new Error(`无法识别的修饰键：${part}`)
    if (!mods.includes(canonical)) mods.push(canonical)
  }
  const hasPrimaryModifier = mods.some(modifier =>
    modifier === 'Ctrl' || modifier === 'Alt' || modifier === 'Super' || modifier === 'Meta'
    || modifier === 'Cmd' || modifier === 'Command' || modifier === 'CommandOrControl'
  )
  if (!hasPrimaryModifier) throw new Error('热键需要包含 Ctrl、Alt 或 Super')
  return [...mods, key].join('+')
}

export function hotkeyConflictWarning(accelerator: string): string {
  return `热键 ${accelerator} 注册失败，可能与其他程序冲突`
}

/**
 * Registers `requested`. On conflict, restores `previous` when possible and returns a visible warning.
 */
export function applyHotkey(
  requested: unknown,
  registrar: HotkeyRegistrar,
  onTrigger: () => void,
  previous: string | null
): HotkeyApplyResult {
  let accelerator: string
  try {
    accelerator = normalizeAccelerator(requested)
  } catch (error) {
    const message = error instanceof Error ? error.message : '热键无效'
    return {
      ok: false,
      hotkey: previous && previous.length > 0 ? previous : DEFAULT_HOTKEY,
      warning: message
    }
  }

  if (previous) {
    try {
      registrar.unregister(previous)
    } catch {
      // The previous accelerator may already be gone.
    }
  }

  if (registrar.register(accelerator, onTrigger)) {
    return { ok: true, hotkey: accelerator, warning: null }
  }

  let restored = false
  if (previous && previous !== accelerator) {
    restored = registrar.register(previous, onTrigger)
  }
  return {
    ok: false,
    hotkey: restored && previous ? previous : (previous ?? accelerator),
    warning: hotkeyConflictWarning(accelerator)
  }
}
