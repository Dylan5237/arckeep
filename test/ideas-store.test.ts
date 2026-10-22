import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IdeaStore } from '../src/main/ideas/store.js'

const FIRST_ID = '00000000-0000-4000-8000-000000000001'
const SECOND_ID = '00000000-0000-4000-8000-000000000002'

describe('IdeaStore', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-ideas-'))
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it('persists create, update, and delete across restarts while keeping order', () => {
    const file = path.join(directory, 'ideas.json')
    let nextId = 0
    let nextTime = 0
    const ids = [FIRST_ID, SECOND_ID]
    const times = ['2026-10-04T01:00:00.000Z', '2026-10-04T01:01:00.000Z', '2026-10-04T01:02:00.000Z']
    const options = {
      file,
      id: () => ids[nextId++],
      now: () => new Date(times[nextTime++])
    }
    const first = new IdeaStore(options)
    expect(first.list()).toEqual([])
    expect(existsSync(file)).toBe(false)

    const createdFirst = first.create({ text: '第一条灵感', repo: ' octocat/hello ' })
    const createdSecond = first.create({ text: '第二条灵感', repo: null })
    expect(createdFirst).toMatchObject({ id: FIRST_ID, repo: 'octocat/hello', createdAt: times[0], updatedAt: times[0] })
    expect(createdSecond).toMatchObject({ id: SECOND_ID, createdAt: times[1], updatedAt: times[1] })

    const reloaded = new IdeaStore(options)
    expect(reloaded.list()).toEqual([createdFirst, createdSecond])
    const updated = reloaded.update({ id: FIRST_ID, text: '更新后的第一条', repo: '' })
    expect(updated).toMatchObject({ id: FIRST_ID, text: '更新后的第一条', repo: null, createdAt: times[0], updatedAt: times[2] })
    expect(reloaded.delete(SECOND_ID)).toEqual({ id: SECOND_ID })

    const restarted = new IdeaStore({ file })
    expect(restarted.list()).toEqual([updated])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 1, items: [updated] })
  })

  it('uses a UUID and ISO timestamps by default, preserves multiline literal text, and returns copies', () => {
    const file = path.join(directory, 'ideas.json')
    const store = new IdeaStore({ file })
    const text = '# 标题\n!等我处理\n第二行内容'
    const created = store.create({ text, repo: null })
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt)
    expect(created.updatedAt).toBe(created.createdAt)
    expect(created.text).toBe(text)

    const listed = store.list()
    listed[0].text = '外部改写'
    expect(store.list()[0].text).toBe(text)
  })

  it('rejects invalid input without writing and rejects todo-only fields', () => {
    const file = path.join(directory, 'ideas.json')
    const store = new IdeaStore({ file, id: () => FIRST_ID })
    const invalidInputs: unknown[] = [
      { text: ' \n ', repo: null },
      { text: 'x'.repeat(10_001), repo: null },
      { text: '内容', repo: 'owner/repo/extra' },
      { text: '内容', repo: null, waiting: true },
      { text: '内容', repo: null, completed: true }
    ]
    for (const input of invalidInputs) expect(() => store.create(input)).toThrow()
    expect(existsSync(file)).toBe(false)
    expect(store.list()).toEqual([])

    const created = store.create({ text: '有效内容', repo: null })
    const before = readFileSync(file, 'utf8')
    expect(() => store.update({ id: created.id, text: '修改', repo: null, completed: false })).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(store.list()).toEqual([created])
  })

  it.each([
    ['malformed JSON', '{"version":1,"items":[', /损坏/],
    ['unknown version', '{"version":2,"items":[]}', /版本不支持/]
  ])('defers %s load errors to store operations and preserves the file', (_label, contents, errorMessage) => {
    const file = path.join(directory, 'ideas.json')
    writeFileSync(file, contents, 'utf8')
    const store = new IdeaStore({ file, id: () => FIRST_ID })
    expect(() => store.list()).toThrow(errorMessage)
    expect(() => store.create({ text: '新的灵感', repo: null })).toThrow(errorMessage)
    expect(() => store.update({ id: FIRST_ID, text: '更新', repo: null })).toThrow(errorMessage)
    expect(() => store.delete(FIRST_ID)).toThrow(errorMessage)
    expect(readFileSync(file, 'utf8')).toBe(contents)
  })

  it('refuses to overwrite a damaged or externally changed file after startup', () => {
    const file = path.join(directory, 'ideas.json')
    const store = new IdeaStore({ file, id: () => FIRST_ID })
    const damaged = '{"version":99,"items":[]}'
    writeFileSync(file, damaged, 'utf8')
    expect(() => store.create({ text: '灵感', repo: null })).toThrow(/版本不支持/)
    expect(readFileSync(file, 'utf8')).toBe(damaged)
    expect(store.list()).toEqual([])
  })

  it('does not report success or mutate memory when storage cannot be read or written', () => {
    const blockingFile = path.join(directory, 'blocker')
    const file = path.join(blockingFile, 'ideas.json')
    const store = new IdeaStore({ file, id: () => FIRST_ID })
    writeFileSync(blockingFile, 'not a directory', 'utf8')

    expect(() => store.create({ text: '灵感', repo: null })).toThrow(/灵感保存失败/)
    expect(store.list()).toEqual([])
    expect(readFileSync(blockingFile, 'utf8')).toBe('not a directory')
  })
})
