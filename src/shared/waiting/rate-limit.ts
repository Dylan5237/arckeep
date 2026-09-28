export class GithubRateLimitError extends Error {
  readonly resetAt: string

  constructor(resetAt: string) {
    super(`GitHub 速率限制，重置时间 ${resetAt}`)
    this.name = 'GithubRateLimitError'
    this.resetAt = resetAt
  }
}

export class GithubAuthError extends Error {
  constructor() {
    super('GitHub 认证无效或已过期')
    this.name = 'GithubAuthError'
  }
}

export function rateLimitResetIso(header: string | null, _now = Date.now()): string | null {
  if (!header) return null
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return new Date(seconds * 1000).toISOString()
}

export function rateLimitFromResponse(
  status: number,
  headers: { get(name: string): string | null },
  bodyText: string,
  now = Date.now()
): string | null {
  const remaining = headers.get('x-ratelimit-remaining')
  const retryAfter = headers.get('retry-after')
  const bodyLimited = /rate limit/i.test(bodyText) || /secondary rate limit/i.test(bodyText)
  const limited = status === 429 || (status === 403 && (remaining === '0' || bodyLimited))
  if (!limited) return null
  const fromHeader = rateLimitResetIso(headers.get('x-ratelimit-reset'), now)
  if (fromHeader) return fromHeader
  const retrySeconds = Number(retryAfter)
  if (Number.isFinite(retrySeconds) && retrySeconds > 0) return new Date(now + retrySeconds * 1000).toISOString()
  return new Date(now + 60_000).toISOString()
}

export function earlierReset(left: string | null, right: string | null): string | null {
  if (!left) return right
  if (!right) return left
  return Date.parse(left) <= Date.parse(right) ? left : right
}
