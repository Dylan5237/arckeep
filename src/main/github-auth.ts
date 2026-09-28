import { execFile } from 'node:child_process'
import { githubSourceLabel, type GithubSource } from '../shared/types.js'

export interface CommandSuccess {
  code: number
  stdout: string
  stderr: string
}

export type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandSuccess>

export type GhLookup =
  | { ok: true, token: string }
  | { ok: false, reason: 'not-installed' | 'not-logged-in' | 'empty' }

export interface ResolvedGithubAuth {
  source: GithubSource
  token: string | null
  patSaved: boolean
}

const GH_ARGS = ['auth', 'token'] as const

export function execFileRunner(command: string, args: readonly string[]): Promise<CommandSuccess> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 64 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(error)
        return
      }
      if (error && typeof (error as { code?: unknown }).code === 'number') {
        resolve({
          code: (error as { code: number }).code,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '')
        })
        return
      }
      if (error) {
        resolve({ code: 1, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
        return
      }
      resolve({ code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

export async function readGhAuthToken(
  run: CommandRunner = execFileRunner,
  log: (message: string) => void = () => {}
): Promise<GhLookup> {
  try {
    const result = await run('gh', GH_ARGS)
    if (result.code !== 0) {
      log('gh auth token unavailable: not-logged-in')
      return { ok: false, reason: 'not-logged-in' }
    }
    const token = result.stdout.trim()
    if (!token || /\s/.test(token)) {
      log('gh auth token unavailable: empty')
      return { ok: false, reason: 'empty' }
    }
    return { ok: true, token }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') {
      log('gh auth token unavailable: not-installed')
      return { ok: false, reason: 'not-installed' }
    }
    log('gh auth token unavailable: not-logged-in')
    return { ok: false, reason: 'not-logged-in' }
  }
}

export async function resolveGithubAuth(options: {
  readGh: () => Promise<GhLookup>
  readPat: () => string | null
  patSaved: boolean
}): Promise<ResolvedGithubAuth> {
  const gh = await options.readGh()
  if (gh.ok) {
    return { source: 'gh-cli', token: gh.token, patSaved: options.patSaved }
  }
  const pat = options.readPat()
  if (pat) return { source: 'pat', token: pat, patSaved: true }
  return { source: 'none', token: null, patSaved: options.patSaved }
}

export function toPublicGithubAuth(resolved: ResolvedGithubAuth): {
  source: GithubSource
  sourceLabel: string
  patSaved: boolean
} {
  return {
    source: resolved.source,
    sourceLabel: githubSourceLabel(resolved.source),
    patSaved: resolved.patSaved
  }
}

export class GitHubConnectionError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null) {
    super(message)
    this.name = 'GitHubConnectionError'
    this.status = status
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export async function fetchGitHubLogin(token: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let response: Response
  try {
    response = await fetchImpl('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Arckeep',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
  } catch {
    throw new GitHubConnectionError('无法连接 GitHub，请检查网络后重试', null)
  }

  if (response.status === 401 || response.status === 403) {
    throw new GitHubConnectionError(
      `GitHub 拒绝了这个 token（HTTP ${response.status}）。请检查 PAT 权限，或重新执行 gh auth login。`,
      response.status
    )
  }
  if (!response.ok) {
    throw new GitHubConnectionError(`GitHub 返回错误（HTTP ${response.status}）`, response.status)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new GitHubConnectionError('GitHub 响应无法解析', response.status)
  }
  const login = isRecord(body) && typeof body.login === 'string' ? body.login : ''
  if (!login) throw new GitHubConnectionError('GitHub 响应里没有用户名', response.status)
  return login
}

export async function testGithubConnection(options: {
  token: string | null
  fetchImpl?: typeof fetch
}): Promise<{ ok: true, login: string } | { ok: false, error: string }> {
  if (!options.token) return { ok: false, error: '尚未配置 GitHub token' }
  try {
    const login = await fetchGitHubLogin(options.token, options.fetchImpl)
    return { ok: true, login }
  } catch (error) {
    if (error instanceof GitHubConnectionError) return { ok: false, error: error.message }
    return { ok: false, error: '测试连接失败' }
  }
}
