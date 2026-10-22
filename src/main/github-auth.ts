import { abortable, isCancellation, throwIfCancelled, type TaskScope } from '../shared/task-scope.js'
import { readHttpResponse } from '../github/http-request.js'
import { runManagedCommand, type ManagedCommandContext } from './managed-command.js'
import { githubSourceLabel, type GithubSource } from '../shared/types.js'

export interface CommandSuccess {
  code: number
  stdout: string
  stderr: string
}

export type CommandRunner = (command: string, args: readonly string[], options?: ManagedCommandContext) => Promise<CommandSuccess>
export type GithubAuthTaskOptions = ManagedCommandContext

export type GhLookup =
  | { ok: true, token: string }
  | { ok: false, reason: 'not-installed' | 'not-logged-in' | 'empty' }

export interface ResolvedGithubAuth {
  source: GithubSource
  token: string | null
  patSaved: boolean
}

const GH_ARGS = ['auth', 'token'] as const

export function execFileRunner(
  command: string,
  args: readonly string[],
  options?: ManagedCommandContext
): Promise<CommandSuccess> {
  return runManagedCommand(command, args, {
    ...options,
    timeoutMs: 15_000,
    maxBuffer: 1024 * 64,
    label: 'GitHub CLI 认证进程'
  })
}

export async function readGhAuthToken(
  run: CommandRunner = execFileRunner,
  log: (message: string) => void = () => {},
  options: GithubAuthTaskOptions = {}
): Promise<GhLookup> {
  const signal = options.signal ?? options.tasks?.signal
  throwIfCancelled(signal)
  try {
    const command = run('gh', GH_ARGS, options)
    const result = run === execFileRunner ? await command : await abortable(command, signal)
    throwIfCancelled(signal)
    if (result.code === 127) {
      log('gh auth token unavailable: not-installed')
      return { ok: false, reason: 'not-installed' }
    }
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
    if (isCancellation(error)) throw error
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
  readGh: (options?: GithubAuthTaskOptions) => Promise<GhLookup>
  readPat: () => string | null
  patSaved: boolean
  signal?: AbortSignal
  tasks?: TaskScope
}): Promise<ResolvedGithubAuth> {
  const signal = options.signal ?? options.tasks?.signal
  throwIfCancelled(signal)
  const gh = await options.readGh({ signal, tasks: options.tasks })
  throwIfCancelled(signal)
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

export type GithubFailureKind = 'invalid-token' | 'insufficient-scope' | 'network' | 'other'

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NODATA',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET'
])

export function isGithubNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = 'code' in error && typeof error.code === 'string' ? error.code : ''
  if (NETWORK_CODES.has(code)) return true
  const name = 'name' in error && typeof error.name === 'string' ? error.name : ''
  if (name === 'AbortError' || name === 'TimeoutError') return true
  const message = 'message' in error && typeof error.message === 'string' ? error.message.toLowerCase() : ''
  return message.includes('timeout')
    || message.includes('timed out')
    || message.includes('network')
    || message.includes('fetch failed')
    || message.includes('getaddrinfo')
    || message.includes('enotfound')
    || message.includes('eai_again')
    || message.includes('econnrefused')
    || message.includes('offline')
}

export function scopesAreMissing(granted: string | null | undefined, accepted: string | null | undefined): boolean {
  if (!accepted?.trim()) return false
  const have = new Set(
    (granted ?? '').split(/[,\s]+/).map(scope => scope.trim().toLowerCase()).filter(Boolean)
  )
  return accepted.split(/[,\s]+/).some(scope => {
    const name = scope.trim().toLowerCase()
    return name.length > 0 && !have.has(name)
  })
}

export function classifyGithubFailure(input: {
  status?: number | null
  grantedScopes?: string | null
  acceptedScopes?: string | null
  network?: boolean
}): { kind: GithubFailureKind, message: string } {
  if (input.network) {
    return {
      kind: 'network',
      message: '连不上 GitHub（网络不可达、DNS 失败或超时）。请检查网络或代理，恢复后再点一次测试连接。'
    }
  }
  if (input.status === 401) {
    return {
      kind: 'invalid-token',
      message: '这个 token 无效或已过期（HTTP 401）。请重新生成 PAT，或执行 gh auth login 后再试。'
    }
  }
  if (input.status === 403 || scopesAreMissing(input.grantedScopes, input.acceptedScopes)) {
    return {
      kind: 'insufficient-scope',
      message: '这个 token 的权限不够（HTTP 403 或缺少 scope）。请在 GitHub 上补齐所需权限后再试。'
    }
  }
  const status = input.status ?? '未知'
  return {
    kind: 'other',
    message: `GitHub 返回了意外错误（HTTP ${status}）。请稍后重试，或换一个 token。`
  }
}

export class GitHubConnectionError extends Error {
  readonly status: number | null
  readonly kind: GithubFailureKind

  constructor(message: string, status: number | null, kind: GithubFailureKind) {
    super(message)
    this.name = 'GitHubConnectionError'
    this.status = status
    this.kind = kind
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export async function fetchGitHubLogin(
  token: string,
  fetchImpl: typeof fetch = fetch,
  options: { signal?: AbortSignal, timeoutMs?: number } = {}
): Promise<string> {
  let response: Response
  let bodyText: string
  try {
    const result = await readHttpResponse('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Arckeep',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    }, fetchImpl, options)
    throwIfCancelled(options.signal)
    response = result.response
    bodyText = result.bodyText
  } catch (error) {
    if (isCancellation(error)) throw error
    const failure = classifyGithubFailure({ network: true })
    throw new GitHubConnectionError(failure.message, null, failure.kind)
  }

  const grantedScopes = response.headers.get('x-oauth-scopes')
  const acceptedScopes = response.headers.get('x-accepted-oauth-scopes')
  const failure = classifyGithubFailure({
    status: response.status,
    grantedScopes,
    acceptedScopes
  })
  if (!response.ok || scopesAreMissing(grantedScopes, acceptedScopes)) {
    throw new GitHubConnectionError(failure.message, response.status, failure.kind)
  }

  let body: unknown
  try {
    body = JSON.parse(bodyText) as unknown
  } catch {
    throw new GitHubConnectionError('GitHub 响应无法解析。请稍后重试。', response.status, 'other')
  }
  const login = isRecord(body) && typeof body.login === 'string' ? body.login : ''
  if (!login) throw new GitHubConnectionError('GitHub 响应里没有用户名。请稍后重试，或换一个 token。', response.status, 'other')
  throwIfCancelled(options.signal)
  return login
}

export async function testGithubConnection(options: {
  token: string | null
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<{ ok: true, login: string } | { ok: false, error: string }> {
  throwIfCancelled(options.signal)
  if (!options.token) return { ok: false, error: '尚未配置 GitHub token' }
  try {
    const login = await fetchGitHubLogin(options.token, options.fetchImpl, {
      signal: options.signal,
      timeoutMs: options.timeoutMs
    })
    throwIfCancelled(options.signal)
    return { ok: true, login }
  } catch (error) {
    if (isCancellation(error)) throw error
    if (error instanceof GitHubConnectionError) return { ok: false, error: error.message }
    if (isGithubNetworkError(error)) return { ok: false, error: classifyGithubFailure({ network: true }).message }
    return { ok: false, error: '测试连接失败。请稍后重试。' }
  }
}
