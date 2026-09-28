import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { defaultOverviewConfig, parseOverviewConfig } from '../shared/overview/rules.js'
import type { OverviewConfig } from '../shared/overview/types.js'
import { defaultWaitingConfig, parseWaitingConfig } from '../shared/waiting/rules.js'
import type { WaitingConfig } from '../shared/waiting/types.js'
import { DEFAULT_HOTKEY } from '../shared/types.js'
import { normalizeAccelerator } from './hotkey.js'
import { normalizeWatchedRepos } from './ipc-validators.js'

export interface PersistedSettings {
  version: 1
  watchedRepos: string[]
  hotkey: string
  patCiphertext: string | null
  waiting: WaitingConfig
  overview: OverviewConfig
}

export function defaultSettings(): PersistedSettings {
  return {
    version: 1,
    watchedRepos: [],
    hotkey: DEFAULT_HOTKEY,
    patCiphertext: null,
    waiting: defaultWaitingConfig(),
    overview: defaultOverviewConfig()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseSettings(raw: unknown): PersistedSettings {
  const defaults = defaultSettings()
  if (!isRecord(raw)) return defaults
  let watchedRepos = defaults.watchedRepos
  try {
    watchedRepos = normalizeWatchedRepos(raw.watchedRepos ?? [])
  } catch {
    watchedRepos = defaults.watchedRepos
  }
  let hotkey = defaults.hotkey
  try {
    hotkey = normalizeAccelerator(raw.hotkey ?? defaults.hotkey)
  } catch {
    hotkey = defaults.hotkey
  }
  const patCiphertext = typeof raw.patCiphertext === 'string' && raw.patCiphertext.length > 0
    ? raw.patCiphertext
    : null
  let waiting = defaultWaitingConfig()
  try {
    waiting = parseWaitingConfig(raw.waiting)
  } catch {
    waiting = defaultWaitingConfig()
  }
  let overview = defaultOverviewConfig()
  try {
    overview = parseOverviewConfig(raw.overview)
  } catch {
    overview = defaultOverviewConfig()
  }
  return { version: 1, watchedRepos, hotkey, patCiphertext, waiting, overview }
}

export function loadSettings(file: string): PersistedSettings {
  try {
    const text = readFileSync(file, 'utf8')
    return parseSettings(JSON.parse(text) as unknown)
  } catch {
    return defaultSettings()
  }
}

export function saveSettings(file: string, settings: PersistedSettings): void {
  mkdirSync(path.dirname(file), { recursive: true })
  const payload = JSON.stringify({ ...settings, version: 1 }, null, 2)
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, file)
}
