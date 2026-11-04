import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import { normalizeClaudeRepo, normalizeClaudeSessionId, parseGithubRemote, type ClaudeSession, type ClaudeSessionTranscript, type ClaudeWorkspace } from '../../shared/claude-sessions.js'
import { ClaudeSessionStore } from './session-store.js'
import { readClaudeTranscript, readClaudeTranscriptAt, canonicalDirectory } from './transcript.js'
import { discoverLocalClaudeSessions, type LocalClaudeSession } from './discovery.js'
import { projectIdentities } from './project-map.js'

const execFileAsync = promisify(execFile)
const TERMINAL_START_GRACE_MS = 10_000

export function repoSlugFromRemote(remote: string): string | null {
  return parseGithubRemote(remote)?.toLowerCase() ?? null
}

export async function verifyClaudeWorkspace(input: string, expectedRepo: string): Promise<string> {
  const selected = await canonicalDirectory(input)
  let root: string
  let remote: string
  try {
    const rootResult = await execFileAsync('git', ['-C', selected, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4096
    })
    root = await canonicalDirectory(rootResult.stdout.trim())
    const remoteResult = await execFileAsync('git', ['-C', root, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4096
    })
    remote = remoteResult.stdout.trim()
  } catch {
    throw new Error('所选目录不是有效的 GitHub 仓库，请选择该项目的仓库或 worktree')
  }
  const actualRepo = repoSlugFromRemote(remote)
  if (!actualRepo || actualRepo !== normalizeClaudeRepo(expectedRepo).toLowerCase()) {
    throw new Error('所选目录的 origin 与当前项目不匹配，请检查目录后重试')
  }
  return root
}

export interface ClaudeSessionServiceOptions {
  store: ClaudeSessionStore
  chooseDirectory: (repo: string, name: string) => Promise<string | null>
  linkedDirectories: (repo: string) => readonly string[]
  activate?: (input: { repo: string, cwd: string, sessionId: string }) => Promise<boolean>
  launch: (input: { repo: string, cwd: string, sessionId: string, resume: boolean }) => Promise<void>
  verifyDirectory?: (path: string, repo: string) => Promise<string>
  configDirectory?: string
  now?: () => number
  discoverLocal?: (configDirectory: string) => Promise<LocalClaudeSession[]>
}

function directoryKey(value: string): string {
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    return path.win32.normalize(path.win32.resolve(value)).toLowerCase()
  }
  return path.resolve(value).toLowerCase()
}

export class ClaudeSessionService {
  private readonly verifyDirectory: (path: string, repo: string) => Promise<string>
  private readonly configDirectory: string
  private readonly now: () => number
  private readonly starts = new Map<string, Promise<ClaudeSession>>()
  private readonly workspaceStarts = new Map<string, Promise<void>>()
  private readonly launches = new Map<string, Promise<void>>()
  private readonly recentlyLaunched = new Map<string, number>()
  private localCache: { at: number, value: LocalClaudeSession[] } | null = null

  constructor(private readonly options: ClaudeSessionServiceOptions) {
    this.verifyDirectory = options.verifyDirectory ?? verifyClaudeWorkspace
    this.configDirectory = options.configDirectory
      ? path.resolve(options.configDirectory)
      : process.env.CLAUDE_CONFIG_DIR
        ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
        : path.join(os.homedir(), '.claude')
    this.now = options.now ?? Date.now
  }

  async list(repo?: unknown): Promise<ClaudeSession[]> {
    const filter = repo === undefined || repo === null || repo === ''
      ? null
      : normalizeClaudeRepo(repo).toLowerCase()
    const stored = this.options.store.list().map(item => ({
      ...item,
      source: 'arckeep' as const,
      updatedAt: item.startedAt,
      title: null
    }))
    const local = await this.localSessions()
    const storedIds = new Set(stored.map(item => item.id))
    const candidates = local.filter(item => !storedIds.has(item.id))
    const workspaceByPath = new Map(this.options.store.workspaces()
      .map(item => [directoryKey(item.path), item] as const))
    const identities = await projectIdentities([...new Set(candidates.map(item => item.cwd))])
    const merged: ClaudeSession[] = [...stored]
    for (const item of candidates) {
      const workspace = workspaceByPath.get(directoryKey(item.cwd))
      const identity = workspace
        ? { repo: workspace.repo, name: workspace.name }
        : identities.get(item.cwd) ?? { repo: 'local/project', name: path.basename(item.cwd) }
      merged.push({
        id: item.id,
        cwd: item.cwd,
        repo: identity.repo,
        name: identity.name,
        startedAt: item.startedAt,
        source: 'local',
        updatedAt: item.updatedAt,
        title: item.title
      })
    }
    return merged
      .filter(item => filter === null || item.repo.toLowerCase() === filter)
      .sort((left, right) => (right.updatedAt ?? right.startedAt).localeCompare(left.updatedAt ?? left.startedAt))
  }

  private async localSessions(): Promise<LocalClaudeSession[]> {
    const now = this.now()
    if (this.localCache && now - this.localCache.at < 15_000) return this.localCache.value
    try {
      const discover = this.options.discoverLocal
        ?? ((directory: string) => discoverLocalClaudeSessions({ configDirectory: directory }))
      const value = await discover(this.configDirectory)
      this.localCache = { at: now, value }
      return value
    } catch {
      this.localCache = { at: now, value: [] }
      return []
    }
  }

  async chooseWorkspace(repoInput: unknown, nameInput: unknown): Promise<ClaudeWorkspace> {
    const repo = normalizeClaudeRepo(repoInput)
    const name = this.normalizeName(nameInput, repo)
    const selected = await this.options.chooseDirectory(repo, name)
    if (!selected) throw new Error('已取消选择项目目录')
    const cwd = await this.verifyDirectory(selected, repo)
    return this.options.store.setWorkspace({ repo, name, path: cwd })
  }

  async start(repoInput: unknown, nameInput: unknown, resumeInput?: unknown): Promise<ClaudeSession> {
    const repo = normalizeClaudeRepo(repoInput)
    const name = this.normalizeName(nameInput, repo)
    const resumeId = resumeInput === undefined ? null : normalizeClaudeSessionId(resumeInput)
    const operationKey = resumeId ? 'session:' + resumeId : 'project:' + repo.toLowerCase()
    const pending = this.starts.get(operationKey)
    if (pending) return pending
    const operation = this.startOnce(repo, name, resumeId)
    this.starts.set(operationKey, operation)
    try {
      return await operation
    } finally {
      if (this.starts.get(operationKey) === operation) this.starts.delete(operationKey)
    }
  }

  private async startOnce(repo: string, name: string, resumeId: string | null): Promise<ClaudeSession> {
    const previous = resumeId ? this.options.store.find(resumeId) : null
    if (resumeId && (!previous || previous.repo.toLowerCase() !== repo.toLowerCase())) {
      throw new Error('找不到该项目的 Claude 会话')
    }

    let cwd: string
    if (previous) {
      cwd = await this.verifyDirectory(previous.cwd, repo)
    } else {
      const saved = this.options.store.workspace(repo)
      const linked = [...new Set(this.options.linkedDirectories(repo).map(item => path.resolve(item)))]
      let candidate = saved?.path ?? (linked.length === 1 ? linked[0] : null)
      if (!candidate) candidate = await this.options.chooseDirectory(repo, name) ?? null
      if (!candidate) throw new Error('已取消选择项目目录')
      cwd = await this.verifyDirectory(candidate, repo)
      this.options.store.setWorkspace({ repo, name, path: cwd })
    }

    const workspaceKey = directoryKey(cwd)
    const previousStart = this.workspaceStarts.get(workspaceKey)
    let release!: () => void
    const currentStart = new Promise<void>(resolve => { release = resolve })
    this.workspaceStarts.set(workspaceKey, currentStart)
    try {
      if (previousStart) await previousStart
      return await this.startInWorkspace(repo, name, cwd, previous)
    } finally {
      release()
      if (this.workspaceStarts.get(workspaceKey) === currentStart) this.workspaceStarts.delete(workspaceKey)
    }
  }

  private async startInWorkspace(
    repo: string,
    name: string,
    cwd: string,
    previous: ClaudeSession | null
  ): Promise<ClaudeSession> {
    const workspaceKey = directoryKey(cwd)
    const existing = this.options.store.list(repo)
      .filter(item => directoryKey(item.cwd) === workspaceKey)
      .sort((left, right) => (this.recentlyLaunched.get(right.id) ?? 0) - (this.recentlyLaunched.get(left.id) ?? 0))
    if (previous) {
      const pendingLaunch = this.launches.get(previous.id)
      if (pendingLaunch) {
        await pendingLaunch
        return previous
      }
      const launchedAt = this.recentlyLaunched.get(previous.id)
      if (launchedAt !== undefined && this.now() - launchedAt < TERMINAL_START_GRACE_MS) return previous
      if (await this.activate(previous)) return previous

      for (const session of existing) {
        if (session.id === previous.id) continue
        const otherPendingLaunch = this.launches.get(session.id)
        if (otherPendingLaunch) {
          await otherPendingLaunch
          throw this.workspaceSessionConflict()
        }
        const otherLaunchedAt = this.recentlyLaunched.get(session.id)
        if (otherLaunchedAt !== undefined && this.now() - otherLaunchedAt < TERMINAL_START_GRACE_MS) {
          throw this.workspaceSessionConflict()
        }
        if (await this.activate(session)) throw this.workspaceSessionConflict()
      }
    } else {
      for (const session of existing) {
        const pendingLaunch = this.launches.get(session.id)
        if (pendingLaunch) {
          await pendingLaunch
          return session
        }
        const launchedAt = this.recentlyLaunched.get(session.id)
        if (launchedAt !== undefined && this.now() - launchedAt < TERMINAL_START_GRACE_MS) return session
        if (await this.activate(session)) return session
      }
    }

    const session = previous ?? this.options.store.createSession({ repo, name, cwd })
    try {
      await this.launchSession(session, previous !== null)
    } catch (error) {
      if (!previous) this.options.store.removeSession(session.id)
      throw error instanceof Error ? error : new Error('无法启动 Claude 终端')
    }
    return session
  }

  private workspaceSessionConflict(): Error {
    return new Error('该工作目录已有另一个 Claude 会话窗口，请先切换或关闭它，再恢复指定会话')
  }

  private launchSession(session: ClaudeSession, resume: boolean): Promise<void> {
    const pending = this.launches.get(session.id)
    if (pending) return pending
    const launch = Promise.resolve()
      .then(() => this.options.launch({ repo: session.repo, cwd: session.cwd, sessionId: session.id, resume }))
      .then(() => {
        const launchedAt = this.now()
        this.recentlyLaunched.set(session.id, launchedAt)
        for (const [id, timestamp] of this.recentlyLaunched) {
          if (launchedAt - timestamp >= TERMINAL_START_GRACE_MS) this.recentlyLaunched.delete(id)
        }
      })
    const tracked = launch.finally(() => {
      if (this.launches.get(session.id) === tracked) this.launches.delete(session.id)
    })
    this.launches.set(session.id, tracked)
    return tracked
  }

  private async activate(session: ClaudeSession): Promise<boolean> {
    return this.options.activate
      ? this.options.activate({ repo: session.repo, cwd: session.cwd, sessionId: session.id })
      : false
  }

  async read(sessionId: unknown): Promise<ClaudeSessionTranscript> {
    const session = this.options.store.find(sessionId)
    if (session) return readClaudeTranscript({ ...session, source: 'arckeep' }, this.configDirectory)
    const id = normalizeClaudeSessionId(sessionId)
    const local = (await this.localSessions()).find(item => item.id === id)
    if (!local) throw new Error('找不到该 Claude 会话')
    const sessionView = await this.localSessionView(local)
    return readClaudeTranscriptAt(local.file, sessionView)
  }

  async resume(sessionId: unknown): Promise<ClaudeSession> {
    const stored = this.options.store.find(sessionId)
    if (stored) return this.start(stored.repo, stored.name, stored.id)
    const id = normalizeClaudeSessionId(sessionId)
    const local = (await this.localSessions()).find(item => item.id === id)
    if (!local) throw new Error('找不到该 Claude 会话')
    const session = await this.localSessionView(local)
    const launchedAt = this.recentlyLaunched.get(id)
    if (launchedAt !== undefined && this.now() - launchedAt < TERMINAL_START_GRACE_MS) return session
    const pending = this.launches.get(id)
    if (pending) {
      await pending
      return session
    }
    try {
      await canonicalDirectory(local.cwd)
    } catch {
      throw new Error('该会话的工作目录已不存在，无法恢复')
    }
    const launch = this.options.launch({ repo: session.repo, cwd: session.cwd, sessionId: session.id, resume: true })
    const tracked = launch.finally(() => {
      if (this.launches.get(id) === tracked) this.launches.delete(id)
    })
    this.launches.set(id, tracked)
    await tracked
    const now = this.now()
    this.recentlyLaunched.set(id, now)
    for (const [key, timestamp] of this.recentlyLaunched) {
      if (now - timestamp >= TERMINAL_START_GRACE_MS) this.recentlyLaunched.delete(key)
    }
    return session
  }

  private async localSessionView(local: LocalClaudeSession): Promise<ClaudeSession> {
    const workspace = this.options.store.workspaces().find(item => directoryKey(item.path) === directoryKey(local.cwd))
    const identity = workspace
      ?? (await projectIdentities([local.cwd])).get(local.cwd)
      ?? { repo: 'local/project', name: path.basename(local.cwd) }
    return {
      id: local.id,
      cwd: local.cwd,
      repo: identity.repo,
      name: identity.name,
      startedAt: local.startedAt,
      source: 'local',
      updatedAt: local.updatedAt,
      title: local.title
    }
  }

  private normalizeName(input: unknown, repo: string): string {
    if (input === undefined || input === null || input === '') return repo
    if (typeof input !== 'string' || input.trim().length > 200) throw new Error('项目名称无效')
    return input.trim()
  }
}

