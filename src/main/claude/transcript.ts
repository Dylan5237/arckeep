import { open, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ClaudeSession, ClaudeSessionMessage, ClaudeSessionTranscript } from '../../shared/claude-sessions.js'
import { normalizeClaudeSessionId } from '../../shared/claude-sessions.js'

const MAX_TRANSCRIPT_BYTES = 1024 * 1024
const MAX_MESSAGES = 120
const MAX_MESSAGE_TEXT = 6000

export function claudeProjectDirectoryName(cwd: string): string {
  const resolved = path.resolve(cwd)
  const slug = resolved.replace(/[^a-zA-Z0-9]/g, '-')
  if (slug.length <= 200) return slug
  let hash = 0
  for (let index = 0; index < resolved.length; index += 1) {
    hash = (Math.imul(hash, 31) + resolved.charCodeAt(index)) | 0
  }
  return slug.slice(0, 200) + '-' + Math.abs(hash).toString(36)
}

export function claudeTranscriptPath(configDirectory: string, session: ClaudeSession): string {
  const id = normalizeClaudeSessionId(session.id)
  return path.join(configDirectory, 'projects', claudeProjectDirectoryName(session.cwd), id + '.jsonl')
}

function textParts(content: unknown): { text: string, tools: string[] } {
  if (typeof content === 'string') return { text: content, tools: [] }
  if (!Array.isArray(content)) return { text: '', tools: [] }
  const texts: string[] = []
  const tools: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const item = part as Record<string, unknown>
    if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text)
    if (item.type === 'tool_use' && typeof item.name === 'string') tools.push(item.name)
  }
  return { text: texts.join('\n').trim(), tools }
}

function recordsFromTail(contents: string, fileTruncated: boolean): { messages: ClaudeSessionMessage[], truncated: boolean } {
  const lines = contents.split(/\r?\n/)
  if (fileTruncated) lines.shift()
  if (lines.at(-1) === '') lines.pop()
  const messages: ClaudeSessionMessage[] = []
  let truncated = fileTruncated
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { continue }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const record = parsed as Record<string, unknown>
    if (record.isSidechain === true) continue
    if (record.type !== 'user' && record.type !== 'assistant') continue
    if (!record.message || typeof record.message !== 'object' || Array.isArray(record.message)) continue
    const message = record.message as Record<string, unknown>
    const parts = textParts(message.content)
    const role = record.type
    const text = role === 'assistant' && parts.tools.length > 0
      ? [parts.text, ...parts.tools.map(name => '调用工具：' + name)].filter(Boolean).join('\n')
      : parts.text
    if (!text) continue
    if (text.length > MAX_MESSAGE_TEXT) truncated = true
    messages.push({
      id: typeof record.uuid === 'string' ? record.uuid.slice(0, 120) : 'message-' + index,
      role,
      text: text.slice(0, MAX_MESSAGE_TEXT),
      at: typeof record.timestamp === 'string' && Number.isFinite(Date.parse(record.timestamp))
        ? new Date(record.timestamp).toISOString()
        : null
    })
  }
  if (messages.length > MAX_MESSAGES) truncated = true
  return { messages: messages.slice(-MAX_MESSAGES), truncated }
}

export async function readClaudeTranscript(
  session: ClaudeSession,
  configDirectory = path.join(os.homedir(), '.claude')
): Promise<ClaudeSessionTranscript> {
  const file = claudeTranscriptPath(configDirectory, session)
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(file, 'r')
    const info = await handle.stat()
    const start = Math.max(0, info.size - MAX_TRANSCRIPT_BYTES)
    const length = info.size - start
    const buffer = Buffer.alloc(length)
    if (length > 0) await handle.read(buffer, 0, length, start)
    const parsed = recordsFromTail(buffer.toString('utf8'), start > 0)
    return {
      session: { ...session },
      messages: parsed.messages,
      updatedAt: info.mtime.toISOString(),
      truncated: parsed.truncated
    }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : ''
    if (code === 'ENOENT') {
      return { session: { ...session }, messages: [], updatedAt: null, truncated: false }
    }
    throw new Error('无法读取 Claude 会话记录')
  } finally {
    await handle?.close()
  }
}

export async function canonicalDirectory(input: string): Promise<string> {
  let resolved: string
  try {
    resolved = await realpath(input)
    const details = await stat(resolved)
    if (!details.isDirectory()) throw new Error('所选路径不是目录')
  } catch {
    throw new Error('项目目录不存在或不可访问')
  }
  return resolved
}

