import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { defaultEngineConfig, normalizeEngineData } from '../../shared/tasks/validate.js'
import type { TaskEngineConfig, TaskEngineData, TaskDecision, TaskRun, Task } from '../../shared/tasks/types.js'

interface StoreFile {
  version: 1
  config: TaskEngineConfig
  tasks: Task[]
  decisions: TaskDecision[]
  runs: TaskRun[]
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined
}

export interface TaskStoreOptions {
  file: string
  now?: () => Date
}

/** Atomic JSON persistence for tasks, decisions and run metadata. */
export class TaskStore {
  private readonly file: string
  private readonly now: () => Date
  private content: string | null = null
  private data: TaskEngineData
  private loadError: Error | null = null

  constructor(options: TaskStoreOptions) {
    if (typeof options.file !== 'string' || !options.file.trim()) throw new Error('任务数据路径无效')
    this.file = options.file
    this.now = options.now ?? (() => new Date())
    this.data = {
      version: 1,
      config: defaultEngineConfig(),
      tasks: [],
      decisions: [],
      runs: []
    }
    try {
      this.load()
    } catch (error) {
      this.loadError = error instanceof Error && /[㐀-鿿]/u.test(error.message)
        ? error
        : new Error('任务数据文件损坏，已保留原文件')
    }
  }

  private assertLoaded(): void {
    if (this.loadError) throw this.loadError
  }

  loadErrorValue(): Error | null {
    return this.loadError
  }

  getData(): TaskEngineData {
    this.assertLoaded()
    return structuredClone(this.data)
  }

  config(): TaskEngineConfig {
    this.assertLoaded()
    return { ...this.data.config }
  }

  save(data: TaskEngineData): void {
    this.assertLoaded()
    const content = JSON.stringify({
      version: 1,
      config: data.config,
      tasks: data.tasks,
      decisions: data.decisions,
      runs: data.runs
    } satisfies StoreFile, null, 2) + '\n'
    this.assertDiskUnchanged()
    const directory = path.dirname(this.file)
    const temporary = path.join(directory, `.${path.basename(this.file)}.${randomUUID()}.tmp`)
    let handle: number | null = null
    let ownsTemporary = false
    try {
      mkdirSync(directory, { recursive: true })
      handle = openSync(temporary, 'wx', 0o600)
      ownsTemporary = true
      writeFileSync(handle, content, 'utf8')
      closeSync(handle)
      handle = null
      renameSync(temporary, this.file)
      ownsTemporary = false
    } catch {
      if (handle !== null) {
        try { closeSync(handle) } catch { /* best effort */ }
      }
      if (ownsTemporary) {
        try { unlinkSync(temporary) } catch { /* no temporary file remains */ }
      }
      throw new Error('任务数据保存失败，原数据未变更')
    }
    this.content = content
    this.data = structuredClone(data)
  }

  private load(): void {
    const current = this.readFile()
    if (current === null) return
    const parsed = normalizeEngineData(JSON.parse(current))
    this.data = { version: 1, ...parsed }
    this.content = current
  }

  private readFile(): string | null {
    try {
      return readFileSync(this.file, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null
      throw new Error('任务数据读取失败')
    }
  }

  private assertDiskUnchanged(): void {
    const current = this.readFile()
    if (current === this.content) return
    if (current === null) throw new Error('任务数据文件已被移除，已拒绝覆盖')
    try {
      normalizeEngineData(JSON.parse(current))
    } catch {
      throw new Error('任务数据文件已损坏或被外部修改，已拒绝覆盖')
    }
    throw new Error('任务数据文件已被外部修改，已拒绝覆盖')
  }

  nowIso(): string {
    const value = this.now()
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('任务时间无效')
    return value.toISOString()
  }
}
