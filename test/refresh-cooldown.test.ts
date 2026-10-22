import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { OverviewService } from '../src/main/overview-service.js'
import { SettingsService } from '../src/main/settings-service.js'
import type { SecretBox } from '../src/main/token-store.js'
import { WaitingService } from '../src/main/waiting-service.js'
import { overviewCachePath, settingsFilePath, waitingCachePath, waitingDismissalPath } from '../src/main/paths.js'
import { defaultWaitingConfig } from '../src/shared/waiting/rules.js'
import { createWaitingClock } from '../src/shared/waiting/clock.js'
import type { TodoWaitingItem, WaitingConfig } from '../src/shared/waiting/types.js'

const BASE_TIME = Date.parse('2026-10-12T02:00:00.000Z')
const COOLDOWN_MS = 120_000

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'arckeep-refresh-cooldown-'))
}

function makeSettings(dir: string): SettingsService {
  const secretBox: SecretBox = {
    encrypt: value => `encrypted:${Buffer.from(value, 'utf8').toString('base64')}`,
    decrypt: value => value.startsWith('encrypted:')
      ? Buffer.from(value.slice('encrypted:'.length), 'base64').toString('utf8')
      : ''
  }
  const settings = new SettingsService({
    file: settingsFilePath(dir),
    secretBox,
    registrar: { register: () => true, isRegistered: () => true, unregister: () => {} },
    onHotkey: () => {},
    readGh: async () => ({ ok: false, reason: 'not-installed' })
  })
  settings.init()
  settings.setRepoFetchWindow('all')
  return settings
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

function quotaResponse(now: number): { response: Response, resetAt: string } {
  const resetAt = new Date(now + COOLDOWN_MS).toISOString()
  return {
    resetAt,
    response: jsonResponse(
      { message: 'API rate limit exceeded' },
      429,
      { 'x-ratelimit-reset': String(Math.ceil(Date.parse(resetAt) / 1000)) }
    )
  }
}

function overviewSuccess(): Response {
  const recent = new Date(BASE_TIME - 86_400_000).toISOString()
  return jsonResponse({
    data: {
      r0: {
        nameWithOwner: 'example/demo',
        url: 'https://github.com/example/demo',
        isEmpty: false,
        isArchived: false,
        diskUsage: 20,
        createdAt: new Date(BASE_TIME - 10 * 86_400_000).toISOString(),
        pushedAt: recent,
        defaultBranchRef: {
          target: {
            oid: 'abc123',
            committedDate: recent,
            statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } }
          }
        },
        pullRequests: { totalCount: 0, nodes: [] },
        commandCenters: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
        issues: { nodes: [] },
        recentPulls: { nodes: [] }
      },
      ccEnglish: { issueCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
      ccChinese: { issueCount: 0, pageInfo: { hasNextPage: false }, nodes: [] }
    }
  })
}

function waitingSuccess(): Response {
  const emptyConnection = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }
  return jsonResponse({
    data: {
      viewer: { login: 'ada', repositories: emptyConnection, watching: emptyConnection }
    }
  })
}

function waitingConfig(): WaitingConfig {
  const defaults = defaultWaitingConfig()
  return {
    ...defaults,
    sources: {
      ...defaults.sources,
      assignee: false,
      reviewRequested: false,
      mentions: false,
      todos: true,
      statusDocs: false,
      openPrs: false,
      humanIssues: false,
      localBranches: false
    }
  }
}

function todo(title: string): TodoWaitingItem {
  const createdAt = new Date(BASE_TIME - 60_000).toISOString()
  return { id: 'local-task', title, createdAt, updatedAt: createdAt, url: 'arckeep://todos?id=local-task' }
}

describe('refresh cooldown gate', () => {
  it('blocks forced overview refreshes for the same identity until reset or identity change', async () => {
    const dir = tempDir()
    const settings = makeSettings(dir)
    expect(settings.setRepos(['example/demo']).ok).toBe(true)
    const env = { GITHUB_TOKEN: 'alice-token' }
    let now = BASE_TIME
    let aliceLimited = false
    let bobLimited = false
    let requests = 0
    const service = new OverviewService(settings, overviewCachePath(dir), {
      env,
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      now: () => new Date(now),
      fetchImpl: async (_input, init) => {
        requests += 1
        const token = new Headers(init?.headers).get('Authorization')
        if ((token === 'Bearer alice-token' && aliceLimited) || (token === 'Bearer bob-token' && bobLimited)) {
          return quotaResponse(now).response
        }
        return overviewSuccess()
      }
    })

    const baseline = await service.refresh(false)
    expect(baseline.rows.map(row => row.name)).toEqual(['example/demo'])

    aliceLimited = true
    const limited = await service.refresh(true)
    expect(limited.rateLimitResetAt).toBe(new Date(now + COOLDOWN_MS).toISOString())
    expect(limited.rows.map(({ commandCenter: _cc, ...row }) => row)).toEqual(baseline.rows.map(({ commandCenter: _cc, ...row }) => row))
    expect(limited.rows[0]?.commandCenter?.kind).toBe('unavailable')
    expect(limited.sourceErrors.length).toBeGreaterThan(0)
    const limitErrors = limited.sourceErrors
    const afterLimit = requests

    const blockedForce = await service.refresh(true)
    expect(requests).toBe(afterLimit)
    expect(blockedForce.rows).toEqual(limited.rows)
    expect(blockedForce.rateLimitResetAt).toBe(limited.rateLimitResetAt)
    expect(blockedForce.sourceErrors).toEqual(limitErrors)
    expect(blockedForce.refreshing).toBe(false)

    const currentConfig = settings.getSettings().overview
    expect(settings.setOverview({ ...currentConfig, staleDays: currentConfig.staleDays + 1 }).ok).toBe(true)
    const changedConfig = await service.refresh(true)
    expect(requests).toBe(afterLimit)
    expect(changedConfig.rateLimitResetAt).toBe(limited.rateLimitResetAt)

    service.current().rateLimitResetAt = 'invalid-reset-time'
    await service.refresh(true)
    expect(requests).toBe(afterLimit + 1)
    expect(service.current().rateLimitResetAt).toBe(new Date(now + COOLDOWN_MS).toISOString())

    now = Date.parse(service.current().rateLimitResetAt!) + 1
    aliceLimited = false
    const afterExpiry = await service.refresh(true)
    expect(requests).toBe(afterLimit + 2)
    expect(afterExpiry.rateLimitResetAt).toBeNull()
    expect(afterExpiry.rows.map(row => row.name)).toEqual(['example/demo'])

    aliceLimited = true
    await service.refresh(true)
    const beforeIdentityChange = requests
    env.GITHUB_TOKEN = 'bob-token'
    const bob = await service.refresh(true)
    expect(requests).toBe(beforeIdentityChange + 1)
    expect(bob.auth).toBe('ok')
    expect(bob.rateLimitResetAt).toBeNull()

    bobLimited = true
    const bobLimitedSnapshot = await service.refresh(true)
    expect(bobLimitedSnapshot.rateLimitResetAt).toBeTruthy()
    const beforeMissingAuth = requests
    env.GITHUB_TOKEN = ''
    const missing = await service.refresh(true)
    expect(requests).toBe(beforeMissingAuth)
    expect(missing.auth).toBe('missing')
    expect(missing.rateLimitResetAt).toBeNull()
    expect(missing.sourceErrors).toEqual([])
  })

  it('keeps waiting rows and limit errors while refreshing local todos without GitHub', async () => {
    const dir = tempDir()
    const settings = makeSettings(dir)
    expect(settings.setWaiting(waitingConfig()).ok).toBe(true)
    const env = { GITHUB_TOKEN: 'alice-token' }
    let now = BASE_TIME
    let aliceLimited = false
    let bobLimited = false
    let requests = 0
    let todoTitle = 'Local baseline'
    let todoFailure = false
    const service = new WaitingService(settings, {
      cache: waitingCachePath(dir),
      dismissals: waitingDismissalPath(dir)
    }, {
      env,
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      clock: createWaitingClock(() => new Date(now)),
      todos: {
        available: true,
        async listWaitingOnMe() {
          if (todoFailure) throw new Error('todo source temporarily unavailable')
          return [todo(todoTitle)]
        }
      },
      fetchImpl: async (_input, init) => {
        requests += 1
        const token = new Headers(init?.headers).get('Authorization')
        if ((token === 'Bearer alice-token' && aliceLimited) || (token === 'Bearer bob-token' && bobLimited)) {
          return quotaResponse(now).response
        }
        return waitingSuccess()
      }
    })

    const baseline = await service.refresh(false)
    expect(baseline.rows.map(row => row.title)).toContain('Local baseline')

    aliceLimited = true
    const limited = await service.refresh(true)
    expect(limited.rateLimitResetAt).toBe(new Date(now + COOLDOWN_MS).toISOString())
    expect(limited.rows.map(row => row.title)).toContain('Local baseline')
    expect(limited.sourceErrors.length).toBeGreaterThan(0)
    const limitErrors = limited.sourceErrors
    const afterLimit = requests

    const blockedForce = await service.refresh(true)
    expect(requests).toBe(afterLimit)
    expect(blockedForce.rows.map(row => row.title)).toContain('Local baseline')
    expect(blockedForce.rateLimitResetAt).toBe(limited.rateLimitResetAt)
    expect(blockedForce.sourceErrors).toEqual(limitErrors)
    expect(blockedForce.refreshing).toBe(false)

    todoFailure = true
    const failedLocalRefresh = await service.refresh(true)
    expect(requests).toBe(afterLimit)
    expect(failedLocalRefresh.sourceErrors.map(error => error.source)).toEqual(['GitHub', '待办'])
    const failedLocalErrors = failedLocalRefresh.sourceErrors
    const repeatedLocalFailure = await service.refresh(true)
    expect(requests).toBe(afterLimit)
    expect(repeatedLocalFailure.sourceErrors).toEqual(failedLocalErrors)

    todoFailure = false
    todoTitle = 'Updated local todo during cooldown'
    const currentConfig = settings.getSettings().waiting
    expect(settings.setWaiting({ ...currentConfig, showIgnored: true }).ok).toBe(true)
    const changedConfig = await service.refresh(true)
    expect(requests).toBe(afterLimit)
    expect(changedConfig.rows.map(row => row.title)).toContain('Updated local todo during cooldown')
    expect(changedConfig.rateLimitResetAt).toBe(limited.rateLimitResetAt)
    expect(changedConfig.sourceErrors).toEqual(limitErrors)

    service.current().rateLimitResetAt = 'invalid-reset-time'
    await service.refresh(true)
    expect(requests).toBe(afterLimit + 1)

    now = Date.parse(service.current().rateLimitResetAt!) + 1
    aliceLimited = false
    const afterExpiry = await service.refresh(true)
    expect(requests).toBe(afterLimit + 2)
    expect(afterExpiry.rateLimitResetAt).toBeNull()
    expect(afterExpiry.rows.map(row => row.title)).toContain('Updated local todo during cooldown')

    aliceLimited = true
    await service.refresh(true)
    const beforeIdentityChange = requests
    env.GITHUB_TOKEN = 'bob-token'
    const bob = await service.refresh(true)
    expect(requests).toBe(beforeIdentityChange + 1)
    expect(bob.auth).toBe('ok')
    expect(bob.rateLimitResetAt).toBeNull()

    bobLimited = true
    const bobLimitedSnapshot = await service.refresh(true)
    expect(bobLimitedSnapshot.rateLimitResetAt).toBeTruthy()
    const beforeMissingAuth = requests
    env.GITHUB_TOKEN = ''
    todoTitle = 'Local todo with missing authentication'
    const missing = await service.refresh(true)
    expect(requests).toBe(beforeMissingAuth)
    expect(missing.auth).toBe('missing')
    expect(missing.rateLimitResetAt).toBeNull()
    expect(missing.rows.map(row => row.title)).toContain('Local todo with missing authentication')
  })

  it('preserves cached local branches through Git failures during cooldown and replaces them after recovery', async () => {
    const dir = tempDir()
    const settings = makeSettings(dir)
    const config = waitingConfig()
    config.sources.todos = false
    config.sources.localBranches = true
    config.localRepoDirs = ['C:/synthetic-local-repo']
    expect(settings.setWaiting(config).ok).toBe(true)
    const cache = waitingCachePath(dir)
    const files = { cache, dismissals: waitingDismissalPath(dir) }
    const now = BASE_TIME
    let rateLimited = false
    let gitFailure = false
    let branchName = 'feature/local-before-failure'
    let requests = 0
    const service = new WaitingService(settings, files, {
      env: { GITHUB_TOKEN: 'synthetic-token' },
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      clock: createWaitingClock(() => new Date(now)),
      git: async args => {
        if (args.includes('rev-parse')) return { code: 0, stdout: 'true', stderr: '' }
        if (args.includes('remote')) return { code: 0, stdout: 'https://github.com/example/demo.git', stderr: '' }
        if (gitFailure && args.includes('for-each-ref')) {
          return { code: 1, stdout: '', stderr: 'synthetic local IO failure' }
        }
        return {
          code: 0,
          stdout: [branchName, 'origin/main', '[ahead 1]', new Date(now - 60_000).toISOString(), 'abcdef', 'Local change'].join('\0'),
          stderr: ''
        }
      },
      fetchImpl: async () => {
        requests += 1
        return rateLimited ? quotaResponse(now).response : waitingSuccess()
      }
    })

    const baseline = await service.refresh(true)
    expect(baseline.rows.map(row => row.title)).toContain('feature/local-before-failure 领先 1 个提交 · Local change')
    expect(JSON.parse(readFileSync(cache, 'utf8')).memory.branches).toHaveLength(1)

    rateLimited = true
    const limited = await service.refresh(true)
    expect(limited.rateLimitResetAt).toBeTruthy()
    expect(limited.rows.map(row => row.title)).toContain('feature/local-before-failure 领先 1 个提交 · Local change')
    const afterLimit = requests

    gitFailure = true
    const failedLocalRead = await service.refresh(true)
    expect(requests).toBe(afterLimit)
    expect(failedLocalRead.rateLimitResetAt).toBe(limited.rateLimitResetAt)
    expect(failedLocalRead.rows.map(row => row.title)).toContain('feature/local-before-failure 领先 1 个提交 · Local change')
    expect(failedLocalRead.sourceErrors).toEqual([
      ...limited.sourceErrors,
      { source: '本地没推送', message: 'synthetic local IO failure' }
    ])
    expect(JSON.parse(readFileSync(cache, 'utf8')).memory.branches).toHaveLength(1)

    gitFailure = false
    branchName = 'feature/local-after-recovery'
    const recovered = await service.refresh(true)
    expect(requests).toBe(afterLimit)
    expect(recovered.rateLimitResetAt).toBe(limited.rateLimitResetAt)
    expect(recovered.rows.map(row => row.title)).toContain('feature/local-after-recovery 领先 1 个提交 · Local change')
    expect(recovered.rows.map(row => row.title)).not.toContain('feature/local-before-failure 领先 1 个提交 · Local change')
    expect(recovered.sourceErrors).toEqual(limited.sourceErrors)
    const cachedBranches = JSON.parse(readFileSync(cache, 'utf8')).memory.branches
    expect(cachedBranches).toHaveLength(1)
    expect(cachedBranches[0].branch).toBe('feature/local-after-recovery')
  })

  it('does not treat permission 403 responses as a cooldown and rejects refreshes after close', async () => {
    const dir = tempDir()
    const settings = makeSettings(dir)
    expect(settings.setRepos(['example/demo']).ok).toBe(true)
    expect(settings.setWaiting(waitingConfig()).ok).toBe(true)
    let overviewRequests = 0
    let waitingRequests = 0
    const permissionDenied = () => jsonResponse({ message: 'Resource not accessible by integration' }, 403)
    const overview = new OverviewService(settings, overviewCachePath(dir), {
      env: { GITHUB_TOKEN: 'permission-token' },
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      now: () => new Date(BASE_TIME),
      fetchImpl: async () => { overviewRequests += 1; return permissionDenied() }
    })
    const overviewDenied = await overview.refresh(true)
    expect(overviewDenied.rateLimitResetAt).toBeNull()
    const afterOverviewDenied = overviewRequests
    await overview.refresh(true)
    expect(overviewRequests).toBeGreaterThan(afterOverviewDenied)

    const waiting = new WaitingService(settings, {
      cache: waitingCachePath(dir),
      dismissals: waitingDismissalPath(dir)
    }, {
      env: { GITHUB_TOKEN: 'permission-token' },
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      clock: createWaitingClock(() => new Date(BASE_TIME)),
      todos: { available: true, async listWaitingOnMe() { return [todo('Local todo')] } },
      fetchImpl: async () => { waitingRequests += 1; return permissionDenied() }
    })
    const waitingDenied = await waiting.refresh(true)
    expect(waitingDenied.rateLimitResetAt).toBeNull()
    const afterWaitingDenied = waitingRequests
    await waiting.refresh(true)
    expect(waitingRequests).toBeGreaterThan(afterWaitingDenied)

    overview.close()
    waiting.close()
    const requestsBeforeClose = overviewRequests + waitingRequests
    await expect(overview.refresh(true)).rejects.toThrow()
    await expect(waiting.refresh(true)).rejects.toThrow()
    expect(overviewRequests + waitingRequests).toBe(requestsBeforeClose)
  })
})
