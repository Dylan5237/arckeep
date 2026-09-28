import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel } from '../shared/ipc.js'
import type { ArckeepApi } from '../shared/types.js'

const api: ArckeepApi = {
  getState: () => ipcRenderer.invoke(IpcChannel.getState),
  setRepos: repos => ipcRenderer.invoke(IpcChannel.setRepos, repos),
  setHotkey: hotkey => ipcRenderer.invoke(IpcChannel.setHotkey, hotkey),
  setPat: token => ipcRenderer.invoke(IpcChannel.setPat, token),
  clearPat: () => ipcRenderer.invoke(IpcChannel.clearPat),
  testGithub: (pastedToken?: string) => ipcRenderer.invoke(IpcChannel.testGithub, pastedToken),
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
  advanceWaitingDays: days => ipcRenderer.invoke(IpcChannel.advanceWaitingDays, days)
}

contextBridge.exposeInMainWorld('arckeep', api)
