import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IpcChannel } from '../shared/ipc.js'
import type { ArckeepApi } from '../shared/types.js'

const api: ArckeepApi = {
  getState: () => ipcRenderer.invoke(IpcChannel.getState),
  setRepos: repos => ipcRenderer.invoke(IpcChannel.setRepos, repos),
  setRepoFetchWindow: window => ipcRenderer.invoke(IpcChannel.setRepoFetchWindow, window),
  setHotkey: hotkey => ipcRenderer.invoke(IpcChannel.setHotkey, hotkey),
  setHideMainWindowOnLaunch: hide => ipcRenderer.invoke(IpcChannel.setHideMainWindowOnLaunch, hide),
  setPat: token => ipcRenderer.invoke(IpcChannel.setPat, token),
  clearPat: () => ipcRenderer.invoke(IpcChannel.clearPat),
  testGithub: (pastedToken?: string) => ipcRenderer.invoke(IpcChannel.testGithub, pastedToken),
  listTodos: () => ipcRenderer.invoke(IpcChannel.listTodos),
  createTodo: input => ipcRenderer.invoke(IpcChannel.createTodo, input),
  updateTodo: input => ipcRenderer.invoke(IpcChannel.updateTodo, input),
  setTodoCompleted: (id, completed) => ipcRenderer.invoke(IpcChannel.setTodoCompleted, { id, completed }),
  deleteTodo: id => ipcRenderer.invoke(IpcChannel.deleteTodo, id),
  restoreTodo: item => ipcRenderer.invoke(IpcChannel.restoreTodo, item),
  todoRepoOptions: () => ipcRenderer.invoke(IpcChannel.todoRepoOptions),
  listIdeas: () => ipcRenderer.invoke(IpcChannel.listIdeas),
  createIdea: input => ipcRenderer.invoke(IpcChannel.createIdea, input),
  updateIdea: input => ipcRenderer.invoke(IpcChannel.updateIdea, input),
  deleteIdea: id => ipcRenderer.invoke(IpcChannel.deleteIdea, id),
  onIdeasChanged: listener => {
    const handler = () => listener()
    ipcRenderer.on(IpcChannel.ideasChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannel.ideasChanged, handler)
  },
  listPrompts: () => ipcRenderer.invoke(IpcChannel.listPrompts),
  createPrompt: input => ipcRenderer.invoke(IpcChannel.createPrompt, input),
  updatePrompt: input => ipcRenderer.invoke(IpcChannel.updatePrompt, input),
  deletePrompt: id => ipcRenderer.invoke(IpcChannel.deletePrompt, id),
  setPromptPinned: (id, pinned) => ipcRenderer.invoke(IpcChannel.setPromptPinned, id, pinned),
  onPromptsChanged: listener => {
    const handler = () => listener()
    ipcRenderer.on(IpcChannel.promptsChanged, handler)
    return () => ipcRenderer.removeListener(IpcChannel.promptsChanged, handler)
  },
  closeCapture: (mode?: 'dismiss' | 'saved') => ipcRenderer.invoke(IpcChannel.closeCapture, mode ?? 'dismiss'),
  getCaptureDraft: () => ipcRenderer.invoke(IpcChannel.getCaptureDraft),
  setCaptureDraft: draft => ipcRenderer.invoke(IpcChannel.setCaptureDraft, draft),
  onTodosChanged(listener) {
    const wrapped = (_event: IpcRendererEvent) => listener()
    ipcRenderer.on(IpcChannel.todosChanged, wrapped)
    return () => ipcRenderer.removeListener(IpcChannel.todosChanged, wrapped)
  },
  onHotkeyStatus(listener) {
    const wrapped = (_event: IpcRendererEvent, combo: string | null) => listener(combo)
    ipcRenderer.on(IpcChannel.hotkeyStatus, wrapped)
    return () => ipcRenderer.removeListener(IpcChannel.hotkeyStatus, wrapped)
  },
  onFocusHotkey(listener) {
    const wrapped = () => listener()
    ipcRenderer.on(IpcChannel.focusHotkey, wrapped)
    return () => ipcRenderer.removeListener(IpcChannel.focusHotkey, wrapped)
  },
  getWaiting: () => ipcRenderer.invoke(IpcChannel.getWaiting),
  refreshWaiting: force => ipcRenderer.invoke(IpcChannel.refreshWaiting, force),
  commentWaitingApo: (rowId, actionId) => ipcRenderer.invoke(IpcChannel.commentWaitingApo, rowId, actionId),
  checkWaitingApo: (rowId, actionId) => ipcRenderer.invoke(IpcChannel.checkWaitingApo, rowId, actionId),
  snoozeWaiting: (id, days) => ipcRenderer.invoke(IpcChannel.snoozeWaiting, id, days),
  ignoreWaiting: id => ipcRenderer.invoke(IpcChannel.ignoreWaiting, id),
  restoreWaiting: id => ipcRenderer.invoke(IpcChannel.restoreWaiting, id),
  hideWaitingRepo: repo => ipcRenderer.invoke(IpcChannel.hideWaitingRepo, repo),
  unhideWaitingRepo: repo => ipcRenderer.invoke(IpcChannel.unhideWaitingRepo, repo),
  setShowIgnored: show => ipcRenderer.invoke(IpcChannel.setShowIgnored, show),
  setMaybeSectionOpen: open => ipcRenderer.invoke(IpcChannel.setMaybeSectionOpen, open),
  setWaiting: config => ipcRenderer.invoke(IpcChannel.setWaiting, config),
  openExternal: url => ipcRenderer.invoke(IpcChannel.openExternal, url),
  advanceWaitingDays: days => ipcRenderer.invoke(IpcChannel.advanceWaitingDays, days),
  getOverview: () => ipcRenderer.invoke(IpcChannel.getOverview),
  refreshOverview: force => ipcRenderer.invoke(IpcChannel.refreshOverview, force),
  setOverview: config => ipcRenderer.invoke(IpcChannel.setOverview, config),
  setToolShelf: json => ipcRenderer.invoke(IpcChannel.setToolShelf, json),
  getToolExample: () => ipcRenderer.invoke(IpcChannel.getToolExample),
  getToolCatalog: () => ipcRenderer.invoke(IpcChannel.getToolCatalog),
  getKnownRepos: () => ipcRenderer.invoke(IpcChannel.getKnownRepos),
  pickFolder: () => ipcRenderer.invoke(IpcChannel.pickFolder),
  importToolShelf: () => ipcRenderer.invoke(IpcChannel.importToolShelf),
  exportToolShelf: json => ipcRenderer.invoke(IpcChannel.exportToolShelf, json),
  previewTool: (actionId, params, requestId) => ipcRenderer.invoke(IpcChannel.previewTool, actionId, params, requestId),
  cancelToolPreview: requestId => ipcRenderer.invoke(IpcChannel.cancelToolPreview, requestId),
  runTool: (actionId, params, confirmationId) => ipcRenderer.invoke(IpcChannel.runTool, actionId, params, confirmationId),
  abortTool: runId => ipcRenderer.invoke(IpcChannel.abortTool, runId),
  copyText: text => ipcRenderer.invoke(IpcChannel.copyText, text),
  getToolFixture: () => ipcRenderer.invoke(IpcChannel.getToolFixture),
  onToolEvent: listener => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => listener(payload)
    ipcRenderer.on(IpcChannel.toolEvent, wrapped)
    return () => ipcRenderer.removeListener(IpcChannel.toolEvent, wrapped)
  },
  listClaudeSessions: repo => ipcRenderer.invoke(IpcChannel.listClaudeSessions, repo),
  chooseClaudeWorkspace: (repo, name) => ipcRenderer.invoke(IpcChannel.chooseClaudeWorkspace, repo, name),
  startClaudeSession: (repo, name, resumeSessionId) => ipcRenderer.invoke(IpcChannel.startClaudeSession, repo, name, resumeSessionId),
  readClaudeSession: sessionId => ipcRenderer.invoke(IpcChannel.readClaudeSession, sessionId)
}

contextBridge.exposeInMainWorld('arckeep', api)
