import { describe, expect, it, vi } from 'vitest'
import { MAX_GITHUB_REQUESTS } from '../src/github/concurrency.js'
import { assembleWaiting } from '../src/shared/waiting/assemble.js'
import { blankRecord } from '../src/shared/waiting/parse-github.js'
import { defaultWaitingConfig } from '../src/shared/waiting/rules.js'
import type { WaitingConfig } from '../src/shared/waiting/types.js'
import { loadGithubRecords } from '../src/waiting/github-load.js'
import { collectWaiting, emptyWaitingMemory } from '../src/waiting/collect.js'

interface Request {
  query: string
  variables: Record<string, unknown>
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

function config(patch: Omit<Partial<WaitingConfig>, 'sources'> & { sources?: Partial<WaitingConfig['sources']> } = {}): WaitingConfig {
  const defaults = defaultWaitingConfig()
  return {
    ...defaults,
    ...patch,
    humanKeywords: patch.humanKeywords ?? [],
    humanLabels: patch.humanLabels ?? ['human'],
    sources: {
      ...defaults.sources,
      assignee: false, reviewRequested: false, mentions: false, openPrs: false, humanIssues: false,
      ...patch.sources
    }
  }
}

function repository(full: string, isEmpty = false): Record<string, unknown> {
  const owner = full.split('/')[0]
  return {
    nameWithOwner: full, description: '', isEmpty, pushedAt: '2026-10-08T00:00:00.000Z',
    isFork: false, viewerPermission: owner === 'ada' ? 'ADMIN' : 'READ', owner: { login: owner },
    repositoryTopics: { nodes: [] }
  }
}

function names(variables: Record<string, unknown>): string[] {
  return Object.keys(variables).filter(key => /^n\d+$/.test(key))
    .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)))
    .map(key => String(variables[key]))
}

function issue(full: string, number: number): unknown {
  return {
    __typename: 'Issue', number, title: `issue ${number}`, url: `https://github.com/${full}/issues/${number}`,
    body: '', state: 'OPEN', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
    repository: repository(full), author: { login: 'ada' }, labels: { nodes: [] }, comments: { nodes: [] },
    timelineItems: { nodes: [] }, parent: null, subIssues: { nodes: [] }
  }
}

function search(nodes: unknown[] = [], hasNextPage = false): Response {
  return json({ data: { search: { nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? 'NEXT' : null } } } })
}

function contents(request: Request, withIssues = false, complete = true): Response {
  const data: Record<string, unknown> = {}
  names(request.variables).forEach((name, index) => {
    const full = `${request.variables[`o${index}`]}/${name}`
    data[`r${index}`] = {
      ...repository(full),
      issues: { nodes: withIssues ? [issue(full, 1)] : [], pageInfo: complete ? { hasNextPage: false } : {} },
      pullRequests: { nodes: [], pageInfo: { hasNextPage: false } }
    }
  })
  return json({ data })
}

function explicitFetch(handler: (request: Request) => Promise<Response>, emptyRepos: readonly string[] = []): typeof fetch {
  return async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as Request
    if (/viewer\s*\{\s*login\s*\}/.test(request.query)) return json({ data: { viewer: { login: 'ada' } } })
    if (!request.query.includes('issues(states: OPEN, first: 40') && !request.query.includes('search(') && !request.query.includes('issue(number:')) {
      const data: Record<string, unknown> = {}
      names(request.variables).forEach((name, index) => {
        const full = `${request.variables[`o${index}`]}/${name}`
        data[`r${index}`] = repository(full, emptyRepos.includes(full))
      })
      return json({ data })
    }
    return handler(request)
  }
}

describe('Waiting refresh performance and source integrity', () => {
  it('keeps full content windows across three-repository batches and a final tail', async () => {
    const repos = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const batches: string[][] = []
    const fetchImpl = explicitFetch(async request => {
      batches.push(names(request.variables))
      expect(request.query).toContain('issues(states: OPEN, first: 40')
      expect(request.query).toContain('subIssues(first: 1)')
      expect(request.query).toContain('comments(last: 8)')
      return contents(request, true)
    })
    const result = await loadGithubRecords({
      token: 'test-token', watchedRepos: repos.map(name => `ada/${name}`), fetchImpl,
      config: config({ sources: { humanIssues: true, openPrs: true } })
    })
    expect(batches).toEqual([repos.slice(0, 3), repos.slice(3, 6), ['g']])
    expect(result.bySource.humanIssues.map(record => record.repo)).toEqual(repos.map(name => `ada/${name}`))
    expect(result.fresh.humanIssues).toBe(true)
    expect(result.errors).toEqual([])
  })
  it('overlaps personal searches, author and both content groups, then skips fully covered keyword searches', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<Response>>>()
    const requests = new Map<string, Request>()
    const fetchImpl = explicitFetch(async request => {
      const text = String(request.variables.q ?? '')
      const key = request.query.includes('issues(states: OPEN, first: 40')
        ? `contents:${request.variables.o0}/${request.variables.n0}`
        : text.split(' ')[0]!
      const gate = deferred<Response>()
      requests.set(key, request)
      gates.set(key, gate)
      return gate.promise
    }, ['ada/empty'])
    const pending = loadGithubRecords({
      token: 'test-token', watchedRepos: ['ada/empty', 'other/watched'], fetchImpl,
      config: config({ openPrScope: 'watching', sources: {
        assignee: true, reviewRequested: true, mentions: true, openPrs: true, humanIssues: true
      } })
    })

    await vi.waitFor(() => expect(gates.size).toBe(6))
    expect(gates.size).toBeLessThanOrEqual(MAX_GITHUB_REQUESTS)
    expect([...gates.keys()]).toEqual([
      'contents:ada/empty', 'contents:other/watched',
      'assignee:@me', 'review-requested:@me', 'mentions:@me', 'author:@me'
    ])
    gates.get('contents:other/watched')!.resolve(contents(requests.get('contents:other/watched')!, true))
    await new Promise<void>(resolve => setImmediate(resolve))
    for (const [key, gate] of gates) {
      const request = requests.get(key)!
      gate.resolve(key.startsWith('contents:') ? contents(request, true) : search())
    }
    const result = await pending
    expect(gates.has('is:issue')).toBe(false)
    expect(result.errors).toEqual([])
    expect(result.fresh).toEqual({ assignee: true, reviewRequested: true, mentions: true, openPrs: true, humanIssues: true })
    expect(result.bySource.humanIssues.map(record => record.repo)).toEqual(['ada/empty', 'other/watched'])
    expect(requests.get('contents:ada/empty')!.query).not.toContain('pullRequests(')
    expect(requests.get('contents:other/watched')!.query).toContain('pullRequests(')
  })

  it.each(['human', 'author'] as const)('runs independent %s repo-clause searches together and merges by query order', async kind => {
    const owner = kind === 'human' ? 'ada' : 'other'
    const repos = Array.from({ length: 16 }, (_, index) => `${owner}/repo-${index}`)
    const gates: Array<{ request: Request, gate: ReturnType<typeof deferred<Response>> }> = []
    const fetchImpl = explicitFetch(async request => {
      if (request.query.includes('issues(states: OPEN, first: 40')) return contents(request, false, false)
      if (String(request.variables.q).startsWith('mentions:')) return search()
      const gate = deferred<Response>()
      gates.push({ request, gate })
      return gate.promise
    })
    const pending = loadGithubRecords({ token: 'test-token', watchedRepos: repos, fetchImpl,
      config: config({ sources: kind === 'human' ? { humanIssues: true } : { mentions: true } }) })
    await vi.waitFor(() => expect(gates).toHaveLength(2))
    gates[1]!.gate.resolve(search([issue(repos[8]!, 2)]))
    gates[0]!.gate.resolve(search([issue(repos[0]!, 1)]))
    const result = await pending
    expect(result.errors).toEqual([])
    expect(result.bySource.humanIssues.map(record => record.number)).toEqual([1, 2])
    expect(gates[0]!.request.variables.q).toContain(`repo:${repos[0]}`)
    expect(gates[1]!.request.variables.q).toContain(`repo:${repos[8]}`)
  })

  it.each([401, 429])('stops new keyword pages and queued queries after HTTP %s without making a partial source fresh', async status => {
    const repos = Array.from({ length: 104 }, (_, index) => `ada/repo-${index}`)
    const gates: Array<ReturnType<typeof deferred<Response>>> = []
    const fetchImpl = explicitFetch(async request => {
      if (request.query.includes('issues(states: OPEN, first: 40')) return contents(request, false, false)
      const gate = deferred<Response>()
      gates.push(gate)
      return gate.promise
    })
    const pending = loadGithubRecords({ token: 'test-token', watchedRepos: repos, fetchImpl,
      config: config({ maxScopeRepos: repos.length, sources: { humanIssues: true } }) })
    await vi.waitFor(() => expect(gates).toHaveLength(MAX_GITHUB_REQUESTS))
    gates[0]!.resolve(json({ message: 'blocked' }, status, {
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791500000'
    }))
    // Keep the already running requests suspended until the fatal result has been consumed.
    await gates[0]!.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    gates.slice(1).forEach(gate => gate.resolve(search([], true)))
    const result = await pending
    expect(gates).toHaveLength(MAX_GITHUB_REQUESTS)
    expect(result.errors.some(error => error.source === '要人动手')).toBe(true)
    expect(result.fresh.humanIssues).toBe(false)
    expect(result.auth).toBe(status === 401 ? 'invalid' : 'ok')
    expect(result.rateLimitResetAt).toBe(status === 429 ? new Date(1791500000 * 1000).toISOString() : null)
  })

  it('isolates simultaneous schema retries and keeps later tasklist queries at the relaxed schema', async () => {
    const repos = Array.from({ length: 16 }, (_, index) => `ada/repo-${index}`)
    const firstParentError = deferred<Response>()
    const secondTopicsError = deferred<Response>()
    const searchQueries: Array<{ first: boolean, query: string }> = []
    let tasklistQuery = ''
    const fetchImpl: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Request
      if (request.query.includes('issue(number:')) {
        tasklistQuery = request.query
        return json({ data: { r0: { ...repository(repos[0]!), issue: issue(repos[0]!, 99) } } })
      }
      return explicitFetch(async next => {
        if (next.query.includes('issues(states: OPEN, first: 40')) return contents(next, false, false)
        const first = String(next.variables.q).includes('repo:ada/repo-0 ')
        searchQueries.push({ first, query: next.query })
        if (first && next.query.includes('parent {')) return firstParentError.promise
        if (!first && next.query.includes('repositoryTopics')) return secondTopicsError.promise
        if (first) return search([{ ...(issue(repos[0]!, 1) as object), body: '- [ ] #99' }])
        return search()
      })(_input, init)
    }
    const pending = loadGithubRecords({ token: 'test-token', watchedRepos: repos, fetchImpl,
      config: config({ sources: { humanIssues: true } }) })
    await vi.waitFor(() => expect(searchQueries).toHaveLength(2))
    firstParentError.resolve(json({ data: null, errors: [{ message: "Field 'parent' doesn't exist on Issue" }] }))
    await vi.waitFor(() => expect(searchQueries.some(item => item.first && !item.query.includes('parent {'))).toBe(true))
    secondTopicsError.resolve(json({ data: null, errors: [{ message: "Field 'repositoryTopics' doesn't exist on Repository" }] }))
    const result = await pending
    const firstRetry = searchQueries.find(item => item.first && !item.query.includes('parent {'))!
    const secondRetry = searchQueries.find(item => !item.first && !item.query.includes('repositoryTopics'))!
    expect(firstRetry.query).toContain('repositoryTopics')
    expect(secondRetry.query).toContain('parent {')
    expect(tasklistQuery).not.toContain('parent {')
    expect(result.errors).toEqual([])
    expect(result.bySource.humanIssues.map(record => record.number)).toEqual([1, 99])
  })

  it('keeps failed human fallback stale after a successful but unproven contents result', async () => {
    const contentGate = deferred<Response>()
    const humanGate = deferred<Response>()
    let contentRequest: Request | undefined
    const fetchImpl = explicitFetch(async request => {
      if (request.query.includes('issues(states: OPEN, first: 40')) {
        contentRequest = request
        return contentGate.promise
      }
      return humanGate.promise
    })
    const pending = loadGithubRecords({ token: 'test-token', watchedRepos: ['ada/demo'], fetchImpl,
      config: config({ sources: { humanIssues: true, openPrs: true } }) })
    await vi.waitFor(() => expect(contentRequest).toBeDefined())
    contentGate.resolve(contents(contentRequest!, true, false))
    humanGate.resolve(json({ data: null, errors: [{ message: 'search unavailable' }] }))
    const result = await pending
    expect(result.bySource.humanIssues).toHaveLength(1)
    expect(result.fresh.openPrs).toBe(true)
    expect(result.fresh.humanIssues).toBe(false)
    expect(result.errors).toEqual([{ source: '要人动手', message: 'search unavailable' }])
  })

  it('searches only repositories still capped after four content pages', async () => {
    const seen: Array<{ repo: string, after: unknown }> = []
    const queries: string[] = []
    const fetchImpl = explicitFetch(async request => {
      if (request.query.includes('search(')) {
        queries.push(String(request.variables.q))
        return search([issue('ada/capped', 99)])
      }
      const data: Record<string, unknown> = {}
      names(request.variables).forEach((name, index) => {
        const page = Number(String(request.variables[`ia${index}`] ?? '0').replace('PAGE_', '')) + 1
        seen.push({ repo: name, after: request.variables[`ia${index}`] })
        const hasNextPage = name === 'capped' || page === 1
        data[`r${index}`] = { ...repository(`ada/${name}`),
          issues: { nodes: [issue(`ada/${name}`, page)], pageInfo: { hasNextPage, endCursor: hasNextPage ? `PAGE_${page}` : null } }
        }
      })
      return json({ data })
    })
    const result = await loadGithubRecords({ token: 'test-token', watchedRepos: ['ada/complete', 'ada/capped'], fetchImpl,
      config: config({ sources: { humanIssues: true } }) })
    expect(seen.filter(item => item.repo === 'complete')).toHaveLength(2)
    expect(seen.filter(item => item.repo === 'capped')).toHaveLength(4)
    expect(queries).toHaveLength(1)
    expect(queries[0]).toContain('repo:ada/capped')
    expect(queries[0]).not.toContain('repo:ada/complete')
    expect(result.bySource.humanIssues.filter(record => record.repo === 'ada/complete').map(record => record.number)).toEqual([1, 2])
    expect(result.bySource.humanIssues.filter(record => record.repo === 'ada/capped').map(record => record.number)).toEqual([1, 2, 3, 4, 99])
    expect(result.errors).toEqual([])
    expect(result.fresh.humanIssues).toBe(true)
  })

  it.each(['missing connection', 'missing page info', 'missing cursor', 'null node', 'partial errors'] as const)(
    'keeps human search when repository coverage has %s', async defect => {
      let searches = 0
      const fetchImpl = explicitFetch(async request => {
        if (request.query.includes('search(')) {
          searches += 1
          return search([issue('ada/demo', 7)])
        }
        let connection: unknown = { nodes: [], pageInfo: { hasNextPage: false } }
        if (defect === 'missing connection') connection = null
        if (defect === 'missing page info') connection = { nodes: [] }
        if (defect === 'missing cursor') connection = { nodes: [], pageInfo: { hasNextPage: true } }
        if (defect === 'null node') connection = { nodes: [null], pageInfo: { hasNextPage: false } }
        return json({ data: { r0: { ...repository('ada/demo'), issues: connection } },
          ...(defect === 'partial errors' ? { errors: [{ message: 'some issue data unavailable', path: ['r0', 'issues'] }] } : {}) })
      })
      const result = await loadGithubRecords({ token: 'test-token', watchedRepos: ['ada/demo'], fetchImpl,
        config: config({ sources: { humanIssues: true } }) })
      expect(searches).toBe(1)
      expect(result.bySource.humanIssues.map(record => record.number)).toEqual([7])
    }
  )

  it('retains cached human rows and the contents error even when fallback search succeeds', async () => {
    let searches = 0
    const fetchImpl = explicitFetch(async request => {
      if (request.query.includes('issues(states: OPEN, first: 40')) return json({ data: null, errors: [{ message: 'content unavailable' }] })
      searches += 1
      return search([issue('ada/demo', 8)])
    })
    const rules = config({ sources: { humanIssues: true } })
    const result = await loadGithubRecords({ token: 'test-token', watchedRepos: ['ada/demo'], fetchImpl, config: rules })
    expect(searches).toBe(1)
    expect(result.bySource.humanIssues.map(record => record.number)).toEqual([8])
    expect(result.errors).toEqual([{ source: '仓库内容', message: 'content unavailable' }])
    expect(result.fresh.humanIssues).toBe(false)
    const memory = emptyWaitingMemory()
    memory.humanIssues = [blankRecord({ kind: 'issue', repo: 'ada/demo', number: 4, title: 'cached', url: 'https://github.com/ada/demo/issues/4' })]
    const collected = await collectWaiting({ token: 'test-token', config: rules, watchedRepos: ['ada/demo'], fetchImpl,
      memory, now: new Date('2026-10-09T00:00:00.000Z') })
    expect(collected.memory.humanIssues).toEqual(memory.humanIssues)
    expect(collected.errors).toEqual(result.errors)
  })

  it('keeps meaningful Waiting rows identical when full enumeration replaces duplicate keyword hits', async () => {
    const child = { ...(issue('ada/demo', 2) as object), body: '请确认子任务', labels: { nodes: [{ name: 'human' }] } }
    const parent = { ...(issue('ada/demo', 1) as object), body: '请确认', labels: { nodes: [{ name: 'human' }] },
      comments: { nodes: [{ body: '仍需确认', createdAt: '2026-10-08T12:00:00.000Z', author: { login: 'ada' } }] },
      subIssues: { nodes: [child] } }
    const rules = config({ sources: { humanIssues: true } })
    const run = async (complete: boolean) => {
      let searchCount = 0
      const fetchImpl = explicitFetch(async request => {
        if (request.query.includes('issue(number:')) {
          return json({ data: { r0: { issue: { number: 1, subIssues: { nodes: [child] } } } } })
        }
        if (request.query.includes('search(')) {
          searchCount += 1
          return search([parent, child])
        }
        return json({ data: { r0: { ...repository('ada/demo'),
          issues: { nodes: [parent, child], pageInfo: complete ? { hasNextPage: false } : {} }
        } } })
      })
      const loaded = await loadGithubRecords({ token: 'test-token', config: rules, watchedRepos: ['ada/demo'], fetchImpl })
      const rows = assembleWaiting({ records: Object.values(loaded.bySource).flat(), config: rules,
        statusDocs: [], branches: [], todos: [], now: new Date('2026-10-09T00:00:00.000Z') })
      return { rows, searchCount, fresh: loaded.fresh.humanIssues }
    }
    const fallback = await run(false)
    const covered = await run(true)
    expect(fallback.searchCount).toBe(1)
    expect(covered.searchCount).toBe(0)
    expect(covered.rows).toEqual(fallback.rows)
    expect(new Set(covered.rows.map(row => row.number))).toEqual(new Set([1, 2]))
    expect(covered.fresh).toBe(true)
  })

  it('combines automatic scope first pages with login, keeps owned priority and avoids excess watch pagination', async () => {
    const requests: Request[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Request
      requests.push(request)
      if (requests.length === 1) {
        return json({ data: { viewer: {
          login: 'ada',
          repositories: { nodes: [repository('ada/owned')], pageInfo: { hasNextPage: false } },
          watching: { nodes: [repository('other/one'), repository('other/two')], pageInfo: { hasNextPage: true, endCursor: 'WATCH_NEXT' } }
        } } })
      }
      if (request.query.includes('search(')) return search()
      return contents(request, true)
    }
    const result = await loadGithubRecords({ token: 'test-token', watchedRepos: [], fetchImpl,
      config: config({ maxScopeRepos: 2, humanLabels: [], sources: { humanIssues: true } }) })
    expect(requests[0]!.query).toContain('login')
    expect(requests[0]!.query).toContain('ownerAffiliations: [OWNER]')
    expect(requests[0]!.query).toContain('watching(first: 40, orderBy: {field: PUSHED_AT, direction: DESC})')
    expect(requests).toHaveLength(3)
    expect(requests.filter(request => request.query.includes('watching('))).toHaveLength(1)
    expect(result.errors).toEqual([])
    expect(result.notices).toHaveLength(1)
    expect(result.bySource.humanIssues.map(record => record.repo)).toEqual(['ada/owned'])
  })

  it('continues owned pages after the combined first response before using the remaining watch room', async () => {
    const scopeRequests: Request[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Request
      if (request.query.includes('issues(states: OPEN, first: 40')) return contents(request, true)
      if (request.query.includes('search(')) return search()
      scopeRequests.push(request)
      if (scopeRequests.length === 1) return json({ data: { viewer: {
        login: 'ada',
        repositories: { nodes: [repository('ada/first')], pageInfo: { hasNextPage: true, endCursor: 'OWN_NEXT' } },
        watching: { nodes: [repository('other/watch')], pageInfo: { hasNextPage: false } }
      } } })
      expect(request.variables.cursor).toBe('OWN_NEXT')
      return json({ data: { viewer: { repositories: {
        nodes: [repository('ada/second')], pageInfo: { hasNextPage: false }
      } } } })
    }
    const result = await loadGithubRecords({ token: 'test-token', watchedRepos: [], fetchImpl,
      config: config({ maxScopeRepos: 3, humanLabels: [], sources: { humanIssues: true } }) })
    expect(scopeRequests).toHaveLength(2)
    expect(result.errors).toEqual([])
    expect(result.notices).toEqual([])
    expect(result.bySource.humanIssues.map(record => record.repo)).toEqual(['ada/first', 'ada/second'])
  })

  it('keeps global personal sources available when automatic repository discovery fails normally', async () => {
    const requests: Request[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Request
      requests.push(request)
      if (request.query.includes('repositories(')) {
        return json({ data: null, errors: [{ message: 'repository discovery unavailable' }] })
      }
      if (request.query.includes('search(')) return search([issue('ada/demo', 7)])
      return json({ data: { viewer: { login: 'ada' } } })
    }
    const result = await loadGithubRecords({ token: 'test-token', watchedRepos: [], fetchImpl,
      config: config({ sources: { assignee: true } }) })
    expect(requests).toHaveLength(3)
    expect(result.errors).toEqual([{ source: '仓库范围', message: 'repository discovery unavailable' }])
    expect(result.auth).toBe('ok')
    expect(result.fresh.assignee).toBe(true)
    expect(result.bySource.assignee[0]!.number).toBe(7)
  })

  it('retains the twelve-query and four-page search caps with every allowed page merged in query order', async () => {
    const repos = Array.from({ length: 104 }, (_, index) => `ada/repo-${index}`)
    const pages = new Map<string, string[]>()
    const fetchImpl = explicitFetch(async request => {
      if (request.query.includes('issues(states: OPEN, first: 40')) return contents(request, false, false)
      const text = String(request.variables.q)
      const seen = pages.get(text) ?? []
      seen.push(String(request.variables.after))
      pages.set(text, seen)
      const firstRepo = /repo:(\S+)/.exec(text)![1]!
      return json({ data: { search: {
        nodes: [issue(firstRepo, seen.length)], pageInfo: { hasNextPage: true, endCursor: `PAGE_${seen.length}` }
      } } })
    })
    const result = await loadGithubRecords({ token: 'test-token', watchedRepos: repos, fetchImpl,
      config: config({ maxScopeRepos: repos.length, sources: { humanIssues: true } }) })
    expect(pages.size).toBe(12)
    for (const seen of pages.values()) expect(seen).toEqual(['null', 'PAGE_1', 'PAGE_2', 'PAGE_3'])
    expect(result.fresh.humanIssues).toBe(false)
    expect(result.errors).toHaveLength(12)
    expect(result.errors.every(error => error.source === '要人动手' && /搜索结果不完整/.test(error.message))).toBe(true)
    expect(result.bySource.humanIssues).toHaveLength(48)
    expect(result.bySource.humanIssues.map(record => `${record.repo}#${record.number}`)).toEqual(
      Array.from({ length: 12 }, (_, queryIndex) => Array.from({ length: 4 }, (_, page) =>
        `ada/repo-${queryIndex * 8}#${page + 1}`)).flat()
    )
  })

  it('cancels pending sources without starting further keyword queries', async () => {
    const controller = new AbortController()
    const gates: Array<ReturnType<typeof deferred<Response>>> = []
    const repos = Array.from({ length: 104 }, (_, index) => `ada/repo-${index}`)
    const fetchImpl = explicitFetch(async request => {
      if (request.query.includes('issues(states: OPEN, first: 40')) return contents(request, false, false)
      const gate = deferred<Response>()
      gates.push(gate)
      return gate.promise
    })
    const pending = loadGithubRecords({ token: 'test-token', watchedRepos: repos, fetchImpl, signal: controller.signal,
      config: config({ maxScopeRepos: repos.length, sources: { humanIssues: true } }) })
    await vi.waitFor(() => expect(gates).toHaveLength(MAX_GITHUB_REQUESTS))
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    gates.forEach(gate => gate.resolve(search()))
    expect(gates).toHaveLength(MAX_GITHUB_REQUESTS)
  })
})
