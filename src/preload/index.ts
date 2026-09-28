import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel } from '../shared/ipc.js'
import type { ArckeepApi } from '../shared/types.js'

const api: ArckeepApi = {
  getState: () => ipcRenderer.invoke(IpcChannel.getState),
  setRepos: repos => ipcRenderer.invoke(IpcChannel.setRepos, repos),
  setHotkey: hotkey => ipcRenderer.invoke(IpcChannel.setHotkey, hotkey),
  setPat: token => ipcRenderer.invoke(IpcChannel.setPat, token),
  clearPat: () => ipcRenderer.invoke(IpcChannel.clearPat),
  testGithub: () => ipcRenderer.invoke(IpcChannel.testGithub)
}

contextBridge.exposeInMainWorld('arckeep', api)
