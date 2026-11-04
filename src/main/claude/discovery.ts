import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { normalizeClaudeSessionId } from '../../shared/claude-sessions.js'

const HEAD_BYTES = 256 * 1024
const DEFAULT_LIMIT = 400
const CACHE_LIMIT = 1200

export interface LocalClaudeSession {
  id: string
  cwd: string
  startedAt: string
  updatedAt: string
  title: string | null
  file: string
}

interface CachedFile {
  mtimeMs: number
  size: number
  value: LocalClaudeSession | null
}

const fileCache = new Map<string, CachedFile>()

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const item = part as Record<string, unknown>
    if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text)
  }
  return texts.join('\n').trim()
}

function titleFrom(text: string): string | null {
  const value = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  if (!value) return null
  if (/^(?:Caveat:|<local-command|<command-name|Tool result)/i.test(value)) return null
  return value.slice(0, 140)
}

async function parseFile(file: string, size: number): Promise<LocalClaudeSession | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(file, 'r')
    const length = Math.min(size, HEAD_BYTES)
    const buffer = Buffer.alloc(length)
    if (length > 0) await handle.read(buffer, 0, length, 0)
    const lines = buffer.toString('utf8').split(/\r?\n/)
    if (length < size) lines.pop()
    let cwd: string | null = null
    let sessionId: string | null = null
    let startedAt: string | null = null
    let title: string | null = null
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('{')) continue
      let record: Record<string, unknown>
      try {
        record = JSON.parse(trimmed) as Record<string, unknown>
      } catch {
        continue
      }
      if (!sessionId && typeof record.sessionId === 'string') {
        try { sessionId = normalizeClaudeSessionId(record.sessionId) } catch { /* keep filename id */ }
      }
      if (!cwd && typeof record.cwd === 'string' && record.cwd.trim()) cwd = record.cwd.trim()
      if (!startedAt && typeof record.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp))) {
        startedAt = new Date(record.timestamp).toISOString()
      }
      if (!title && record.type === 'user' && record.message && typeof record.message === 'object' && !Array.isArray(record.message)) {
        const content = (record.message as Record<string, unknown>).content
        const text = textFromContent(content)
        title = titleFrom(text)
      }
      if (cwd && title && startedAt) break    }
    if (!cwd) return null
    const id = sessionId ?? normalizeClaudeSessionId(path.basename(file, '.jsonl'))
    const info = await stat(file)
    return {
      id,
      cwd: path.resolve(cwd),
      startedAt: startedAt ?? info.birthtime.toISOString(),
      updatedAt: info.mtime.toISOString(),
      title,
      file
    }
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}

async function cachedParse(file: string, mtimeMs: number, size: number): Promise<LocalClaudeSession | null> {
  const cached = fileCache.get(file)
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.value
  const value = await parseFile(file, size)
  if (fileCache.size > CACHE_LIMIT) fileCache.clear()
  fileCache.set(file, { mtimeMs, size, value })
  return value
}

export interface DiscoverOptions {
  configDirectory: string
  limit?: number
}

/**
 * Reads Claude Code's own project transcripts so Arckeep can show sessions it
 * did not start. Only the first 256 KiB of each file is inspected; transcript
 * content stays in Claude's directory and is never copied.
 */
export async function discoverLocalClaudeSessions(options: DiscoverOptions): Promise<LocalClaudeSession[]> {
  const projectsDir = path.join(options.configDirectory, 'projects')
  const limit = options.limit ?? DEFAULT_LIMIT
  let directories: string[]
  try {
    directories = (await readdir(projectsDir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(projectsDir, entry.name))
  } catch {
    return []
  }
  const files: Array<{ file: string, mtimeMs: number, size: number }> = []
  for (const directory of directories) {
    let entries: string[]
    try {
      entries = (await readdir(directory)).filter(name => name.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const name of entries) {
      const base = name.slice(0, -'.jsonl'.length)
      try { normalizeClaudeSessionId(base) } catch { continue }
      const file = path.join(directory, name)
      try {
        const info = await stat(file)
        if (!info.isFile() || info.size < 16) continue
        files.push({ file, mtimeMs: info.mtimeMs, size: info.size })
      } catch {
        continue
      }
    }
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs)
  const sessions: LocalClaudeSession[] = []
  const seen = new Set<string>()
  for (const entry of files.slice(0, limit * 2)) {
    if (sessions.length >= limit) break
    const session = await cachedParse(entry.file, entry.mtimeMs, entry.size)
    if (!session || seen.has(session.id)) continue
    seen.add(session.id)
    sessions.push(session)
  }
  return sessions
}
