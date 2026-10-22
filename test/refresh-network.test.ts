import { describe, expect, it } from 'vitest'
import { MAX_GITHUB_REQUESTS, createGithubRequestScheduler, mapConcurrentOrdered } from '../src/github/concurrency.js'
import { githubGraphql } from '../src/github/client.js'
import { GithubAuthError, GithubRateLimitError } from '../src/shared/waiting/rate-limit.js'
import { defaultOverviewConfig } from '../src/shared/overview/rules.js'
import { defaultWaitingConfig } from '../src/shared/waiting/rules.js'
import type { OverviewConfig } from '../src/shared/overview/types.js'
import type { WaitingConfig } from '../src/shared/waiting/types.js'
import { loadOverview } from '../src/overview/load.js'
import { loadGithubRecords } from '../src/waiting/github-load.js'

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

interface GraphqlRequest {
  query: string
  variables: Record<string, unknown>
}

function readRequest(init?: RequestInit): GraphqlRequest {
  return JSON.parse(String(init?.body ?? '{}')) as GraphqlRequest
}

function namedVariables(variables: Record<string, unknown>, prefix: string): string[] {
  return Object.keys(variables)
    .filter(key => new RegExp(`^${prefix}\\d+$`).test(key))
    .sort((left, right) => Number(left.slice(prefix.length)) - Number(right.slice(prefix.length)))
    .map(key => String(variables[key]))
}

function waitingConfig(patch: Partial<WaitingConfig> = {}): WaitingConfig {
  const defaults = defaultWaitingConfig()
  return {
    ...defaults,
    ...patch,
    sources: { ...defaults.sources, ...patch.sources }
  }
}

function overviewConfig(patch: Partial<OverviewConfig> = {}): OverviewConfig {
  return { ...defaultOverviewConfig(), ...patch }
}

function metadataNode(name: string): Record<string, unknown> {
  return {
    nameWithOwner: `ada/${name}`,
    description: '',
    isEmpty: false,
    pushedAt: '2026-10-07T00:00:00.000Z',
    isFork: false,
    viewerPermission: 'ADMIN',
    owner: { login: 'ada' },
    repositoryTopics: { nodes: [{ topic: { name: 'ready' } }] }
  }
}

function metadataPayload(variables: Record<string, unknown>): unknown {
  const data: Record<string, unknown> = {}
  namedVariables(variables, 'n').forEach((name, index) => {
    data[`r${index}`] = metadataNode(name)
  })
  return { data }
}

function contentPayload(variables: Record<string, unknown>, hasMore: boolean): unknown {
  const data: Record<string, unknown> = {}
  namedVariables(variables, 'n').forEach((name, index) => {
    const issueCursor = `issue-${name}`
    const pullCursor = `pull-${name}`
    const issuePage = variables[`ia${index}`] === null ? 1 : 2
    const pullPage = variables[`pa${index}`] === null ? 1 : 2
    data[`r${index}`] = {
      nameWithOwner: `ada/${name}`,
      description: '',
      repositoryTopics: { nodes: [] },
      isEmpty: false,
      pushedAt: '2026-10-07T00:00:00.000Z',
      issues: {
        pageInfo: { hasNextPage: hasMore && issuePage === 1, endCursor: hasMore && issuePage === 1 ? issueCursor : null },
        nodes: [{
          number: issuePage,
          title: `${name} issue ${issuePage}`,
          url: `https://github.com/ada/${name}/issues/${issuePage}`,
          body: '',
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
          subIssues: { nodes: [] },
          labels: { nodes: [] },
          comments: { nodes: [] },
          timelineItems: { nodes: [] }
        }]
      },
      pullRequests: {
        pageInfo: { hasNextPage: hasMore && pullPage === 1, endCursor: hasMore && pullPage === 1 ? pullCursor : null },
        nodes: [{
          number: pullPage,
          title: `${name} pull ${pullPage}`,
          url: `https://github.com/ada/${name}/pull/${pullPage}`,
          body: '',
          isDraft: false,
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
          labels: { nodes: [] },
          comments: { nodes: [] },
          commits: { nodes: [] },
          reviews: { nodes: [] },
          timelineItems: { nodes: [] }
        }]
      }
    }
  })
  return { data }
}

describe('GitHub refresh network concurrency', () => {
  it('keeps concurrent GitHub requests within the refresh bound', async () => {
    let active = 0
    let peak = 0
    const scheduler = createGithubRequestScheduler({ timeoutMs: 1_000 })
    const fetchImpl: typeof fetch = async () => {
      active += 1
      peak = Math.max(peak, active)
      await delay(8)
      active -= 1
      return jsonResponse({ data: { ok: true } })
    }

    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      githubGraphql('test-token', `query { value${index} }`, {}, fetchImpl, scheduler)
    ))

    expect(peak).toBe(MAX_GITHUB_REQUESTS)
  })

  it('aborts a request whose response body read exceeds the timeout', async () => {
    let signal: AbortSignal | null | undefined
    const hangingResponse = {
      status: 200,
      ok: true,
      headers: new Headers(),
      text: () => new Promise<string>(() => {})
    } as Response
    const scheduler = createGithubRequestScheduler({ timeoutMs: 15 })
    const fetchImpl: typeof fetch = async (_input, init) => {
      signal = init?.signal
      return hangingResponse
    }

    await expect(githubGraphql('test-token', 'query { value }', {}, fetchImpl, scheduler))
      .rejects.toThrow(/请求超时/)
    expect(signal?.aborted).toBe(true)
  })

  it.each([
    { label: 'authentication', status: 401, expected: GithubAuthError },
    {
      label: 'rate limit',
      status: 429,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791500000' },
      expected: GithubRateLimitError
    }
  ])('stops queued fetches after a $label failure', async ({ status, headers, expected }) => {
    let releaseSecond: ((response: Response) => void) | undefined
    const started: string[] = []
    const scheduler = createGithubRequestScheduler({ concurrency: 2, timeoutMs: 1_000 })
    const fetchImpl: typeof fetch = async (_input, init) => {
      const { query } = readRequest(init)
      started.push(query)
      if (query.includes('value0')) return jsonResponse({ errors: [{ message: 'blocked' }] }, status, headers)
      if (query.includes('value1')) {
        return await new Promise<Response>(resolve => { releaseSecond = resolve })
      }
      return jsonResponse({ data: { ok: true } })
    }
    const pending = Promise.allSettled(Array.from({ length: 5 }, (_, index) =>
      githubGraphql('test-token', `query { value${index} }`, {}, fetchImpl, scheduler)
    ))
    for (let attempt = 0; attempt < 50 && !scheduler.stopped; attempt += 1) await delay(1)

    expect(scheduler.stopped).toBeInstanceOf(expected)
    expect(started).toEqual(['query { value0 }', 'query { value1 }'])
    releaseSecond?.(jsonResponse({ data: { ok: true } }))
    const results = await pending
    expect(results[0]?.status).toBe('rejected')
    if (results[0]?.status === 'rejected') expect(results[0].reason).toBeInstanceOf(expected)
    expect(results.slice(2).every(result => result.status === 'rejected')).toBe(true)
    expect(started).toHaveLength(2)
  })

  it('does not multiply ordinary overview batch failures into single-repository retries', async () => {
    const names = ['alpha', 'bravo', 'charlie', 'delta']
    let activeSingles = 0
    let peakSingles = 0
    let fetches = 0
    const startedSingles: string[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      fetches += 1
      const { variables } = readRequest(init)
      if (namedVariables(variables, 'n').length > 1) throw new Error('batch unavailable')
      const name = String(variables.n0)
      startedSingles.push(name)
      activeSingles += 1
      peakSingles = Math.max(peakSingles, activeSingles)
      await delay(name === 'alpha' ? 24 : 4)
      activeSingles -= 1
      return jsonResponse({
        data: {
          r0: {
            nameWithOwner: `example/${name}`,
            url: `https://github.com/example/${name}`,
            isEmpty: false,
            diskUsage: 8,
            pushedAt: '2026-10-07T00:00:00.000Z',
            createdAt: '2026-09-01T00:00:00.000Z',
            defaultBranchRef: {
              target: { oid: name, committedDate: '2026-10-07T00:00:00.000Z', statusCheckRollup: { state: 'SUCCESS' } }
            },
            pullRequests: { totalCount: 0, nodes: [] }
          }
        }
      })
    }

    const result = await loadOverview({
      token: 'test-token',
      config: overviewConfig(),
      watchedRepos: names.map(name => `example/${name}`),
      now: new Date('2026-10-08T00:00:00.000Z'),
      fetchImpl
    })

    // The final one-repository slice is a normal tail batch, not a retry.
    expect(peakSingles).toBe(1)
    expect(startedSingles).toEqual(['delta'])
    expect(fetches).toBe(2)
    expect(result.rows.map(row => row.name)).toEqual(['delta', ...names.slice(0, 3)].map(name => `example/${name}`))
    expect(result.rows.filter(row => row.name !== 'example/delta').every(row => /连不上 GitHub/.test(row.error ?? ''))).toBe(true)
    expect(result.rows.find(row => row.name === 'example/delta')?.error).toBeNull()
  })

  it('keeps Waiting cursor pages serial and merges concurrent batches in input order', async () => {
    const names = Array.from({ length: 16 }, (_, index) => `repo-${String(index).padStart(2, '0')}`)
    let activeContents = 0
    let peakContents = 0
    let firstPageFinished = 0
    const pageCursors: Array<{ name: string, issueCursor: unknown, pullCursor: unknown }> = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const { query, variables } = readRequest(init)
      if (/viewer\s*\{\s*login\s*\}/.test(query)) return jsonResponse({ data: { viewer: { login: 'ada' } } })
      if (!query.includes('issues(states: OPEN, first: 40')) return jsonResponse(metadataPayload(variables))

      activeContents += 1
      peakContents = Math.max(peakContents, activeContents)
      const batchNames = namedVariables(variables, 'n')
      const secondPage = variables.ia0 !== null || variables.pa0 !== null
      for (let index = 0; index < batchNames.length; index += 1) {
        pageCursors.push({
          name: batchNames[index] ?? '',
          issueCursor: variables[`ia${index}`],
          pullCursor: variables[`pa${index}`]
        })
      }
      if (secondPage) expect(firstPageFinished).toBe(6)
      await delay(secondPage ? 2 : (batchNames[0] === names[0] ? 20 : 4))
      const payload = contentPayload(variables, !secondPage)
      if (!secondPage) firstPageFinished += 1
      activeContents -= 1
      return jsonResponse(payload)
    }
    const config = waitingConfig({
      maxScopeRepos: names.length,
      sources: {
        assignee: false,
        reviewRequested: false,
        mentions: false,
        openPrs: true,
        humanIssues: false,
        statusDocs: false,
        todos: false
      }
    })

    const result = await loadGithubRecords({
      token: 'test-token',
      config,
      watchedRepos: names.map(name => `ada/${name}`),
      fetchImpl
    })

    expect(peakContents).toBe(MAX_GITHUB_REQUESTS)
    expect(firstPageFinished).toBe(6)
    expect(pageCursors.filter(cursor => cursor.issueCursor !== undefined).map(cursor => cursor.name)).toEqual([
      ...names,
      ...names
    ])
    expect(pageCursors.filter(cursor => cursor.issueCursor !== null).map(cursor => cursor.issueCursor)).toEqual([
      ...names.map(name => `issue-${name}`)
    ])
    expect(result.bySource.openPrs.map(record => `${record.repo}#${record.number}`)).toEqual([
      ...names.map((name) => `ada/${name}#1`),
      ...names.map((name) => `ada/${name}#2`)
    ])
  })

  it('isolates schema downgrades between concurrent Waiting batches', async () => {
    const names = Array.from({ length: 16 }, (_, index) => `repo-${String(index).padStart(2, '0')}`)
    const contentQueries: Array<{ firstRepo: string, query: string }> = []
    const searchQueries: string[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const { query, variables } = readRequest(init)
      if (/viewer\s*\{\s*login\s*\}/.test(query)) return jsonResponse({ data: { viewer: { login: 'ada' } } })
      if (query.includes('search(')) {
        searchQueries.push(query)
        return jsonResponse({ data: { search: { pageInfo: { hasNextPage: false }, nodes: [] } } })
      }
      if (!query.includes('issues(states: OPEN, first: 40')) return jsonResponse(metadataPayload(variables))

      const firstRepo = String(variables.n0)
      contentQueries.push({ firstRepo, query })
      if (firstRepo === 'repo-00' && query.includes('repositoryTopics')) {
        return jsonResponse({ data: null, errors: [{ message: "Field 'repositoryTopics' doesn't exist on Repository" }] })
      }
      if (firstRepo === 'repo-06' && query.includes('repositoryTopics') && query.includes('parent')) {
        await delay(30)
        return jsonResponse({ data: null, errors: [{ message: "Field 'parent' doesn't exist on Issue" }] })
      }
      if (firstRepo === 'repo-00' && !query.includes('repositoryTopics')) {
        return jsonResponse(contentPayload(variables, false))
      }
      if (firstRepo === 'repo-06' && query.includes('repositoryTopics') && !query.includes('parent')) {
        return jsonResponse(contentPayload(variables, false))
      }
      return jsonResponse(contentPayload(variables, false))
    }
    const config = waitingConfig({
      maxScopeRepos: names.length,
      sources: {
        assignee: true,
        reviewRequested: false,
        mentions: false,
        openPrs: true,
        humanIssues: false,
        statusDocs: false,
        todos: false
      }
    })

    const result = await loadGithubRecords({
      token: 'test-token',
      config,
      watchedRepos: names.map(name => `ada/${name}`),
      fetchImpl
    })

    const secondBatchRetry = contentQueries.find(item => item.firstRepo === 'repo-06' && !item.query.includes('parent'))
    expect(secondBatchRetry?.query).toContain('repositoryTopics(first: 20)')
    expect(secondBatchRetry?.query).not.toContain('parent')
    expect(searchQueries).toHaveLength(1)
    // Search and repository sources now start independently; the search starts
    // before repository batches discover optional fields are unsupported.
    expect(searchQueries[0]).toContain('repositoryTopics')
    expect(searchQueries[0]).toContain('parent')
    expect(result.errors).toEqual([])
  })

  it('keeps ordered concurrent helper results when ordinary tasks finish out of order', async () => {
    const result = await mapConcurrentOrdered(['slow', 'fast', 'last'], 2, async value => {
      await delay(value === 'slow' ? 20 : 2)
      return value
    })
    expect(result).toEqual(['slow', 'fast', 'last'])
  })
})
