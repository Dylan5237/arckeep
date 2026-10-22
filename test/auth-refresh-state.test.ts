import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GhLookup } from '../src/main/github-auth.js'
import { OverviewService } from '../src/main/overview-service.js'
import { WaitingService } from '../src/main/waiting-service.js'
import { SettingsService } from '../src/main/settings-service.js'
import { overviewCachePath, settingsFilePath, waitingCachePath, waitingDismissalPath } from '../src/main/paths.js'
import { createWaitingClock } from '../src/shared/waiting/clock.js'
import { defaultWaitingConfig } from '../src/shared/waiting/rules.js'
import { blankRecord } from '../src/shared/waiting/parse-github.js'
import type { TodoWaitingProvider } from '../src/shared/waiting/types.js'
import type { WaitingMemory } from '../src/waiting/collect.js'

const NOW = new Date('2026-10-09T00:00:00.000Z')
type ServiceKind = 'overview' | 'waiting'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function settingsFor(dir: string): SettingsService {
  const settings = new SettingsService({
    file: settingsFilePath(dir),
    secretBox: { encrypt: value => value, decrypt: value => value },
    registrar: { register: () => true, isRegistered: () => true, unregister: () => {} },
    onHotkey: () => {},
    readGh: async () => ({ ok: false, reason: 'not-installed' })
  })
  settings.init()
  settings.setRepos(['example/demo'])
  const config = defaultWaitingConfig()
  settings.setWaiting({
    ...config,
    sources: {
      ...config.sources,
      reviewRequested: false,
      mentions: false,
      openPrs: false,
      humanIssues: false,
      statusDocs: false,
      localBranches: false
    }
  })
  return settings
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function successfulResponse(init?: RequestInit): Response {
  const request = JSON.parse(String(init?.body ?? '{}')) as { query?: string }
  if (request.query?.includes('viewer { login }')) return jsonResponse({ data: { viewer: { login: 'test-user' } } })
  if (request.query?.includes('r0: repository(owner:')) {
    return jsonResponse({ data: { r0: {
      nameWithOwner: 'example/demo',
      url: 'https://github.com/example/demo',
      isEmpty: false,
      diskUsage: 20,
      createdAt: '2026-10-01T00:00:00.000Z',
      pushedAt: '2026-10-08T00:00:00.000Z',
      defaultBranchRef: { target: {
        oid: 'test-commit',
        committedDate: '2026-10-08T00:00:00.000Z',
        statusCheckRollup: { state: 'SUCCESS' }
      } },
      pullRequests: { totalCount: 0, nodes: [] },
      commandCenters: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
      issues: { nodes: [] }
    }, ccEnglish: { issueCount: 0, pageInfo: { hasNextPage: false }, nodes: [] }, ccChinese: { issueCount: 0, pageInfo: { hasNextPage: false }, nodes: [] } } })
  }
  return jsonResponse({ data: { search: { pageInfo: { hasNextPage: false }, nodes: [] } } })
}

function fixture(kind: ServiceKind, options: {
  dir?: string
  readGh: () => Promise<GhLookup>
  fetchImpl?: typeof fetch
  todos?: TodoWaitingProvider
}) {
  const dir = options.dir ?? mkdtempSync(path.join(tmpdir(), `arckeep-${kind}-auth-state-`))
  const settings = settingsFor(dir)
  const shared = {
    env: {},
    readGh: options.readGh,
    fetchImpl: options.fetchImpl ?? (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => successfulResponse(init))
  }
  const service = kind === 'overview'
    ? new OverviewService(settings, overviewCachePath(dir), { ...shared, now: () => NOW })
    : new WaitingService(settings, { cache: waitingCachePath(dir), dismissals: waitingDismissalPath(dir) }, {
      ...shared,
      clock: createWaitingClock(() => NOW),
      todos: options.todos ?? { available: true, async listWaitingOnMe() { return [] } }
    })
  return { dir, service }
}

describe.each<ServiceKind>(['overview', 'waiting'])('%s authentication snapshot during refresh', kind => {
  it('keeps authentication unknown until credential lookup completes, then publishes the resolved state during the query', async () => {
    const lookup = deferred<GhLookup>()
    const networkStarted = deferred<void>()
    const response = deferred<Response>()
    const { service } = fixture(kind, {
      readGh: () => lookup.promise,
      fetchImpl: async (_input, init) => {
        networkStarted.resolve()
        await response.promise
        return successfulResponse(init)
      }
    })
    expect(service.current().auth).toBe('unknown')
    const refresh = service.refresh(false)
    await Promise.resolve()
    expect(service.current()).toMatchObject({ auth: 'unknown', refreshing: true })
    expect(service.current().rows).toEqual([])

    lookup.resolve({ ok: true, token: 'fake-auth-state-token' })
    await networkStarted.promise
    expect(service.current()).toMatchObject({ auth: 'ok', refreshing: true })
    response.resolve(jsonResponse({}))
    const result = await refresh
    expect(result).toMatchObject({ auth: 'ok', refreshing: false })
    await service.shutdown()
  })

  it('reports missing authentication only after all credential sources resolve empty', async () => {
    const lookup = deferred<GhLookup>()
    let fetches = 0
    const { service } = fixture(kind, {
      readGh: () => lookup.promise,
      fetchImpl: async () => { fetches += 1; throw new Error('missing credentials must not make a GitHub request') }
    })
    const refresh = service.refresh(false)
    await Promise.resolve()
    expect(service.current().auth).toBe('unknown')
    lookup.resolve({ ok: false, reason: 'not-logged-in' })
    expect(await refresh).toMatchObject({ auth: 'missing', refreshing: false })
    expect(fetches).toBe(0)
    await service.shutdown()
  })

  it('still reports an explicitly rejected credential as invalid', async () => {
    const { service } = fixture(kind, {
      readGh: async () => ({ ok: true, token: 'fake-rejected-token' }),
      fetchImpl: async () => jsonResponse({ message: 'Bad credentials' }, 401)
    })
    expect(await service.refresh(false)).toMatchObject({ auth: 'invalid', refreshing: false })
    await service.shutdown()
  })

  it.each(['missing', 'invalid'] as const)('clears a previous %s diagnosis while fresh credentials are being checked', async previousAuth => {
    let access: Promise<GhLookup> = Promise.resolve(previousAuth === 'missing'
      ? { ok: false, reason: 'not-logged-in' }
      : { ok: true, token: 'fake-old-rejected-token' })
    let rejectCredential = previousAuth === 'invalid'
    const { service } = fixture(kind, {
      readGh: () => access,
      fetchImpl: async (_input, init) => rejectCredential
        ? jsonResponse({ message: 'Bad credentials' }, 401)
        : successfulResponse(init)
    })
    const previous = await service.refresh(false)
    expect(previous).toMatchObject({ auth: previousAuth, refreshing: false })
    if (previousAuth === 'invalid') expect(previous.sourceErrors.length).toBeGreaterThan(0)

    const lookup = deferred<GhLookup>()
    access = lookup.promise
    rejectCredential = false
    const retry = service.refresh()
    expect(service.current()).toMatchObject({ auth: 'unknown', refreshing: true })
    expect(service.current().sourceErrors).toEqual([])
    await Promise.resolve()
    expect(service.current().auth).toBe('unknown')
    lookup.resolve({ ok: true, token: 'fake-new-valid-token' })
    expect(await retry).toMatchObject({ auth: 'ok', refreshing: false })
    await service.shutdown()
  })

  it('retains a verified authenticated snapshot while rechecking credentials', async () => {
    let access: Promise<GhLookup> = Promise.resolve({ ok: true, token: 'fake-stable-token' })
    const { service } = fixture(kind, { readGh: () => access })
    const previous = await service.refresh(false)
    expect(previous.auth).toBe('ok')
    const lookup = deferred<GhLookup>()
    access = lookup.promise
    const refresh = service.refresh()
    expect(service.current()).toMatchObject({ auth: 'ok', refreshing: true, rows: previous.rows })
    lookup.resolve({ ok: true, token: 'fake-stable-token' })
    expect(await refresh).toMatchObject({ auth: 'ok', refreshing: false })
    await service.shutdown()
  })

  it('does not turn an authentication lookup failure into a missing-credential diagnosis', async () => {
    const { service } = fixture(kind, {
      readGh: async () => { throw new Error('credential process failed') },
      fetchImpl: async () => { throw new Error('lookup failure must not make a GitHub request') }
    })
    await expect(service.refresh(false)).rejects.toThrow('credential process failed')
    expect(service.current()).toMatchObject({ auth: 'unknown', refreshing: false })
    expect(service.current().rows).toEqual([])
    await service.shutdown()
  })

  it('does not diagnose missing credentials when a pending lookup is cancelled', async () => {
    const lookupStarted = deferred<void>()
    const lookup = deferred<GhLookup>()
    const { service } = fixture(kind, {
      readGh: () => { lookupStarted.resolve(); return lookup.promise },
      fetchImpl: async () => { throw new Error('cancelled lookup must not make a GitHub request') }
    })
    const refresh = service.refresh(false)
    const rejected = expect(refresh).rejects.toMatchObject({ name: 'AbortError' })
    await lookupStarted.promise
    service.close()
    await rejected
    expect(service.current()).toMatchObject({ auth: 'unknown', refreshing: false })
    expect(service.current().rows).toEqual([])
    lookup.resolve({ ok: true, token: 'fake-cancelled-token' })
    await service.shutdown()
  })

  it('marks a verified same-identity cache as authenticated without another remote request', async () => {
    let fetches = 0
    const fetchImpl: typeof fetch = async (_input, init) => { fetches += 1; return successfulResponse(init) }
    const first = fixture(kind, {
      readGh: async () => ({ ok: true, token: 'fake-cache-token' }),
      fetchImpl
    })
    expect(await first.service.refresh(false)).toMatchObject({ auth: 'ok', refreshing: false })
    const initialFetches = fetches
    await first.service.shutdown()
    if (kind === 'waiting') {
      const file = waitingCachePath(first.dir)
      const cached = JSON.parse(readFileSync(file, 'utf8')) as { memory: WaitingMemory }
      cached.memory.assignee.push(blankRecord({
        kind: 'issue',
        repo: 'example/demo',
        number: 17,
        title: 'Cached private assignment',
        url: 'https://github.com/example/demo/issues/17',
        fromAssignee: true,
        inScopeRepo: true,
        assignedAt: '2026-10-08T00:00:00.000Z',
        updatedAt: '2026-10-08T00:00:00.000Z'
      }))
      writeFileSync(file, JSON.stringify(cached), 'utf8')
    }

    const lookup = deferred<GhLookup>()
    const localStarted = deferred<void>()
    const localReady = deferred<[]>()
    const reopened = fixture(kind, {
      dir: first.dir,
      readGh: () => lookup.promise,
      fetchImpl,
      todos: { available: true, listWaitingOnMe() { localStarted.resolve(); return localReady.promise } }
    })
    const refresh = reopened.service.refresh(false)
    await Promise.resolve()
    expect(reopened.service.current()).toMatchObject({ auth: 'unknown', refreshing: true })
    expect(reopened.service.current().rows).toEqual([])
    lookup.resolve({ ok: true, token: 'fake-cache-token' })
    if (kind === 'waiting') {
      await localStarted.promise
      expect(reopened.service.current()).toMatchObject({ auth: 'ok', refreshing: true })
      expect(reopened.service.current().rows).toEqual([expect.objectContaining({ title: 'Cached private assignment' })])
      localReady.resolve([])
    }
    expect(await refresh).toMatchObject({ auth: 'ok', refreshing: false })
    expect(fetches).toBe(initialFetches)
    await reopened.service.shutdown()
  })
})
