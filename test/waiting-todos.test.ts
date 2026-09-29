import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultAppDataDir, todosFilePath, userDataDir } from '../src/main/paths.js'
import { parseSettings } from '../src/main/settings-store.js'
import { TodoStore } from '../src/main/todos/store.js'
import { assembleWaiting } from '../src/shared/waiting/assemble.js'
import { defaultWaitingConfig } from '../src/shared/waiting/rules.js'
import { toTodoWaitingItems } from '../src/shared/waiting/todo-source.js'
import type { WaitingJsonRow } from '../src/shared/waiting/types.js'
import { runCli } from '../src/waiting/cli.js'

function tempTodos(): string {
  return todosFilePath(mkdtempSync(path.join(tmpdir(), 'arckeep-wait-todo-')))
}

describe('等我 todos', () => {
  it('turns the todo source on when reading settings saved by the disabled placeholder', () => {
    const migrated = parseSettings({
      version: 1,
      waiting: { sources: { todos: false, assignee: true } }
    })
    expect(migrated.version).toBe(2)
    expect(migrated.waiting.sources.todos).toBe(true)
    expect(migrated.waiting.sources.assignee).toBe(true)

    const chosen = parseSettings({
      version: 2,
      waiting: { sources: { todos: false } }
    })
    expect(chosen.waiting.sources.todos).toBe(false)
  })

  it('counts waiting days from the moment 等我 is checked, and restarts after a toggle', () => {
    const file = tempTodos()
    let clock = new Date('2026-09-01T00:00:00.000Z')
    const store = new TodoStore({ file, now: () => clock })
    const createdOn = store.create({ text: '创建时就等我', repo: 'example/demo', waiting: true })
    expect(createdOn.waitingSince).toBe('2026-09-01T00:00:00.000Z')

    clock = new Date('2026-09-02T00:00:00.000Z')
    const later = store.create({ text: '后来才勾', repo: null, waiting: false })
    expect(later.waitingSince).toBeNull()
    clock = new Date('2026-09-04T08:00:00.000Z')
    const checked = store.update({ id: later.id, text: '后来才勾', repo: null, waiting: true })
    expect(checked.waitingSince).toBe('2026-09-04T08:00:00.000Z')

    clock = new Date('2026-09-06T08:00:00.000Z')
    const edited = store.update({ id: later.id, text: '改正文', repo: 'example/demo', waiting: true })
    expect(edited.waitingSince).toBe('2026-09-04T08:00:00.000Z')

    clock = new Date('2026-09-07T08:00:00.000Z')
    const cleared = store.update({ id: later.id, text: '改正文', repo: 'example/demo', waiting: false })
    expect(cleared.waitingSince).toBeNull()
    clock = new Date('2026-09-09T08:00:00.000Z')
    const rechecked = store.update({ id: later.id, text: '改正文', repo: 'example/demo', waiting: true })
    expect(rechecked.waitingSince).toBe('2026-09-09T08:00:00.000Z')

    const now = new Date('2026-09-12T08:00:00.000Z')
    const rows = assembleWaiting({
      records: [],
      statusDocs: [],
      branches: [],
      todos: toTodoWaitingItems(store.listWaitingTodos()),
      config: defaultWaitingConfig(),
      now
    })
    const byTitle = new Map(rows.map(row => [row.title, row]))
    expect(byTitle.get('创建时就等我')).toMatchObject({
      type: 'todo',
      reasons: ['待办'],
      action: '待办',
      waitingDays: 11,
      daysEstimated: false,
      url: `arckeep://todos?id=${encodeURIComponent(createdOn.id)}`
    })
    expect(byTitle.get('改正文')).toMatchObject({
      waitingDays: 3,
      reasons: ['待办'],
      action: '待办'
    })
  })

  it('adds an incomplete 等我 todo to the waiting list and drops it when finished, unchecked, or deleted', () => {
    const file = tempTodos()
    const store = new TodoStore({ file, now: () => new Date('2026-09-03T00:00:00.000Z') })
    const item = store.create({ text: '等我看一眼', repo: null, waiting: false })
    const listed = () => store.listWaitingTodos().map(row => row.id)

    expect(listed()).toEqual([])
    store.update({ id: item.id, text: '等我看一眼', repo: null, waiting: true })
    expect(listed()).toEqual([item.id])

    store.setCompleted({ id: item.id, completed: true })
    expect(listed()).toEqual([])
    store.setCompleted({ id: item.id, completed: false })
    expect(listed()).toEqual([item.id])

    store.update({ id: item.id, text: '等我看一眼', repo: null, waiting: false })
    expect(listed()).toEqual([])
    store.update({ id: item.id, text: '等我看一眼', repo: null, waiting: true })
    expect(listed()).toEqual([item.id])

    store.delete(item.id)
    expect(listed()).toEqual([])
  })

  it('prints 等我 todos in npm run waiting -- --json with the same fields as other rows', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'arckeep-waiting-cli-'))
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, 'config'),
      APPDATA: path.join(home, 'AppData', 'Roaming')
    }
    delete env.GITHUB_TOKEN
    delete env.GH_TOKEN
    const file = todosFilePath(userDataDir(defaultAppDataDir(env, process.platform, home)))
    let clock = new Date('2026-09-01T00:00:00.000Z')
    const store = new TodoStore({ file, now: () => clock })
    const kept = store.create({ text: '还在等我', repo: 'example/demo', waiting: true })
    clock = new Date('2026-09-05T00:00:00.000Z')
    const done = store.create({ text: '已经做完', repo: null, waiting: true })
    store.setCompleted({ id: done.id, completed: true })
    const plain = store.create({ text: '普通待办', repo: null, waiting: false })

    let stdout = ''
    const stderr: string[] = []
    const code = await runCli(['--json'], {
      stdout: text => { stdout += text },
      stderr: text => { stderr.push(text) },
      env,
      now: new Date('2026-09-08T00:00:00.000Z'),
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      readSaved: () => null,
      fetchImpl: async () => {
        throw new Error('json test must not call GitHub')
      }
    })
    expect(code).toBe(0)
    const rows = JSON.parse(stdout) as WaitingJsonRow[]
    expect(rows.map(row => row.title)).toEqual(['还在等我'])
    expect(rows.some(row => row.title === done.text || row.title === plain.text)).toBe(false)
    const row = rows[0]
    expect(row).toEqual({
      repo: 'local/todos',
      number: null,
      type: 'todo',
      title: '还在等我',
      url: `arckeep://todos?id=${encodeURIComponent(kept.id)}`,
      reasons: ['待办'],
      action: '待办',
      waitingDays: 7,
      daysEstimated: false,
      parent: null,
      childCount: 0
    })
    const keys = Object.keys(row ?? {}).sort()
    expect(keys).toEqual([
      'action',
      'childCount',
      'daysEstimated',
      'number',
      'parent',
      'reasons',
      'repo',
      'title',
      'type',
      'url',
      'waitingDays'
    ])
  })
})
