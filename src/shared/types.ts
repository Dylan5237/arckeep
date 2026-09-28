import type { CaptureDraft, TodoItem, TodoUpdate } from './todos/types.js'

export const DEFAULT_HOTKEY = 'Ctrl+Alt+Space'

export type { CaptureDraft, TodoItem, TodoUpdate, WaitingTodo } from './todos/types.js'

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
  listTodos(): Promise<TodoItem[]>
  createTodo(input: { text: string, repo: string | null, waiting: boolean }): Promise<IpcResult<TodoItem>>
  updateTodo(input: TodoUpdate): Promise<IpcResult<TodoItem>>
  setTodoCompleted(id: string, completed: boolean): Promise<IpcResult<TodoItem>>
  deleteTodo(id: string): Promise<IpcResult<{ id: string }>>
  todoRepoOptions(): Promise<string[]>
  closeCapture(mode?: 'dismiss' | 'saved'): Promise<void>
  getCaptureDraft(): Promise<CaptureDraft>
  setCaptureDraft(draft: CaptureDraft): Promise<CaptureDraft>
  onTodosChanged(listener: () => void): () => void
}

export function githubSourceLabel(source: GithubSource): string {
  if (source === 'gh-cli') return '来源：gh CLI'
  if (source === 'pat') return '来源：本机 PAT'
  return '未配置'
}
