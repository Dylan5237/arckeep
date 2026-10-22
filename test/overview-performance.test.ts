import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_GITHUB_REQUESTS } from '../src/github/concurrency.js'
import { loadOverview } from '../src/overview/load.js'
import { defaultOverviewConfig } from '../src/shared/overview/rules.js'

const NOW = new Date('2026-10-09T00:00:00.000Z')

interface GraphqlRequest {
  query: string
  variables: Record<string, unknown>
}

function readRequest(init?: RequestInit): GraphqlRequest {
  return JSON.parse(String(init?.body)) as GraphqlRequest
}

function requestedNames(variables: Record<string, unknown>): string[] {
  return Object.keys(variables)
    .filter(key => /^n\d+$/.test(key))
    .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)))
    .map(key => `${String(variables[`o${key.slice(1)}`])}/${String(variables[key])}`)
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function repoNames(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `example/repo-${String(index).padStart(3, '0')}`)
}

function repositoryNode(name: string): Record<string, unknown> {
  return {
    nameWithOwner: name,
    url: `https://github.com/${name}`,
    isEmpty: false,
    isArchived: false,
    diskUsage: 42,
    createdAt: '2026-09-01T00:00:00.000Z',
    pushedAt: '2026-10-08T00:00:00.000Z',
    defaultBranchRef: {
      target: {
        oid: name,
        committedDate: '2026-10-08T00:00:00.000Z',
        statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } }
      }
    },
    pullRequests: { totalCount: 0, nodes: [] },
    issues: { nodes: [] },
    recentPulls: { nodes: [] }
  }
}

function detailPayload(names: readonly string[]): { data: Record<string, unknown> } {
  return { data: Object.fromEntries(names.map((name, index) => [`r${index}`, repositoryNode(name)])) }
}

afterEach(() => { vi.useRealTimers() })

describe('overview request scheduling and failure handling', () => {
  it('runs bounded batches of three concurrently and keeps all 36 repositories when batches finish out of order', async () => {
    const names = repoNames(36).reverse()
    const requests: Array<{ names: string[], response: ReturnType<typeof deferred<Response>> }> = []
    let active = 0
    let peak = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      const batch = requestedNames(readRequest(init).variables)
      const response = deferred<Response>()
      requests.push({ names: batch, response })
      active += 1
      peak = Math.max(peak, active)
      try {
        return await response.promise
      } finally {
        active -= 1
      }
    }
    const pending = loadOverview({
      token: 'test-token', config: defaultOverviewConfig(), watchedRepos: names, now: NOW, fetchImpl
    })

    await vi.waitFor(() => expect(requests).toHaveLength(MAX_GITHUB_REQUESTS))
    expect(peak).toBe(MAX_GITHUB_REQUESTS)
    expect(requests.flatMap(request => request.names)).toEqual(names.slice(0, MAX_GITHUB_REQUESTS * 3))
    expect(requests.every(request => request.names.length === 3)).toBe(true)
    const totalBatches = Math.ceil(names.length / 3)
    for (let completed = 0; completed < totalBatches; completed += MAX_GITHUB_REQUESTS) {
      const nextWave = Math.min(totalBatches, completed + MAX_GITHUB_REQUESTS)
      await vi.waitFor(() => expect(requests).toHaveLength(nextWave))
      for (const request of requests.slice(completed, nextWave).reverse()) {
        request.response.resolve(jsonResponse(detailPayload(request.names)))
      }
    }

    const result = await pending
    expect(peak).toBe(MAX_GITHUB_REQUESTS)
    expect(requests).toHaveLength(totalBatches)
    expect(requests.flatMap(request => request.names)).toEqual(names)
    expect(result.rows.map(row => row.name)).toEqual([...names].sort())
    expect(result.rows.every(row => row.error === null && row.fromWatchList === true)).toBe(true)
    expect(result).toMatchObject({ fresh: true, errors: [], auth: 'ok' })
  })

  it('keeps discovery pages serial and retains the full range beyond the first 40 repositories', async () => {
    const names = repoNames(83)
    const cursors: unknown[] = []
    const queried: string[] = []
    let activeDiscovery = 0
    let peakDiscovery = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      const { query, variables } = readRequest(init)
      if (query.includes('repositories(')) {
        expect(query).toContain('repositories(first: 40, after: $cursor')
        expect(query).toContain('OWNER, COLLABORATOR, ORGANIZATION_MEMBER')
        expect(query).toContain('nodes { nameWithOwner isArchived viewerPermission pushedAt }')
        expect(query).not.toContain('isEmpty')
        expect(query).toContain('pushedAt')
        activeDiscovery += 1
        peakDiscovery = Math.max(peakDiscovery, activeDiscovery)
        cursors.push(variables.cursor)
        const page = variables.cursor === null ? 0 : Number(variables.cursor)
        const slice = names.slice(page * 40, (page + 1) * 40)
        await Promise.resolve()
        activeDiscovery -= 1
        return jsonResponse({ data: { viewer: { repositories: {
          pageInfo: { hasNextPage: page < 2, endCursor: page < 2 ? String(page + 1) : null },
          nodes: slice.map(name => ({
            nameWithOwner: name, isArchived: false, viewerPermission: 'ADMIN'
          }))
        } } } })
      }
      const batch = requestedNames(variables)
      queried.push(...batch)
      return jsonResponse(detailPayload(batch))
    }

    const result = await loadOverview({
      token: 'test-token', config: defaultOverviewConfig(), watchedRepos: [], now: NOW, fetchImpl
    })
    expect(cursors).toEqual([null, '1', '2'])
    expect(peakDiscovery).toBe(1)
    expect(queried).toEqual(names)
    expect(result.rows.map(row => row.name)).toEqual(names)
    expect(result.rows.every(row => row.fromWatchList === false)).toBe(true)
    expect(result.notices).toEqual([])
  })

  it('uses detail values for empty and activity groups after lightweight permission and archive discovery', async () => {
    const names = ['example/empty', 'example/revived', 'example/stale']
    const old = '2025-01-01T00:00:00.000Z'
    const queried: string[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const { query, variables } = readRequest(init)
      if (query.includes('repositories(')) {
        return jsonResponse({ data: { viewer: { repositories: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            ...names.map(name => ({ nameWithOwner: name, isArchived: false, viewerPermission: 'WRITE' })),
            { nameWithOwner: 'example/archived', isArchived: true, viewerPermission: 'ADMIN' },
            { nameWithOwner: 'example/read-only', isArchived: false, viewerPermission: 'READ' }
          ]
        } } } })
      }
      expect(query).toContain('\n  isEmpty\n')
      expect(query).toContain('\n  pushedAt\n')
      const batch = requestedNames(variables)
      queried.push(...batch)
      const payload = detailPayload(batch)
      for (const [index, name] of batch.entries()) {
        const base = repositoryNode(name)
        payload.data[`r${index}`] = name === names[0]
          ? {
              ...base, isEmpty: true, diskUsage: 0, pushedAt: null,
              createdAt: '2026-10-08T00:00:00.000Z', defaultBranchRef: null
            }
          : {
              ...base,
              createdAt: old,
              pushedAt: name === names[1] ? '2026-10-08T00:00:00.000Z' : old,
              defaultBranchRef: { target: { oid: name, committedDate: old, statusCheckRollup: { state: 'SUCCESS' } } }
            }
      }
      return jsonResponse(payload)
    }
    const result = await loadOverview({
      token: 'test-token', config: defaultOverviewConfig(), watchedRepos: [], now: NOW, fetchImpl
    })
    expect(queried).toEqual(names)
    expect(result.rows.find(row => row.name === names[0])).toMatchObject({ group: 'active', warnings: [{ kind: '空仓' }] })
    expect(result.rows.find(row => row.name === names[1])).toMatchObject({ group: 'active', lastCommitAt: old })
    expect(result.rows.find(row => row.name === names[2])).toMatchObject({ group: 'stale', warnings: [{ kind: '陈旧' }] })
    expect(result).toMatchObject({ fresh: true, errors: [], notices: [] })
  })

  it('respects the configured repository ceiling without lowering the detail field windows', async () => {
    const names = repoNames(13)
    const batches: string[][] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const { query, variables } = readRequest(init)
      expect(query).toContain('contexts(first: 10)')
      expect(query).toContain('pullRequests(states: OPEN, first: 40')
      expect(query).toContain('issues(states: [OPEN, CLOSED], first: 1')
      expect(query).toContain('recentPulls: pullRequests(states: [OPEN, CLOSED, MERGED], first: 1')
      expect(query).toContain('comments(last: 1)')
      expect(query).toContain('reviews(last: 1)')
      const batch = requestedNames(variables)
      batches.push(batch)
      const payload = detailPayload(batch)
      if (batch.includes(names[0]!)) {
        payload.data.r0 = {
          ...repositoryNode(names[0]!),
          pullRequests: {
            totalCount: 45,
            nodes: Array.from({ length: 40 }, (_, index) => ({
              number: index + 1,
              title: `PR ${index + 1}`,
              url: `https://github.com/${names[0]}/pull/${index + 1}`,
              createdAt: index === 39 ? '2026-09-01T00:00:00.000Z' : '2026-10-08T00:00:00.000Z',
              isDraft: false,
              reviewDecision: 'REVIEW_REQUIRED',
              reviews: { totalCount: 0 }
            }))
          },
          recentPulls: { nodes: [{ updatedAt: '2026-10-08T00:00:00.000Z', reviews: { nodes: [
            { submittedAt: '2026-10-09T00:00:00.000Z' }
          ] } }] }
        }
      }
      return jsonResponse(payload)
    }
    const result = await loadOverview({
      token: 'test-token', config: { ...defaultOverviewConfig(), maxScopeRepos: 9 },
      watchedRepos: names, now: NOW, fetchImpl
    })
    expect(batches.map(batch => batch.length)).toEqual([3, 3, 3])
    expect(batches.flat()).toEqual(names.slice(0, 9))
    expect(result.rows).toHaveLength(9)
    const rich = result.rows.find(row => row.name === names[0])!
    expect(rich.openPrCount).toBe(45)
    expect(rich.warnings[0]?.targets).toEqual([{ url: `https://github.com/${names[0]}/pull/40` }])
    expect(rich.stallBasis.lastIssueActivityAt).toBe('2026-10-09T00:00:00.000Z')
    expect(result.notices).toHaveLength(1)
    expect(result.notices[0]).toContain('上限 9')
  })

  it.each(['network', 'HTTP 502', 'GraphQL'])('does not retry individual repositories after a general $0 failure', async kind => {
    const names = repoNames(12)
    const queried: string[][] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const batch = requestedNames(readRequest(init).variables)
      queried.push(batch)
      if (batch[0] !== names[0]) return jsonResponse(detailPayload(batch))
      if (kind === 'network') throw new Error('socket disconnected')
      if (kind === 'HTTP 502') return jsonResponse({ message: 'bad gateway' }, 502)
      return jsonResponse({ data: null, errors: [{ message: 'Something went wrong executing the query' }] })
    }
    const result = await loadOverview({
      token: 'test-token', config: defaultOverviewConfig(), watchedRepos: names, now: NOW, fetchImpl
    })
    expect(queried).toHaveLength(4)
    expect(queried.every(batch => batch.length === 3)).toBe(true)
    const failed = result.rows.filter(row => row.error)
    expect(failed.map(row => row.name).sort()).toEqual(names.slice(0, 3))
    expect(failed.every(row => row.error?.startsWith('仓库查询失败：'))).toBe(true)
    expect(failed.every(row => !row.error?.includes('不存在'))).toBe(true)
    expect(result.rows.filter(row => !row.error).map(row => row.name)).toEqual(names.slice(3))
    expect(result.rows).toHaveLength(names.length)
  })

  it('reports timed out batches without turning them into per-repository retries', async () => {
    vi.useFakeTimers()
    const names = repoNames(12)
    const signals: AbortSignal[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      signals.push(init!.signal!)
      return await new Promise<Response>(() => {})
    }
    const pending = loadOverview({
      token: 'test-token', config: defaultOverviewConfig(), watchedRepos: names, now: NOW, fetchImpl
    })
    await vi.advanceTimersByTimeAsync(15_000)
    const result = await pending
    expect(signals).toHaveLength(4)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(result.rows).toHaveLength(names.length)
    expect(result.rows.every(row => row.error?.includes('请求超时'))).toBe(true)
  })

  it('isolates missing repository errors and preserves CI warnings when an optional field is unavailable', async () => {
    const names = repoNames(4)
    let requests = 0
    const result = await loadOverview({
      token: 'test-token', config: defaultOverviewConfig(), watchedRepos: names, now: NOW,
      fetchImpl: async (_url, init) => {
        requests += 1
        const batch = requestedNames(readRequest(init).variables)
        const data: Record<string, unknown> = {}
        const errors: Array<{ message: string, path: string[] }> = []
        batch.forEach((name, index) => {
          const alias = `r${index}`
          if (name === names[1] || name === names[3]) {
            data[alias] = null
            errors.push({ message: name === names[1] ? 'Could not resolve to a Repository' : 'Repository is disabled', path: [alias] })
          } else {
            data[alias] = repositoryNode(name)
            if (name === names[2]) {
              data[alias] = { ...repositoryNode(name), defaultBranchRef: { target: {
                oid: 'commit', committedDate: '2026-10-08T00:00:00.000Z', statusCheckRollup: { state: 'FAILURE' }
              } } }
              errors.push({ message: 'Issues are disabled for this repo', path: [alias, 'issues'] })
            }
          }
        })
        return jsonResponse({ data, errors })
      }
    })
    expect(requests).toBe(2)
    expect(result.rows.find(row => row.name === names[0])).toMatchObject({ error: null, ciState: 'success' })
    expect(result.rows.find(row => row.name === names[1])?.error).toBe('仓库不存在或无权访问')
    expect(result.rows.find(row => row.name === names[2])).toMatchObject({
      lastCommitAt: '2026-10-08T00:00:00.000Z',
      ciState: 'failure',
      error: null,
      warnings: [{ label: '卡住：CI 失败', targets: [{ url: `https://github.com/${names[2]}/actions` }] }]
    })
    expect(result.rows.find(row => row.name === names[3])?.error).toBe('仓库已停用或无权访问')
  })

  it('does not report unscoped GraphQL errors or missing response aliases as successful data', async () => {
    const names = repoNames(4)
    const result = await loadOverview({
      token: 'test-token', config: defaultOverviewConfig(), watchedRepos: names, now: NOW,
      fetchImpl: async (_url, init) => jsonResponse({
        data: { r0: repositoryNode(requestedNames(readRequest(init).variables)[0]!) },
        errors: [{ message: 'Query service temporarily unavailable' }]
      })
    })
    expect(result.rows.every(row => row.error === '仓库查询失败：Query service temporarily unavailable')).toBe(true)
    const incomplete = await loadOverview({
      token: 'test-token', config: defaultOverviewConfig(), watchedRepos: names, now: NOW,
      fetchImpl: async (_url, init) => jsonResponse({
        data: { r0: repositoryNode(requestedNames(readRequest(init).variables)[0]!) }
      })
    })
    expect(incomplete.rows.filter(row => row.error).map(row => row.error)).toEqual(Array(2).fill('仓库查询失败：GitHub 返回的仓库数据不完整'))
  })

  it.each([
    { status: 401, auth: 'invalid' },
    { status: 429, auth: 'ok' }
  ])('starts no new batch after HTTP $status and collects successful in-flight batches', async ({ status, auth }) => {
    const names = repoNames(36)
    const requests: Array<{ names: string[], response: ReturnType<typeof deferred<Response>> }> = []
    const pending = loadOverview({
      token: 'test-token', config: defaultOverviewConfig(), watchedRepos: names, now: NOW,
      fetchImpl: async (_url, init) => {
        const response = deferred<Response>()
        requests.push({ names: requestedNames(readRequest(init).variables), response })
        return await response.promise
      }
    })
    await vi.waitFor(() => expect(requests).toHaveLength(MAX_GITHUB_REQUESTS))
    requests[1]!.response.resolve(jsonResponse({ message: 'blocked' }, status, { 'x-ratelimit-reset': '1791500000' }))
    await new Promise(resolve => setImmediate(resolve))
    for (const [index, request] of requests.entries()) {
      if (index !== 1) request.response.resolve(jsonResponse(detailPayload(request.names)))
    }
    const result = await pending
    expect(requests).toHaveLength(MAX_GITHUB_REQUESTS)
    expect(result).toMatchObject({ fresh: false, auth })
    if (status === 401) {
      expect(result.rows).toEqual([])
      expect(result.errors[0]?.message).toContain('认证无效')
    } else {
      expect(result.rateLimitResetAt).toBe(new Date(1791500000 * 1000).toISOString())
      expect(result.rows.map(row => row.name)).toEqual([...names.slice(0, 3), ...names.slice(6, MAX_GITHUB_REQUESTS * 3)])
      expect(result.rows.every(row => row.error === null)).toBe(true)
    }
  })

  it('cancels in-flight requests and does not assign further batches or retries', async () => {
    const controller = new AbortController()
    const signals: AbortSignal[] = []
    const pending = loadOverview({
      token: 'test-token', config: defaultOverviewConfig(), watchedRepos: repoNames(36), now: NOW,
      signal: controller.signal,
      fetchImpl: async (_url, init) => {
        signals.push(init!.signal!)
        return await new Promise<Response>(() => {})
      }
    })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(signals).toHaveLength(MAX_GITHUB_REQUESTS))
    controller.abort(Object.assign(new Error('Refresh cancelled'), { name: 'AbortError' }))
    await rejected
    expect(signals).toHaveLength(MAX_GITHUB_REQUESTS)
    expect(signals.every(signal => signal.aborted)).toBe(true)
  })
})
