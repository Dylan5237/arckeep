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

import { registerPromptIpc } from '../src/main/prompts/ipc.js'
import { PromptStore } from '../src/main/prompts/store.js'
import { IpcChannel } from '../src/shared/ipc.js'

const FIRST_ID = '00000000-0000-4000-8000-000000000001'
const SECOND_ID = '00000000-0000-4000-8000-000000000002'
const event = {} as IpcMainInvokeEvent
const input = { title: '代码审查', text: '逐项审查\n保留空白 ', tags: ['工程'], pinned: false }

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
  return await handler(event, ...args)
}

describe('prompt IPC', () => {
  let directory: string
  let file: string

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-prompts-ipc-'))
    file = path.join(directory, 'prompts.json')
    handlers.clear()
  })

  afterEach(() => {
    handlers.clear()
    rmSync(directory, { recursive: true, force: true })
  })

  it('guards each handler and broadcasts only successfully persisted mutations', async () => {
    const ids = [FIRST_ID, SECOND_ID]
    let nextId = 0
    const store = new PromptStore({ file, id: () => ids[nextId++] })
    const guard = vi.fn()
    const onChanged = vi.fn()
    registerPromptIpc({ store, guard, onChanged })

    expect(await invoke(IpcChannel.listPrompts)).toEqual({ ok: true, data: [] })
    expect(await invoke(IpcChannel.createPrompt, input)).toMatchObject({ ok: true, data: { id: FIRST_ID, ...input } })
    expect(await invoke(IpcChannel.createPrompt, { ...input, title: '第二条' })).toMatchObject({ ok: true, data: { id: SECOND_ID } })
    expect(await invoke(IpcChannel.updatePrompt, { id: FIRST_ID, ...input, text: '最新正文\n' })).toMatchObject({ ok: true, data: { id: FIRST_ID, text: '最新正文\n' } })
    expect(await invoke(IpcChannel.setPromptPinned, FIRST_ID, true)).toMatchObject({ ok: true, data: { id: FIRST_ID, text: '最新正文\n', pinned: true } })
    expect(await invoke(IpcChannel.deletePrompt, SECOND_ID)).toEqual({ ok: true, data: { id: SECOND_ID } })
    expect(await invoke(IpcChannel.listPrompts)).toMatchObject({ ok: true, data: [{ id: FIRST_ID, text: '最新正文\n', pinned: true }] })

    expect(await invoke(IpcChannel.createPrompt, { ...input, text: '  ' })).toMatchObject({ ok: false, error: expect.stringMatching(/提示词/) })
    expect(await invoke(IpcChannel.updatePrompt, { id: SECOND_ID, ...input })).toMatchObject({ ok: false, error: expect.stringMatching(/不存在/) })
    expect(await invoke(IpcChannel.setPromptPinned, FIRST_ID, 'true')).toMatchObject({ ok: false, error: expect.stringMatching(/状态无效/) })
    expect(await invoke(IpcChannel.deletePrompt, 'bad-id')).toMatchObject({ ok: false, error: expect.stringMatching(/编号无效/) })
    expect(guard).toHaveBeenCalledTimes(11)
    expect(onChanged).toHaveBeenCalledTimes(5)
    expect(new PromptStore({ file }).list()).toEqual(store.list())
  })

  it('denies every unauthorized operation before calling storage or broadcasting', async () => {
    const store = {
      list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), setPinned: vi.fn()
    }
    const guard = vi.fn(() => { throw new Error('Blocked sender') })
    const onChanged = vi.fn()
    registerPromptIpc({ store, guard, onChanged })

    const requests = [
      [IpcChannel.listPrompts],
      [IpcChannel.createPrompt, input],
      [IpcChannel.updatePrompt, { id: FIRST_ID, ...input }],
      [IpcChannel.deletePrompt, FIRST_ID],
      [IpcChannel.setPromptPinned, FIRST_ID, true]
    ]
    for (const [channel, ...args] of requests) {
      expect(await invoke(channel as string, ...args)).toEqual({ ok: false, error: '提示词请求未授权' })
    }
    for (const operation of Object.values(store)) expect(operation).not.toHaveBeenCalled()
    expect(guard).toHaveBeenCalledTimes(5)
    expect(onChanged).not.toHaveBeenCalled()
    expect(existsSync(file)).toBe(false)
  })

  it('reports a real persistence failure without emitting a changed event', async () => {
    const blocker = path.join(directory, 'blocker')
    const store = new PromptStore({ file: path.join(blocker, 'prompts.json'), id: () => FIRST_ID })
    writeFileSync(blocker, 'occupied path', 'utf8')
    const onChanged = vi.fn()
    registerPromptIpc({ store, guard: () => {}, onChanged })

    expect(await invoke(IpcChannel.createPrompt, input)).toMatchObject({ ok: false, error: expect.stringMatching(/保存失败/) })
    expect(store.list()).toEqual([])
    expect(onChanged).not.toHaveBeenCalled()
    expect(readFileSync(blocker, 'utf8')).toBe('occupied path')
  })

  it('keeps saved results successful even when every changed notification fails', async () => {
    const store = new PromptStore({ file, id: () => FIRST_ID })
    const onChanged = vi.fn(() => { throw new Error('window destroyed') })
    registerPromptIpc({ store, guard: () => {}, onChanged })

    expect(await invoke(IpcChannel.createPrompt, input)).toMatchObject({ ok: true, data: { id: FIRST_ID } })
    expect(new PromptStore({ file }).list()).toMatchObject([{ id: FIRST_ID, text: input.text }])
    expect(await invoke(IpcChannel.updatePrompt, { id: FIRST_ID, ...input, text: '更新正文' })).toMatchObject({ ok: true, data: { id: FIRST_ID, text: '更新正文' } })
    expect(await invoke(IpcChannel.setPromptPinned, FIRST_ID, true)).toMatchObject({ ok: true, data: { id: FIRST_ID, text: '更新正文', pinned: true } })
    expect(new PromptStore({ file }).list()).toMatchObject([{ id: FIRST_ID, text: '更新正文', pinned: true }])
    expect(await invoke(IpcChannel.deletePrompt, FIRST_ID)).toEqual({ ok: true, data: { id: FIRST_ID } })
    expect(new PromptStore({ file }).list()).toEqual([])
    expect(onChanged).toHaveBeenCalledTimes(4)
  })

  it.each([
    ['损坏数据', '{"version":1,"items":[', '提示词数据文件损坏，已保留原文件'],
    ['未来版本', '{"version":2,"items":[]}', '提示词数据文件版本不支持，已保留原文件']
  ])('registers normally with %s while returning guarded localized errors', async (_label, contents, error) => {
    writeFileSync(file, contents, 'utf8')
    const store = new PromptStore({ file })
    const guard = vi.fn()
    const onChanged = vi.fn()
    expect(() => registerPromptIpc({ store, guard, onChanged })).not.toThrow()
    expect(await invoke(IpcChannel.listPrompts)).toEqual({ ok: false, error })
    expect(await invoke(IpcChannel.createPrompt, input)).toEqual({ ok: false, error })
    expect(await invoke(IpcChannel.setPromptPinned, FIRST_ID, true)).toEqual({ ok: false, error })
    expect(guard).toHaveBeenCalledTimes(3)
    expect(onChanged).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe(contents)
  })

  it('hides unlocalized internal exceptions from the renderer', async () => {
    const store = new PromptStore({ file })
    vi.spyOn(store, 'list').mockImplementation(() => { throw new Error('Private internal path or token') })
    registerPromptIpc({ store, guard: () => {}, onChanged: () => {} })
    expect(await invoke(IpcChannel.listPrompts)).toEqual({ ok: false, error: '无法读取提示词列表' })
  })
})
