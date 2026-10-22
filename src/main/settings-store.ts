import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { defaultOverviewConfig, parseOverviewConfig } from '../shared/overview/rules.js'
import type { OverviewConfig } from '../shared/overview/types.js'
import { defaultWaitingConfig, parseWaitingConfig } from '../shared/waiting/rules.js'
import type { WaitingConfig } from '../shared/waiting/types.js'
import { DEFAULT_HOTKEY } from '../shared/types.js'
import { normalizeAccelerator } from './hotkey.js'
import { normalizeWatchedRepos } from './ipc-validators.js'
import { toolShelfExampleText } from './tool-assets.js'
import { DEFAULT_REPO_FETCH_WINDOW, parseRepoFetchWindow, type RepoFetchWindow } from '../shared/repo-fetch-window.js'

export interface PersistedSettings {
  version: 2
  watchedRepos: string[]
  repoFetchWindow: RepoFetchWindow
  hotkey: string
  patCiphertext: string | null
  waiting: WaitingConfig
  overview: OverviewConfig
  toolShelfJson: string
  /** When true, a normal launch leaves the main window hidden and keeps the tray. */
  hideMainWindowOnLaunch: boolean
}

export function defaultSettings(): PersistedSettings {
  return {
    version: 2,
    watchedRepos: [],
    repoFetchWindow: DEFAULT_REPO_FETCH_WINDOW,
    hotkey: DEFAULT_HOTKEY,
    patCiphertext: null,
    waiting: defaultWaitingConfig(),
    overview: defaultOverviewConfig(),
    toolShelfJson: toolShelfExampleText(),
    hideMainWindowOnLaunch: false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const LEGACY_DEFAULT_APO_ACTION = {
  id: 'apo-init',
  title: 'apo 项目初始化',
  description: '初始化一个 apo 项目。',
  confirmLabel: '在 {{cwd}} 初始化 {{name}}',
  type: 'run-command',
  shell: 'powershell',
  cwd: '{{cwd}}',
  previewCommand: 'apo init --dry-run --name {{name}}',
  command: 'apo init --name {{name}}',
  params: [
    { key: 'cwd', label: '工作目录', required: true, input: 'directory', default: 'C:\\work\\demo' },
    { key: 'name', label: '项目名', required: true, default: 'demo' }
  ]
}

function upgradeDefaultApoAction(toolShelfJson: string, defaultToolShelfJson: string): string {
  let savedShelf: unknown
  let defaultShelf: unknown
  try {
    savedShelf = JSON.parse(toolShelfJson) as unknown
    defaultShelf = JSON.parse(defaultToolShelfJson) as unknown
  } catch {
    return toolShelfJson
  }
  if (!isRecord(savedShelf) || !Array.isArray(savedShelf.actions)
    || !isRecord(defaultShelf) || !Array.isArray(defaultShelf.actions)) return toolShelfJson

  const replacement = defaultShelf.actions.find(action =>
    isRecord(action) && action.id === 'apo-init' && action.type === 'template')
  if (replacement === undefined) return toolShelfJson

  let replaced = false
  const actions = savedShelf.actions.map(action => {
    if (!replaced && isDeepStrictEqual(action, LEGACY_DEFAULT_APO_ACTION)) {
      replaced = true
      return replacement
    }
    return action
  })
  if (!replaced) return toolShelfJson
  return JSON.stringify({ ...savedShelf, actions }, null, 2)
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
  // Version 1 saved「待办」as off because the settings switch was a disabled
  // placeholder. That was not a user choice, so turn the source on once.
  if (raw.version !== 2) {
    waiting = { ...waiting, sources: { ...waiting.sources, todos: true } }
  }
  const savedToolShelfJson = typeof raw.toolShelfJson === 'string' && raw.toolShelfJson.trim()
    ? raw.toolShelfJson
    : defaults.toolShelfJson
  const toolShelfJson = upgradeDefaultApoAction(savedToolShelfJson, defaults.toolShelfJson)
  const hideMainWindowOnLaunch = raw.hideMainWindowOnLaunch === true
  let repoFetchWindow = DEFAULT_REPO_FETCH_WINDOW
  try { repoFetchWindow = parseRepoFetchWindow(raw.repoFetchWindow) } catch { /* Keep other settings intact. */ }
  return {
    version: 2,
    watchedRepos,
    repoFetchWindow,
    hotkey,
    patCiphertext,
    waiting,
    overview,
    toolShelfJson,
    hideMainWindowOnLaunch
  }
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
  const payload = JSON.stringify({ ...settings, version: 2 }, null, 2)
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, file)
}
