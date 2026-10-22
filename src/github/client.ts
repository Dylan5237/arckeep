import { GithubAuthError, GithubRateLimitError, rateLimitFromResponse } from '../shared/waiting/rate-limit.js'
import { isCancellation, throwIfCancelled } from '../shared/task-scope.js'
import { GITHUB_REQUEST_TIMEOUT_MS, type GithubRequestScheduler } from './concurrency.js'
import { readHttpResponse } from './http-request.js'

const API = 'https://api.github.com/graphql'

export async function githubGraphql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch,
  scheduler?: GithubRequestScheduler
): Promise<unknown> {
  const execute = async (): Promise<unknown> => {
    const timeoutMs = scheduler?.timeoutMs ?? GITHUB_REQUEST_TIMEOUT_MS
    let response: Response
    let bodyText: string
    try {
      const read = await readHttpResponse(API, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'Arckeep',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        body: JSON.stringify({ query, variables })
      }, fetchImpl, { signal: scheduler?.signal, timeoutMs })
      throwIfCancelled(scheduler?.signal)
      response = read.response
      bodyText = read.bodyText
    } catch (error) {
      if (isCancellation(error)) throw error
      const message = error instanceof Error && error.name === 'TimeoutError'
        ? `请求超时（${Math.ceil(timeoutMs / 1000)} 秒）`
        : error instanceof Error ? error.message : '网络错误'
      throw new Error(`连不上 GitHub：${message}`)
    }
    if (response.status === 401) throw new GithubAuthError()
    const resetAt = rateLimitFromResponse(response.status, response.headers, bodyText)
    if (resetAt) throw new GithubRateLimitError(resetAt)
    let payload: unknown
    try {
      payload = JSON.parse(bodyText) as unknown
    } catch {
      throw new Error(`GitHub 响应无法解析（HTTP ${response.status}）`)
    }
    if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`)
    if (payload && typeof payload === 'object' && payload !== null && 'errors' in payload) {
      const errors = (payload as { errors?: unknown }).errors
      const messages = Array.isArray(errors)
        ? errors.map(error => (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') ? error.message : '')
        : []
      const rate = messages.some(message => /rate limit/i.test(message))
      if (rate) {
        const headerReset = rateLimitFromResponse(403, response.headers, messages.join('\n'))
        throw new GithubRateLimitError(headerReset ?? new Date(Date.now() + 60_000).toISOString())
      }
      const data = (payload as { data?: unknown }).data
      if (data === null || data === undefined) {
        throw new Error(messages.filter(Boolean).join('；') || 'GitHub GraphQL 查询失败')
      }
    }
    return payload
  }

  try {
    return await (scheduler ? scheduler.run(execute) : execute())
  } catch (error) {
    if (isCancellation(error)) throw error
    if (error instanceof GithubAuthError || error instanceof GithubRateLimitError) scheduler?.stop(error)
    throw error
  }
}

export function githubData(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {}
  const data = (payload as { data?: unknown }).data
  if (!data || typeof data !== 'object') return {}
  return data as Record<string, unknown>
}

export function githubErrorMessages(payload: unknown): { path: string, message: string }[] {
  if (!payload || typeof payload !== 'object' || !('errors' in payload)) return []
  const errors = (payload as { errors?: unknown }).errors
  if (!Array.isArray(errors)) return []
  const found: { path: string, message: string }[] = []
  for (const error of errors) {
    if (!error || typeof error !== 'object') continue
    const message = 'message' in error && typeof error.message === 'string' ? error.message : ''
    const path = 'path' in error && Array.isArray(error.path) && typeof error.path[0] === 'string' ? error.path[0] : ''
    if (message) found.push({ path, message })
  }
  return found
}
