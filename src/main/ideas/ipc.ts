import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IpcChannel } from '../../shared/ipc.js'
import type { IpcResult } from '../../shared/types.js'
import type { IdeaItem } from '../../shared/ideas/types.js'
import type { IdeaStore } from './store.js'

export interface IdeaIpcOptions {
  store: Pick<IdeaStore, 'list' | 'create' | 'update' | 'delete'>
  guard: (event: IpcMainInvokeEvent) => void
  onChanged: () => void
  onCreated?: (event: IpcMainInvokeEvent) => void
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && /[\u3400-\u9fff]/u.test(error.message)) return error.message
  return fallback
}

function invoke<T>(
  options: IdeaIpcOptions,
  event: IpcMainInvokeEvent,
  fallback: string,
  operation: () => T,
  changed = false
): IpcResult<T> {
  try {
    options.guard(event)
  } catch {
    return { ok: false, error: '灵感请求未授权' }
  }

  let data: T
  try {
    data = operation()
  } catch (error) {
    return { ok: false, error: errorText(error, fallback) }
  }

  if (changed) {
    // Persistence has already succeeded, so a notification failure must not
    // make the caller believe that the saved change failed.
    try { options.onChanged() } catch { /* the stored result remains successful */ }
  }
  return { ok: true, data }
}

export function registerIdeaIpc(options: IdeaIpcOptions): void {
  ipcMain.handle(IpcChannel.listIdeas, (event: IpcMainInvokeEvent) =>
    invoke<IdeaItem[]>(options, event, '无法读取灵感列表', () => options.store.list()))

  ipcMain.handle(IpcChannel.createIdea, (event: IpcMainInvokeEvent, input: unknown) => {
    const result = invoke(options, event, '灵感创建失败', () => options.store.create(input), true)
    if (result.ok) {
      try { options.onCreated?.(event) } catch { /* Persistence has already succeeded. */ }
    }
    return result
  })

  ipcMain.handle(IpcChannel.updateIdea, (event: IpcMainInvokeEvent, input: unknown) =>
    invoke(options, event, '灵感更新失败', () => options.store.update(input), true))

  ipcMain.handle(IpcChannel.deleteIdea, (event: IpcMainInvokeEvent, id: unknown) =>
    invoke(options, event, '灵感删除失败', () => options.store.delete(id), true))
}
