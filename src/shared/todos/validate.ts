import type { TodoInput, TodoItem, TodoUpdate } from './types.js'

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const MAX_TODO_TEXT = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Empty means no repo tag. Anything else must be owner/repo. */
export function normalizeRepoTag(input: unknown): string | null {
  if (input === null || input === undefined) return null
  if (typeof input !== 'string') throw new Error('仓库标签无效')
  const value = input.trim()
  if (!value) return null
  if (value.length > 200 || !REPO_PATTERN.test(value)) {
    throw new Error(`仓库标签格式应为 owner/repo：${value}`)
  }
  return value
}

export function normalizeTodoText(input: unknown): string {
  if (typeof input !== 'string') throw new Error('待办内容无效')
  const text = input.replace(/[\r\n]+/g, ' ').trim()
  if (!text) throw new Error('待办内容不能为空')
  if (text.length > MAX_TODO_TEXT) throw new Error('待办内容过长')
  return text
}

export function normalizeWaiting(input: unknown): boolean {
  if (typeof input !== 'boolean') throw new Error('等我标记无效')
  return input
}

export function normalizeTodoId(input: unknown): string {
  if (typeof input !== 'string' || !ID_PATTERN.test(input)) throw new Error('待办编号无效')
  return input.toLowerCase()
}

export function normalizeTodoInput(input: unknown): TodoInput {
  if (!isRecord(input)) throw new Error('待办无效')
  return {
    text: normalizeTodoText(input.text),
    repo: normalizeRepoTag(input.repo),
    waiting: normalizeWaiting(input.waiting)
  }
}

export function normalizeTodoUpdate(input: unknown): TodoUpdate {
  if (!isRecord(input)) throw new Error('待办无效')
  return {
    id: normalizeTodoId(input.id),
    ...normalizeTodoInput(input)
  }
}

export function normalizeTodoCompletion(input: unknown): { id: string, completed: boolean } {
  if (!isRecord(input)) throw new Error('待办无效')
  if (typeof input.completed !== 'boolean') throw new Error('完成状态无效')
  return {
    id: normalizeTodoId(input.id),
    completed: input.completed
  }
}

function normalizeIso(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 40 || Number.isNaN(Date.parse(input))) {
    throw new Error(`${label}无效`)
  }
  return new Date(input).toISOString()
}

/** Full row used to put a deleted todo back where it was. */
export function normalizeTodoSnapshot(input: unknown): TodoItem {
  if (!isRecord(input)) throw new Error('待办无效')
  const waiting = normalizeWaiting(input.waiting)
  if (typeof input.completed !== 'boolean') throw new Error('完成状态无效')
  let waitingSince: string | null = null
  if (waiting) {
    waitingSince = normalizeIso(input.waitingSince, '等我计时')
  } else if (input.waitingSince != null) {
    throw new Error('等我计时无效')
  }
  return {
    id: normalizeTodoId(input.id),
    text: normalizeTodoText(input.text),
    repo: normalizeRepoTag(input.repo),
    waiting,
    waitingSince,
    createdAt: normalizeIso(input.createdAt, '创建时间'),
    updatedAt: normalizeIso(input.updatedAt, '更新时间'),
    completed: input.completed
  }
}
