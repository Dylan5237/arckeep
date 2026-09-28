import type { WaitingConfig, WaitingSnapshot } from './waiting/types.js'

export type { WaitingConfig, WaitingSnapshot } from './waiting/types.js'

export const DEFAULT_HOTKEY = 'Ctrl+Alt+Space'

export type GithubSource = 'gh-cli' | 'pat' | 'none'

export interface PublicGithubAuth {
  source: GithubSource
  sourceLabel: string
  patSaved: boolean
}

export interface AppState {
  watchedRepos: string[]
  hotkey: string
  hotkeyWarning: string | null
  github: PublicGithubAuth
  waiting: WaitingConfig
}

export interface OkResult<T> {
  ok: true
  data: T
}

export interface ErrResult {
  ok: false
  error: string
}

export type IpcResult<T> = OkResult<T> | ErrResult

export interface ArckeepApi {
  getState(): Promise<AppState>
  setRepos(repos: string[]): Promise<IpcResult<{ watchedRepos: string[] }>>
  setHotkey(hotkey: string): Promise<IpcResult<{ hotkey: string }>>
  setPat(token: string): Promise<IpcResult<{ patSaved: true }>>
  clearPat(): Promise<IpcResult<{ patSaved: false }>>
  testGithub(pastedToken?: string): Promise<{ ok: true, login: string } | { ok: false, error: string }>
  getWaiting(): Promise<WaitingSnapshot>
  refreshWaiting(): Promise<WaitingSnapshot>
  snoozeWaiting(id: string, days: 1 | 3 | 7): Promise<IpcResult<WaitingSnapshot>>
  ignoreWaiting(id: string): Promise<IpcResult<WaitingSnapshot>>
  restoreWaiting(id: string): Promise<IpcResult<WaitingSnapshot>>
  hideWaitingRepo(repo: string): Promise<IpcResult<WaitingSnapshot>>
  unhideWaitingRepo(repo: string): Promise<IpcResult<WaitingSnapshot>>
  setShowIgnored(show: boolean): Promise<IpcResult<WaitingSnapshot>>
  setWaiting(config: WaitingConfig): Promise<IpcResult<AppState>>
  openExternal(url: string): Promise<IpcResult<true>>
  advanceWaitingDays(days: number): Promise<IpcResult<WaitingSnapshot>>
}

export function githubSourceLabel(source: GithubSource): string {
  if (source === 'gh-cli') return '来源：gh CLI'
  if (source === 'pat') return '来源：本机 PAT'
  return '未配置'
}
