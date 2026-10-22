import type { IdeaInput, IdeaItem, IdeaUpdate } from './types.js'
import { MAX_IDEA_LENGTH } from './types.js'

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ITEM_KEYS = ['id', 'text', 'repo', 'createdAt', 'updatedAt']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertKeys(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(input).some(key => !allowed.includes(key))) {
    throw new Error(`${label}包含不支持的字段`)
  }
}

export function normalizeIdeaText(input: unknown): string {
  if (typeof input !== 'string') throw new Error('灵感内容无效')
  if (input.trim().length === 0) throw new Error('灵感内容不能为空')
  if (input.length > MAX_IDEA_LENGTH) throw new Error(`灵感内容不能超过 ${MAX_IDEA_LENGTH} 个字符`)
  return input
}

export function normalizeIdeaRepo(input: unknown): string | null {
  if (input === null) return null
  if (typeof input !== 'string') throw new Error('灵感仓库无效')
  const value = input.trim()
  if (!value) return null
  if (value.length > 200 || !REPO_PATTERN.test(value)) {
    throw new Error('灵感仓库格式应为 owner/repo')
  }
  return value
}

export function normalizeIdeaId(input: unknown): string {
  if (typeof input !== 'string' || !UUID_PATTERN.test(input)) throw new Error('灵感编号无效')
  return input.toLowerCase()
}

export function normalizeIdeaInput(input: unknown): IdeaInput {
  if (!isRecord(input)) throw new Error('灵感参数无效')
  assertKeys(input, ['text', 'repo'], '灵感参数')
  if (!Object.hasOwn(input, 'text') || !Object.hasOwn(input, 'repo')) throw new Error('灵感参数不完整')
  return {
    text: normalizeIdeaText(input.text),
    repo: normalizeIdeaRepo(input.repo)
  }
}

export function normalizeIdeaUpdate(input: unknown): IdeaUpdate {
  if (!isRecord(input)) throw new Error('灵感参数无效')
  assertKeys(input, ['id', 'text', 'repo'], '灵感参数')
  if (!Object.hasOwn(input, 'id')) throw new Error('灵感参数不完整')
  return {
    id: normalizeIdeaId(input.id),
    ...normalizeIdeaInput({ text: input.text, repo: input.repo })
  }
}

function normalizeIsoTimestamp(input: unknown, label: string): string {
  if (typeof input !== 'string') throw new Error(`${label}无效`)
  const parsed = new Date(input)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== input) throw new Error(`${label}无效`)
  return input
}

/** Validates a stored row without admitting todo or waiting-only fields. */
export function normalizeIdeaItem(input: unknown): IdeaItem {
  if (!isRecord(input)) throw new Error('灵感数据无效')
  assertKeys(input, ITEM_KEYS, '灵感数据')
  if (ITEM_KEYS.some(key => !Object.hasOwn(input, key))) throw new Error('灵感数据不完整')
  return {
    id: normalizeIdeaId(input.id),
    text: normalizeIdeaText(input.text),
    repo: normalizeIdeaRepo(input.repo),
    createdAt: normalizeIsoTimestamp(input.createdAt, '灵感创建时间'),
    updatedAt: normalizeIsoTimestamp(input.updatedAt, '灵感更新时间')
  }
}
