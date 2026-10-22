import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IpcChannel } from '../../shared/ipc.js'
import type { IpcResult } from '../../shared/types.js'
import type { ClaudeSessionService } from './service.js'

export interface ClaudeIpcOptions {
  service: ClaudeSessionService
  guard: (event: IpcMainInvokeEvent) => void
}

function invoke<T>(
  options: ClaudeIpcOptions,
  event: IpcMainInvokeEvent,
  fallback: string,
  operation: () => T | Promise<T>
): Promise<IpcResult<T>> {
  try {
    options.guard(event)
  } catch {
    return Promise.resolve({ ok: false, error: 'Claude 会话请求未授权' })
  }
  return Promise.resolve()
    .then(operation)
    .then(data => ({ ok: true as const, data }))
    .catch(error => ({
      ok: false as const,
      error: error instanceof Error && /[\u3400-\u9fff]/u.test(error.message)
        ? error.message
        : fallback
    }))
}

export function registerClaudeIpc(options: ClaudeIpcOptions): void {
  ipcMain.handle(IpcChannel.listClaudeSessions, (event, repo: unknown) =>
    invoke(options, event, '无法读取 Claude 会话', () => options.service.list(repo)))
  ipcMain.handle(IpcChannel.chooseClaudeWorkspace, (event, repo: unknown, name: unknown) =>
    invoke(options, event, '无法选择 Claude 工作目录', () => options.service.chooseWorkspace(repo, name)))
  ipcMain.handle(IpcChannel.startClaudeSession, (event, repo: unknown, name: unknown, resumeId: unknown) =>
    invoke(options, event, '无法启动 Claude，请确认 Claude CLI 和 Windows Terminal 已安装', () =>
      options.service.start(repo, name, resumeId)))
  ipcMain.handle(IpcChannel.readClaudeSession, (event, sessionId: unknown) =>
    invoke(options, event, '无法读取 Claude 会话记录', () => options.service.read(sessionId)))
}

