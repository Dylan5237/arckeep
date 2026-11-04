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
  /** Where the session came from. Arckeep sessions are resumable through the store. */
  source?: 'arckeep' | 'local'
  /** Last transcript write, used to sort local sessions. */
  updatedAt?: string | null
  /** First user message, for local sessions that Arckeep did not start. */
  title?: string | null
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

/** Parses a git origin URL into owner/repo. Returns null for non-GitHub remotes. */
export function parseGithubRemote(remote: string): string | null {
  const value = remote.trim()
  let repoPath: string
  const scp = value.match(/^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/i)
  if (scp) {
    repoPath = scp[1]
  } else {
    let parsed: URL
    try { parsed = new URL(value) } catch { return null }
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol.toLowerCase())) return null
    if (parsed.hostname.toLowerCase() !== 'github.com' || parsed.search || parsed.hash) return null
    repoPath = parsed.pathname.replace(/^\/+|\/+$/g, '')
  }
  repoPath = repoPath.replace(/\.git$/i, '')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoPath)) return null
  return repoPath
}

