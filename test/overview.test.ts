import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { OverviewService } from '../src/main/overview-service.js'
import { overviewCachePath, settingsFilePath } from '../src/main/paths.js'
import { SettingsService } from '../src/main/settings-service.js'
import type { SecretBox } from '../src/main/token-store.js'
import { classifyOverview, inAutoScope, isEmptyRepo, isReviewStuck } from '../src/shared/overview/classify.js'
import { defaultOverviewConfig, parseOverviewConfig } from '../src/shared/overview/rules.js'
import type { OverviewConfig, OverviewPullRequest, OverviewRepoFacts, OverviewRow } from '../src/shared/overview/types.js'
import { runOverviewCli } from '../src/overview/cli.js'
import { loadOverview, parseRepositoryNode } from '../src/overview/load.js'

const NOW = new Date('2026-09-28T00:00:00.000Z')
const DAY = 86_400_000

function ago(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString()
}

function config(patch: Partial<OverviewConfig> = {}): OverviewConfig {
  return { ...defaultOverviewConfig(), ...patch }
}

function facts(patch: Partial<OverviewRepoFacts> = {}): OverviewRepoFacts {
  return {
    name: 'example/demo',
    url: 'https://github.com/example/demo',
    isEmpty: false,
    sizeKb: 24,
    hasDefaultBranchCommit: true,
    pushedAt: ago(1),
    lastCommitAt: ago(1),
    openPrCount: 0,
    ciState: 'success',
    pullRequests: [],
    error: null,
    ...patch
  }
}

function pull(patch: Partial<OverviewPullRequest> = {}): OverviewPullRequest {
  return {
    number: 4,
    title: 'Review me',
    url: 'https://github.com/example/demo/pull/4',
    isDraft: false,
    createdAt: ago(5),
    reviewDecision: 'REVIEW_REQUIRED',
    approvedReviewCount: 0,
    ...patch
  }
}

function kinds(row: OverviewRow): string[] {
  return row.warnings.map(warning => warning.kind)
}

function xorBox(): SecretBox {
  return {
    encrypt(plain: string) {
      const xored = Uint8Array.from(Buffer.from(plain, 'utf8'), byte => byte ^ 0x5a)
      return Buffer.from(xored).toString('base64')
    },
    decrypt(payload: string) {
      const xored = Uint8Array.from(Buffer.from(payload, 'base64'), byte => byte ^ 0x5a)
      return Buffer.from(xored).toString('utf8')
    }
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

describe('overview warnings', () => {
  it('marks 停滞, 卡住, 空仓, and 陈旧 from configurable day counts', () => {
    const rules = config({ staleDays: 14, reviewWaitDays: 3, staleRepoDays: 90 })
    const stalled = classifyOverview([facts({
      name: 'example/quiet',
      url: 'https://github.com/example/quiet',
      pushedAt: ago(14),
      lastCommitAt: ago(14)
    })], rules, NOW)[0]
    expect(kinds(stalled!)).toEqual(['停滞'])
    expect(stalled?.warnings[0]?.targets).toEqual([{ url: 'https://github.com/example/quiet' }])

    const recent = classifyOverview([facts({ pushedAt: ago(13), lastCommitAt: ago(13) })], rules, NOW)[0]
    expect(kinds(recent!)).toEqual([])

    const stuck = classifyOverview([facts({
      openPrCount: 1,
      pullRequests: [pull({ createdAt: ago(3) })]
    })], rules, NOW)[0]
    expect(kinds(stuck!)).toEqual(['卡住'])
    expect(stuck?.warnings[0]?.targets).toEqual([{ url: 'https://github.com/example/demo/pull/4' }])
    expect(isReviewStuck(pull({ createdAt: ago(2) }), rules, NOW)).toBe(false)
    expect(isReviewStuck(pull({ isDraft: true, createdAt: ago(30) }), rules, NOW)).toBe(false)
    expect(isReviewStuck(pull({ reviewDecision: 'APPROVED', approvedReviewCount: 1 }), rules, NOW)).toBe(false)
    expect(isReviewStuck(pull({ reviewDecision: 'CHANGES_REQUESTED' }), rules, NOW)).toBe(false)

    expect(isEmptyRepo(facts({ isEmpty: true }))).toBe(true)
    expect(isEmptyRepo(facts({ sizeKb: 0, isEmpty: false, hasDefaultBranchCommit: true }))).toBe(true)
    expect(isEmptyRepo(facts({ hasDefaultBranchCommit: false, isEmpty: false, sizeKb: 8 }))).toBe(true)
    expect(isEmptyRepo(facts({ sizeKb: null }))).toBe(false)

    const empty = classifyOverview([facts({
      name: 'example/empty',
      url: 'https://github.com/example/empty',
      isEmpty: true,
      sizeKb: 0,
      hasDefaultBranchCommit: false,
      pushedAt: null,
      lastCommitAt: null,
      ciState: 'none'
    })], rules, NOW)[0]
    expect(kinds(empty!)).toEqual(['空仓'])
    expect(kinds(classifyOverview([facts({ sizeKb: 0 })], rules, NOW)[0]!)).toContain('空仓')
    expect(kinds(classifyOverview([facts({ hasDefaultBranchCommit: false, lastCommitAt: null })], rules, NOW)[0]!)).toContain('空仓')

    const ancient = classifyOverview([facts({
      pushedAt: ago(90),
      lastCommitAt: ago(1)
    })], rules, NOW)[0]
    expect(kinds(ancient!)).toEqual(['陈旧'])
    expect(kinds(classifyOverview([facts({ pushedAt: ago(89), lastCommitAt: ago(89) })], rules, NOW)[0]!)).toEqual(['停滞'])

    const named = classifyOverview([
      facts({ name: 'alpha/one', url: 'https://github.com/alpha/one', pushedAt: ago(20), lastCommitAt: ago(20) }),
      facts({ name: 'beta/two', url: 'https://github.com/beta/two', pushedAt: ago(20), lastCommitAt: ago(20) })
    ], rules, NOW)
    expect(named.map(row => kinds(row))).toEqual([['停滞'], ['停滞']])
  })

  it('sorts active warnings ahead of quiet repos and keeps 陈旧 after them, oldest first', () => {
    const rows = classifyOverview([
      facts({ name: 'example/clean', lastCommitAt: ago(1), pushedAt: ago(1) }),
      facts({ name: 'example/older-stale', lastCommitAt: ago(200), pushedAt: ago(200) }),
      facts({ name: 'example/stale', lastCommitAt: ago(100), pushedAt: ago(100) }),
      facts({
        name: 'example/stuck',
        lastCommitAt: ago(2),
        pushedAt: ago(2),
        openPrCount: 1,
        pullRequests: [pull({ url: 'https://github.com/example/stuck/pull/8', createdAt: ago(9) })]
      }),
      facts({ name: 'example/quiet', lastCommitAt: ago(20), pushedAt: ago(20) }),
      facts({ name: 'example/failed', lastCommitAt: ago(2), pushedAt: ago(2), ciState: 'failure' }),
      facts({ name: 'example/missing', error: '仓库不存在或无权访问', lastCommitAt: null, pushedAt: null, ciState: 'unknown' })
    ], config(), NOW)
    expect(rows.map(row => row.name)).toEqual([
      'example/stuck',
      'example/quiet',
      'example/failed',
      'example/clean',
      'example/missing',
      'example/older-stale',
      'example/stale'
    ])
    expect(rows.at(-1)?.warnings.map(warning => warning.kind)).toEqual(['陈旧'])
  })

  it('uses the auto-mode push window without naming a repository', () => {
    const rules = config({ autoPushWindowDays: 30, staleRepoDays: 90 })
    expect(inAutoScope({ isEmpty: false, pushedAt: ago(30) }, rules, NOW)).toBe(true)
    expect(inAutoScope({ isEmpty: false, pushedAt: ago(31) }, rules, NOW)).toBe(false)
    expect(inAutoScope({ isEmpty: false, pushedAt: ago(90) }, rules, NOW)).toBe(true)
    expect(inAutoScope({ isEmpty: true, pushedAt: null }, rules, NOW)).toBe(true)
    expect(inAutoScope({ isEmpty: false, pushedAt: null }, rules, NOW)).toBe(false)
    const defaults = defaultOverviewConfig()
    expect(JSON.stringify(defaults)).not.toContain('Dylan5237/')
    const source = [
      readFileSync(path.join('src', 'shared', 'overview', 'classify.ts'), 'utf8'),
      readFileSync(path.join('src', 'overview', 'load.ts'), 'utf8')
    ].join('\n')
    expect(source).not.toContain('Dylan5237/')
    expect(parseOverviewConfig(undefined)).toEqual(defaults)
    expect(() => parseOverviewConfig({ staleDays: 0 })).toThrow('停滞天数')
  })
})

describe('overview loading', () => {
  it('keeps a missing repository on its own row', async () => {
    const payload = {
      data: {
        r0: {
          nameWithOwner: 'example/live',
          url: 'https://github.com/example/live',
          isEmpty: false,
          diskUsage: 12,
          pushedAt: ago(2),
          defaultBranchRef: {
            target: {
              oid: 'abc',
              committedDate: ago(2),
              statusCheckRollup: { state: 'SUCCESS' }
            }
          },
          pullRequests: { totalCount: 0, nodes: [] }
        },
        r1: null
      },
      errors: [{ message: "Could not resolve to a Repository with the name 'example/gone'.", path: ['r1'] }]
    }
    const result = await loadOverview({
      token: 'test-token',
      config: config(),
      watchedRepos: ['example/live', 'example/gone'],
      now: NOW,
      fetchImpl: async () => jsonResponse(payload)
    })
    expect(result.fresh).toBe(true)
    expect(result.rows.map(row => row.name)).toEqual(['example/live', 'example/gone'])
    expect(result.rows[1]).toMatchObject({
      error: '仓库不存在或无权访问',
      ciState: 'unknown',
      warnings: [],
      openPrCount: 0
    })
    expect(result.rows[0]?.ciState).toBe('success')
  })

  it('falls back per repository when a batch fails', async () => {
    let calls = 0
    const result = await loadOverview({
      token: 'test-token',
      config: config(),
      watchedRepos: ['example/ok', 'example/denied'],
      now: NOW,
      fetchImpl: async (_url, init) => {
        calls += 1
        const body = JSON.parse(String(init?.body)) as { query: string, variables: Record<string, string> }
        if (body.query.includes('$o1')) throw new Error('batch failed')
        if (body.variables.n0 === 'denied') {
          return jsonResponse({
            data: { r0: null },
            errors: [{ message: 'Could not resolve to a Repository', path: ['r0'] }]
          })
        }
        return jsonResponse({
          data: {
            r0: {
              nameWithOwner: 'example/ok',
              url: 'https://github.com/example/ok',
              isEmpty: false,
              diskUsage: 4,
              pushedAt: ago(1),
              defaultBranchRef: { target: { oid: 'abc', committedDate: ago(1), statusCheckRollup: { state: 'FAILURE' } } },
              pullRequests: { totalCount: 0, nodes: [] }
            }
          }
        })
      }
    })
    expect(calls).toBeGreaterThan(1)
    expect(result.rows.map(row => [row.name, row.error, row.ciState])).toEqual([
      ['example/ok', null, 'failure'],
      ['example/denied', '仓库不存在或无权访问', 'unknown']
    ])
  })

  it('skips the quiet middle of auto mode and still loads empty and 陈旧 repos', async () => {
    const seen: string[] = []
    const node = (name: string, days: number) => ({
      nameWithOwner: name,
      url: `https://github.com/${name}`,
      isEmpty: false,
      diskUsage: 8,
      pushedAt: ago(days),
      defaultBranchRef: { target: { oid: 'abc', committedDate: ago(days), statusCheckRollup: null } },
      pullRequests: { totalCount: 0, nodes: [] }
    })
    await loadOverview({
      token: 'test-token',
      config: config({ autoPushWindowDays: 30, staleRepoDays: 90, maxScopeRepos: 20 }),
      watchedRepos: [],
      now: NOW,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { query: string, variables: Record<string, string> }
        if (body.query.includes('repositories(')) {
          return jsonResponse({
            data: {
              viewer: {
                repositories: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { nameWithOwner: 'example/recent', isEmpty: false, pushedAt: ago(2) },
                    { nameWithOwner: 'example/middle', isEmpty: false, pushedAt: ago(40) },
                    { nameWithOwner: 'example/ancient', isEmpty: false, pushedAt: ago(120) },
                    { nameWithOwner: 'example/blank', isEmpty: true, pushedAt: null }
                  ]
                }
              }
            }
          })
        }
        if (body.query.includes('watching(')) {
          return jsonResponse({
            data: { viewer: { watching: { pageInfo: { hasNextPage: false }, nodes: [] } } }
          })
        }
        for (const [key, value] of Object.entries(body.variables)) {
          if (key.startsWith('n')) seen.push(value)
        }
        const names = Object.entries(body.variables).filter(([key]) => key.startsWith('n')).map(([, value]) => value)
        const data: Record<string, unknown> = {}
        names.forEach((name, index) => {
          const full = `example/${name}`
          data[`r${index}`] = name === 'blank'
            ? { nameWithOwner: full, url: `https://github.com/${full}`, isEmpty: true, diskUsage: 0, pushedAt: null, defaultBranchRef: null, pullRequests: { totalCount: 0, nodes: [] } }
            : node(full, name === 'ancient' ? 120 : 2)
        })
        return jsonResponse({ data })
      }
    })
    expect(seen.sort()).toEqual(['ancient', 'blank', 'recent'])
  })

  it('keeps the previous list when GitHub rate limits, and does not call GitHub without a token', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'arckeep-overview-cache-'))
    const file = settingsFilePath(dir)
    const service = new SettingsService({
      file,
      secretBox: xorBox(),
      registrar: { register: () => true, isRegistered: () => false, unregister: () => {} },
      onHotkey: () => {},
      readGh: async () => ({ ok: false, reason: 'not-installed' })
    })
    service.init()
    expect(service.setRepos(['example/live']).ok).toBe(true)
    let fetches = 0
    const live = jsonResponse({
      data: {
        r0: {
          nameWithOwner: 'example/live',
          url: 'https://github.com/example/live',
          isEmpty: false,
          diskUsage: 3,
          pushedAt: ago(1),
          defaultBranchRef: { target: { oid: 'abc', committedDate: ago(1), statusCheckRollup: { state: 'SUCCESS' } } },
          pullRequests: { totalCount: 0, nodes: [] }
        }
      }
    })
    const overview = new OverviewService(service, overviewCachePath(dir), {
      env: { GITHUB_TOKEN: 'test-token' },
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      now: () => NOW,
      fetchImpl: async () => {
        fetches += 1
        if (fetches === 1) return live
        return jsonResponse('rate limit exceeded', 429, { 'x-ratelimit-reset': '1790600000' })
      }
    })
    const first = await overview.refresh()
    expect(first.rows.map(row => row.name)).toEqual(['example/live'])
    const limited = await overview.refresh()
    expect(limited.rows.map(row => row.name)).toEqual(['example/live'])
    expect(limited.rateLimitResetAt).toBeTruthy()
    const blocked = new OverviewService(service, overviewCachePath(`${dir}-empty`), {
      env: {},
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      fetchImpl: async () => { throw new Error('should not fetch') }
    })
    const missing = await blocked.refresh()
    expect(missing.auth).toBe('missing')
    expect(missing.rows).toEqual([])
  })
})

describe('overview cli', () => {
  it('prints name, url, last commit, pull count, CI, and warning urls', async () => {
    let output = ''
    const code = await runOverviewCli(['--json', '--fixture', path.join('test', 'fixtures', 'overview-cli.json')], {
      stdout: text => { output += text },
      stderr: () => {},
      env: {},
      fetchImpl: async () => { throw new Error('network') }
    })
    expect(code).toBe(0)
    const rows = JSON.parse(output) as OverviewRow[]
    expect(rows.map(row => row.name)).toEqual(['example/stuck', 'example/stalled'])
    for (const row of rows) {
      expect(row).toEqual(expect.objectContaining({
        name: expect.any(String),
        url: expect.stringContaining('https://github.com/example/'),
        openPrCount: expect.any(Number),
        ciState: expect.any(String)
      }))
      expect(Array.isArray(row.warnings)).toBe(true)
      for (const warning of row.warnings) {
        expect(warning.targets.every(target => target.url.startsWith('https://github.com/'))).toBe(true)
      }
    }
    expect(rows[0]?.warnings[0]).toMatchObject({ kind: '卡住', targets: [{ url: 'https://github.com/example/stuck/pull/8' }] })
    expect(rows[1]?.lastCommitAt).toBe('2026-09-01T00:00:00.000Z')
    expect(rows[1]?.ciState).toBe('failure')
  })
})

describe('repository node', () => {
  it('treats a missing default-branch commit as an empty repo signal', () => {
    const parsed = parseRepositoryNode({
      nameWithOwner: 'example/new',
      url: 'https://github.com/example/new',
      isEmpty: false,
      diskUsage: 0,
      pushedAt: null,
      defaultBranchRef: null,
      pullRequests: { totalCount: 0, nodes: [] }
    }, 'example/new')
    expect(parsed.hasDefaultBranchCommit).toBe(false)
    expect(parsed.sizeKb).toBe(0)
    expect(kinds(classifyOverview([parsed], config(), NOW)[0]!)).toContain('空仓')
  })
})
