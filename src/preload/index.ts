import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IpcChannel } from '../shared/ipc.js'
import type { ArckeepApi } from '../shared/types.js'

const api: ArckeepApi = {
  getState: () => ipcRenderer.invoke(IpcChannel.getState),
  setRepos: repos => ipcRenderer.invoke(IpcChannel.setRepos, repos),
  setHotkey: hotkey => ipcRenderer.invoke(IpcChannel.setHotkey, hotkey),
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
  refreshWaiting: () => ipcRenderer.invoke(IpcChannel.refreshWaiting),
  snoozeWaiting: (id, days) => ipcRenderer.invoke(IpcChannel.snoozeWaiting, id, days),
  ignoreWaiting: id => ipcRenderer.invoke(IpcChannel.ignoreWaiting, id),
  restoreWaiting: id => ipcRenderer.invoke(IpcChannel.restoreWaiting, id),
  hideWaitingRepo: repo => ipcRenderer.invoke(IpcChannel.hideWaitingRepo, repo),
  unhideWaitingRepo: repo => ipcRenderer.invoke(IpcChannel.unhideWaitingRepo, repo),
  setShowIgnored: show => ipcRenderer.invoke(IpcChannel.setShowIgnored, show),
  setWaiting: config => ipcRenderer.invoke(IpcChannel.setWaiting, config),
  openExternal: url => ipcRenderer.invoke(IpcChannel.openExternal, url),
  advanceWaitingDays: days => ipcRenderer.invoke(IpcChannel.advanceWaitingDays, days),
  getOverview: () => ipcRenderer.invoke(IpcChannel.getOverview),
  refreshOverview: () => ipcRenderer.invoke(IpcChannel.refreshOverview),
  setOverview: config => ipcRenderer.invoke(IpcChannel.setOverview, config),
  setToolShelf: json => ipcRenderer.invoke(IpcChannel.setToolShelf, json),
  getToolExample: () => ipcRenderer.invoke(IpcChannel.getToolExample),
  getToolCatalog: () => ipcRenderer.invoke(IpcChannel.getToolCatalog),
  importToolShelf: () => ipcRenderer.invoke(IpcChannel.importToolShelf),
  exportToolShelf: json => ipcRenderer.invoke(IpcChannel.exportToolShelf, json),
  previewTool: (actionId, params) => ipcRenderer.invoke(IpcChannel.previewTool, actionId, params),
  runTool: (actionId, params) => ipcRenderer.invoke(IpcChannel.runTool, actionId, params),
  abortTool: runId => ipcRenderer.invoke(IpcChannel.abortTool, runId),
  copyText: text => ipcRenderer.invoke(IpcChannel.copyText, text),
  getToolFixture: () => ipcRenderer.invoke(IpcChannel.getToolFixture),
  onToolEvent: listener => {
    const wrapped = (_event: unknown, payload: Parameters<typeof listener>[0]) => listener(payload)
    ipcRenderer.on(IpcChannel.toolEvent, wrapped)
    return () => ipcRenderer.removeListener(IpcChannel.toolEvent, wrapped)
  }
}

contextBridge.exposeInMainWorld('arckeep', api)
