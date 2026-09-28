import type { TodoItem } from './types.js'
import {
  normalizeRepoTag,
  normalizeTodoId,
  normalizeTodoText,
  normalizeWaiting
} from './validate.js'

export interface MalformedTodoLine {
  line: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 40 && !Number.isNaN(Date.parse(value))
}

export function compareTodos(left: TodoItem, right: TodoItem): number {
  if (left.completed !== right.completed) return left.completed ? 1 : -1
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1
  if (left.id !== right.id) return left.id < right.id ? -1 : 1
  return 0
}

function applyCreate(items: Map<string, TodoItem>, record: unknown): boolean {
  if (!isRecord(record)) return false
  try {
    const id = normalizeTodoId(record.id)
    const text = normalizeTodoText(record.text)
    const repo = normalizeRepoTag(record.repo)
    const waiting = normalizeWaiting(record.waiting)
    if (!isIso(record.createdAt)) return false
    const createdAt = new Date(record.createdAt).toISOString()
    items.set(id, {
      id,
      text,
      repo,
      waiting,
      createdAt,
      updatedAt: createdAt,
      completed: false
    })
    return true
  } catch {
    return false
  }
}

function applyUpdate(items: Map<string, TodoItem>, event: Record<string, unknown>): boolean {
  try {
    const id = normalizeTodoId(event.id)
    const existing = items.get(id)
    if (!existing || !isRecord(event.patch)) return false
    const next: TodoItem = { ...existing }
    let changed = false
    if ('text' in event.patch) {
      next.text = normalizeTodoText(event.patch.text)
      changed = true
    }
    if ('repo' in event.patch) {
      next.repo = normalizeRepoTag(event.patch.repo)
      changed = true
    }
    if ('waiting' in event.patch) {
      next.waiting = normalizeWaiting(event.patch.waiting)
      changed = true
    }
    if (!changed) return false
    if (isIso(event.updatedAt)) next.updatedAt = new Date(event.updatedAt).toISOString()
    items.set(id, next)
    return true
  } catch {
    return false
  }
}

function applyCompletion(items: Map<string, TodoItem>, event: Record<string, unknown>, completed: boolean): boolean {
  try {
    const id = normalizeTodoId(event.id)
    const existing = items.get(id)
    if (!existing) return false
    const updatedAt = isIso(event.at) ? new Date(event.at).toISOString() : existing.updatedAt
    items.set(id, { ...existing, completed, updatedAt })
    return true
  } catch {
    return false
  }
}

function applyDelete(items: Map<string, TodoItem>, event: Record<string, unknown>): boolean {
  try {
    const id = normalizeTodoId(event.id)
    if (!items.has(id)) return false
    items.delete(id)
    return true
  } catch {
    return false
  }
}

function applyEvent(items: Map<string, TodoItem>, event: unknown): boolean {
  if (!isRecord(event) || typeof event.op !== 'string') return false
  if (event.op === 'create') return applyCreate(items, event.record)
  if (event.op === 'update') return applyUpdate(items, event)
  if (event.op === 'complete') return applyCompletion(items, event, true)
  if (event.op === 'uncomplete') return applyCompletion(items, event, false)
  if (event.op === 'delete') return applyDelete(items, event)
  return false
}

/**
 * Folds an append-only JSONL log. Blank lines are ignored. A line that is not
 * valid JSON, or not a valid event, is reported and skipped. This function
 * never writes.
 */
export function foldTodoLines(
  content: string,
  onMalformedLine?: (info: MalformedTodoLine) => void
): TodoItem[] {
  const items = new Map<string, TodoItem>()
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? ''
    if (!line) continue
    let event: unknown
    try {
      event = JSON.parse(line) as unknown
    } catch {
      onMalformedLine?.({ line: index + 1 })
      continue
    }
    if (!applyEvent(items, event)) onMalformedLine?.({ line: index + 1 })
  }
  return [...items.values()].sort(compareTodos)
}
