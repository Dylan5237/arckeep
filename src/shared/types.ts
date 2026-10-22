import type { OverviewConfig, OverviewSnapshot } from './overview/types.js'
import type { IdeaInput, IdeaItem, IdeaUpdate } from './ideas/types.js'
import type { PromptInput, PromptItem, PromptUpdate } from './prompts/types.js'
import type { CaptureDraft, TodoItem, TodoUpdate } from './todos/types.js'
import type { ToolFixture } from './tools/fixture.js'
import type { KnownRepo } from './tools/repos.js'
import type { ActionPreview, ToolAction, ToolRunEvent } from './tools/types.js'
import type { WaitingConfig, WaitingSnapshot } from './waiting/types.js'
import type { ApoCommentOutcome } from './waiting/apo-actions.js'
import type { ApoReplyChoice } from './waiting/apo-reply.js'
import type { RepoFetchWindow } from './repo-fetch-window.js'
import type { ClaudeSession, ClaudeSessionTranscript, ClaudeWorkspace } from './claude-sessions.js'

export type { OverviewConfig, OverviewSnapshot } from './overview/types.js'
export type { IdeaInput, IdeaItem, IdeaUpdate } from './ideas/types.js'
export type { PromptInput, PromptItem, PromptUpdate } from './prompts/types.js'
export type { WaitingConfig, WaitingSnapshot } from './waiting/types.js'
export type { ToolFixture } from './tools/fixture.js'
export type { KnownRepo } from './tools/repos.js'
export type { ActionPreview, ToolAction, ToolRunEvent } from './tools/types.js'
export type { ClaudeSession, ClaudeSessionMessage, ClaudeSessionTranscript, ClaudeWorkspace } from './claude-sessions.js'

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
  repoFetchWindow: RepoFetchWindow
  /** Value shown in the hotkey field. A failed save keeps what was typed. */
  hotkey: string
  /** Combo registered with the OS, or null when nothing is live. */
  activeHotkey: string | null
  hotkeyWarning: string | null
  /** Combo named in the banner. Null hides it. Set only when no hotkey is registered. */
  hotkeyUnavailable: string | null
  github: PublicGithubAuth
  waiting: WaitingConfig
  overview: OverviewConfig
  toolShelfJson: string
  hideMainWindowOnLaunch: boolean
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
  setRepoFetchWindow(window: RepoFetchWindow): Promise<IpcResult<{ repoFetchWindow: RepoFetchWindow }>>
  setHotkey(hotkey: string): Promise<IpcResult<{ hotkey: string }>>
  setHideMainWindowOnLaunch(hide: boolean): Promise<IpcResult<{ hideMainWindowOnLaunch: boolean }>>
  setPat(token: string): Promise<IpcResult<{ patSaved: true }>>
  clearPat(): Promise<IpcResult<{ patSaved: false }>>
  testGithub(pastedToken?: string): Promise<{ ok: true, login: string } | { ok: false, error: string }>
  listTodos(): Promise<TodoItem[]>
  createTodo(input: { text: string, repo: string | null, waiting: boolean }): Promise<IpcResult<TodoItem>>
  updateTodo(input: TodoUpdate): Promise<IpcResult<TodoItem>>
  setTodoCompleted(id: string, completed: boolean): Promise<IpcResult<TodoItem>>
  deleteTodo(id: string): Promise<IpcResult<{ id: string }>>
  restoreTodo(item: TodoItem): Promise<IpcResult<TodoItem>>
  todoRepoOptions(): Promise<string[]>
  listIdeas(): Promise<IpcResult<IdeaItem[]>>
  createIdea(input: IdeaInput): Promise<IpcResult<IdeaItem>>
  updateIdea(input: IdeaUpdate): Promise<IpcResult<IdeaItem>>
  deleteIdea(id: string): Promise<IpcResult<{ id: string }>>
  onIdeasChanged(listener: () => void): () => void
  listPrompts(): Promise<IpcResult<PromptItem[]>>
  createPrompt(input: PromptInput): Promise<IpcResult<PromptItem>>
  updatePrompt(input: PromptUpdate): Promise<IpcResult<PromptItem>>
  deletePrompt(id: string): Promise<IpcResult<{ id: string }>>
  setPromptPinned(id: string, pinned: boolean): Promise<IpcResult<PromptItem>>
  onPromptsChanged(listener: () => void): () => void
  closeCapture(mode?: 'dismiss' | 'saved'): Promise<void>
  getCaptureDraft(): Promise<CaptureDraft>
  setCaptureDraft(draft: CaptureDraft): Promise<CaptureDraft>
  onTodosChanged(listener: () => void): () => void
  onHotkeyStatus(listener: (combo: string | null) => void): () => void
  onFocusHotkey(listener: () => void): () => void
  getWaiting(): Promise<WaitingSnapshot>
  refreshWaiting(force?: boolean): Promise<WaitingSnapshot>
  commentWaitingApo(rowId: string, actionId: string): Promise<IpcResult<ApoCommentOutcome>>
  checkWaitingApo(rowId: string, actionId: string): Promise<IpcResult<ApoCommentOutcome>>
  replyWaitingDecision(rowId: string, actionId: string, choice: ApoReplyChoice, reason?: string): Promise<IpcResult<ApoCommentOutcome>>
  checkWaitingDecision(rowId: string, actionId: string): Promise<IpcResult<ApoCommentOutcome>>
  snoozeWaiting(id: string, days: 1 | 3 | 7): Promise<IpcResult<WaitingSnapshot>>
  ignoreWaiting(id: string): Promise<IpcResult<WaitingSnapshot>>
  restoreWaiting(id: string): Promise<IpcResult<WaitingSnapshot>>
  hideWaitingRepo(repo: string): Promise<IpcResult<WaitingSnapshot>>
  unhideWaitingRepo(repo: string): Promise<IpcResult<WaitingSnapshot>>
  setShowIgnored(show: boolean): Promise<IpcResult<WaitingSnapshot>>
  setMaybeSectionOpen(open: boolean): Promise<IpcResult<WaitingSnapshot>>
  setWaiting(config: WaitingConfig): Promise<IpcResult<AppState>>
  openExternal(url: string): Promise<IpcResult<true>>
  advanceWaitingDays(days: number): Promise<IpcResult<WaitingSnapshot>>
  getOverview(): Promise<OverviewSnapshot>
  refreshOverview(force?: boolean): Promise<OverviewSnapshot>
  setOverview(config: OverviewConfig): Promise<IpcResult<AppState>>
  setToolShelf(json: string): Promise<IpcResult<{ toolShelfJson: string }>>
  getToolExample(): Promise<string>
  getToolCatalog(): Promise<{ ok: true, actions: ToolAction[] } | { ok: false, error: string }>
  getKnownRepos(): Promise<KnownRepo[]>
  pickFolder(): Promise<IpcResult<{ cancelled: true } | { cancelled: false, path: string }>>
  importToolShelf(): Promise<IpcResult<{ cancelled: true } | { cancelled: false, text: string }>>
  exportToolShelf(json: string): Promise<IpcResult<{ cancelled: boolean }>>
  previewTool(actionId: string, params: Record<string, string>, requestId: string): Promise<IpcResult<ActionPreview>>
  cancelToolPreview(requestId: string): Promise<IpcResult<{ cancelled: true }>>
  runTool(actionId: string, params: Record<string, string>, confirmationId?: string): Promise<IpcResult<
    | { kind: 'run', runId: string }
    | { kind: 'open-url' }
    | { kind: 'open-folder' }
    | { kind: 'template', text: string }
  >>
  abortTool(runId: string): Promise<IpcResult<true>>
  copyText(text: string): Promise<IpcResult<true>>
  getToolFixture(): Promise<ToolFixture | null>
  onToolEvent(listener: (event: ToolRunEvent) => void): () => void
  listClaudeSessions(repo?: string): Promise<IpcResult<ClaudeSession[]>>
  chooseClaudeWorkspace(repo: string, name: string): Promise<IpcResult<ClaudeWorkspace>>
  startClaudeSession(repo: string, name: string, resumeSessionId?: string): Promise<IpcResult<ClaudeSession>>
  readClaudeSession(sessionId: string): Promise<IpcResult<ClaudeSessionTranscript>>
}

export function githubSourceLabel(source: GithubSource): string {
  if (source === 'gh-cli') return '来源：gh CLI'
  if (source === 'pat') return '来源：本机 PAT'
  return '未配置'
}
