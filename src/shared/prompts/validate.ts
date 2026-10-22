import type { PromptInput, PromptItem, PromptUpdate } from './types.js'
import { MAX_PROMPT_LENGTH, MAX_PROMPT_TAG_LENGTH, MAX_PROMPT_TAGS, MAX_PROMPT_TITLE_LENGTH } from './types.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const INPUT_KEYS = ['title', 'text', 'tags', 'pinned']
const UPDATE_KEYS = ['id', ...INPUT_KEYS]
const ITEM_KEYS = [...UPDATE_KEYS, 'createdAt', 'updatedAt']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertKeys(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(input).some(key => !allowed.includes(key))) {
    throw new Error(`${label}包含不支持的字段`)
  }
  if (allowed.some(key => !Object.hasOwn(input, key))) throw new Error(`${label}不完整`)
}

export function normalizePromptTitle(input: unknown): string {
  if (typeof input !== 'string') throw new Error('提示词标题无效')
  const title = input.trim()
  if (!title) throw new Error('提示词标题不能为空')
  if (title.length > MAX_PROMPT_TITLE_LENGTH) throw new Error(`提示词标题不能超过 ${MAX_PROMPT_TITLE_LENGTH} 个字符`)
  return title
}

export function normalizePromptText(input: unknown): string {
  if (typeof input !== 'string') throw new Error('提示词正文无效')
  if (!input.trim()) throw new Error('提示词正文不能为空')
  if (input.length > MAX_PROMPT_LENGTH) throw new Error(`提示词正文不能超过 ${MAX_PROMPT_LENGTH} 个字符`)
  return input
}

export function normalizePromptTags(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error('提示词标签无效')
  const tags: string[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (typeof raw !== 'string') throw new Error('提示词标签无效')
    const tag = raw.trim()
    if (!tag) throw new Error('提示词标签不能为空')
    if (tag.length > MAX_PROMPT_TAG_LENGTH) throw new Error(`提示词标签不能超过 ${MAX_PROMPT_TAG_LENGTH} 个字符`)
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
    if (tags.length > MAX_PROMPT_TAGS) throw new Error(`提示词标签不能超过 ${MAX_PROMPT_TAGS} 个`)
  }
  return tags
}

export function normalizePromptPinned(input: unknown): boolean {
  if (typeof input !== 'boolean') throw new Error('提示词置顶状态无效')
  return input
}

export function normalizePromptId(input: unknown): string {
  if (typeof input !== 'string' || !UUID_PATTERN.test(input)) throw new Error('提示词编号无效')
  return input.toLowerCase()
}

export function normalizePromptInput(input: unknown): PromptInput {
  if (!isRecord(input)) throw new Error('提示词参数无效')
  assertKeys(input, INPUT_KEYS, '提示词参数')
  return {
    title: normalizePromptTitle(input.title),
    text: normalizePromptText(input.text),
    tags: normalizePromptTags(input.tags),
    pinned: normalizePromptPinned(input.pinned)
  }
}

export function normalizePromptUpdate(input: unknown): PromptUpdate {
  if (!isRecord(input)) throw new Error('提示词参数无效')
  assertKeys(input, UPDATE_KEYS, '提示词参数')
  return {
    id: normalizePromptId(input.id),
    ...normalizePromptInput({ title: input.title, text: input.text, tags: input.tags, pinned: input.pinned })
  }
}

function normalizeIsoTimestamp(input: unknown, label: string): string {
  if (typeof input !== 'string') throw new Error(`${label}无效`)
  const parsed = new Date(input)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== input) throw new Error(`${label}无效`)
  return input
}

export function normalizePromptItem(input: unknown): PromptItem {
  if (!isRecord(input)) throw new Error('提示词数据无效')
  assertKeys(input, ITEM_KEYS, '提示词数据')
  return {
    id: normalizePromptId(input.id),
    title: normalizePromptTitle(input.title),
    text: normalizePromptText(input.text),
    tags: normalizePromptTags(input.tags),
    pinned: normalizePromptPinned(input.pinned),
    createdAt: normalizeIsoTimestamp(input.createdAt, '提示词创建时间'),
    updatedAt: normalizeIsoTimestamp(input.updatedAt, '提示词更新时间')
  }
}
