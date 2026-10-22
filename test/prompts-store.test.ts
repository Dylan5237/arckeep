import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const filesystemFault = vi.hoisted(() => ({ rejectRename: false }))

vi.mock('node:fs', async importOriginal => {
  const filesystem = await importOriginal<typeof import('node:fs')>()
  return {
    ...filesystem,
    renameSync: (...args: Parameters<typeof filesystem.renameSync>) => {
      if (filesystemFault.rejectRename) throw new Error('Injected OS rename failure')
      return filesystem.renameSync(...args)
    }
  }
})

import { PromptStore } from '../src/main/prompts/store.js'
import { MAX_PROMPT_LENGTH, MAX_PROMPT_TAG_LENGTH, MAX_PROMPT_TAGS, MAX_PROMPT_TITLE_LENGTH } from '../src/shared/prompts/types.js'

const FIRST_ID = '00000000-0000-4000-8000-000000000001'
const SECOND_ID = '00000000-0000-4000-8000-000000000002'
const input = { title: '代码审查', text: '请审查当前代码', tags: ['工程'], pinned: false }
const saved = {
  id: FIRST_ID,
  ...input,
  createdAt: '2026-10-08T01:00:00.000Z',
  updatedAt: '2026-10-08T01:00:00.000Z'
}

describe('PromptStore', () => {
  let directory: string
  let file: string

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-prompts-'))
    file = path.join(directory, 'prompts.json')
  })

  afterEach(() => {
    filesystemFault.rejectRename = false
    rmSync(directory, { recursive: true, force: true })
  })

  it('persists CRUD across restarts without changing creation time or insertion order', () => {
    const ids = [FIRST_ID, SECOND_ID]
    const times = ['2026-10-08T01:00:00.000Z', '2026-10-08T01:01:00.000Z', '2026-10-08T01:02:00.000Z']
    let nextId = 0
    let nextTime = 0
    const store = new PromptStore({ file, id: () => ids[nextId++], now: () => new Date(times[nextTime++]) })
    expect(store.list()).toEqual([])
    expect(existsSync(file)).toBe(false)

    const first = store.create(input)
    const second = store.create({ title: '需求分析', text: '分析以下需求', tags: [], pinned: true })
    expect(first).toMatchObject({ id: FIRST_ID, createdAt: times[0], updatedAt: times[0] })
    expect(second).toMatchObject({ id: SECOND_ID, createdAt: times[1], updatedAt: times[1] })

    const restarted = new PromptStore({ file, now: () => new Date(times[2]) })
    expect(restarted.list()).toEqual([first, second])
    const updated = restarted.update({ id: FIRST_ID, title: '安全审查', text: '查找安全问题', tags: ['安全'], pinned: true })
    expect(updated).toMatchObject({ id: FIRST_ID, title: '安全审查', text: '查找安全问题', createdAt: times[0], updatedAt: times[2] })
    expect(restarted.list()).toEqual([updated, second])
    expect(restarted.delete(SECOND_ID)).toEqual({ id: SECOND_ID })
    expect(new PromptStore({ file }).list()).toEqual([updated])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, items: [updated] })
    expect(readdirSync(directory)).toEqual(['prompts.json'])
  })

  it('preserves literal prompt whitespace while normalizing titles and duplicate tags', () => {
    const text = '  \r\n\t# 任务\r\n使用 ${repo} 初始化项目  \n\n'
    const store = new PromptStore({ file })
    const created = store.create({ title: '  项目初始化  ', text, tags: [' 工程 ', '工程', 'Code Review', 'code review'], pinned: false })
    expect(created).toMatchObject({ title: '项目初始化', text, tags: ['工程', 'Code Review'], pinned: false })
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt)
    expect(new PromptStore({ file }).list()[0].text).toBe(text)
  })

  it('returns separate tag arrays for creates, lists, updates, and pin changes', () => {
    const store = new PromptStore({ file, id: () => FIRST_ID })
    const draft = { ...input, tags: ['工程'] }
    const created = store.create(draft)
    draft.tags.push('外部输入')
    created.tags.push('返回值')
    const listed = store.list()
    listed[0].tags.push('列表返回值')
    listed[0].text = '外部改写'
    expect(store.list()[0]).toMatchObject({ text: input.text, tags: ['工程'] })

    const updated = store.update({ id: FIRST_ID, ...input, tags: ['新标签'] })
    updated.tags.push('更新返回值')
    const pinned = store.setPinned(FIRST_ID, true)
    pinned.tags.push('置顶返回值')
    expect(store.list()[0]).toMatchObject({ tags: ['新标签'], pinned: true })
    expect(new PromptStore({ file }).list()).toEqual(store.list())
  })

  it('pins the current saved content without overwriting it with an earlier UI snapshot', () => {
    let seconds = 0
    const store = new PromptStore({ file, id: () => FIRST_ID, now: () => new Date(Date.UTC(2026, 9, 8, 1, 0, seconds++)) })
    const earlier = store.create(input)
    const updated = store.update({ id: earlier.id, title: '最新标题', text: '最新正文\n保留行尾 ', tags: ['最新标签'], pinned: false })
    const pinned = store.setPinned(earlier.id, true)
    expect(pinned).toEqual({ ...updated, pinned: true, updatedAt: '2026-10-08T01:00:02.000Z' })
    expect(new PromptStore({ file }).list()).toEqual([pinned])
    expect(store.setPinned(earlier.id, false).pinned).toBe(false)
  })

  it('accepts the maximum supported title, text, tag length, and unique tag count', () => {
    const store = new PromptStore({ file, id: () => FIRST_ID })
    const tags = Array.from({ length: MAX_PROMPT_TAGS }, (_, index) => `${index}`.padEnd(MAX_PROMPT_TAG_LENGTH, 'a'))
    const created = store.create({ title: 't'.repeat(MAX_PROMPT_TITLE_LENGTH), text: 'x'.repeat(MAX_PROMPT_LENGTH), tags, pinned: true })
    expect(created.tags).toHaveLength(MAX_PROMPT_TAGS)
    expect(new PromptStore({ file }).list()).toEqual([created])
  })

  it.each([
    ['missing field', { title: '标题', text: '正文', tags: [] }],
    ['unknown field', { ...input, repo: 'owner/repo' }],
    ['blank title', { ...input, title: ' \t\n ' }],
    ['long title', { ...input, title: 'x'.repeat(MAX_PROMPT_TITLE_LENGTH + 1) }],
    ['blank text', { ...input, text: ' \r\n\t ' }],
    ['long text', { ...input, text: 'x'.repeat(MAX_PROMPT_LENGTH + 1) }],
    ['nonboolean pin', { ...input, pinned: 'true' }],
    ['nonarray tags', { ...input, tags: '工程' }],
    ['nonstring tag', { ...input, tags: [42] }],
    ['blank tag', { ...input, tags: ['  '] }],
    ['long tag', { ...input, tags: ['x'.repeat(MAX_PROMPT_TAG_LENGTH + 1)] }],
    ['too many tags', { ...input, tags: Array.from({ length: MAX_PROMPT_TAGS + 1 }, (_, index) => String(index)) }]
  ])('rejects %s before writing any file', (_label, invalid) => {
    const store = new PromptStore({ file, id: () => FIRST_ID })
    expect(() => store.create(invalid)).toThrow(/提示词/)
    expect(store.list()).toEqual([])
    expect(existsSync(file)).toBe(false)
  })

  it('rejects invalid update, delete, and pin requests while preserving saved data', () => {
    const store = new PromptStore({ file, id: () => FIRST_ID })
    const created = store.create(input)
    const before = readFileSync(file, 'utf8')
    expect(() => store.update({ id: FIRST_ID, ...input, createdAt: saved.createdAt })).toThrow(/不支持/)
    expect(() => store.update({ id: SECOND_ID, ...input })).toThrow(/不存在/)
    expect(() => store.delete('00000000-0000-0000-0000-000000000001')).toThrow(/编号无效/)
    expect(() => store.delete(SECOND_ID)).toThrow(/不存在/)
    expect(() => store.setPinned(FIRST_ID, 1)).toThrow(/状态无效/)
    expect(() => store.setPinned(` ${FIRST_ID}`, true)).toThrow(/编号无效/)
    expect(() => store.setPinned(SECOND_ID, true)).toThrow(/不存在/)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(store.list()).toEqual([created])
  })

  it.each([
    ['malformed JSON', '{"version":1,"items":[', /损坏/],
    ['unknown version', '{"version":2,"items":[]}', /版本不支持/],
    ['unknown file field', JSON.stringify({ version: 1, items: [], extra: true }), /格式无效/],
    ['unknown item field', JSON.stringify({ version: 1, items: [{ ...saved, repo: 'owner/repo' }] }), /格式无效/],
    ['invalid UUID variant', JSON.stringify({ version: 1, items: [{ ...saved, id: '00000000-0000-4000-0000-000000000001' }] }), /格式无效/],
    ['noncanonical date', JSON.stringify({ version: 1, items: [{ ...saved, createdAt: '2026-10-08T01:00:00Z' }] }), /格式无效/],
    ['impossible date', JSON.stringify({ version: 1, items: [{ ...saved, updatedAt: '2026-02-30T01:00:00.000Z' }] }), /格式无效/],
    ['duplicate row identity', JSON.stringify({ version: 1, items: [saved, saved] }), /格式无效/]
  ])('fails closed on %s and retains the original bytes for every operation', (_label, contents, expected) => {
    writeFileSync(file, contents, 'utf8')
    const before = readFileSync(file)
    const store = new PromptStore({ file, id: () => SECOND_ID })
    expect(() => store.list()).toThrow(expected)
    expect(() => store.create(input)).toThrow(expected)
    expect(() => store.update({ id: FIRST_ID, ...input })).toThrow(expected)
    expect(() => store.delete(FIRST_ID)).toThrow(expected)
    expect(() => store.setPinned(FIRST_ID, true)).toThrow(expected)
    expect(readFileSync(file)).toEqual(before)
  })

  it('refuses to overwrite another writer and keeps the original memory snapshot', () => {
    const store = new PromptStore({ file, id: () => FIRST_ID })
    const first = store.create(input)
    const otherWriter = new PromptStore({ file })
    const external = otherWriter.update({ id: FIRST_ID, ...input, text: '外部修改的正文' })
    const before = readFileSync(file)
    expect(() => store.update({ id: FIRST_ID, ...input, text: '过时修改' })).toThrow(/外部修改/)
    expect(() => store.delete(FIRST_ID)).toThrow(/外部修改/)
    expect(() => store.setPinned(FIRST_ID, true)).toThrow(/外部修改/)
    expect(readFileSync(file)).toEqual(before)
    expect(store.list()).toEqual([first])
    expect(new PromptStore({ file }).list()).toEqual([external])
  })

  it('refuses to recreate a removed file or overwrite corruption introduced after startup', () => {
    const store = new PromptStore({ file, id: () => FIRST_ID })
    const created = store.create(input)
    const preserved = path.join(directory, 'preserved.json')
    renameSync(file, preserved)
    expect(() => store.setPinned(FIRST_ID, true)).toThrow(/已被移除/)
    expect(existsSync(file)).toBe(false)
    const futureVersion = '{"version":99,"items":[]}'
    writeFileSync(file, futureVersion, 'utf8')
    expect(() => store.delete(FIRST_ID)).toThrow(/版本不支持/)
    expect(readFileSync(file, 'utf8')).toBe(futureVersion)
    expect(store.list()).toEqual([created])
    expect(JSON.parse(readFileSync(preserved, 'utf8'))).toEqual({ version: 1, items: [created] })
  })

  it('keeps memory and existing bytes unchanged on a real filesystem write failure', () => {
    const blocker = path.join(directory, 'blocker')
    const store = new PromptStore({ file: path.join(blocker, 'prompts.json'), id: () => FIRST_ID })
    writeFileSync(blocker, 'occupied path', 'utf8')
    expect(() => store.create(input)).toThrow(/保存失败/)
    expect(store.list()).toEqual([])
    expect(readFileSync(blocker, 'utf8')).toBe('occupied path')
    expect(readdirSync(directory)).toEqual(['blocker'])
  })

  it('retains an existing file and memory snapshot if atomic replacement fails', () => {
    const store = new PromptStore({ file, id: () => FIRST_ID })
    const created = store.create(input)
    const before = readFileSync(file)
    filesystemFault.rejectRename = true
    expect(() => store.update({ id: FIRST_ID, ...input, text: '不能落盘的更新' })).toThrow(/保存失败/)
    expect(() => store.setPinned(FIRST_ID, true)).toThrow(/保存失败/)
    expect(() => store.delete(FIRST_ID)).toThrow(/保存失败/)
    expect(readFileSync(file)).toEqual(before)
    expect(store.list()).toEqual([created])
    expect(new PromptStore({ file }).list()).toEqual([created])
    expect(readdirSync(directory)).toEqual(['prompts.json'])

    filesystemFault.rejectRename = false
    expect(store.update({ id: FIRST_ID, ...input, text: '恢复后的更新' }).text).toBe('恢复后的更新')
    expect(new PromptStore({ file }).list()[0].text).toBe('恢复后的更新')
  })

  it('rejects invalid generated IDs, duplicate IDs, and invalid clocks without changing storage', () => {
    const invalidIdStore = new PromptStore({ file, id: () => 'not-a-uuid' })
    expect(() => invalidIdStore.create(input)).toThrow(/编号无效/)
    expect(existsSync(file)).toBe(false)
    const invalidClockStore = new PromptStore({ file, id: () => FIRST_ID, now: () => new Date('invalid') })
    expect(() => invalidClockStore.create(input)).toThrow(/时间无效/)
    expect(existsSync(file)).toBe(false)
    const store = new PromptStore({ file, id: () => FIRST_ID })
    const created = store.create(input)
    const before = readFileSync(file)
    expect(() => store.create(input)).toThrow(/编号重复/)
    expect(readFileSync(file)).toEqual(before)
    expect(store.list()).toEqual([created])
  })
})
