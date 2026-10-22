import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { OverviewService } from '../src/main/overview-service.js'
import { WaitingService } from '../src/main/waiting-service.js'
import { overviewCachePath, settingsFilePath, waitingCachePath, waitingDismissalPath } from '../src/main/paths.js'
import { SettingsService } from '../src/main/settings-service.js'
import type { SecretBox } from '../src/main/token-store.js'
import { defaultWaitingConfig } from '../src/shared/waiting/rules.js'
import { writeDismissalState } from '../src/shared/waiting/snooze.js'
import { createWaitingClock } from '../src/shared/waiting/clock.js'
import { emptyWaitingMemory } from '../src/waiting/collect.js'
import { waitingTokenIdentityHash } from '../src/waiting/token.js'
import { blankRecord } from '../src/shared/waiting/parse-github.js'
import type { TodoWaitingItem, WaitingConfig } from '../src/shared/waiting/types.js'

const BASE_TIME = Date.parse('2026-10-08T00:00:00.000Z')

interface GraphqlRequest {
  query: string
  variables?: Record<string, unknown>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

function repoNode(owner = 'example', name = 'demo'): Record<string, unknown> {
  return {
    nameWithOwner: `${owner}/${name}`,
    url: `https://github.com/${owner}/${name}`,
    description: '',
    isEmpty: false,
    diskUsage: 20,
    pushedAt: new Date(BASE_TIME - 86_400_000).toISOString(),
    createdAt: new Date(BASE_TIME - 10 * 86_400_000).toISOString(),
    defaultBranchRef: {
      target: {
        oid: 'abc123',
        committedDate: new Date(BASE_TIME - 86_400_000).toISOString(),
        statusCheckRollup: { state: 'SUCCESS' }
      }
    },
    pullRequests: { totalCount: 0, nodes: [] },
    commandCenters: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
    issues: { pageInfo: { hasNextPage: false }, nodes: [] },
    repositoryTopics: { nodes: [] },
    viewerPermission: 'ADMIN',
    owner: { login: owner },
    isFork: false
  }
}

function successFor(request: GraphqlRequest): Response {
  if (request.query.includes('viewer { login }')) {
    return jsonResponse({ data: { viewer: { login: 'ada' } } })
  }
  if (request.query.includes('r0: repository(owner:')) {
    const owner = String(request.variables?.o0 ?? 'example')
    const name = String(request.variables?.n0 ?? 'demo')
    const emptySearch = { issueCount: 0, pageInfo: { hasNextPage: false }, nodes: [] }
    return jsonResponse({ data: { r0: repoNode(owner, name), ccEnglish: emptySearch, ccChinese: emptySearch } })
  }
  if (request.query.includes('search(query:')) {
    return jsonResponse({ data: { search: { pageInfo: { hasNextPage: false }, nodes: [] } } })
  }
  return jsonResponse({ data: {} })
}

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

function testSecretBox(): SecretBox {
  return {
    encrypt: value => `encrypted:${Buffer.from(value, 'utf8').toString('base64')}`,
    decrypt: value => value.startsWith('encrypted:')
      ? Buffer.from(value.slice('encrypted:'.length), 'base64').toString('utf8')
      : ''
  }
}

function settingsFor(dir: string): SettingsService {
  const settings = new SettingsService({
    file: settingsFilePath(dir),
    secretBox: testSecretBox(),
    registrar: { register: () => true, isRegistered: () => true, unregister: () => {} },
    onHotkey: () => {},
    readGh: async () => ({ ok: false, reason: 'not-installed' })
  })
  settings.init()
  settings.setRepoFetchWindow('all') // Keep the original coordination fixtures in their full scope.
  return settings
}

function waitingConfig(): WaitingConfig {
  const defaults = defaultWaitingConfig()
  return {
    ...defaults,
    sources: {
      ...defaults.sources,
      reviewRequested: false,
      mentions: false,
      openPrs: false,
      humanIssues: false,
      statusDocs: false,
      localBranches: false
    }
  }
}

function waitingTodo(id: string, title: string): TodoWaitingItem {
  return {
    id,
    title,
    createdAt: new Date(BASE_TIME - 86_400_000).toISOString(),
    updatedAt: new Date(BASE_TIME - 86_400_000).toISOString(),
    url: `arckeep://todos?id=${id}`
  }
}

function recorder(onRequest?: (request: GraphqlRequest, index: number) => Promise<Response> | Response) {
  const requests: GraphqlRequest[] = []
  const fetchImpl: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body ?? '{}')) as GraphqlRequest
    requests.push(request)
    return onRequest ? onRequest(request, requests.length) : successFor(request)
  }
  return { fetchImpl, requests }
}

describe('GitHub service refresh coordination', () => {
  it('merges concurrent overview refreshes and keeps unverified cached rows hidden', async () => {
    const dir = tempDir('arckeep-overview-refresh-')
    const settings = settingsFor(dir)
    settings.setRepos(['example/demo'])
    const oldRow = {
      name: 'cached/old',
      url: 'https://github.com/cached/old',
      lastCommitAt: null,
      openPrCount: 0,
      ciState: 'none' as const,
      warnings: [],
      group: 'active' as const,
      stallBasis: { at: null, source: 'none' as const, lastCommitAt: null, lastIssueActivityAt: null },
      archived: false,
      error: null
    }
    writeFileSync(overviewCachePath(dir), JSON.stringify({ version: 1, refreshedAt: null, rows: [oldRow] }), 'utf8')

    const started = deferred<void>()
    const response = deferred<Response>()
    const requests: GraphqlRequest[] = []
    let ghReads = 0
    const service = new OverviewService(settings, overviewCachePath(dir), {
      env: { GITHUB_TOKEN: 'test-token' },
      readGh: async () => { ghReads += 1; return { ok: false, reason: 'not-installed' } },
      now: () => new Date(BASE_TIME),
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as GraphqlRequest
        requests.push(request)
        if (requests.length === 1) {
          started.resolve()
          return response.promise
        }
        return successFor(request)
      }
    })

    const first = service.refresh()
    const second = service.refresh()
    await started.promise
    expect(ghReads).toBe(1)
    expect(requests).toHaveLength(1)
    expect(service.current().refreshing).toBe(true)
    expect(service.current().rows).toEqual([])

    response.resolve(successFor(requests[0]!))
    const [one, two] = await Promise.all([first, second])
    expect(one.rows.map(row => row.name)).toEqual(['example/demo'])
    expect(two.refreshing).toBe(false)
    expect(service.current().refreshing).toBe(false)
    expect(requests).toHaveLength(1)
  })

  it('keys the overview cache to the resolved identity, preserves page TTL, and forces manual refresh', async () => {
    const dir = tempDir('arckeep-overview-ttl-')
    const settings = settingsFor(dir)
    settings.setRepos(['example/demo'])
    let nowMs = BASE_TIME
    let ghReads = 0
    const fetcher = recorder(request => {
      const response = successFor(request)
      nowMs += 90_000
      return response
    })
    const service = new OverviewService(settings, overviewCachePath(dir), {
      env: { GITHUB_TOKEN: 'test-token' },
      readGh: async () => { ghReads += 1; return { ok: false, reason: 'not-installed' } },
      now: () => new Date(nowMs),
      fetchImpl: fetcher.fetchImpl
    })

    await service.refresh(false)
    const afterFirst = fetcher.requests.length
    await service.refresh(false)
    expect(fetcher.requests).toHaveLength(afterFirst)
    expect(ghReads).toBe(2)

    expect(settings.setPat('test-pat-change').ok).toBe(true)
    await service.refresh(false)
    expect(fetcher.requests).toHaveLength(afterFirst)

    await service.refresh()
    expect(fetcher.requests.length).toBeGreaterThan(afterFirst)
    const afterForced = fetcher.requests.length
    await service.refresh(false)
    expect(fetcher.requests).toHaveLength(afterForced)

    const reopened = new OverviewService(settings, overviewCachePath(dir), {
      env: { GITHUB_TOKEN: 'test-token' },
      readGh: async () => { ghReads += 1; return { ok: false, reason: 'not-installed' } },
      now: () => new Date(nowMs),
      fetchImpl: fetcher.fetchImpl
    })
    await reopened.refresh(false)
    expect(fetcher.requests).toHaveLength(afterForced)

    nowMs += 60_000
    await service.refresh(false)
    expect(fetcher.requests.length).toBeGreaterThan(afterForced)
  })

  it('does not reuse cached overview rows after the resolved environment token changes', async () => {
    const dir = tempDir('arckeep-overview-auth-cache-')
    const settings = settingsFor(dir)
    const cacheFile = overviewCachePath(dir)
    const privateRow = {
      name: 'alice/private',
      url: 'https://github.com/alice/private',
      lastCommitAt: null,
      openPrCount: 0,
      ciState: 'none' as const,
      warnings: [],
      group: 'active' as const,
      stallBasis: { at: null, source: 'none' as const, lastCommitAt: null, lastIssueActivityAt: null },
      archived: false,
      error: null
    }
    writeFileSync(cacheFile, JSON.stringify({
      version: 1,
      refreshedAt: new Date(BASE_TIME - 5_000).toISOString(),
      configKey: null,
      identityHash: waitingTokenIdentityHash({ token: 'alice-token', via: 'env' }),
      rows: [privateRow]
    }), 'utf8')
    const env = { GITHUB_TOKEN: 'alice-token' }
    const authorization: string[] = []
    const service = new OverviewService(settings, cacheFile, {
      env,
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      now: () => new Date(BASE_TIME),
      fetchImpl: async (_input, init) => {
        const token = new Headers(init?.headers).get('Authorization') ?? ''
        authorization.push(token)
        if (token === 'Bearer alice-token') return jsonResponse({ message: 'offline' }, 500)
        return successFor(JSON.parse(String(init?.body ?? '{}')) as GraphqlRequest)
      }
    })

    expect(service.current().rows).toEqual([])
    const alice = await service.refresh(false)
    expect(alice.rows.map(row => row.name)).toContain('alice/private')

    env.GITHUB_TOKEN = 'bob-token'
    const bob = await service.refresh(false)
    expect(authorization).toEqual(['Bearer alice-token', 'Bearer bob-token'])
    expect(bob.rows.map(row => row.name)).not.toContain('alice/private')
    const persisted = readFileSync(cacheFile, 'utf8')
    expect(JSON.parse(persisted).identityHash).toBe(waitingTokenIdentityHash({ token: 'bob-token', via: 'env' }))
    expect(persisted).not.toContain('alice-token')
    expect(persisted).not.toContain('bob-token')
  })

  it('queues an overview refresh after watched repositories change and uses the new scope', async () => {
    const dir = tempDir('arckeep-overview-scope-')
    const settings = settingsFor(dir)
    settings.setRepos(['first/repo'])
    const started = deferred<void>()
    const response = deferred<Response>()
    const requests: GraphqlRequest[] = []
    const service = new OverviewService(settings, overviewCachePath(dir), {
      env: { GITHUB_TOKEN: 'test-token' },
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      now: () => new Date(BASE_TIME),
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as GraphqlRequest
        requests.push(request)
        if (requests.length === 1) {
          started.resolve()
          return response.promise
        }
        return successFor(request)
      }
    })

    const first = service.refresh(false)
    await started.promise
    settings.setRepos(['second/repo'])
    const second = service.refresh(false)
    await Promise.resolve()
    expect(requests).toHaveLength(1)

    response.resolve(successFor(requests[0]!))
    await Promise.all([first, second])
    const requestedRepos = requests
      .map(request => request.variables)
      .filter((variables): variables is Record<string, unknown> => Boolean(variables?.o0 && variables?.n0))
      .map(variables => `${variables.o0}/${variables.n0}`)
    expect(requestedRepos).toEqual(['first/repo', 'second/repo'])
  })

  it('does not cache an overview row-level query error and retries it on the next page refresh', async () => {
    const dir = tempDir('arckeep-overview-error-')
    const settings = settingsFor(dir)
    settings.setRepos(['example/demo'])
    let fail = true
    const fetcher = recorder((_request, index) => {
      if (index === 1 && fail) {
        fail = false
        return jsonResponse({ message: 'temporary server failure' }, 500)
      }
      return successFor(_request)
    })
    const service = new OverviewService(settings, overviewCachePath(dir), {
      env: { GITHUB_TOKEN: 'test-token' },
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      now: () => new Date(BASE_TIME),
      fetchImpl: fetcher.fetchImpl
    })

    const failed = await service.refresh(false)
    expect(failed.rows.some(row => row.error)).toBe(true)
    const callsAfterFailure = fetcher.requests.length
    const retried = await service.refresh(false)
    expect(retried.rows.every(row => row.error === null)).toBe(true)
    expect(fetcher.requests.length).toBeGreaterThan(callsAfterFailure)
  })

  it('clears refreshing without exposing cached private rows when authentication lookup throws', async () => {
    const overviewDir = tempDir('arckeep-overview-throws-')
    const overviewSettings = settingsFor(overviewDir)
    const oldRow = {
      name: 'cached/overview',
      url: 'https://github.com/cached/overview',
      lastCommitAt: null,
      openPrCount: 0,
      ciState: 'none' as const,
      warnings: [],
      group: 'active' as const,
      stallBasis: { at: null, source: 'none' as const, lastCommitAt: null, lastIssueActivityAt: null },
      archived: false,
      error: null
    }
    writeFileSync(overviewCachePath(overviewDir), JSON.stringify({
      version: 1,
      refreshedAt: null,
      rows: [oldRow]
    }), 'utf8')
    const overview = new OverviewService(overviewSettings, overviewCachePath(overviewDir), {
      readGh: async () => { throw new Error('auth lookup failed') },
      fetchImpl: async () => { throw new Error('must not fetch') }
    })
    const overviewRefresh = overview.refresh()
    expect(overview.current().refreshing).toBe(true)
    await expect(overviewRefresh).rejects.toThrow('auth lookup failed')
    expect(overview.current().refreshing).toBe(false)
    expect(overview.current().rows).toEqual([])

    const waitingDir = tempDir('arckeep-waiting-throws-')
    const waitingSettings = settingsFor(waitingDir)
    waitingSettings.setWaiting(waitingConfig())
    const waitingFiles = {
      cache: waitingCachePath(waitingDir),
      dismissals: waitingDismissalPath(waitingDir)
    }
    const memory = emptyWaitingMemory()
    memory.todos = [waitingTodo('cached', 'Cached waiting row')]
    writeFileSync(waitingFiles.cache, JSON.stringify({
      version: 1,
      refreshedAt: null,
      memory
    }), 'utf8')
    const waiting = new WaitingService(waitingSettings, waitingFiles, {
      readGh: async () => { throw new Error('auth lookup failed') },
      fetchImpl: async () => { throw new Error('must not fetch') },
      clock: createWaitingClock(() => new Date(BASE_TIME))
    })
    const waitingRefresh = waiting.refresh()
    expect(waiting.current().refreshing).toBe(true)
    await expect(waitingRefresh).rejects.toThrow('auth lookup failed')
    expect(waiting.current().refreshing).toBe(false)
    expect(waiting.current().rows.map(row => row.title)).toEqual(['Cached waiting row'])
  })

  it('merges concurrent waiting refreshes into one GitHub read', async () => {
    const dir = tempDir('arckeep-waiting-flight-')
    const settings = settingsFor(dir)
    settings.setRepos(['example/demo'])
    settings.setWaiting(waitingConfig())
    const baselineFetcher = recorder()
    const baseline = new WaitingService(settings, {
      cache: path.join(dir, 'baseline-cache.json'),
      dismissals: path.join(dir, 'baseline-dismissals.json')
    }, {
      env: { GITHUB_TOKEN: 'test-token' },
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      clock: createWaitingClock(() => new Date(BASE_TIME)),
      fetchImpl: baselineFetcher.fetchImpl
    })
    await baseline.refresh()

    const started = deferred<void>()
    const response = deferred<Response>()
    const requests: GraphqlRequest[] = []
    let ghReads = 0
    const service = new WaitingService(settings, {
      cache: waitingCachePath(dir),
      dismissals: waitingDismissalPath(dir)
    }, {
      env: { GITHUB_TOKEN: 'test-token' },
      readGh: async () => { ghReads += 1; return { ok: false, reason: 'not-installed' } },
      clock: createWaitingClock(() => new Date(BASE_TIME)),
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as GraphqlRequest
        requests.push(request)
        if (requests.length === 1) {
          started.resolve()
          return response.promise
        }
        return successFor(request)
      }
    })

    const first = service.refresh()
    const second = service.refresh()
    await started.promise
    expect(ghReads).toBe(1)
    expect(requests).toHaveLength(1)
    expect(service.current().refreshing).toBe(true)

    response.resolve(successFor(requests[0]!))
    const [one, two] = await Promise.all([first, second])
    expect(one.refreshing).toBe(false)
    expect(two.refreshing).toBe(false)
    expect(service.current().refreshing).toBe(false)
    expect(requests).toHaveLength(baselineFetcher.requests.length)
  })

  it('reuses successful waiting data for one minute but refreshes local todos and honors forced refresh', async () => {
    const dir = tempDir('arckeep-waiting-ttl-')
    const settings = settingsFor(dir)
    settings.setRepos(['example/demo'])
    settings.setWaiting(waitingConfig())
    let nowMs = BASE_TIME
    let items = [waitingTodo('first', 'First local todo')]
    let todoReads = 0
    let ghReads = 0
    let todoFailure = false
    const todos = {
      available: true,
      async listWaitingOnMe() {
        todoReads += 1
        if (todoFailure) throw new Error('temporary local todo failure')
        return items
      }
    }
    const fetcher = recorder()
    const service = new WaitingService(settings, {
      cache: waitingCachePath(dir),
      dismissals: waitingDismissalPath(dir)
    }, {
      env: { GITHUB_TOKEN: 'test-token' },
      readGh: async () => { ghReads += 1; return { ok: false, reason: 'not-installed' } },
      clock: createWaitingClock(() => new Date(nowMs)),
      todos,
      fetchImpl: fetcher.fetchImpl
    })

    await service.refresh(false)
    const afterFirst = fetcher.requests.length
    const reopened = new WaitingService(settings, {
      cache: waitingCachePath(dir),
      dismissals: waitingDismissalPath(dir)
    }, {
      env: { GITHUB_TOKEN: 'test-token' },
      readGh: async () => { ghReads += 1; return { ok: false, reason: 'not-installed' } },
      clock: createWaitingClock(() => new Date(nowMs)),
      todos,
      fetchImpl: fetcher.fetchImpl
    })
    const reopenedSnapshot = await reopened.refresh(false)
    expect(reopenedSnapshot.rows.map(row => row.title)).toContain('First local todo')
    expect(fetcher.requests).toHaveLength(afterFirst)

    items = [waitingTodo('second', 'Updated local todo')]
    const cached = await service.refresh(false)
    expect(fetcher.requests).toHaveLength(afterFirst)
    expect(todoReads).toBe(3)
    expect(cached.rows.map(row => row.title)).toContain('Updated local todo')
    expect(cached.rows.map(row => row.title)).not.toContain('First local todo')
    expect(ghReads).toBe(3)

    await service.refresh()
    const afterForced = fetcher.requests.length
    expect(afterForced).toBeGreaterThan(afterFirst)
    expect(ghReads).toBe(4)

    nowMs += 60_000
    await service.refresh(false)
    expect(fetcher.requests.length).toBeGreaterThan(afterForced)
    const afterExpiry = fetcher.requests.length
    expect(ghReads).toBe(5)

    todoFailure = true
    const cachedError = await service.refresh(false)
    expect(cachedError.sourceErrors.some(error => error.source === '待办')).toBe(true)
    expect(fetcher.requests).toHaveLength(afterExpiry)

    nowMs += 60_000
    const expiredError = await service.refresh(false)
    expect(expiredError.sourceErrors.some(error => error.source === '待办')).toBe(true)
    expect(fetcher.requests.length).toBeGreaterThan(afterExpiry)
    const afterErrorRefresh = fetcher.requests.length
    await service.refresh(false)
    expect(fetcher.requests.length).toBeGreaterThan(afterErrorRefresh)
    expect(todoReads).toBe(8)
  })

  it('clears cached GitHub waiting data on account change or missing auth while retaining local data', async () => {
    const dir = tempDir('arckeep-waiting-auth-cache-')
    const settings = settingsFor(dir)
    settings.setRepos(['example/private'])
    const config = waitingConfig()
    config.sources.localBranches = true
    config.localRepoDirs = ['C:/local-repo']
    settings.setWaiting(config)
    const files = {
      cache: waitingCachePath(dir),
      dismissals: waitingDismissalPath(dir)
    }
    const memory = emptyWaitingMemory()
    memory.assignee.push(blankRecord({
      kind: 'issue',
      repo: 'example/private',
      number: 17,
      title: 'Alice private issue',
      url: 'https://github.com/example/private/issues/17',
      fromAssignee: true,
      inScopeRepo: true,
      assignedAt: new Date(BASE_TIME - 86_400_000).toISOString(),
      updatedAt: new Date(BASE_TIME - 86_400_000).toISOString()
    }))
    memory.branches = [{
      dir: 'C:/local-repo',
      repo: 'example/private',
      branch: 'feature/local-work',
      ahead: 1,
      subject: 'Local change',
      committedAt: new Date(BASE_TIME - 60_000).toISOString(),
      url: 'https://github.com/example/private/compare/main...feature/local-work'
    }]
    memory.todos = [waitingTodo('preserved', 'Local todo survives account change')]
    writeFileSync(files.cache, JSON.stringify({
      version: 1,
      refreshedAt: new Date(BASE_TIME - 5_000).toISOString(),
      configKey: null,
      identityHash: waitingTokenIdentityHash({ token: 'alice-token', via: 'env' }),
      memory
    }), 'utf8')
    const env = { GITHUB_TOKEN: 'alice-token' }
    const authorization: string[] = []
    const service = new WaitingService(settings, files, {
      env,
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      clock: createWaitingClock(() => new Date(BASE_TIME)),
      todos: { available: true, async listWaitingOnMe() { throw new Error('local todo source unavailable') } },
      git: async () => ({ code: 1, stdout: '', stderr: 'local repository unavailable' }),
      fetchImpl: async (_input, init) => {
        const token = new Headers(init?.headers).get('Authorization') ?? ''
        authorization.push(token)
        if (token === 'Bearer alice-token') return jsonResponse({ message: 'offline' }, 500)
        return successFor(JSON.parse(String(init?.body ?? '{}')) as GraphqlRequest)
      }
    })

    expect(service.current().rows.map(row => row.title)).not.toContain('Alice private issue')
    const alice = await service.refresh(false)
    expect(alice.rows.map(row => row.title)).toContain('Alice private issue')

    env.GITHUB_TOKEN = 'bob-token'
    const bob = await service.refresh(false)
    expect(authorization[0]).toBe('Bearer alice-token')
    expect(authorization.slice(1).every(token => token === 'Bearer bob-token')).toBe(true)
    expect(bob.rows.map(row => row.title)).not.toContain('Alice private issue')
    expect(bob.rows.map(row => row.title)).toContain('Local todo survives account change')
    expect(service.observedLocalLinks()).toEqual([{ github: 'example/private', path: 'C:/local-repo' }])
    const persistedForBob = readFileSync(files.cache, 'utf8')
    expect(JSON.parse(persistedForBob).identityHash).toBe(waitingTokenIdentityHash({ token: 'bob-token', via: 'env' }))
    expect(persistedForBob).not.toContain('alice-token')
    expect(persistedForBob).not.toContain('bob-token')

    const requestsBeforeMissingAuth = authorization.length
    env.GITHUB_TOKEN = ''
    const missing = await service.refresh(false)
    expect(missing.auth).toBe('missing')
    expect(authorization).toHaveLength(requestsBeforeMissingAuth)
    expect(missing.rows.map(row => row.title)).not.toContain('Alice private issue')
    expect(missing.rows.map(row => row.title)).toContain('Local todo survives account change')
    expect(service.observedLocalLinks()).toEqual([{ github: 'example/private', path: 'C:/local-repo' }])
    expect(JSON.parse(readFileSync(files.cache, 'utf8')).identityHash).toBeNull()
  })

  it('queues a waiting refresh after watched repositories change and uses the new scope', async () => {
    const dir = tempDir('arckeep-waiting-scope-')
    const settings = settingsFor(dir)
    settings.setRepos(['first/repo'])
    settings.setWaiting(waitingConfig())
    const started = deferred<void>()
    const response = deferred<Response>()
    const requests: GraphqlRequest[] = []
    const service = new WaitingService(settings, {
      cache: waitingCachePath(dir),
      dismissals: waitingDismissalPath(dir)
    }, {
      env: { GITHUB_TOKEN: 'test-token' },
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      clock: createWaitingClock(() => new Date(BASE_TIME)),
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as GraphqlRequest
        requests.push(request)
        if (requests.length === 1) {
          started.resolve()
          return response.promise
        }
        return successFor(request)
      }
    })

    const first = service.refresh(false)
    await started.promise
    settings.setRepos(['second/repo'])
    const second = service.refresh(false)
    await Promise.resolve()
    expect(requests).toHaveLength(1)

    response.resolve(successFor(requests[0]!))
    await Promise.all([first, second])
    const requestedRepos = requests
      .map(request => request.variables)
      .filter((variables): variables is Record<string, unknown> => Boolean(variables?.o0 && variables?.n0))
      .map(variables => `${variables.o0}/${variables.n0}`)
    expect(new Set(requestedRepos)).toEqual(new Set(['first/repo', 'second/repo']))
  })

  it('waits for a rate-limit reset before retrying waiting and does not cache a failed refresh as successful', async () => {
    const dir = tempDir('arckeep-waiting-error-')
    const settings = settingsFor(dir)
    settings.setRepos(['example/demo'])
    settings.setWaiting(waitingConfig())
    let now = BASE_TIME
    let fail = true
    const fetcher = recorder((request, index) => {
      if (index === 1 && fail) {
        fail = false
        return jsonResponse({ message: 'API rate limit exceeded' }, 429, { 'x-ratelimit-reset': '1791500000' })
      }
      return successFor(request)
    })
    const service = new WaitingService(settings, {
      cache: waitingCachePath(dir),
      dismissals: waitingDismissalPath(dir)
    }, {
      env: { GITHUB_TOKEN: 'test-token' },
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      clock: createWaitingClock(() => new Date(now)),
      fetchImpl: fetcher.fetchImpl
    })

    const limited = await service.refresh(false)
    expect(limited.rateLimitResetAt).toBeTruthy()
    const callsAfterLimit = fetcher.requests.length
    const cooled = await service.refresh(false)
    expect(cooled.rateLimitResetAt).toBe(limited.rateLimitResetAt)
    expect(fetcher.requests).toHaveLength(callsAfterLimit)
    now = Date.parse(limited.rateLimitResetAt!) + 1
    const retried = await service.refresh(false)
    expect(retried.rateLimitResetAt).toBeNull()
    expect(fetcher.requests.length).toBeGreaterThan(callsAfterLimit)
  })

  it('rebuilds cached local waiting rows on startup without GitHub, todo reads, or disk writes', () => {
    const dir = tempDir('arckeep-waiting-startup-')
    const settings = settingsFor(dir)
    settings.setWaiting(waitingConfig())
    const cache = waitingCachePath(dir)
    const dismissals = waitingDismissalPath(dir)
    const memory = emptyWaitingMemory()
    memory.todos = [
      waitingTodo('visible', 'Cached local todo'),
      waitingTodo('snoozed', 'Snoozed cached todo')
    ]
    memory.assignee.push(blankRecord({
      kind: 'issue',
      repo: 'example/parked',
      number: 42,
      title: 'Parked assigned issue',
      url: 'https://github.com/example/parked/issues/42',
      repoDescription: 'parked',
      fromAssignee: true,
      assignedAt: new Date(BASE_TIME - 2 * 86_400_000).toISOString(),
      assignedBy: 'ada',
      viewerLogin: 'ada'
    }))
    const cached = { version: 1, refreshedAt: new Date(BASE_TIME - 5_000).toISOString(), memory }
    writeFileSync(cache, JSON.stringify(cached), 'utf8')
    const dismissalState = writeDismissalState({
      items: {
        'todo:snoozed': { snoozeUntil: new Date(BASE_TIME + 86_400_000).toISOString(), ignored: false, ignoredUpdatedAt: null }
      },
      hiddenRepos: [],
      revealedParked: [],
      maybeWhenEmpty: null,
      maybeWhenListed: null
    })
    writeFileSync(dismissals, JSON.stringify(dismissalState), 'utf8')
    const cacheContents = cached
    let ghReads = 0
    let todoReads = 0
    const service = new WaitingService(settings, { cache, dismissals }, {
      readGh: async () => { ghReads += 1; return { ok: false, reason: 'not-installed' } },
      fetchImpl: async () => { throw new Error('startup must not fetch') },
      clock: createWaitingClock(() => new Date(BASE_TIME)),
      todos: { available: true, async listWaitingOnMe() { todoReads += 1; return [] } }
    })

    expect(service.current().rows.map(row => row.title)).toEqual(['Cached local todo'])
    expect(service.current().hiddenCount).toBe(1)
    expect(service.current().refreshedAt).toBeNull()
    expect(service.observedGithubRepos()).toEqual([])
    expect(service.current().refreshing).toBe(false)
    expect(ghReads).toBe(0)
    expect(todoReads).toBe(0)
    expect(JSON.parse(readFileSync(cache, 'utf8')).memory.todos).toEqual(cacheContents.memory.todos)
  })
})
