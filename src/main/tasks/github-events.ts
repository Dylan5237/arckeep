import type { GithubObservation } from '../../shared/tasks/state.js'
import type { TaskWait } from '../../shared/tasks/types.js'

const API = 'https://api.github.com'
const REQUEST_TIMEOUT_MS = 15_000

export class GithubEventError extends Error {
  constructor(message: string, readonly retryAfterMs: number | null = null) {
    super(message)
  }
}

interface PullResponse {
  state?: unknown
  merged?: unknown
  draft?: unknown
  head?: { sha?: unknown } | null
  title?: unknown
  html_url?: unknown
}

interface CheckRunsResponse {
  total_count?: unknown
  check_runs?: Array<{
    name?: unknown
    status?: unknown
    conclusion?: unknown
  }>
}

interface CombinedStatusResponse {
  state?: unknown
  total_count?: unknown
  statuses?: Array<{ context?: unknown, state?: unknown }>
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get('retry-after')
  if (header && /^\d+$/.test(header.trim())) return Math.min(Number(header.trim()) * 1000, 60 * 60 * 1000)
  const reset = response.headers.get('x-ratelimit-reset')
  if (reset && /^\d+$/.test(reset.trim())) {
    return Math.max(15_000, Math.min(Number(reset.trim()) * 1000 - Date.now(), 60 * 60 * 1000))
  }
  return 60_000
}

async function requestJson<T>(
  path: string,
  token: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal
): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  let response: Response
  try {
    response = await fetchImpl(API + path, {
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Arckeep'
      },
      signal: combined
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new GithubEventError('无法连接 GitHub，请检查网络后重试')
  }
  if (!response.ok) {
    const limited = response.status === 429
      || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
    if (limited) throw new GithubEventError('GitHub API 已限流，稍后自动重试', retryAfterMs(response))
    if (response.status === 401) throw new GithubEventError('GitHub 认证已失效，请到设置重新认证')
    if (response.status === 404) throw new GithubEventError('找不到该 PR，或当前认证无权读取')
    throw new GithubEventError('GitHub 请求失败（HTTP ' + response.status + '）')
  }
  return await response.json() as T
}

function checkState(runs: CheckRunsResponse, statuses: CombinedStatusResponse | null): {
  state: 'pending' | 'success' | 'failure' | 'none'
  detail: string
} {
  const list = Array.isArray(runs.check_runs) ? runs.check_runs : []
  const legacy = Array.isArray(statuses?.statuses) ? statuses.statuses : []
  const failures: string[] = []
  const pending: string[] = []
  let completed = 0
  for (const run of list) {
    const name = typeof run.name === 'string' ? run.name : 'check'
    const status = typeof run.status === 'string' ? run.status : ''
    const conclusion = typeof run.conclusion === 'string' ? run.conclusion : ''
    if (status !== 'completed') {
      pending.push(name)
      continue
    }
    completed += 1
    if (['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(conclusion)) failures.push(name)
  }
  for (const status of legacy) {
    const name = typeof status.context === 'string' ? status.context : 'status'
    const state = typeof status.state === 'string' ? status.state : ''
    if (state === 'pending') pending.push(name)
    else if (state === 'failure' || state === 'error') failures.push(name)
    else completed += 1
  }
  const total = list.length + legacy.length
  if (total === 0) return { state: 'none', detail: '该提交还没有 CI 检查' }
  if (failures.length > 0) {
    return {
      state: 'failure',
      detail: `CI 共 ${total} 项，${failures.length} 项失败：${failures.slice(0, 6).join('、')}`
    }
  }
  if (pending.length > 0) {
    return {
      state: 'pending',
      detail: `CI 共 ${total} 项，已完成 ${completed} 项，等待 ${pending.length} 项：${pending.slice(0, 6).join('、')}`
    }
  }
  return { state: 'success', detail: `CI 共 ${total} 项，全部完成且未发现失败` }
}

export interface ObserveGithubOptions {
  token: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export async function observeGithubWait(wait: TaskWait, options: ObserveGithubOptions): Promise<GithubObservation> {
  if (!wait.repo || !wait.pr) throw new GithubEventError('等待事件缺少仓库或 PR 编号')
  const fetchImpl = options.fetchImpl ?? fetch
  const pullPath = `/repos/${wait.repo}/pulls/${wait.pr}`
  const pull = await requestJson<PullResponse>(pullPath, options.token, fetchImpl, options.signal)
  const headSha = typeof pull.head?.sha === 'string' && /^[0-9a-f]{7,64}$/i.test(pull.head.sha) ? pull.head.sha : null
  const title = typeof pull.title === 'string' ? pull.title.slice(0, 200) : ''
  const prState = pull.merged === true ? 'merged' : pull.state === 'closed' ? 'closed' : pull.state === 'open' ? 'open' : 'unknown'
  const labels = 'PR #' + wait.pr + (title ? '《' + title + '》' : '') + '，状态 ' + prState + (headSha ? '，HEAD ' + headSha.slice(0, 12) : '')

  if (wait.type === 'github_pr') {
    return { checks: 'unknown', pr: prState, headSha, detail: labels }
  }
  if (!headSha) return { checks: 'unknown', pr: prState, headSha, detail: labels + '；无法读取 HEAD 提交' }

  let runs: CheckRunsResponse = {}
  let runsError: GithubEventError | null = null
  try {
    runs = await requestJson<CheckRunsResponse>(
      `/repos/${wait.repo}/commits/${headSha}/check-runs?per_page=100`,
      options.token,
      fetchImpl,
      options.signal
    )
  } catch (error) {
    if (!(error instanceof GithubEventError)) throw error
    runsError = error
  }
  let statuses: CombinedStatusResponse | null = null
  try {
    statuses = await requestJson<CombinedStatusResponse>(
      `/repos/${wait.repo}/commits/${headSha}/status`,
      options.token,
      fetchImpl,
      options.signal
    )
  } catch (error) {
    if (!(error instanceof GithubEventError)) throw error
    if (runsError) throw runsError
  }
  if (runsError && !statuses) throw runsError
  const summary = checkState(runs, statuses)
  return {
    checks: summary.state,
    pr: prState,
    headSha,
    detail: labels + '；' + summary.detail
  }
}
