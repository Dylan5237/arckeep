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
  todoRepoOptions: () => ipcRenderer.invoke(IpcChannel.todoRepoOptions),
  closeCapture: (mode?: 'dismiss' | 'saved') => ipcRenderer.invoke(IpcChannel.closeCapture, mode ?? 'dismiss'),
  getCaptureDraft: () => ipcRenderer.invoke(IpcChannel.getCaptureDraft),
  setCaptureDraft: draft => ipcRenderer.invoke(IpcChannel.setCaptureDraft, draft),
  onTodosChanged(listener) {
    const wrapped = (_event: IpcRendererEvent) => listener()
    ipcRenderer.on(IpcChannel.todosChanged, wrapped)
    return () => ipcRenderer.removeListener(IpcChannel.todosChanged, wrapped)
  }
}

contextBridge.exposeInMainWorld('arckeep', api)
