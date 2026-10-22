import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { normalizeClaudeRepo, normalizeClaudeSessionId, type ClaudeSession, type ClaudeWorkspace } from '../../shared/claude-sessions.js'

const DATA_VERSION = 1
const MAX_SESSIONS = 500

interface SessionFile {
  version: 1
  workspaces: ClaudeWorkspace[]
  sessions: ClaudeSession[]
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Claude 会话时间无效')
  return new Date(value).toISOString()
}

function normalizeWorkspace(input: unknown): ClaudeWorkspace {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Claude 项目目录数据无效')
  const value = input as Record<string, unknown>
  const repo = normalizeClaudeRepo(value.repo)
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200) throw new Error('Claude 项目名称无效')
  if (typeof value.path !== 'string' || !value.path.trim() || value.path.length > 2000) throw new Error('Claude 项目目录无效')
  return { repo, name: value.name.trim(), path: path.resolve(value.path), updatedAt: timestamp(value.updatedAt) }
}

function normalizeSession(input: unknown): ClaudeSession {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Claude 会话数据无效')
  const value = input as Record<string, unknown>
  const repo = normalizeClaudeRepo(value.repo)
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200) throw new Error('Claude 项目名称无效')
  if (typeof value.cwd !== 'string' || !value.cwd.trim() || value.cwd.length > 2000) throw new Error('Claude 会话目录无效')
  return {
    id: normalizeClaudeSessionId(value.id),
    repo,
    name: value.name.trim(),
    cwd: path.resolve(value.cwd),
    startedAt: timestamp(value.startedAt)
  }
}

function parseFile(content: string): SessionFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('Claude 会话索引损坏，原文件已保留')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Claude 会话索引格式无效，原文件已保留')
  const value = parsed as Record<string, unknown>
  if (value.version !== DATA_VERSION || Object.keys(value).some(key => !['version', 'workspaces', 'sessions'].includes(key))) {
    throw new Error('Claude 会话索引版本或格式不支持，原文件已保留')
  }
  if (!Array.isArray(value.workspaces) || !Array.isArray(value.sessions) || value.sessions.length > MAX_SESSIONS) {
    throw new Error('Claude 会话索引格式无效，原文件已保留')
  }
  try {
    const workspaces = value.workspaces.map(normalizeWorkspace)
    const sessions = value.sessions.map(normalizeSession)
    if (new Set(workspaces.map(item => item.repo.toLowerCase())).size !== workspaces.length) throw new Error('duplicate workspace')
    if (new Set(sessions.map(item => item.id)).size !== sessions.length) throw new Error('duplicate session')
    return { version: DATA_VERSION, workspaces, sessions }
  } catch {
    throw new Error('Claude 会话索引格式无效，原文件已保留')
  }
}

export interface ClaudeSessionStoreOptions {
  file: string
  now?: () => Date
  id?: () => string
}

/** Persists project bindings and launch metadata; transcript content remains in Claude's own files. */
export class ClaudeSessionStore {
  private readonly file: string
  private readonly now: () => Date
  private readonly makeId: () => string
  private data: SessionFile = { version: DATA_VERSION, workspaces: [], sessions: [] }
  private diskSnapshot: string | null = null
  private loadError: Error | null = null

  constructor(options: ClaudeSessionStoreOptions) {
    if (!options.file.trim()) throw new Error('Claude 会话索引路径无效')
    this.file = options.file
    this.now = options.now ?? (() => new Date())
    this.makeId = options.id ?? randomUUID
    try {
      const content = this.readFile()
      if (content !== null) {
        this.data = parseFile(content)
        this.diskSnapshot = content
      }
    } catch (error) {
      this.loadError = error instanceof Error ? error : new Error('Claude 会话索引读取失败')
    }
  }

  list(repo?: unknown): ClaudeSession[] {
    this.assertLoaded()
    const filter = repo === undefined ? null : normalizeClaudeRepo(repo).toLowerCase()
    return this.data.sessions
      .filter(item => filter === null || item.repo.toLowerCase() === filter)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(item => ({ ...item }))
  }

  find(id: unknown): ClaudeSession | null {
    this.assertLoaded()
    const key = normalizeClaudeSessionId(id)
    const item = this.data.sessions.find(session => session.id === key)
    return item ? { ...item } : null
  }

  workspace(repo: unknown): ClaudeWorkspace | null {
    this.assertLoaded()
    const key = normalizeClaudeRepo(repo).toLowerCase()
    const item = this.data.workspaces.find(workspace => workspace.repo.toLowerCase() === key)
    return item ? { ...item } : null
  }

  setWorkspace(input: { repo: unknown, name: unknown, path: unknown }): ClaudeWorkspace {
    this.assertLoaded()
    const item = normalizeWorkspace({ ...input, updatedAt: this.timestamp() })
    const next = this.data.workspaces.filter(workspace => workspace.repo.toLowerCase() !== item.repo.toLowerCase())
    next.push(item)
    this.persist({ ...this.data, workspaces: next })
    return { ...item }
  }

  createSession(input: { repo: unknown, name: unknown, cwd: unknown }): ClaudeSession {
    this.assertLoaded()
    let id = normalizeClaudeSessionId(this.makeId())
    while (this.data.sessions.some(item => item.id === id)) id = normalizeClaudeSessionId(this.makeId())
    const item = normalizeSession({ ...input, id, startedAt: this.timestamp() })
    const sessions = [...this.data.sessions, item].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, MAX_SESSIONS)
    this.persist({ ...this.data, sessions })
    return { ...item }
  }

  removeSession(id: unknown): void {
    this.assertLoaded()
    const key = normalizeClaudeSessionId(id)
    const next = this.data.sessions.filter(item => item.id !== key)
    if (next.length !== this.data.sessions.length) this.persist({ ...this.data, sessions: next })
  }

  private timestamp(): string {
    const value = this.now()
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Claude 会话时间无效')
    return value.toISOString()
  }

  private assertLoaded(): void {
    if (this.loadError) throw this.loadError
  }

  private readFile(): string | null {
    try {
      return readFileSync(this.file, 'utf8')
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null
      throw new Error('Claude 会话索引读取失败')
    }
  }

  private assertUnchanged(): void {
    const current = this.readFile()
    if (current === this.diskSnapshot) return
    if (current !== null) parseFile(current)
    throw new Error('Claude 会话索引已被外部修改，已拒绝覆盖')
  }

  private persist(data: SessionFile): void {
    this.assertUnchanged()
    const content = JSON.stringify(data, null, 2) + '\n'
    const directory = path.dirname(this.file)
    const temporary = path.join(directory, '.' + path.basename(this.file) + '.' + randomUUID() + '.tmp')
    let handle: number | null = null
    let ownsTemporary = false
    try {
      mkdirSync(directory, { recursive: true })
      handle = openSync(temporary, 'wx', 0o600)
      ownsTemporary = true
      writeFileSync(handle, content, 'utf8')
      closeSync(handle)
      handle = null
      try {
        this.assertUnchanged()
      } catch (error) {
        if (error instanceof Error && error.message.includes('外部修改')) throw error
        throw error
      }
      renameSync(temporary, this.file)
      ownsTemporary = false
    } catch (error) {
      if (handle !== null) {
        try { closeSync(handle) } catch { /* best-effort cleanup */ }
      }
      if (ownsTemporary) {
        try { unlinkSync(temporary) } catch { /* best-effort cleanup */ }
      }
      if (error instanceof Error && error.message.includes('外部修改')) throw error
      throw new Error('Claude 会话索引保存失败，原文件未变更')
    }
    this.data = data
    this.diskSnapshot = content
  }
}

