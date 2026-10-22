import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { PromptItem } from '../../shared/prompts/types.js'
import {
  normalizePromptId,
  normalizePromptInput,
  normalizePromptItem,
  normalizePromptPinned,
  normalizePromptUpdate
} from '../../shared/prompts/validate.js'

const DATA_VERSION = 1

export interface PromptStoreOptions {
  file: string
  now?: () => Date
  id?: () => string
}

interface PromptFile {
  version: 1
  items: PromptItem[]
}

function copyItem(item: PromptItem): PromptItem {
  return { ...item, tags: [...item.tags] }
}

function parsePromptFile(content: string): PromptItem[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('提示词数据文件损坏，已保留原文件')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('提示词数据文件格式无效，已保留原文件')
  }

  const record = parsed as Record<string, unknown>
  if (record.version !== DATA_VERSION) throw new Error('提示词数据文件版本不支持，已保留原文件')
  if (Object.keys(record).some(key => key !== 'version' && key !== 'items')) {
    throw new Error('提示词数据文件格式无效，已保留原文件')
  }
  if (!Array.isArray(record.items)) throw new Error('提示词数据文件格式无效，已保留原文件')

  try {
    const items = record.items.map(normalizePromptItem)
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('duplicate id')
    return items
  } catch {
    throw new Error('提示词数据文件格式无效，已保留原文件')
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined
}

export class PromptStore {
  private items: PromptItem[] = []
  private diskSnapshot: string | null = null
  private loadError: Error | null = null
  private readonly file: string
  private readonly now: () => Date
  private readonly id: () => string

  constructor(options: PromptStoreOptions) {
    if (typeof options.file !== 'string' || !options.file.trim()) throw new Error('提示词文件路径无效')
    this.file = options.file
    this.now = options.now ?? (() => new Date())
    this.id = options.id ?? randomUUID
    try {
      this.load()
    } catch (error) {
      this.loadError = error instanceof Error ? error : new Error('提示词数据文件读取失败')
    }
  }

  list(): PromptItem[] {
    this.assertLoaded()
    return this.items.map(copyItem)
  }

  create(input: unknown): PromptItem {
    this.assertLoaded()
    const draft = normalizePromptInput(input)
    const id = this.newId()
    if (this.items.some(item => item.id === id)) throw new Error('提示词编号重复')
    const createdAt = this.timestamp()
    const item: PromptItem = { id, ...draft, createdAt, updatedAt: createdAt }
    this.persist([...this.items, item])
    return copyItem(item)
  }

  update(input: unknown): PromptItem {
    this.assertLoaded()
    const patch = normalizePromptUpdate(input)
    const index = this.items.findIndex(item => item.id === patch.id)
    if (index < 0) throw new Error('提示词不存在')
    const item: PromptItem = { ...this.items[index], ...patch, updatedAt: this.timestamp() }
    const next = [...this.items]
    next[index] = item
    this.persist(next)
    return copyItem(item)
  }

  delete(id: unknown): { id: string } {
    this.assertLoaded()
    const promptId = normalizePromptId(id)
    const index = this.items.findIndex(item => item.id === promptId)
    if (index < 0) throw new Error('提示词不存在')
    const next = [...this.items]
    next.splice(index, 1)
    this.persist(next)
    return { id: promptId }
  }

  setPinned(id: unknown, pinned: unknown): PromptItem {
    this.assertLoaded()
    const promptId = normalizePromptId(id)
    const nextPinned = normalizePromptPinned(pinned)
    const index = this.items.findIndex(item => item.id === promptId)
    if (index < 0) throw new Error('提示词不存在')
    const item: PromptItem = { ...this.items[index], pinned: nextPinned, updatedAt: this.timestamp() }
    const next = [...this.items]
    next[index] = item
    this.persist(next)
    return copyItem(item)
  }

  private load(): void {
    const content = this.readFile()
    if (content === null) return
    this.items = parsePromptFile(content)
    this.diskSnapshot = content
  }

  private assertLoaded(): void {
    if (this.loadError) throw this.loadError
  }

  private readFile(): string | null {
    try {
      return readFileSync(this.file, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null
      throw new Error('提示词数据文件读取失败')
    }
  }

  private timestamp(): string {
    try {
      const date = this.now()
      if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error('invalid date')
      return date.toISOString()
    } catch {
      throw new Error('提示词时间无效')
    }
  }

  private newId(): string {
    let value: string
    try {
      value = this.id()
    } catch {
      throw new Error('提示词编号生成失败')
    }
    return normalizePromptId(value)
  }

  private assertDiskUnchanged(): void {
    const current = this.readFile()
    if (current === this.diskSnapshot) return
    if (current === null) throw new Error('提示词数据文件已被移除，已拒绝覆盖')
    parsePromptFile(current)
    throw new Error('提示词数据文件已被外部修改，已拒绝覆盖')
  }

  private persist(items: PromptItem[]): void {
    this.assertDiskUnchanged()
    const content = `${JSON.stringify({ version: DATA_VERSION, items } satisfies PromptFile, null, 2)}\n`
    const directory = path.dirname(this.file)
    const temporary = path.join(directory, `.${path.basename(this.file)}.${randomUUID()}.tmp`)
    let handle: number | null = null
    let ownsTemporary = false
    let conflict: Error | null = null
    try {
      mkdirSync(directory, { recursive: true })
      handle = openSync(temporary, 'wx', 0o600)
      ownsTemporary = true
      writeFileSync(handle, content, 'utf8')
      closeSync(handle)
      handle = null
      // Recheck immediately before replacing the destination, after preparing
      // the temporary file, so an intervening external write is not accepted.
      try {
        this.assertDiskUnchanged()
      } catch (error) {
        conflict = error instanceof Error ? error : new Error('提示词数据文件读取失败')
        throw conflict
      }
      renameSync(temporary, this.file)
      ownsTemporary = false
    } catch {
      if (handle !== null) {
        try { closeSync(handle) } catch { /* best-effort cleanup */ }
      }
      if (ownsTemporary) {
        try { unlinkSync(temporary) } catch { /* best-effort cleanup */ }
      }
      throw conflict ?? new Error('提示词保存失败，原数据未变更')
    }

    this.items = items
    this.diskSnapshot = content
  }
}
