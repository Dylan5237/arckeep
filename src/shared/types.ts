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
}

export function githubSourceLabel(source: GithubSource): string {
  if (source === 'gh-cli') return '来源：gh CLI'
  if (source === 'pat') return '来源：本机 PAT'
  return '未配置'
}
