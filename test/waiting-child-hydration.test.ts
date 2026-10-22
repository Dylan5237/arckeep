import { describe, expect, it, vi } from 'vitest'
import { parseIssueTree, parseRepoNode } from '../src/shared/waiting/parse-github.js'
import { defaultWaitingConfig } from '../src/shared/waiting/rules.js'
import type { WaitingConfig } from '../src/shared/waiting/types.js'
import { loadGithubRecords } from '../src/waiting/github-load.js'

interface Request {
  query: string
  variables: Record<string, unknown>
}

function deferred<T>(): { promise: Promise<T>, resolve: (value: T) => void, reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

function config(sources: Partial<WaitingConfig['sources']> = {}): WaitingConfig {
  const defaults = defaultWaitingConfig()
  return {
    ...defaults,
    humanKeywords: [],
    humanLabels: [],
    sources: {
      ...defaults.sources,
      assignee: false,
      reviewRequested: false,
      mentions: false,
      openPrs: false,
      humanIssues: false,
      ...sources
    }
  }
}

function repository(full: string): Record<string, unknown> {
  const owner = full.split('/')[0] ?? ''
  return {
    nameWithOwner: full,
    description: 'Repository description',
    isEmpty: false,
    pushedAt: '2026-10-08T00:00:00.000Z',
    isFork: false,
    viewerPermission: owner === 'ada' ? 'ADMIN' : 'READ',
    owner: { login: owner },
    repositoryTopics: { nodes: [{ topic: { name: 'team' } }] }
  }
}

function issue(
  full: string,
  number: number,
  patch: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    __typename: 'Issue',
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${full}/issues/${number}`,
    body: '',
    state: 'OPEN',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-08T00:00:00.000Z',
    author: { login: 'ada' },
    labels: { nodes: [{ name: 'human' }] },
    comments: { nodes: [] },
    timelineItems: { nodes: [] },
    parent: null,
    repository: repository(full),
    ...patch
  }
}

function variableNames(variables: Record<string, unknown>): number[] {
  return Object.keys(variables)
    .filter(key => /^n\d+$/.test(key))
    .map(key => Number(key.slice(1)))
    .sort((left, right) => left - right)
}

function issueNumbers(request: Request): number[] {
  return Object.keys(request.variables)
    .filter(key => /^i\d+$/.test(key))
    .map(key => Number(request.variables[key]))
    .sort((left, right) => left - right)
}

function parentOnly(request: Request): Response {
  const data: Record<string, unknown> = {}
  for (const index of variableNames(request.variables)) {
    data[`r${index}`] = { issue: { number: request.variables[`i${index}`] } }
  }
  return json({ data })
}

function metadata(request: Request): Response {
  const data: Record<string, unknown> = {}
  for (const index of variableNames(request.variables)) {
    const full = `${request.variables[`o${index}`]}/${request.variables[`n${index}`]}`
    data[`r${index}`] = repository(full)
  }
  return json({ data })
}

function content(request: Request, contents: ReadonlyMap<string, readonly unknown[]>): Response {
  const data: Record<string, unknown> = {}
  for (const index of variableNames(request.variables)) {
    const full = `${request.variables[`o${index}`]}/${request.variables[`n${index}`]}`
    data[`r${index}`] = {
      ...repository(full),
      issues: {
        nodes: [...(contents.get(full) ?? [])],
        pageInfo: { hasNextPage: false }
      }
    }
  }
  return json({ data })
}

function search(nodes: readonly unknown[], hasNextPage = false, endCursor: string | null = null): Response {
  return json({ data: { search: { nodes, pageInfo: { hasNextPage, endCursor } } } })
}

function childHydration(request: Request, byParent: ReadonlyMap<string, readonly unknown[]>): Response {
  const data: Record<string, unknown> = {}
  for (const index of variableNames(request.variables)) {
    const full = `${request.variables[`o${index}`]}/${request.variables[`n${index}`]}`
    const number = Number(request.variables[`i${index}`])
    data[`r${index}`] = {
      issue: {
        number,
        subIssues: { nodes: [...(byParent.get(`${full.toLowerCase()}#${number}`) ?? [])] }
      }
    }
  }
  return json({ data })
}

function fakeGithub(handler: (request: Request) => Promise<Response> | Response): {
  fetchImpl: typeof fetch
  requests: Request[]
} {
  const requests: Request[] = []
  const fetchImpl: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as Request
    requests.push(request)
    if (/viewer\s*\{\s*login\s*\}/.test(request.query)) {
      return json({ data: { viewer: { login: 'ada' } } })
    }
    if (request.query.includes('issue(number:')) return handler(request)
    if (request.query.includes('issues(states: OPEN, first: 40') || request.query.includes('search(')) return handler(request)
    return metadata(request)
  }
  return { fetchImpl, requests }
}

function asParentChildren(parent: Record<string, unknown>, children: readonly unknown[]): Record<string, unknown> {
  return { ...parent, subIssues: { nodes: [...children] } }
}

describe('Waiting child issue hydration', () => {
  it('does not hydrate a valid empty child probe for an otherwise complete content page', async () => {
    const parent = issue('ada/demo', 1, { subIssues: { nodes: [] } })
    const github = fakeGithub(request => content(request, new Map([['ada/demo', [parent]]])))
    const result = await loadGithubRecords({
      token: 'test-token',
      watchedRepos: ['ada/demo'],
      config: config({ humanIssues: true }),
      fetchImpl: github.fetchImpl
    })

    const contentRequest = github.requests.find(request => request.query.includes('issues(states: OPEN, first: 40'))
    expect(contentRequest?.query).toContain('subIssues(first: 1) { nodes { number } }')
    expect(github.requests.some(request => request.query.includes('issue(number:'))).toBe(false)
    expect(result.bySource.humanIssues.map(record => record.number)).toEqual([1])
    expect(result.bySource.humanIssues[0]?.repoDescription).toBe('Repository description')
    expect(result.fresh.humanIssues).toBe(true)
  })

  it('relaxes a confirmed unsupported subIssues field once and preserves the baseline parent result', async () => {
    const parent = issue('ada/demo', 1, { subIssues: { nodes: [{ number: 2 }] } })
    const searchRequests: Request[] = []
    const github = fakeGithub(request => {
      if (!request.query.includes('search(')) return search([])
      searchRequests.push(request)
      if (request.query.includes('subIssues(')) {
        return json({ data: null, errors: [{ message: "Field 'subIssues' doesn't exist on Issue" }] })
      }
      return search([parent])
    })
    const result = await loadGithubRecords({
      token: 'test-token',
      watchedRepos: ['ada/demo'],
      config: config({ mentions: true }),
      fetchImpl: github.fetchImpl
    })

    expect(searchRequests).toHaveLength(2)
    expect(searchRequests[1]?.query).not.toContain('subIssues(')
    expect(github.requests.some(request => request.query.includes('issue(number:'))).toBe(false)
    expect(result.bySource.mentions.map(record => record.number)).toEqual([1])
    expect(result.fresh.mentions).toBe(true)
  })

  it.each(['content', 'search'] as const)(
    'retries a full child hydration without unsupported subIssues for the %s source and keeps it fresh',
    async source => {
      const parent = issue('ada/demo', 1, {
        body: source === 'content' ? '请确认内容来源' : '请确认 @ada 搜索来源',
        subIssues: { nodes: [{ number: 2 }] }
      })
      const github = fakeGithub(request => {
        if (request.query.includes('issue(number:')) {
          if (request.query.includes('subIssues(first: 20)')) {
            return json({ data: null, errors: [{ message: "Field 'subIssues' doesn't exist on Issue" }] })
          }
          return json({ data: { r0: { issue: { number: 1 } } } })
        }
        if (source === 'content' && request.query.includes('issues(')) {
          return content(request, new Map([['ada/demo', [parent]]]))
        }
        return search([parent])
      })
      const result = await loadGithubRecords({
        token: 'test-token',
        watchedRepos: ['ada/demo'],
        config: source === 'content' ? config({ humanIssues: true }) : config({ mentions: true }),
        fetchImpl: github.fetchImpl
      })
      const childRequests = github.requests.filter(request => request.query.includes('issue(number:'))
      const records = source === 'content' ? result.bySource.humanIssues : result.bySource.mentions
      const fresh = source === 'content' ? result.fresh.humanIssues : result.fresh.mentions

      expect(childRequests).toHaveLength(2)
      expect(childRequests[0]?.query).toContain('subIssues(first: 20)')
      expect(childRequests[1]?.query).not.toContain('subIssues(')
      expect(records.map(record => record.number)).toEqual([1])
      expect(fresh).toBe(true)
      expect(result.errors).toEqual([])
    }
  )

  it('downgrades child hydration across multiple content batches, keeps every parent fresh, and discards probes', async () => {
    const parents = Array.from({ length: 41 }, (_, index) => {
      const number = index + 1
      return issue('ada/demo', number, {
        body: `请确认父项 ${number}`,
        subIssues: { nodes: [{ number: number + 1000 }] }
      })
    })
    const childRequests: Request[] = []
    let unsupportedReturned = false
    const github = fakeGithub(request => {
      if (request.query.includes('issue(number:')) {
        childRequests.push(request)
        if (request.query.includes('subIssues(first: 20)') && !unsupportedReturned) {
          unsupportedReturned = true
          return json({ data: null, errors: [{ message: "Field 'subIssues' doesn't exist on Issue" }] })
        }
        return request.query.includes('subIssues(')
          ? childHydration(request, new Map())
          : parentOnly(request)
      }
      return content(request, new Map([['ada/demo', parents]]))
    })
    const result = await loadGithubRecords({
      token: 'test-token',
      watchedRepos: ['ada/demo'],
      config: config({ humanIssues: true }),
      fetchImpl: github.fetchImpl
    })
    const failedRequest = childRequests.find(request => request.query.includes('subIssues(first: 20)'))
    const retry = failedRequest && childRequests.find(request =>
      !request.query.includes('subIssues(')
        && issueNumbers(request).join(',') === issueNumbers(failedRequest).join(','))

    expect(childRequests.filter(request => request.query.includes('subIssues('))).toHaveLength(3)
    expect(retry).toBeDefined()
    expect(issueNumbers(retry!)).toEqual(issueNumbers(failedRequest!))
    expect(result.bySource.humanIssues.map(record => record.number)).toEqual(parents.map(parent => parent.number))
    expect(result.bySource.humanIssues.every(record => record.parentNumber === null)).toBe(true)
    expect(result.fresh.humanIssues).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('hydrates real children and matches the previous full tree parse, including repository metadata and closed-child filtering', async () => {
    const parent = issue('ada/demo', 1, {
      body: '请确认父项',
      subIssues: { nodes: [{ number: 2 }] },
      comments: { nodes: [{ body: '仍需确认', createdAt: '2026-10-08T12:00:00.000Z', author: { login: 'ada' } }] }
    })
    const openChild = issue('ada/demo', 2, {
      parent: { number: 1 },
      body: '请确认子项',
      labels: { nodes: [{ name: 'human-child' }] },
      comments: { nodes: [{ body: '子项评论', createdAt: '2026-10-07T12:00:00.000Z', author: { login: 'bob' } }] }
    })
    const closedChild = issue('ada/demo', 3, { parent: { number: 1 }, state: 'CLOSED' })
    const github = fakeGithub(request => request.query.includes('issue(number:')
      ? childHydration(request, new Map([['ada/demo#1', [openChild, closedChild]]]))
      : content(request, new Map([['ada/demo', [parent]]])))
    const result = await loadGithubRecords({
      token: 'test-token',
      watchedRepos: ['ada/demo'],
      config: config({ humanIssues: true }),
      fetchImpl: github.fetchImpl
    })

    const fullRepo = repository('ada/demo')
    const expected = (parseRepoNode({
      ...fullRepo,
      issues: {
        nodes: [asParentChildren(parent, [openChild, closedChild])],
        pageInfo: { hasNextPage: false }
      }
    }, 'ada')?.issues ?? []).map(record => ({
      ...record,
      repoAccess: 'maintain' as const,
      viewerOwnsRepo: true
    }))
    const hydrationRequest = github.requests.find(request => request.query.includes('issue(number:'))
    expect(hydrationRequest?.query).toContain('subIssues(first: 20)')
    expect(hydrationRequest?.query).toContain('labels(first: 10)')
    expect(hydrationRequest?.query).toContain('comments(last: 4)')
    expect(hydrationRequest?.query).toContain('parent { number }')
    expect(result.bySource.humanIssues).toEqual(expected)
    expect(result.bySource.humanIssues.map(record => record.number)).toEqual([1, 2])
    expect(result.bySource.humanIssues[1]?.parentNumber).toBe(1)
    expect(result.bySource.humanIssues[1]?.repoTopics).toEqual(['team'])
    expect(result.fresh.humanIssues).toBe(true)
  })

  it('preserves search source flags, row order, parent links, and child deduplication after hydration', async () => {
    const parent = issue('ada/demo', 1, {
      body: '请确认 @ada',
      subIssues: { nodes: [{ number: 2 }] }
    })
    const child = issue('ada/demo', 2, { parent: { number: 1 }, body: '请确认子项' })
    const closedChild = issue('ada/demo', 3, { parent: { number: 1 }, state: 'CLOSED' })
    const fullParent = asParentChildren(parent, [child, closedChild])
    const github = fakeGithub(request => request.query.includes('issue(number:')
      ? childHydration(request, new Map([['ada/demo#1', [child, closedChild]]]))
      : search([parent]))
    const result = await loadGithubRecords({
      token: 'test-token',
      watchedRepos: ['ada/demo'],
      config: config({ assignee: true, mentions: true }),
      fetchImpl: github.fetchImpl
    })
    const expected = parseIssueTree(fullParent, { login: 'ada', fromMention: true })
      .map(record => ({ ...record, inScopeRepo: true }))

    expect(result.bySource.mentions).toEqual(expected)
    expect(result.bySource.mentions.map(record => record.number)).toEqual([1, 2])
    expect(result.bySource.mentions[0]?.fromMention).toBe(true)
    expect(result.bySource.mentions[1]?.fromMention).toBe(false)
    expect(result.bySource.mentions[0]?.mentionedAt).toBe('2026-10-01T00:00:00.000Z')
    expect(result.bySource.mentions.every(record => record.inScopeRepo)).toBe(true)
    expect(result.fresh.mentions).toBe(true)
  })

  it('conservatively hydrates a malformed probe instead of treating it as a complete child', async () => {
    const parent = issue('ada/demo', 1, { subIssues: { nodes: [{ number: '2' }] } })
    const child = issue('ada/demo', 2, { parent: { number: 1 } })
    const github = fakeGithub(request => request.query.includes('issue(number:')
      ? childHydration(request, new Map([['ada/demo#1', [child]]]))
      : search([parent]))
    const result = await loadGithubRecords({
      token: 'test-token',
      watchedRepos: ['ada/demo'],
      config: config({ mentions: true }),
      fetchImpl: github.fetchImpl
    })

    expect(github.requests.some(request => request.query.includes('issue(number:'))).toBe(true)
    expect(result.bySource.mentions.map(record => record.number)).toEqual([1, 2])
    expect(result.fresh.mentions).toBe(true)
  })

  it.each(['malformed', 'missing'] as const)('keeps the parent but reports a %s child connection and marks the source stale', async shape => {
    const parent = issue('ada/demo', 1, { subIssues: { nodes: [{ number: 2 }] } })
    const github = fakeGithub(request => request.query.includes('issue(number:')
      ? json({ data: { r0: { issue: shape === 'malformed'
        ? { number: 1, subIssues: { nodes: [{ number: 2 }] } }
        : { number: 1 } } } })
      : search([parent]))
    const result = await loadGithubRecords({
      token: 'test-token',
      watchedRepos: ['ada/demo'],
      config: config({ mentions: true }),
      fetchImpl: github.fetchImpl
    })

    expect(result.bySource.mentions.map(record => record.number)).toEqual([1])
    expect(result.fresh.mentions).toBe(false)
    expect(result.errors.some(error => error.message.includes('子 issue 数据不完整'))).toBe(true)
  })

  it.each([false, true])('follows search cursors up to four pages and marks an unvisited fifth page stale (hasNext on page four: %s)', async lastPageHasNext => {
    const searches: Request[] = []
    const github = fakeGithub(request => {
      if (request.query.includes('issue(number:')) return childHydration(request, new Map())
      searches.push(request)
      const page = request.variables.after === null || request.variables.after === undefined
        ? 1
        : Number(String(request.variables.after).replace('CURSOR_', '')) + 1
      const next = page < 4 || lastPageHasNext
      return search([issue('ada/demo', page)], next, next ? `CURSOR_${page}` : null)
    })
    const result = await loadGithubRecords({
      token: 'test-token',
      watchedRepos: ['ada/demo'],
      config: config({ mentions: true }),
      fetchImpl: github.fetchImpl
    })

    expect(searches).toHaveLength(4)
    expect(searches.map(request => request.variables.after ?? null)).toEqual([null, 'CURSOR_1', 'CURSOR_2', 'CURSOR_3'])
    expect(result.bySource.mentions.map(record => record.number)).toEqual([1, 2, 3, 4])
    expect(result.fresh.mentions).toBe(!lastPageHasNext)
  })

  it.each([401, 429, 503, 'network'] as const)('does not let a confirmed downgrade mask a concurrent %s failure', async status => {
    const childRequests: Array<{ request: Request, gate: ReturnType<typeof deferred<Response>> }> = []
    const postFailureRequests: Request[] = []
    const parents = Array.from({ length: 141 }, (_, index) => {
      const number = index + 1
      return issue('ada/demo', number, { subIssues: { nodes: [{ number: number + 1000 }] } })
    })
    const expectedBatchCount = Math.ceil(parents.length / 20)
    let activeChildRequests = 0
    let maxChildConcurrency = 0
    let failureResponseProcessed = false
    const github = fakeGithub(request => {
      if (request.query.includes('issue(number:')) {
        activeChildRequests += 1
        maxChildConcurrency = Math.max(maxChildConcurrency, activeChildRequests)
        if (failureResponseProcessed) {
          postFailureRequests.push(request)
          const response = request.query.includes('subIssues(')
            ? childHydration(request, new Map())
            : parentOnly(request)
          return Promise.resolve(response).finally(() => { activeChildRequests -= 1 })
        }
        const gate = deferred<Response>()
        childRequests.push({ request, gate })
        return gate.promise.finally(() => { activeChildRequests -= 1 })
      }
      return content(request, new Map([['ada/demo', parents]]))
    })
    const pending = loadGithubRecords({
      token: 'test-token',
      watchedRepos: ['ada/demo'],
      config: config({ humanIssues: true }),
      fetchImpl: github.fetchImpl
    })

    await vi.waitFor(() => expect(childRequests).toHaveLength(6))
    expect(maxChildConcurrency).toBe(6)
    expect(expectedBatchCount).toBeGreaterThanOrEqual(7)
    const downgraded = childRequests[0]!
    const downgradedNumbers = issueNumbers(downgraded.request)
    expect(downgraded.request.query).toContain('subIssues(')
    downgraded.gate.resolve(json({ data: null, errors: [{ message: "Field 'subIssues' doesn't exist on Issue" }] }))
    let retry: typeof childRequests[number] | undefined
    await vi.waitFor(() => {
      retry = childRequests.find(item => !item.request.query.includes('subIssues(')
        && issueNumbers(item.request).join(',') === downgradedNumbers.join(','))
      expect(retry).toBeDefined()
    })
    expect(issueNumbers(retry!.request)).toEqual(downgradedNumbers)
    const headers = status === 429
      ? { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791500000' }
      : {}
    if (status === 'network') childRequests[1]!.gate.reject(new TypeError('fetch failed'))
    else childRequests[1]!.gate.resolve(json({ message: 'request rejected' }, status, headers))
    await new Promise(resolve => setTimeout(resolve, 0))
    failureResponseProcessed = true
    retry!.gate.resolve(parentOnly(retry!.request))
    for (const item of childRequests) {
      if (item === downgraded || item === retry || item === childRequests[1]) continue
      item.gate.resolve(childHydration(item.request, new Map()))
    }
    const result = await pending

    expect(result.fresh.humanIssues).toBe(false)
    expect(result.bySource.humanIssues.length).toBeGreaterThan(0)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(childRequests.filter(item => item.request.query.includes('subIssues(')).length).toBeGreaterThanOrEqual(6)
    expect(childRequests.some(item => !item.request.query.includes('subIssues(')
      && issueNumbers(item.request).join(',') === downgradedNumbers.join(','))).toBe(true)
    expect(result.auth).toBe(status === 401 ? 'invalid' : 'ok')
    expect(result.rateLimitResetAt).toBe(status === 429 ? '2026-10-08T22:53:20.000Z' : null)
    if (status === 401 || status === 429) expect(postFailureRequests).toEqual([])
    expect(activeChildRequests).toBe(0)
  })

  it('does not start another child request after cancellation', async () => {
    const controller = new AbortController()
    const parent = issue('ada/demo', 1, { subIssues: { nodes: [{ number: 2 }] } })
    let childRequests = 0
    const github = fakeGithub(request => {
      if (request.query.includes('issue(number:')) {
        childRequests += 1
        controller.abort()
        return json({ data: {} })
      }
      return content(request, new Map([['ada/demo', [parent]]]))
    })
    const pending = loadGithubRecords({
      token: 'test-token',
      watchedRepos: ['ada/demo'],
      config: config({ humanIssues: true }),
      fetchImpl: github.fetchImpl,
      signal: controller.signal
    })

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(childRequests).toBe(1)
  })

  it('keeps direct tasklist lookups on the full selection without an extra hydration request', async () => {
    const parent = issue('ada/demo', 1, { body: '- [ ] #2', subIssues: { nodes: [] } })
    const task = issue('ada/demo', 2, {
      subIssues: { nodes: [{
        ...issue('ada/demo', 3, { parent: { number: 2 } }),
        labels: { nodes: [] },
        comments: { nodes: [] }
      }] }
    })
    const github = fakeGithub(request => {
      if (request.query.includes('issue(number:')) {
        if (request.query.includes('timelineItems')) {
          return json({ data: { r0: { nameWithOwner: 'ada/demo', issue: task } } })
        }
        return childHydration(request, new Map())
      }
      return search([parent])
    })
    const result = await loadGithubRecords({
      token: 'test-token',
      watchedRepos: ['ada/demo'],
      config: config({ mentions: true }),
      fetchImpl: github.fetchImpl
    })
    const lookup = github.requests.find(request => request.query.includes('issue(number:') && request.query.includes('timelineItems'))

    expect(lookup?.query).toContain('subIssues(first: 20)')
    expect(lookup?.query).toContain('comments(last: 4)')
    expect(github.requests.filter(request => request.query.includes('issue(number:'))).toHaveLength(1)
    expect(result.bySource.humanIssues.map(record => record.number)).toEqual([2, 3])
    expect(result.bySource.humanIssues[0]?.parentNumber).toBe(1)
    expect(result.bySource.humanIssues[1]?.parentNumber).toBe(2)
    expect(result.fresh.humanIssues).toBe(true)
  })

  it.each([
    {
      name: 'an exact tasklist issue lookup miss',
      data: { r0: { nameWithOwner: 'ada/demo', issue: null } },
      errors: [{ path: ['r0', 'issue'], message: 'Could not resolve to an Issue with the number of 2.' }],
      fresh: true
    },
    {
      name: 'a repository lookup miss',
      data: { r0: null },
      errors: [{ path: ['r0'], message: "Could not resolve to a Repository with the name 'demo'." }],
      fresh: false
    },
    {
      name: 'an issue miss on the wrong response path',
      data: { r0: { nameWithOwner: 'ada/demo', issue: null } },
      errors: [{ path: ['r0', 'nameWithOwner'], message: 'Could not resolve to an Issue with the number of 2.' }],
      fresh: false
    },
    {
      name: 'an issue miss for a different number',
      data: { r0: { nameWithOwner: 'ada/demo', issue: null } },
      errors: [{ path: ['r0', 'issue'], message: 'Could not resolve to an Issue with the number of 67.' }],
      fresh: false
    }
  ])('only treats $name as a complete tasklist lookup', async scenario => {
    const parent = issue('ada/demo', 1, { body: '- [ ] #2', subIssues: { nodes: [] } })
    const github = fakeGithub(request => {
      if (request.query.includes('issue(number:') && request.query.includes('timelineItems')) {
        return json({ data: scenario.data, errors: scenario.errors })
      }
      if (request.query.includes('issues(states: OPEN, first: 40')) return content(request, new Map([['ada/demo', [parent]]]))
      return search([])
    })
    const result = await loadGithubRecords({
      token: 'test-token',
      watchedRepos: ['ada/demo'],
      config: config({ humanIssues: true }),
      fetchImpl: github.fetchImpl
    })

    expect(github.requests.some(request => request.query.includes('timelineItems'))).toBe(true)
    expect(result.bySource.humanIssues.map(record => record.number)).toEqual([1])
    expect(result.fresh.humanIssues).toBe(scenario.fresh)
    if (scenario.fresh) expect(result.errors).toEqual([])
    else {
      expect(result.errors.some(error => error.source === '子 issue')).toBe(true)
      expect(result.errors.length).toBeGreaterThan(0)
    }
  })
})
