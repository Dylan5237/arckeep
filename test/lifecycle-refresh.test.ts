import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { OverviewService } from '../src/main/overview-service.js'
import { WaitingService } from '../src/main/waiting-service.js'
import { overviewCachePath, settingsFilePath, waitingCachePath, waitingDismissalPath } from '../src/main/paths.js'
import { SettingsService } from '../src/main/settings-service.js'
import type { SecretBox } from '../src/main/token-store.js'
import { TaskScope } from '../src/shared/task-scope.js'
import { defaultWaitingConfig } from '../src/shared/waiting/rules.js'
import { emptyWaitingMemory } from '../src/waiting/collect.js'
import type { TodoWaitingItem, WaitingConfig } from '../src/shared/waiting/types.js'

const BASE_TIME = Date.parse('2026-10-08T00:00:00.000Z')

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
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

function settingsFor(dir: string, config: WaitingConfig = waitingConfig()): SettingsService {
  const settings = new SettingsService({
    file: settingsFilePath(dir),
    secretBox: testSecretBox(),
    registrar: { register: () => true, isRegistered: () => true, unregister: () => {} },
    onHotkey: () => {},
    readGh: async () => ({ ok: false, reason: 'not-installed' })
  })
  settings.init()
  settings.setWaiting(config)
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

function discoveryOnlyConfig(): WaitingConfig {
  const defaults = defaultWaitingConfig()
  return {
    ...defaults,
    sources: {
      assignee: false,
      reviewRequested: false,
      mentions: false,
      openPrs: false,
      humanIssues: false,
      statusDocs: false,
      localBranches: false,
      todos: false
    }
  }
}

function cachedTodo(): TodoWaitingItem {
  return {
    id: 'cached-todo',
    title: 'Cached waiting item',
    createdAt: new Date(BASE_TIME - 86_400_000).toISOString(),
    updatedAt: new Date(BASE_TIME - 86_400_000).toISOString(),
    url: 'arckeep://todos?id=cached-todo'
  }
}

function seedCache(dir: string): { cache: string, dismissals: string, original: string } {
  const cache = waitingCachePath(dir)
  const dismissals = waitingDismissalPath(dir)
  const memory = emptyWaitingMemory()
  memory.todos = [cachedTodo()]
  const original = JSON.stringify({ version: 1, refreshedAt: null, memory })
  writeFileSync(cache, original, 'utf8')
  return { cache, dismissals, original }
}

function snapshotWithoutRefreshing<T extends { refreshing: boolean }>(snapshot: T): T {
  return { ...snapshot, refreshing: false }
}

describe('application refresh cancellation', () => {
  it('cancels a hanging gh lookup for both services without fallback or cache writes', async () => {
    const dir = tempDir('arckeep-lifecycle-gh-')
    const settings = settingsFor(dir)
    const files = seedCache(dir)
    const overviewCache = overviewCachePath(dir)
    const overviewCacheContent = JSON.stringify({
      version: 1,
      refreshedAt: null,
      rows: [{
        name: 'cached/overview',
        url: 'https://github.com/cached/overview',
        lastCommitAt: null,
        openPrCount: 0,
        ciState: 'none',
        warnings: [],
        group: 'active',
        stallBasis: { at: null, source: 'none', lastCommitAt: null, lastIssueActivityAt: null },
        archived: false,
        error: null
      }]
    })
    writeFileSync(overviewCache, overviewCacheContent, 'utf8')
    const tasks = new TaskScope()
    const ghStarted = deferred<void>()
    const ghResult = deferred<{ ok: false, reason: 'not-installed' }>()
    let ghReads = 0
    let fetches = 0
    const readGh = (options?: { signal?: AbortSignal, tasks?: TaskScope }) => {
      expect(options?.signal).toBe(tasks.signal)
      expect(options?.tasks).toBe(tasks)
      ghReads += 1
      if (ghReads === 2) ghStarted.resolve()
      return ghResult.promise
    }
    const service = new WaitingService(settings, files, {
      env: { GITHUB_TOKEN: 'fallback-token' },
      tasks,
      readGh,
      fetchImpl: async () => {
        fetches += 1
        return new Response('{}')
      }
    })
    const overview = new OverviewService(settings, overviewCache, {
      env: { GITHUB_TOKEN: 'fallback-token' },
      tasks,
      readGh,
      fetchImpl: async () => {
        fetches += 1
        return new Response('{}')
      }
    })
    const before = service.current()
    const overviewBefore = overview.current()
    const cacheBefore = readFileSync(files.cache, 'utf8')
    const overviewCacheBefore = readFileSync(overviewCache, 'utf8')
    const refresh = service.refresh()
    const overviewRefresh = overview.refresh()
    await ghStarted.promise

    service.close()
    const outcomes = await Promise.allSettled([refresh, overviewRefresh])
    await Promise.all([service.shutdown(), overview.shutdown()])

    expect(outcomes.every(result => result.status === 'rejected' && result.reason instanceof Error && result.reason.name === 'AbortError')).toBe(true)
    expect(fetches).toBe(0)
    expect(service.current()).toEqual(snapshotWithoutRefreshing(before))
    expect(overview.current()).toEqual(snapshotWithoutRefreshing(overviewBefore))
    expect(readFileSync(files.cache, 'utf8')).toBe(cacheBefore)
    expect(readFileSync(overviewCache, 'utf8')).toBe(overviewCacheBefore)
    expect(tasks.pendingCount).toBe(0)
    expect(tasks.resourceCount).toBe(0)
    await expect(service.refresh()).rejects.toMatchObject({ name: 'AbortError' })
    await expect(overview.refresh()).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetches).toBe(0)

    ghResult.resolve({ ok: false, reason: 'not-installed' })
  })

  it('cancels a paged GitHub body read and queued config refresh without issuing another request or writing cache', async () => {
    const dir = tempDir('arckeep-lifecycle-pages-')
    const settings = settingsFor(dir, discoveryOnlyConfig())
    const files = seedCache(dir)
    const tasks = new TaskScope()
    const bodyStarted = deferred<void>()
    const bodyResult = deferred<string>()
    const requests: Array<{ query: string, signal?: AbortSignal }> = []
    const service = new WaitingService(settings, files, {
      env: { GITHUB_TOKEN: 'test-token' },
      tasks,
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { query: string }
        requests.push({ query: request.query, signal: init?.signal as AbortSignal | undefined })
        bodyStarted.resolve()
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'Content-Type': 'application/json' }),
          text: () => bodyResult.promise
        } as Response
      }
    })
    const before = service.current()
    const cacheBefore = readFileSync(files.cache, 'utf8')

    const first = service.refresh()
    await bodyStarted.promise
    // Credential resolution completed; the combined scope response is still pending.
    expect(before.auth).toBe('unknown')
    expect(service.current().auth).toBe('ok')
    expect(service.current().rows).toEqual(before.rows)
    settings.setRepos(['changed/while-refreshing'])
    const queued = service.refresh(false)
    await Promise.resolve()
    const beforeCancel = service.current()

    service.close()
    const outcomes = await Promise.allSettled([first, queued])
    await service.shutdown()

    expect(outcomes.every(result => result.status === 'rejected' && result.reason instanceof Error && result.reason.name === 'AbortError')).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.query).toMatch(/viewer\s*\{\s*login/)
    expect(requests[0]?.query).toContain('repositories(first:')
    expect(requests[0]?.query).toContain('watching(first:')
    expect(requests[0]?.signal?.aborted).toBe(true)
    expect(service.current()).toEqual(snapshotWithoutRefreshing(beforeCancel))
    expect(readFileSync(files.cache, 'utf8')).toBe(cacheBefore)
    expect(tasks.pendingCount).toBe(0)
    expect(tasks.resourceCount).toBe(0)
    await expect(service.refresh()).rejects.toMatchObject({ name: 'AbortError' })
    expect(requests).toHaveLength(1)

    bodyResult.resolve(JSON.stringify({
      data: {
        viewer: {
          repositories: {
            pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
            nodes: []
          }
        }
      }
    }))
  })
})
