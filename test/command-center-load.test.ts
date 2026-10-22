import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadOverview } from '../src/overview/load.js'
import { OverviewService } from '../src/main/overview-service.js'
import { SettingsService } from '../src/main/settings-service.js'
import { defaultOverviewConfig } from '../src/shared/overview/rules.js'
import { MAX_GITHUB_REQUESTS } from '../src/github/concurrency.js'
import { CC_BODY, CC_NOW, CC_REPO, ccNode, labelConnection, searchConnection } from './fixtures/command-center.js'

const jsonResponse = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers })
function request(init?: RequestInit): { query: string, variables: Record<string, string> } { return JSON.parse(String(init?.body)) }
function payload(init?: RequestInit) {
  const { variables } = request(init)
  const data: Record<string, unknown> = {}
  const english: unknown[] = []
  for (const key of Object.keys(variables).filter(key => /^n\d+$/.test(key))) {
    const index = Number(key.slice(1))
    const repo = `${variables[`o${index}`]}/${variables[key]}`
    const center = ccNode({ url: `https://github.com/${repo}/issues/1`, repository: { nameWithOwner: repo }, body: CC_BODY.replaceAll(CC_REPO, repo) })
    data[`r${index}`] = {
      nameWithOwner: repo, url: `https://github.com/${repo}`, isEmpty: false, isArchived: false,
      diskUsage: 20, createdAt: CC_NOW, pushedAt: CC_NOW,
      defaultBranchRef: { target: { oid: 'head', committedDate: CC_NOW, statusCheckRollup: { state: 'SUCCESS' } } },
      pullRequests: { totalCount: 0, nodes: [] }, issues: { nodes: [] }, recentPulls: { nodes: [] },
      commandCenters: labelConnection([center])
    }
    english.push(center)
  }
  data.ccEnglish = searchConnection(english)
  data.ccChinese = searchConnection()
  return { data }
}

const services: OverviewService[] = []
afterEach(() => { for (const service of services.splice(0)) service.close() })

function setup(fetchImpl: typeof fetch, env = { GITHUB_TOKEN: 'fixture-token' }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'arckeep-cc-'))
  const settings = new SettingsService({ file: path.join(dir, 'settings.json'), secretBox: { encrypt: value => value, decrypt: value => value },
    registrar: { register: () => true, isRegistered: () => true, unregister: () => {} }, onHotkey: () => {},
    readGh: async () => ({ ok: false, reason: 'not-installed' }) })
  settings.init()
  settings.setRepoFetchWindow('all') // These cases exercise full-range progress/cache behavior.
  settings.setRepos([CC_REPO])
  const file = path.join(dir, 'overview-cache.json')
  const deps = { fetchImpl, env, now: () => new Date(CC_NOW), readGh: async () => ({ ok: false as const, reason: 'not-installed' as const }) }
  const create = () => { const service = new OverviewService(settings, file, deps); services.push(service); return service }
  return { settings, file, env, create }
}

describe('Command Center reads share the overview process boundary', () => {
  it('loads health and both title variants in one request for three repositories', async () => {
    const queries: ReturnType<typeof request>[] = []
    const result = await loadOverview({ token: 'fixture', watchedRepos: [CC_REPO, 'example/two', 'example/three'], config: defaultOverviewConfig(), now: new Date(CC_NOW),
      fetchImpl: async (_url, init) => { queries.push(request(init)); return jsonResponse(payload(init)) } })
    expect(queries).toHaveLength(1)
    expect(queries[0]?.query).toContain('commandCenters: issues(states: OPEN')
    expect(queries[0]?.query).toContain('ccEnglish: search(')
    expect(queries[0]?.query).toContain('ccChinese: search(')
    expect(queries[0]?.variables.ccChineseSearch).toContain('"项目总控台"')
    expect(queries[0]?.variables.ccEnglishSearch).toContain('repo:example/two repo:example/three')
    expect(result.rows.map(row => row.commandCenter?.kind)).toEqual(['ready', 'ready', 'ready'])
    expect(result.rows.every(row => row.ciState === 'success' && row.error === null)).toBe(true)
  })

  it('keeps batch size three and peak concurrency six with full progress payloads', async () => {
    const names = Array.from({ length: 36 }, (_, index) => `example/repo-${index}`)
    let active = 0; let peak = 0; let requests = 0
    const result = await loadOverview({ token: 'fixture', watchedRepos: names, config: defaultOverviewConfig(), now: new Date(CC_NOW),
      fetchImpl: async (_url, init) => {
        requests++; active++; peak = Math.max(peak, active)
        expect(Object.keys(request(init).variables).filter(key => /^n\d+$/.test(key))).toHaveLength(3)
        await new Promise(resolve => setTimeout(resolve, 2))
        active--; return jsonResponse(payload(init))
      } })
    expect(requests).toBe(12)
    expect(peak).toBe(MAX_GITHUB_REQUESTS)
    expect(result.rows).toHaveLength(36)
    expect(result.rows.every(row => row.commandCenter?.kind === 'ready')).toBe(true)
  })

  it('groups title results by repository identity even when issue numbers are identical', async () => {
    const result = await loadOverview({ token: 'fixture', watchedRepos: [CC_REPO, 'example/two'], config: defaultOverviewConfig(), now: new Date(CC_NOW),
      fetchImpl: async (_url, init) => {
        const body = payload(init)
        for (const key of ['r0', 'r1']) (body.data[key] as { commandCenters: unknown }).commandCenters = labelConnection()
        return jsonResponse(body)
      } })
    expect(result.rows.map(row => row.commandCenter?.kind)).toEqual(['ready', 'ready'])
    expect(result.rows.map(row => row.commandCenter?.kind === 'ready' ? row.commandCenter.source.url : null)).toEqual(['https://github.com/example/project/issues/1', 'https://github.com/example/two/issues/1'])
  })

  it('fails closed on batch search overflow or an out-of-scope search node', async () => {
    const run = (outside: boolean) => loadOverview({ token: 'fixture', watchedRepos: [CC_REPO], config: defaultOverviewConfig(), now: new Date(CC_NOW),
      fetchImpl: async (_url, init) => {
        const body = payload(init)
        body.data.ccEnglish = outside ? searchConnection([ccNode({ repository: { nameWithOwner: 'other/scope' } })]) : searchConnection([], 20)
        return jsonResponse(body)
      } })
    expect((await run(false)).rows[0]?.commandCenter).toMatchObject({ kind: 'ambiguous', truncated: true })
    expect((await run(true)).rows[0]?.commandCenter?.kind).toBe('unavailable')
  })

  it('does not declare a renamed repository missing when search still reports its old identity', async () => {
    const result = await loadOverview({ token: 'fixture', watchedRepos: [CC_REPO], config: defaultOverviewConfig(), now: new Date(CC_NOW),
      fetchImpl: async (_url, init) => {
        const body = payload(init)
        const repo = body.data.r0 as Record<string, unknown>
        repo.nameWithOwner = 'example/new-name'
        repo.url = 'https://github.com/example/new-name'
        repo.commandCenters = labelConnection()
        return jsonResponse(body)
      } })
    expect(result.rows[0]).toMatchObject({ name: 'example/new-name', error: null, commandCenter: { kind: 'unavailable' } })
  })

  it.each(['label', 'title'])('isolates a %s query failure from usable repository facts', async field => {
    const result = await loadOverview({ token: 'fixture', watchedRepos: [CC_REPO], config: defaultOverviewConfig(), now: new Date(CC_NOW),
      fetchImpl: async (_url, init) => {
        const body = payload(init)
        const errorPath = field === 'label' ? ['r0', 'commandCenters'] : ['ccEnglish']
        return jsonResponse({ ...body, errors: [{ message: 'candidate query failed', path: errorPath }] })
      } })
    expect(result.rows[0]).toMatchObject({ error: null, ciState: 'success', commandCenter: { kind: 'unavailable', message: 'candidate query failed' } })
  })

  it('retains a labelled prior progress observation on an outage and retries after failure', async () => {
    let fail = false
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => { if (fail) throw new Error('offline'); return jsonResponse(payload(init)) })
    const { create } = setup(fetcher)
    const service = create()
    const first = await service.refresh(false)
    fail = true
    const failed = await service.refresh()
    expect(failed.rows[0]?.commandCenter).toMatchObject({ kind: 'unavailable', previous: { checkedAt: CC_NOW, content: { status: 'verification' } } })
    expect(failed.refreshedAt).toBe(first.refreshedAt)
    await service.refresh(false)
    expect(fetcher).toHaveBeenCalledTimes(3)
    fail = false
    expect((await service.refresh(false)).rows[0]?.commandCenter?.kind).toBe('ready')
  })

  it('does not reuse a TTL success when only the total-control-plane search failed', async () => {
    let fail = true
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => jsonResponse({ ...payload(init), ...(fail ? { errors: [{ path: ['ccEnglish'], message: 'search unavailable' }] } : {}) }))
    const { create } = setup(fetcher)
    const service = create()
    await service.refresh(false)
    fail = false
    await service.refresh(false)
    await service.refresh(false)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(service.current().rows[0]?.commandCenter?.kind).toBe('ready')
  })

  it('persists progress, restores it for the same identity and replaces a pre-board cache', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => jsonResponse(payload(init)))
    const { create, file } = setup(fetcher)
    await create().refresh(false)
    const reopened = create()
    expect(reopened.current().rows).toEqual([])
    expect((await reopened.refresh(false)).rows[0]?.commandCenter?.kind).toBe('ready')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const old = JSON.parse(readFileSync(file, 'utf8'))
    old.version = 1
    delete old.rows[0].commandCenter
    writeFileSync(file, JSON.stringify(old))
    expect((await create().refresh(false)).rows[0]?.commandCenter?.kind).toBe('ready')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('does not resurrect malformed cached fields and continues to a fresh read', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => jsonResponse(payload(init)))
    const { create, file } = setup(fetcher)
    await create().refresh(false)
    const old = JSON.parse(readFileSync(file, 'utf8'))
    old.rows[0].commandCenter.content.phases = 'broken'
    writeFileSync(file, JSON.stringify(old))
    expect((await create().refresh(false)).rows[0]?.commandCenter?.kind).toBe('ready')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('marks retained progress as cached during GraphQL cooldown, then isolates a new identity', async () => {
    let limited = false
    const fetcher: typeof fetch = async (_url, init) => limited
      ? jsonResponse({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Date.parse(CC_NOW) / 1000 + 60) })
      : jsonResponse(payload(init))
    const { create, env } = setup(fetcher)
    const service = create()
    await service.refresh()
    limited = true
    const held = await service.refresh()
    expect(held.rows[0]?.commandCenter).toMatchObject({ kind: 'unavailable', previous: { content: { status: 'verification' } } })
    expect(held.rateLimitResetAt).not.toBeNull()
    env.GITHUB_TOKEN = 'another-identity'
    const switched = await service.refresh()
    expect(switched.rows).toEqual([])
  })

  it('cancels the shared batch on service shutdown instead of leaving search work running', async () => {
    let aborted = false
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(init.signal?.reason) }, { once: true })
    }))
    const { create } = setup(fetcher)
    const service = create()
    const pending = service.refresh()
    const rejection = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    service.close()
    await rejection
    expect(aborted).toBe(true)
    expect(service.current().refreshing).toBe(false)
  })
})
