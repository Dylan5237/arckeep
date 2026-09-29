import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import { foldTodoLines, type MalformedTodoLine } from '../../shared/todos/fold.js'
import type { TodoInput, TodoItem, TodoUpdate, WaitingTodo } from '../../shared/todos/types.js'
import {
  normalizeTodoCompletion,
  normalizeTodoId,
  normalizeTodoInput,
  normalizeTodoUpdate
} from '../../shared/todos/validate.js'

export interface TodoStoreOptions {
  file: string
  now?: () => Date
  onMalformedLine?: (info: MalformedTodoLine) => void
}

/**
 * Append-only todo log.
 *
 * `todos.jsonl` under Electron userData (`%APPDATA%\Arckeep\` on Windows) is
 * the source of truth. Reads fold create/update/complete/uncomplete/delete
 * events. A corrupt line is skipped and the file is never rewritten on load.
 *
 * `listWaitingTodos()` returns incomplete「等我」items.
 * `waitingSince` is the moment the flag was turned on. Editing the text does
 * not move it; turning the flag off and on again does.
 * Provider mapping: `title = text`, reason time = `waitingSince`,
 * `url = arckeep://todos?id=<id>`.
 */
export class TodoStore {
  private items: TodoItem[] = []
  private readonly file: string
  private readonly now: () => Date
  private readonly onMalformedLine?: (info: MalformedTodoLine) => void

  constructor(options: TodoStoreOptions) {
    this.file = options.file
    this.now = options.now ?? (() => new Date())
    this.onMalformedLine = options.onMalformedLine
    this.load()
  }

  load(): void {
    let content = ''
    try {
      content = readFileSync(this.file, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        this.items = []
        return
      }
      throw error
    }
    this.items = foldTodoLines(content, this.onMalformedLine)
  }

  listTodos(): TodoItem[] {
    return this.items.map(item => ({ ...item }))
  }

  listWaitingTodos(): WaitingTodo[] {
    return this.items
      .filter(item => item.waiting && !item.completed)
      .map(item => ({
        id: item.id,
        text: item.text,
        repo: item.repo,
        createdAt: item.createdAt,
        waitingSince: item.waitingSince ?? item.createdAt
      }))
      .sort((left, right) => {
        if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
      })
  }

  create(input: unknown): TodoItem {
    const draft: TodoInput = normalizeTodoInput(input)
    const createdAt = this.now().toISOString()
    const record = {
      id: randomUUID(),
      text: draft.text,
      repo: draft.repo,
      waiting: draft.waiting,
      createdAt
    }
    this.append({ op: 'create', record })
    return this.requireItem(record.id)
  }

  update(input: unknown): TodoItem {
    const patch: TodoUpdate = normalizeTodoUpdate(input)
    this.requireItem(patch.id)
    this.append({
      op: 'update',
      id: patch.id,
      patch: { text: patch.text, repo: patch.repo, waiting: patch.waiting },
      updatedAt: this.now().toISOString()
    })
    return this.requireItem(patch.id)
  }

  setCompleted(input: unknown): TodoItem {
    const change = normalizeTodoCompletion(input)
    const existing = this.requireItem(change.id)
    if (existing.completed === change.completed) return existing
    this.append({
      op: change.completed ? 'complete' : 'uncomplete',
      id: change.id,
      at: this.now().toISOString()
    })
    return this.requireItem(change.id)
  }

  delete(id: unknown): { id: string } {
    const todoId = normalizeTodoId(id)
    this.requireItem(todoId)
    this.append({ op: 'delete', id: todoId, at: this.now().toISOString() })
    return { id: todoId }
  }

  private requireItem(id: string): TodoItem {
    const item = this.items.find(candidate => candidate.id === id)
    if (!item) throw new Error('待办不存在')
    return { ...item }
  }

  private append(event: unknown): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const payload = `${JSON.stringify(event)}\n`
    const needsBreak = existsSync(this.file) && statSync(this.file).size > 0 && !endsWithNewline(this.file)
    appendFileSync(this.file, needsBreak ? `\n${payload}` : payload, 'utf8')
    this.load()
  }
}

function endsWithNewline(file: string): boolean {
  const handle = openSync(file, 'r')
  try {
    const byte = Buffer.alloc(1)
    readSync(handle, byte, 0, 1, statSync(file).size - 1)
    return byte.toString('utf8') === '\n'
  } finally {
    closeSync(handle)
  }
}
