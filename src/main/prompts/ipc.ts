import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IpcChannel } from '../../shared/ipc.js'
import type { IpcResult } from '../../shared/types.js'
import type { PromptItem } from '../../shared/prompts/types.js'
import type { PromptStore } from './store.js'

export interface PromptIpcOptions {
  store: Pick<PromptStore, 'list' | 'create' | 'update' | 'delete' | 'setPinned'>
  guard: (event: IpcMainInvokeEvent) => void
  onChanged: () => void
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && /[\u3400-\u9fff]/u.test(error.message)) return error.message
  return fallback
}

function invoke<T>(
  options: PromptIpcOptions,
  event: IpcMainInvokeEvent,
  fallback: string,
  operation: () => T,
  changed = false
): IpcResult<T> {
  try {
    options.guard(event)
  } catch {
    return { ok: false, error: '提示词请求未授权' }
  }

  let data: T
  try {
    data = operation()
  } catch (error) {
    return { ok: false, error: errorText(error, fallback) }
  }

  if (changed) {
    // The mutation is already on disk. A failed window notification must not
    // turn a persisted operation into a failed save or encourage duplicate input.
    try { options.onChanged() } catch { /* the stored result remains successful */ }
  }
  return { ok: true, data }
}

export function registerPromptIpc(options: PromptIpcOptions): void {
  ipcMain.handle(IpcChannel.listPrompts, (event: IpcMainInvokeEvent) =>
    invoke<PromptItem[]>(options, event, '无法读取提示词列表', () => options.store.list()))

  ipcMain.handle(IpcChannel.createPrompt, (event: IpcMainInvokeEvent, input: unknown) =>
    invoke(options, event, '提示词创建失败', () => options.store.create(input), true))

  ipcMain.handle(IpcChannel.updatePrompt, (event: IpcMainInvokeEvent, input: unknown) =>
    invoke(options, event, '提示词更新失败', () => options.store.update(input), true))

  ipcMain.handle(IpcChannel.deletePrompt, (event: IpcMainInvokeEvent, id: unknown) =>
    invoke(options, event, '提示词删除失败', () => options.store.delete(id), true))

  ipcMain.handle(IpcChannel.setPromptPinned, (event: IpcMainInvokeEvent, id: unknown, pinned: unknown) =>
    invoke(options, event, '提示词置顶失败', () => options.store.setPinned(id, pinned), true))
}
