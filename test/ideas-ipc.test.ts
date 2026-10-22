import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)
  }
}))

import { registerIdeaIpc } from '../src/main/ideas/ipc.js'
import { IdeaStore } from '../src/main/ideas/store.js'
import { IpcChannel } from '../src/shared/ipc.js'

const FIRST_ID = '00000000-0000-4000-8000-000000000001'
const SECOND_ID = '00000000-0000-4000-8000-000000000002'
const event = {} as IpcMainInvokeEvent

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
  return await handler(event, ...args)
}

describe('idea IPC', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-ideas-ipc-'))
    handlers.clear()
  })

  afterEach(() => {
    handlers.clear()
    rmSync(directory, { recursive: true, force: true })
  })

  it('guards every operation, returns IpcResult values, and broadcasts only successful mutations', async () => {
    let nextId = 0
    const ids = [FIRST_ID, SECOND_ID]
    const store = new IdeaStore({ file: path.join(directory, 'ideas.json'), id: () => ids[nextId++] })
    const guard = vi.fn()
    const onChanged = vi.fn()
    registerIdeaIpc({ store, guard, onChanged })

    expect(await invoke(IpcChannel.listIdeas)).toEqual({ ok: true, data: [] })
    const first = await invoke(IpcChannel.createIdea, { text: '# 灵感\n!等我处理', repo: null }) as { ok: boolean, data?: { id: string, text: string } }
    const second = await invoke(IpcChannel.createIdea, { text: '第二条', repo: 'octocat/hello' }) as { ok: boolean, data?: { id: string } }
    expect(first).toMatchObject({ ok: true, data: { id: FIRST_ID, text: '# 灵感\n!等我处理' } })
    expect(second).toMatchObject({ ok: true, data: { id: SECOND_ID } })

    const updated = await invoke(IpcChannel.updateIdea, { id: FIRST_ID, text: '更新后的灵感', repo: null })
    expect(updated).toMatchObject({ ok: true, data: { id: FIRST_ID, text: '更新后的灵感' } })
    expect(await invoke(IpcChannel.deleteIdea, SECOND_ID)).toEqual({ ok: true, data: { id: SECOND_ID } })
    expect(await invoke(IpcChannel.listIdeas)).toMatchObject({ ok: true, data: [{ id: FIRST_ID, text: '更新后的灵感' }] })

    expect(await invoke(IpcChannel.createIdea, { text: '  ', repo: null })).toMatchObject({ ok: false, error: expect.stringMatching(/灵感/) })
    expect(await invoke(IpcChannel.updateIdea, { id: SECOND_ID, text: '找不到', repo: null })).toMatchObject({ ok: false, error: expect.stringMatching(/灵感/) })
    expect(await invoke(IpcChannel.deleteIdea, 'bad-id')).toMatchObject({ ok: false, error: expect.stringMatching(/灵感/) })
    expect(guard).toHaveBeenCalledTimes(9)
    expect(onChanged).toHaveBeenCalledTimes(4)
  })

  it('returns a localized denial and does not call the store when guard rejects the sender', async () => {
    const file = path.join(directory, 'ideas.json')
    const store = new IdeaStore({ file, id: () => FIRST_ID })
    const onChanged = vi.fn()
    const onCreated = vi.fn()
    registerIdeaIpc({ store, guard: () => { throw new Error('Blocked IPC') }, onChanged, onCreated })

    expect(await invoke(IpcChannel.createIdea, { text: '灵感', repo: null })).toEqual({ ok: false, error: '灵感请求未授权' })
    expect(await invoke(IpcChannel.listIdeas)).toEqual({ ok: false, error: '灵感请求未授权' })
    expect(existsSync(file)).toBe(false)
    expect(store.list()).toEqual([])
    expect(onChanged).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('reports persistence failure without broadcasting a change', async () => {
    const blocker = path.join(directory, 'not-a-directory')
    const file = path.join(blocker, 'ideas.json')
    const store = new IdeaStore({ file, id: () => FIRST_ID })
    writeFileSync(blocker, 'occupied', 'utf8')
    const onChanged = vi.fn()
    const onCreated = vi.fn()
    registerIdeaIpc({ store, guard: () => {}, onChanged, onCreated })

    expect(await invoke(IpcChannel.createIdea, { text: '灵感', repo: null })).toMatchObject({ ok: false, error: expect.stringMatching(/灵感/) })
    expect(store.list()).toEqual([])
    expect(onChanged).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('calls onCreated only for a successful create and ignores callback errors after persistence', async () => {
    const file = path.join(directory, 'ideas.json')
    const store = new IdeaStore({ file, id: () => FIRST_ID })
    const onCreated = vi.fn(() => { throw new Error('window notification failed') })
    const onChanged = vi.fn()
    registerIdeaIpc({ store, guard: () => {}, onChanged, onCreated })

    expect(await invoke(IpcChannel.createIdea, { text: '  ', repo: null })).toMatchObject({ ok: false })
    expect(onCreated).not.toHaveBeenCalled()

    const result = await invoke(IpcChannel.createIdea, { text: 'persisted idea', repo: null })
    expect(result).toMatchObject({ ok: true, data: { id: FIRST_ID, text: 'persisted idea' } })
    expect(store.list()).toHaveLength(1)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ items: [{ id: FIRST_ID, text: 'persisted idea' }] })
    expect(onChanged).toHaveBeenCalledOnce()
    expect(onCreated).toHaveBeenCalledOnce()

    expect(await invoke(IpcChannel.updateIdea, { id: FIRST_ID, text: 'updated', repo: null })).toMatchObject({ ok: true })
    expect(await invoke(IpcChannel.deleteIdea, FIRST_ID)).toMatchObject({ ok: true })
    expect(onCreated).toHaveBeenCalledOnce()
  })

  it.each([
    ['损坏文件', '{"version":1,"items":[', '灵感数据文件损坏，已保留原文件'],
    ['未知版本文件', '{"version":2,"items":[]}', '灵感数据文件版本不支持，已保留原文件']
  ])('keeps IPC registration available with a %s', async (_label, contents, error) => {
    const file = path.join(directory, 'ideas.json')
    writeFileSync(file, contents, 'utf8')
    const store = new IdeaStore({ file, id: () => FIRST_ID })
    const guard = vi.fn()
    const onChanged = vi.fn()

    expect(() => registerIdeaIpc({ store, guard, onChanged })).not.toThrow()
    expect(await invoke(IpcChannel.listIdeas)).toEqual({ ok: false, error })
    expect(await invoke(IpcChannel.createIdea, { text: '新的灵感', repo: null })).toEqual({ ok: false, error })
    expect(guard).toHaveBeenCalledTimes(2)
    expect(onChanged).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe(contents)
  })
})
