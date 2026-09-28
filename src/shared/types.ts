import type { ToolFixture } from './tools/fixture.js'
import type { ActionPreview, ToolAction, ToolRunEvent } from './tools/types.js'
import type { WaitingConfig, WaitingSnapshot } from './waiting/types.js'

export type { WaitingConfig, WaitingSnapshot } from './waiting/types.js'
export type { ToolFixture } from './tools/fixture.js'
export type { ActionPreview, ToolAction, ToolRunEvent } from './tools/types.js'

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
  toolShelfJson: string
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
  setShowIgnored(show: boolean): Promise<IpcResult<WaitingSnapshot>>
  setWaiting(config: WaitingConfig): Promise<IpcResult<AppState>>
  openExternal(url: string): Promise<IpcResult<true>>
  advanceWaitingDays(days: number): Promise<IpcResult<WaitingSnapshot>>
  setToolShelf(json: string): Promise<IpcResult<{ toolShelfJson: string }>>
  getToolExample(): Promise<string>
  getToolCatalog(): Promise<{ ok: true, actions: ToolAction[] } | { ok: false, error: string }>
  importToolShelf(): Promise<IpcResult<{ cancelled: true } | { cancelled: false, text: string }>>
  exportToolShelf(json: string): Promise<IpcResult<{ cancelled: boolean }>>
  previewTool(actionId: string, params: Record<string, string>): Promise<IpcResult<ActionPreview>>
  runTool(actionId: string, params: Record<string, string>): Promise<IpcResult<
    { kind: 'run', runId: string } | { kind: 'open-url' } | { kind: 'open-folder' } | { kind: 'template' }
  >>
  abortTool(runId: string): Promise<IpcResult<true>>
  copyText(text: string): Promise<IpcResult<true>>
  getToolFixture(): Promise<ToolFixture | null>
  onToolEvent(listener: (event: ToolRunEvent) => void): () => void
}

export function githubSourceLabel(source: GithubSource): string {
  if (source === 'gh-cli') return '来源：gh CLI'
  if (source === 'pat') return '来源：本机 PAT'
  return '未配置'
}
