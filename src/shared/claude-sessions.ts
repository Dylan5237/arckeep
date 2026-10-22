export interface ClaudeWorkspace {
  repo: string
  name: string
  path: string
  updatedAt: string
}

export interface ClaudeSession {
  id: string
  repo: string
  name: string
  cwd: string
  startedAt: string
}

export interface ClaudeSessionMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  at: string | null
}

export interface ClaudeSessionTranscript {
  session: ClaudeSession
  messages: ClaudeSessionMessage[]
  updatedAt: string | null
  truncated: boolean
}

export function normalizeClaudeRepo(input: unknown): string {
  if (typeof input !== 'string') throw new Error('仓库标识无效')
  const value = input.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error('仓库标识无效')
  return value
}

export function normalizeClaudeSessionId(input: unknown): string {
  if (typeof input !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) {
    throw new Error('Claude 会话编号无效')
  }
  return input.toLowerCase()
}

