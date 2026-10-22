import { describe, expect, it } from 'vitest'
import { rateLimitFromResponse } from '../src/shared/waiting/rate-limit.js'

const NOW = Date.parse('2026-10-09T01:54:00.000Z')
const HOURLY_RESET = Date.parse('2026-10-09T02:46:00.000Z')
const headers = (extra: Record<string, string> = {}) => new Headers({
  'x-ratelimit-remaining': '4727', 'x-ratelimit-reset': String(HOURLY_RESET / 1000), ...extra
})

describe('refresh rate limit cooldown', () => {
  it('honors secondary Retry-After instead of the unrelated hourly quota reset', () => {
    expect(rateLimitFromResponse(403, headers({ 'retry-after': '90' }), 'secondary rate limit', NOW))
      .toBe(new Date(NOW + 90_000).toISOString())
  })

  it('uses a short secondary cooldown when the primary budget is still available', () => {
    expect(rateLimitFromResponse(403, headers(), 'rate limit exceeded', NOW))
      .toBe(new Date(NOW + 60_000).toISOString())
  })

  it('uses the primary reset when the primary quota is exhausted', () => {
    expect(rateLimitFromResponse(403, headers({ 'x-ratelimit-remaining': '0', 'retry-after': '10' }), 'rate limit exceeded', NOW))
      .toBe(new Date(HOURLY_RESET).toISOString())
  })

  it('does not turn a permission failure into a cooldown', () => {
    expect(rateLimitFromResponse(403, headers(), 'Resource not accessible by integration', NOW)).toBeNull()
  })
})
