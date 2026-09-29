import { appendFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { todosFilePath } from '../src/main/paths.js'
import { TodoStore } from '../src/main/todos/store.js'
import { foldTodoLines } from '../src/shared/todos/fold.js'
import { completedGroupTitle, partitionTodos, readCompletedGroupOpen, writeCompletedGroupOpen } from '../src/shared/todos/groups.js'
import { mergeRepoOptions } from '../src/shared/todos/repos.js'
import { formatRelativeTime } from '../src/shared/todos/time.js'
import { beginDeleteUndo, deleteUndoItem } from '../src/shared/todos/undo.js'
import { normalizeRepoTag, normalizeTodoInput } from '../src/shared/todos/validate.js'
import type { TodoItem } from '../src/shared/todos/types.js'

function tempFile(): string {
  return todosFilePath(mkdtempSync(path.join(tmpdir(), 'arckeep-todos-')))
}

describe('todo jsonl fold', () => {
  it('skips a corrupt line and does not truncate or rewrite the file', () => {
    const file = tempFile()
    const malformed: number[] = []
    let clock = new Date('2026-09-01T00:00:00.000Z')
    const first = new TodoStore({
      file,
      now: () => clock,
      onMalformedLine: info => malformed.push(info.line)
    })
    first.create({ text: '第一条', repo: null, waiting: false })
    clock = new Date('2026-09-02T00:00:00.000Z')
    first.create({ text: '第二条', repo: 'Dylan5237/arckeep', waiting: true })
    const broken = '{"op":"create","record":{"id":"broken'
    appendFileSync(file, broken)
    const afterAppend = readFileSync(file, 'utf8')

    const fresh = new TodoStore({
      file,
      now: () => new Date('2026-09-03T00:00:00.000Z'),
      onMalformedLine: info => malformed.push(info.line)
    })
    expect(fresh.listTodos().map(item => item.text)).toEqual(['第一条', '第二条'])
    expect(malformed).toEqual([3])
    expect(readFileSync(file, 'utf8')).toBe(afterAppend)

    fresh.create({ text: '第三条', repo: null, waiting: false })
    const afterCreate = readFileSync(file, 'utf8')
    expect(afterCreate.startsWith(afterAppend)).toBe(true)
    expect(afterCreate.length).toBeGreaterThan(afterAppend.length)
    expect(afterCreate).toContain(broken)
    expect(fresh.listTodos().map(item => item.text)).toEqual(['第一条', '第二条', '第三条'])
  })

  it('keeps events that follow a corrupt line in the middle of the log', () => {
    const file = tempFile()
    const good = {
      op: 'create',
      record: {
        id: '00000000-0000-4000-8000-000000000001',
        text: '仍然在',
        repo: null,
        waiting: false,
        createdAt: '2026-09-01T00:00:00.000Z'
      }
    }
    const later = {
      op: 'create',
      record: {
        id: '00000000-0000-4000-8000-000000000002',
        text: '后面也在',
        repo: 'example/demo',
        waiting: true,
        createdAt: '2026-09-02T00:00:00.000Z'
      }
    }
    const content = `${JSON.stringify(good)}\nthis is not json\n${JSON.stringify(later)}\n`
    appendFileSync(file, content)
    const before = readFileSync(file, 'utf8')
    const skipped: number[] = []
    const folded = foldTodoLines(before, info => skipped.push(info.line))
    expect(skipped).toEqual([2])
    expect(folded.map(item => item.text)).toEqual(['仍然在', '后面也在'])
    expect(readFileSync(file, 'utf8')).toBe(before)
  })
})

describe('todo persistence', () => {
  it('keeps create, edit, complete, uncomplete, and delete across a fresh store', () => {
    const file = tempFile()
    let clock = new Date('2026-09-10T08:00:00.000Z')
    const store = new TodoStore({ file, now: () => clock })
    const created = store.create({ text: '写捕获框', repo: null, waiting: false })
    clock = new Date('2026-09-10T09:00:00.000Z')
    const edited = store.update({
      id: created.id,
      text: '写捕获框和待办页',
      repo: 'Dylan5237/arckeep',
      waiting: true
    })
    expect(edited).toMatchObject({
      text: '写捕获框和待办页',
      repo: 'Dylan5237/arckeep',
      waiting: true,
      completed: false
    })

    clock = new Date('2026-09-10T10:00:00.000Z')
    expect(store.setCompleted({ id: created.id, completed: true }).completed).toBe(true)
    clock = new Date('2026-09-10T11:00:00.000Z')
    expect(store.setCompleted({ id: created.id, completed: false }).completed).toBe(false)

    const other = store.create({ text: '另一条', repo: 'example/demo', waiting: false })
    store.delete(created.id)

    const fresh = new TodoStore({ file })
    expect(fresh.listTodos().map(item => item.id)).toEqual([other.id])
    const reloaded = new TodoStore({ file })
    reloaded.update({ id: other.id, text: '改过的另一条', repo: null, waiting: true })
    const again = new TodoStore({ file })
    expect(again.listTodos()).toMatchObject([{
      id: other.id,
      text: '改过的另一条',
      repo: null,
      waiting: true,
      completed: false
    }])
    expect(existsSync(file)).toBe(true)
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { op: string })
    expect(lines.map(line => line.op)).toEqual([
      'create', 'update', 'complete', 'uncomplete', 'create', 'delete', 'update'
    ])
  })

  it('lists incomplete items first, oldest createdAt first inside each group', () => {
    const file = tempFile()
    let clock = new Date('2026-09-01T00:00:00.000Z')
    const store = new TodoStore({ file, now: () => clock })
    const older = store.create({ text: '更早', repo: null, waiting: false })
    clock = new Date('2026-09-03T00:00:00.000Z')
    const newer = store.create({ text: '更晚', repo: null, waiting: false })
    store.setCompleted({ id: older.id, completed: true })
    expect(store.listTodos().map(item => item.text)).toEqual(['更晚', '更早'])
    expect(newer.text).toBe('更晚')
  })

  it('deletes at once and restores the same place, repo, and 等我 timer', () => {
    const file = tempFile()
    let clock = new Date('2026-09-01T00:00:00.000Z')
    const store = new TodoStore({ file, now: () => clock })
    const first = store.create({ text: '第一条', repo: null, waiting: false })
    clock = new Date('2026-09-02T00:00:00.000Z')
    const middle = store.create({ text: '中间', repo: null, waiting: false })
    clock = new Date('2026-09-03T00:00:00.000Z')
    const last = store.create({ text: '最后', repo: 'example/demo', waiting: false })
    clock = new Date('2026-09-04T08:00:00.000Z')
    const marked = store.update({
      id: middle.id,
      text: '中间改过',
      repo: 'Dylan5237/arckeep',
      waiting: true
    })
    expect(marked.waitingSince).toBe('2026-09-04T08:00:00.000Z')
    clock = new Date('2026-09-05T00:00:00.000Z')
    store.setCompleted({ id: last.id, completed: true })

    const before = store.listTodos()
    expect(before.map(item => item.id)).toEqual([first.id, middle.id, last.id])
    const beforeBytes = readFileSync(file, 'utf8')
    expect(() => store.restore({ id: middle.id })).toThrow(/无效/)
    expect(readFileSync(file, 'utf8')).toBe(beforeBytes)

    store.delete(middle.id)
    expect(store.listTodos().map(item => item.id)).toEqual([first.id, last.id])
    expect(store.listWaitingTodos()).toEqual([])

    clock = new Date('2026-09-20T00:00:00.000Z')
    expect(store.restore(marked)).toEqual(marked)
    const fresh = new TodoStore({ file })
    expect(fresh.listTodos()).toEqual(before)
    expect(fresh.listTodos().findIndex(item => item.id === middle.id)).toBe(1)
    expect(fresh.listWaitingTodos()).toEqual([{
      id: middle.id,
      text: '中间改过',
      repo: 'Dylan5237/arckeep',
      createdAt: middle.createdAt,
      waitingSince: '2026-09-04T08:00:00.000Z'
    }])
    const ops = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { op: string })
    expect(ops.map(line => line.op)).toEqual(['create', 'create', 'create', 'update', 'complete', 'delete', 'restore'])
  })
})

describe('delete undo and completed group', () => {
  const sample = (patch: Partial<TodoItem>): TodoItem => ({
    id: '00000000-0000-4000-8000-000000000001',
    text: '一条',
    repo: 'Dylan5237/arckeep',
    waiting: true,
    waitingSince: '2026-09-04T08:00:00.000Z',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-04T08:00:00.000Z',
    completed: false,
    ...patch
  })

  it('keeps undo for five seconds, then drops the snapshot', () => {
    const item = sample({})
    const pending = beginDeleteUndo(item, 1_000)
    item.text = '改掉原对象'
    expect(pending.until).toBe(6_000)
    expect(deleteUndoItem(pending, 5_999)?.text).toBe('一条')
    expect(deleteUndoItem(pending, 6_000)).toBeNull()
    expect(deleteUndoItem(null, 1_000)).toBeNull()
  })

  it('folds completed todos into a group that stays collapsed until opened', () => {
    const items = [
      sample({ id: '00000000-0000-4000-8000-00000000000a', text: '未完成更早', completed: false, createdAt: '2026-09-01T00:00:00.000Z' }),
      sample({ id: '00000000-0000-4000-8000-00000000000b', text: '已完成', completed: true, waiting: false, waitingSince: null }),
      sample({ id: '00000000-0000-4000-8000-00000000000c', text: '未完成更晚', completed: false, createdAt: '2026-09-03T00:00:00.000Z' })
    ]
    expect(partitionTodos(items).open.map(item => item.text)).toEqual(['未完成更早', '未完成更晚'])
    expect(partitionTodos(items).done.map(item => item.text)).toEqual(['已完成'])
    expect(completedGroupTitle(28)).toBe('已完成 · 28')
    expect(readCompletedGroupOpen(null)).toBe(false)
    expect(readCompletedGroupOpen('0')).toBe(false)
    expect(readCompletedGroupOpen('1')).toBe(true)
    expect(writeCompletedGroupOpen(true)).toBe('1')
    expect(writeCompletedGroupOpen(false)).toBe('0')
  })
})

describe('waiting todos', () => {
  it('returns only incomplete 等我 items with id, text, repo, and createdAt', () => {
    const file = tempFile()
    let clock = new Date('2026-09-02T00:00:00.000Z')
    const store = new TodoStore({ file, now: () => clock })
    const waiting = store.create({ text: '等我看', repo: 'Dylan5237/arckeep', waiting: true })
    clock = new Date('2026-09-01T00:00:00.000Z')
    const earlier = store.create({ text: '更早的等我', repo: null, waiting: true })
    store.create({ text: '普通待办', repo: 'example/demo', waiting: false })
    const done = store.create({ text: '做完的等我', repo: 'example/demo', waiting: true })
    store.setCompleted({ id: done.id, completed: true })
    const removed = store.create({ text: '删掉的等我', repo: 'example/demo', waiting: true })
    store.delete(removed.id)

    expect(store.listWaitingTodos()).toEqual([
      {
        id: earlier.id,
        text: '更早的等我',
        repo: null,
        createdAt: earlier.createdAt,
        waitingSince: earlier.createdAt
      },
      {
        id: waiting.id,
        text: '等我看',
        repo: 'Dylan5237/arckeep',
        createdAt: waiting.createdAt,
        waitingSince: waiting.createdAt
      }
    ])

    const fresh = new TodoStore({ file })
    expect(fresh.listWaitingTodos().map(item => item.text)).toEqual(['更早的等我', '等我看'])
    fresh.setCompleted({ id: earlier.id, completed: true })
    expect(fresh.listWaitingTodos().map(item => item.id)).toEqual([waiting.id])
  })
})

describe('todo validation', () => {
  it('rejects an invalid repo tag without writing', () => {
    const file = tempFile()
    const store = new TodoStore({ file })
    expect(() => store.create({ text: 'x', repo: 'not a repo', waiting: false })).toThrow(/owner\/repo/)
    expect(() => store.create({ text: '   ', repo: null, waiting: false })).toThrow(/不能为空/)
    expect(() => store.create({ text: 'x', repo: null, waiting: 'yes' })).toThrow(/等我标记无效/)
    expect(existsSync(file)).toBe(false)
    expect(normalizeRepoTag('octocat/hello-world')).toBe('octocat/hello-world')
    expect(normalizeTodoInput({ text: '  hello \n world ', repo: '', waiting: false })).toEqual({
      text: 'hello   world',
      repo: null,
      waiting: false
    })
  })

  it('builds the repo picker from watched repos and tags already in use', () => {
    expect(mergeRepoOptions(
      ['Dylan5237/arckeep'],
      [{ repo: 'Dylan5237/arckeep' }, { repo: null }, { repo: 'example/demo' }]
    )).toEqual(['Dylan5237/arckeep', 'example/demo'])
  })
})

describe('formatRelativeTime', () => {
  const now = new Date(2026, 8, 28, 15, 0, 0)

  it('uses local calendar days', () => {
    expect(formatRelativeTime(new Date(2026, 8, 25, 9, 0, 0).toISOString(), now)).toBe('3 天前')
    expect(formatRelativeTime(new Date(2026, 8, 27, 18, 0, 0).toISOString(), now)).toBe('昨天')
    expect(formatRelativeTime(new Date(2026, 8, 28, 14, 20, 0).toISOString(), now)).toBe('40 分钟前')
    expect(formatRelativeTime(new Date(2026, 8, 28, 14, 59, 30).toISOString(), now)).toBe('刚刚')
    expect(formatRelativeTime(new Date(2026, 8, 28, 12, 0, 0).toISOString(), now)).toBe('3 小时前')
  })
})
