import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) }
}))

import { registerClaudeIpc } from '../src/main/claude/ipc.js'
import { IpcChannel } from '../src/shared/ipc.js'
import type { ClaudeSessionService } from '../src/main/claude/service.js'

const event = {} as IpcMainInvokeEvent

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error('Missing IPC handler: ' + channel)
  return await handler(event, ...args)
}

describe('Claude IPC', () => {
  beforeEach(() => handlers.clear())

  it('guards every operation and returns localized results', async () => {
    const service = {
      list: vi.fn(() => []),
      chooseWorkspace: vi.fn(async () => ({ repo: 'octocat/hello' })),
      start: vi.fn(async () => ({ id: '123e4567-e89b-42d3-a456-426614174000' })),
      read: vi.fn(async () => ({ messages: [] }))
    } as unknown as ClaudeSessionService
    const guard = vi.fn()
    registerClaudeIpc({ service, guard })

    expect(await invoke(IpcChannel.listClaudeSessions, 'octocat/hello')).toEqual({ ok: true, data: [] })
    expect(await invoke(IpcChannel.chooseClaudeWorkspace, 'octocat/hello', 'Hello')).toMatchObject({ ok: true })
    expect(await invoke(IpcChannel.startClaudeSession, 'octocat/hello', 'Hello')).toMatchObject({ ok: true })
    expect(await invoke(IpcChannel.readClaudeSession, '123e4567-e89b-42d3-a456-426614174000')).toMatchObject({ ok: true })
    expect(guard).toHaveBeenCalledTimes(4)

    guard.mockImplementation(() => { throw new Error('Blocked IPC') })
    expect(await invoke(IpcChannel.listClaudeSessions)).toEqual({ ok: false, error: 'Claude 会话请求未授权' })
    expect(service.list).toHaveBeenCalledOnce()
  })

  it('does not expose raw non-localized internal errors to renderer callers', async () => {
    const service = { list: () => { throw new Error('EACCES C:\\Users\\someone\\.claude') } } as unknown as ClaudeSessionService
    registerClaudeIpc({ service, guard: () => {} })

    expect(await invoke(IpcChannel.listClaudeSessions)).toEqual({ ok: false, error: '无法读取 Claude 会话' })
  })
})
