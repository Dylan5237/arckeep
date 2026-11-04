import { describe, expect, it, vi } from 'vitest'
import { GithubEventError, observeGithubWait } from '../src/main/tasks/github-events.js'
import type { TaskWait } from '../src/shared/tasks/types.js'

const SHA = '0123456789abcdef0123456789abcdef01234567'

function wait(overrides: Partial<TaskWait> = {}): TaskWait {
  return {
    type: 'github_checks',
    reason: '等待 CI',
    until: null,
    repo: 'example/demo',
    pr: 12,
    createdAt: '2026-11-04T10:00:00.000Z',
    timeoutAt: '2026-11-11T10:00:00.000Z',
    lastCheckedAt: null,
    lastState: null,
    lastError: null,
    firedAt: null,
    firedDetail: null,
    ...overrides
  }
}

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

function fakeFetch(routes: Array<{ match: string, response: () => Response }>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    const route = routes.find(item => url.includes(item.match))
    if (!route) return response({ message: 'not found' }, 404)
    return route.response()
  }) as unknown as typeof fetch
}

describe('GitHub wait observation', () => {
  it('reports a successful check suite for the PR head commit', async () => {
    const fetchImpl = fakeFetch([
      {
        match: '/pulls/12',
        response: () => response({ state: 'open', merged: false, head: { sha: SHA }, title: 'Fix login' })
      },
      {
        match: '/check-runs',
        response: () => response({
          total_count: 2,
          check_runs: [
            { name: 'test', status: 'completed', conclusion: 'success' },
            { name: 'build', status: 'completed', conclusion: 'success' }
          ]
        })
      },
      { match: '/status', response: () => response({ state: 'success', total_count: 0, statuses: [] }) }
    ])
    const observation = await observeGithubWait(wait(), { token: 'token', fetchImpl })
    expect(observation.checks).toBe('success')
    expect(observation.pr).toBe('open')
    expect(observation.headSha).toBe(SHA)
    expect(observation.detail).toContain('全部完成')
  })

  it('reports pending and failed check suites', async () => {
    const pending = fakeFetch([
      { match: '/pulls/12', response: () => response({ state: 'open', merged: false, head: { sha: SHA }, title: 'x' }) },
      {
        match: '/check-runs',
        response: () => response({ total_count: 1, check_runs: [{ name: 'test', status: 'in_progress', conclusion: null }] })
      },
      { match: '/status', response: () => response({ state: 'pending', total_count: 0, statuses: [] }) }
    ])
    expect((await observeGithubWait(wait(), { token: 't', fetchImpl: pending })).checks).toBe('pending')

    const failed = fakeFetch([
      { match: '/pulls/12', response: () => response({ state: 'open', merged: false, head: { sha: SHA }, title: 'x' }) },
      {
        match: '/check-runs',
        response: () => response({ total_count: 2, check_runs: [
          { name: 'test', status: 'completed', conclusion: 'failure' },
          { name: 'build', status: 'completed', conclusion: 'success' }
        ] })
      },
      { match: '/status', response: () => response({ state: 'failure', total_count: 0, statuses: [] }) }
    ])
    const observation = await observeGithubWait(wait(), { token: 't', fetchImpl: failed })
    expect(observation.checks).toBe('failure')
    expect(observation.detail).toContain('test')
  })

  it('uses legacy commit statuses when check runs are unavailable and reports none without checks', async () => {
    const legacy = fakeFetch([
      { match: '/pulls/12', response: () => response({ state: 'open', merged: false, head: { sha: SHA }, title: 'x' }) },
      { match: '/check-runs', response: () => response({ message: 'forbidden' }, 403) },
      {
        match: '/status',
        response: () => response({ state: 'failure', total_count: 1, statuses: [{ context: 'legacy-ci', state: 'failure' }] })
      }
    ])
    const failed = await observeGithubWait(wait(), { token: 't', fetchImpl: legacy })
    expect(failed.checks).toBe('failure')
    expect(failed.detail).toContain('legacy-ci')

    const none = fakeFetch([
      { match: '/pulls/12', response: () => response({ state: 'open', merged: false, head: { sha: SHA }, title: 'x' }) },
      { match: '/check-runs', response: () => response({ total_count: 0, check_runs: [] }) },
      { match: '/status', response: () => response({ state: 'success', total_count: 0, statuses: [] }) }
    ])
    expect((await observeGithubWait(wait(), { token: 't', fetchImpl: none })).checks).toBe('none')
  })

  it('exposes merged/closed PR state without fetching checks for a PR wait', async () => {
    const fetchImpl = fakeFetch([
      { match: '/pulls/12', response: () => response({ state: 'closed', merged: true, head: { sha: SHA }, title: 'x' }) }
    ])
    const observation = await observeGithubWait(wait({ type: 'github_pr' }), { token: 't', fetchImpl })
    expect(observation.pr).toBe('merged')
    expect(observation.checks).toBe('unknown')
  })

  it('turns rate limits and auth failures into actionable errors without leaking the token', async () => {
    const limited = fakeFetch([
      { match: '/pulls/12', response: () => response({ message: 'rate limited' }, 429, { 'retry-after': '2' }) }
    ])
    await expect(observeGithubWait(wait(), { token: 'secret-token', fetchImpl: limited }))
      .rejects.toMatchObject({ retryAfterMs: 2000 })
    try {
      await observeGithubWait(wait(), { token: 'secret-token', fetchImpl: limited })
    } catch (error) {
      expect(error).toBeInstanceOf(GithubEventError)
      expect(String(error)).not.toContain('secret-token')
    }

    const unauthorized = fakeFetch([
      { match: '/pulls/12', response: () => response({ message: 'bad credentials' }, 401) }
    ])
    await expect(observeGithubWait(wait(), { token: 't', fetchImpl: unauthorized }))
      .rejects.toThrow('认证已失效')
  })
})
