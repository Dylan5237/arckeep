import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cachedRepoFetchWindow, DEFAULT_REPO_FETCH_WINDOW, parseRepoFetchWindow, recentRepoPage, repoPushCutoff, REPO_FETCH_WINDOWS, type RepoFetchWindow } from '../src/shared/repo-fetch-window.js'
import { SettingsService } from '../src/main/settings-service.js'
import { parseSettings } from '../src/main/settings-store.js'
import { OverviewService } from '../src/main/overview-service.js'
import { WaitingService } from '../src/main/waiting-service.js'
import { defaultOverviewConfig } from '../src/shared/overview/rules.js'
import { defaultWaitingConfig } from '../src/shared/waiting/rules.js'
import { createWaitingClock } from '../src/shared/waiting/clock.js'
import { blankRecord } from '../src/shared/waiting/parse-github.js'
import { waitingTokenIdentityHash } from '../src/waiting/token.js'
import { collectWaiting, emptyWaitingMemory } from '../src/waiting/collect.js'
import { loadGithubRecords } from '../src/waiting/github-load.js'
import { loadOverview } from '../src/overview/load.js'

const NOW = new Date('2026-10-12T08:12:35.000Z')
const DAY = 86_400_000
const at = (days: number, offset = 0) => new Date(NOW.getTime() - days * DAY + offset).toISOString()
type Request = { query: string, variables: Record<string, string> }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status })
const connection = (nodes: unknown[], next: string | null = null) => ({ nodes, totalCount: nodes.length, pageInfo: { hasNextPage: next !== null, endCursor: next } })
const emptySearch = () => ({ ...connection([]), issueCount: 0 })

function repo(full: string, pushedAt: string | null): Record<string, unknown> {
  return {
    nameWithOwner: full, url: `https://github.com/${full}`, pushedAt, isArchived: false,
    description: '', isEmpty: pushedAt === null, isFork: false, owner: { login: full.split('/')[0] }, viewerPermission: 'WRITE',
    repositoryTopics: connection([]), createdAt: at(60), diskUsage: pushedAt === null ? 0 : 10,
    defaultBranchRef: pushedAt === null ? null : { target: { oid: 'head', committedDate: pushedAt, statusCheckRollup: { state: 'SUCCESS' } } },
    issues: connection([]), pullRequests: connection([]), recentPulls: connection([]), commandCenters: connection([])
  }
}

function batchNames(request: Request): string[] {
  return Object.keys(request.variables).filter(key => /^n\d+$/.test(key))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
    .map(key => `${request.variables[`o${key.slice(1)}`]}/${request.variables[key]}`)
}

function scopeConfig() {
  const defaults = defaultWaitingConfig()
  return { ...defaults, sources: { ...defaults.sources, assignee: false, reviewRequested: false, mentions: false, todos: false, statusDocs: false } }
}

function fakeGithub(ownedPages: Record<string, unknown>[][], watchedPages: Record<string, unknown>[][] = [], records: Record<string, Record<string, unknown>> = {}) {
  const requests: Request[] = []
  const details: string[] = []
  const fetchImpl: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as Request
    requests.push(request)
    const { query, variables } = request
    const page = variables.cursor ? Number(variables.cursor) : 0
    if (query.includes('repositories(') || query.includes('watching(')) {
      const viewer: Record<string, unknown> = { login: 'ada' }
      if (query.includes('repositories(')) viewer.repositories = connection(ownedPages[page] ?? [], page + 1 < ownedPages.length ? String(page + 1) : null)
      if (query.includes('watching(')) viewer.watching = connection(watchedPages[page] ?? [], page + 1 < watchedPages.length ? String(page + 1) : null)
      return json({ data: { viewer } })
    }
    if (query.includes('viewer { login }')) return json({ data: { viewer: { login: 'ada' } } })
    if (query.includes('r0: repository(')) {
      const names = batchNames(request)
      if (query.includes('pullRequests(') || query.includes('commandCenters:') || query.includes('issues(states: OPEN, first: 40')) details.push(...names)
      return json({ data: {
        ...Object.fromEntries(names.map((full, i) => [`r${i}`, records[full] ?? repo(full, at(1))])),
        ccEnglish: emptySearch(), ccChinese: emptySearch()
      } })
    }
    if (query.includes('search(')) return json({ data: { search: emptySearch() } })
    throw new Error(`Unexpected query: ${query}`)
  }
  return { fetchImpl, requests, details }
}

const services: Array<OverviewService | WaitingService> = []
afterEach(() => { for (const service of services.splice(0)) service.close() })

function settingsFor(dir: string) {
  const settings = new SettingsService({ file: path.join(dir, 'settings.json'), secretBox: { encrypt: value => value, decrypt: value => value },
    registrar: { register: () => true, isRegistered: () => true, unregister: () => {} }, onHotkey: () => {},
    readGh: async () => ({ ok: false, reason: 'not-installed' }) })
  settings.init()
  return settings
}

describe('shared repository push window', () => {
  it('defaults to one week and persists only the five authorized choices without changing other preferences', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'arckeep-window-settings-'))
    const legacy = { version: 2, watchedRepos: ['ada/demo'], hideMainWindowOnLaunch: true, patCiphertext: 'encrypted-existing',
      overview: { ...defaultOverviewConfig(), staleDays: 19 }, toolShelfJson: '{"actions":[]}' }
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(legacy))
    const settings = settingsFor(dir)
    expect(DEFAULT_REPO_FETCH_WINDOW).toBe('7d')
    expect(settings.getSettings().repoFetchWindow).toBe('7d')
    for (const window of REPO_FETCH_WINDOWS) {
      expect(settings.setRepoFetchWindow(window)).toEqual({ ok: true, data: { repoFetchWindow: window } })
      expect(settingsFor(dir).getSettings()).toMatchObject({ ...legacy, repoFetchWindow: window })
      expect((await settings.getState()).repoFetchWindow).toBe(window)
    }
    const before = readFileSync(path.join(dir, 'settings.json'), 'utf8')
    for (const invalid of [undefined, null, '', 7, '14d', '0d', {}, ['7d']]) expect(settings.setRepoFetchWindow(invalid).ok).toBe(false)
    expect(readFileSync(path.join(dir, 'settings.json'), 'utf8')).toBe(before)
    expect(parseSettings({ ...legacy, repoFetchWindow: 'broken' })).toMatchObject({ ...legacy, repoFetchWindow: '7d' })
    expect(cachedRepoFetchWindow(undefined)).toBe('all')
  })

  it.each(['3d', '7d', '15d', '30d'] as const)('uses an inclusive rolling %s window and does not confuse creation/issue activity with a push', window => {
    const days = Number(window.slice(0, -1))
    const cutoff = repoPushCutoff(window, NOW)
    const selected = recentRepoPage([
      repo('ada/new', at(0)), repo('ada/boundary', at(days)), repo('ada/expired', at(days, -1)), repo('ada/much-older', at(days + 30))
    ], cutoff)
    expect(selected.nodes.map(node => node.nameWithOwner)).toEqual(['ada/new', 'ada/boundary'])
    expect(selected.reachedCutoff).toBe(true)
    expect(recentRepoPage([repo('ada/empty', null)], cutoff)).toEqual({ nodes: [], reachedCutoff: false })
    expect(parseRepoFetchWindow(window)).toBe(window)
  })

  it.each(['overview', 'waiting'] as const)('%s stops both detail reads and automatic pagination before old repositories', async kind => {
    const owned = [repo('ada/recent', at(1)), repo('ada/boundary', at(7)), repo('ada/old', at(7, -1))]
    const watched = [repo('other/recent', at(2)), repo('other/old', at(9))]
    const fixture = fakeGithub([owned, [repo('ada/unneeded-page', at(80))]], [watched, [repo('other/unneeded-page', at(90))]])
    if (kind === 'overview') {
      const result = await loadOverview({ token: 'fixture', watchedRepos: [], config: defaultOverviewConfig(), now: NOW, repoFetchWindow: '7d', fetchImpl: fixture.fetchImpl })
      expect(result.fresh).toBe(true)
      expect(result.rows.map(row => row.name)).toEqual(['ada/boundary', 'ada/recent'])
    } else {
      const result = await loadGithubRecords({ token: 'fixture', watchedRepos: [], config: scopeConfig(), now: NOW, repoFetchWindow: '7d', fetchImpl: fixture.fetchImpl })
      expect(result.errors).toEqual([])
      expect(result.fresh).toMatchObject({ openPrs: true, humanIssues: true })
      expect(fixture.details).toContain('other/recent')
      expect(fixture.requests[0]!.query).toContain('watching(first: 40, orderBy: {field: PUSHED_AT, direction: DESC})')
    }
    expect(fixture.details).toContain('ada/recent')
    expect(fixture.details).toContain('ada/boundary')
    expect(fixture.details.some(full => /old|unneeded/.test(full))).toBe(false)
    expect(fixture.requests.filter(request => request.query.includes('repositories(') || request.query.includes('watching('))).toHaveLength(1)
  })

  it.each(['overview', 'waiting'] as const)('%s continues beyond page 40 when the next page is still inside the window', async kind => {
    const first = Array.from({ length: 40 }, (_, i) => repo(`ada/repo-${i}`, at(1)))
    const fixture = fakeGithub([first, [repo('ada/tail', at(6)), repo('ada/expired', at(9))], [repo('ada/unneeded', at(90))]])
    const common = { token: 'fixture', watchedRepos: [], now: NOW, repoFetchWindow: '7d' as RepoFetchWindow, fetchImpl: fixture.fetchImpl }
    if (kind === 'overview') expect((await loadOverview({ ...common, config: defaultOverviewConfig() })).rows).toHaveLength(41)
    else expect((await loadGithubRecords({ ...common, config: scopeConfig() })).errors).toEqual([])
    expect(fixture.details).toHaveLength(41)
    expect(fixture.details).toContain('ada/tail')
    expect(fixture.requests.filter(request => request.query.includes('repositories('))).toHaveLength(2)
  })

  it.each(['overview', 'waiting'] as const)('%s can explicitly include old and never-pushed repositories with all', async kind => {
    const fixture = fakeGithub([[repo('ada/recent', at(1))], [repo('ada/old', at(90)), repo('ada/empty', null)]], [], {
      'ada/empty': repo('ada/empty', null), 'ada/old': repo('ada/old', at(90))
    })
    const common = { token: 'fixture', watchedRepos: [], now: NOW, repoFetchWindow: 'all' as RepoFetchWindow, fetchImpl: fixture.fetchImpl }
    if (kind === 'overview') expect((await loadOverview({ ...common, config: defaultOverviewConfig() })).rows).toHaveLength(3)
    else expect((await loadGithubRecords({ ...common, config: scopeConfig() })).errors).toEqual([])
    expect(fixture.details).toContain('ada/old')
    expect(fixture.details).toContain('ada/empty')
    expect(fixture.requests.filter(request => request.query.includes('repositories('))).toHaveLength(2)
  })

  it.each(['overview', 'waiting'] as const)('%s checks explicit push metadata and spends its repository cap on matching repositories', async kind => {
    const fixture = fakeGithub([], [], { 'ada/old': repo('ada/old', at(60)), 'ada/empty': repo('ada/empty', null) })
    const common = { token: 'fixture', watchedRepos: ['ada/old', 'ada/empty', 'ada/recent'], now: NOW, repoFetchWindow: '7d' as RepoFetchWindow, fetchImpl: fixture.fetchImpl }
    if (kind === 'overview') {
      const result = await loadOverview({ ...common, config: { ...defaultOverviewConfig(), maxScopeRepos: 1 } })
      expect(result.rows.map(row => row.name)).toEqual(['ada/recent'])
      expect(result.notices).toEqual([])
    } else {
      const result = await loadGithubRecords({ ...common, config: { ...scopeConfig(), maxScopeRepos: 1 } })
      expect(result.errors).toEqual([])
      expect(result.notices).toEqual([])
    }
    expect(fixture.details).toEqual(['ada/recent'])
    const metadata = fixture.requests.find(request => batchNames(request).length === 3)!
    expect(metadata.query).toContain('pushedAt')
    expect(metadata.query).not.toContain('pullRequests(')
    expect(metadata.query).not.toContain('commandCenters:')
  })

  it('replaces prior broad scan records with an empty successful scope and still checks direct requests and local todos', async () => {
    const fixture = fakeGithub([[repo('ada/old', at(90))]])
    const memory = { ...emptyWaitingMemory(), openPrs: [blankRecord({ kind: 'pr', repo: 'ada/old', number: 1 })],
      humanIssues: [blankRecord({ kind: 'issue', repo: 'ada/old', number: 2 })] }
    const config = scopeConfig()
    config.sources.assignee = config.sources.reviewRequested = config.sources.mentions = config.sources.todos = true
    const result = await collectWaiting({ token: 'fixture', watchedRepos: [], now: NOW, repoFetchWindow: '7d', config, memory,
      fetchImpl: fixture.fetchImpl, todos: { available: true, async listWaitingOnMe() { return [{ id: 'local', title: '本机待办', createdAt: at(90), updatedAt: at(90) }] } } })
    expect(result.errors).toEqual([])
    expect(result.memory.openPrs).toEqual([])
    expect(result.memory.humanIssues).toEqual([])
    expect(result.drafts.some(row => row.title === '本机待办')).toBe(true)
    expect(fixture.details).toEqual([])
    expect(fixture.requests.filter(request => request.query.includes('search(')).map(request => request.variables.q)).toEqual([
      'assignee:@me is:open', 'review-requested:@me is:pr is:open', 'mentions:@me is:open'
    ])
  })

  it.each(['overview', 'waiting'] as const)('%s bypasses its fresh TTL after a window change and restores only the same saved scope on restart', async kind => {
    const dir = mkdtempSync(path.join(tmpdir(), `arckeep-${kind}-window-cache-`))
    const settings = settingsFor(dir)
    settings.setRepoFetchWindow('all')
    const fixture = fakeGithub([[repo('ada/recent', at(1)), repo('ada/old', at(20))]], [], { 'ada/old': repo('ada/old', at(20)) })
    const deps = { env: { GITHUB_TOKEN: 'fixture' }, fetchImpl: fixture.fetchImpl, readGh: async () => ({ ok: false as const, reason: 'not-installed' as const }) }
    settings.setWaiting(scopeConfig())
    const create = () => {
      const service = kind === 'overview'
        ? new OverviewService(settings, path.join(dir, 'overview.json'), { ...deps, now: () => NOW })
        : new WaitingService(settings, { cache: path.join(dir, 'waiting.json'), dismissals: path.join(dir, 'dismissals.json') }, { ...deps, clock: createWaitingClock(() => NOW) })
      services.push(service)
      return service
    }
    const service = create()
    await service.refresh(false)
    expect(fixture.details).toContain('ada/old')
    const afterFirst = fixture.requests.length
    await service.refresh(false)
    expect(fixture.requests).toHaveLength(afterFirst)
    settings.setRepoFetchWindow('7d')
    fixture.details.length = 0
    const scoped = await service.refresh(false)
    expect(scoped.repoFetchWindow).toBe('7d')
    expect(fixture.requests.length).toBeGreaterThan(afterFirst)
    expect(fixture.details).toEqual(['ada/recent'])
    expect(scoped.rows.some(row => 'name' in row && row.name === 'ada/old')).toBe(false)
    const beforeRestart = fixture.requests.length
    await create().refresh(false)
    expect(fixture.requests).toHaveLength(beforeRestart)
    const cached = JSON.parse(readFileSync(path.join(dir, `${kind}.json`), 'utf8'))
    expect(cached.repoFetchWindow).toBe('7d')
    expect(cached.identityHash).toBe(waitingTokenIdentityHash({ token: 'fixture', via: 'env' }))
  })

  it.each(['overview', 'waiting'] as const)('%s actually uses the default one-week setting through the application service', async kind => {
    const dir = mkdtempSync(path.join(tmpdir(), `arckeep-${kind}-default-window-`))
    const settings = settingsFor(dir)
    settings.setWaiting(scopeConfig())
    const fixture = fakeGithub([[repo('ada/recent', at(1)), repo('ada/old', at(15))]])
    const deps = { env: { GITHUB_TOKEN: 'fixture' }, fetchImpl: fixture.fetchImpl, readGh: async () => ({ ok: false as const, reason: 'not-installed' as const }) }
    const service = kind === 'overview'
      ? new OverviewService(settings, path.join(dir, 'overview.json'), { ...deps, now: () => NOW })
      : new WaitingService(settings, { cache: path.join(dir, 'waiting.json'), dismissals: path.join(dir, 'dismissals.json') }, { ...deps, clock: createWaitingClock(() => NOW) })
    services.push(service)
    expect(service.current().repoFetchWindow).toBe('7d')
    expect((await service.refresh()).repoFetchWindow).toBe('7d')
    expect(fixture.details).toEqual(['ada/recent'])
  })

  it('keeps inaccessible explicit repositories visible as errors without querying their content', async () => {
    const fixture = fakeGithub([], [])
    const fetchImpl: typeof fetch = async (url, init) => {
      const request = JSON.parse(String(init?.body)) as Request
      if (batchNames(request).includes('ada/gone')) return json({ data: { r0: null, r1: repo('ada/recent', at(1)) }, errors: [{ path: ['r0'], message: 'Could not resolve to a Repository' }] })
      return fixture.fetchImpl(url, init)
    }
    const result = await loadOverview({ token: 'fixture', config: defaultOverviewConfig(), watchedRepos: ['ada/gone', 'ada/recent'], now: NOW, repoFetchWindow: '7d', fetchImpl })
    expect(result.rows.find(row => row.name === 'ada/gone')?.error).toContain('仓库不存在或无权访问')
    expect(fixture.details).toEqual(['ada/recent'])
  })

  it.each(['partial', 'missing-connection', 'missing-push', 'invalid-push'] as const)('does not publish successful empty automatic scans when metadata is %s', async failure => {
    const node = repo('ada/recent', at(1))
    if (failure === 'missing-push') delete node.pushedAt
    if (failure === 'invalid-push') node.pushedAt = 'not-a-date'
    const viewer = { login: 'ada', repositories: failure === 'missing-connection' ? null : connection([node]), watching: connection([]) }
    const fetchImpl: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as Request
      if (request.query.includes('viewer { login }')) return json({ data: { viewer: { login: 'ada' } } })
      return json({ data: { viewer }, ...(failure === 'partial' ? { errors: [{ path: ['viewer', 'repositories', 'nodes', 0, 'pushedAt'], message: 'push field unavailable' }] } : {}) })
    }
    const overview = await loadOverview({ token: 'fixture', config: defaultOverviewConfig(), watchedRepos: [], repoFetchWindow: '7d', now: NOW, fetchImpl })
    expect(overview.fresh).toBe(false)
    expect(overview.errors.length).toBeGreaterThan(0)
    const waiting = await loadGithubRecords({ token: 'fixture', config: scopeConfig(), watchedRepos: [], repoFetchWindow: '7d', now: NOW, fetchImpl })
    expect(waiting.fresh.openPrs).toBe(false)
    expect(waiting.fresh.humanIssues).toBe(false)
    expect(waiting.errors.length).toBeGreaterThan(0)
  })

  it.each(['partial-null', 'missing-alias', 'missing-push', 'invalid-push'] as const)('retains previous waiting scan data when explicit metadata is %s', async failure => {
    const old = blankRecord({ kind: 'issue', repo: 'ada/recent', number: 1, title: '请你确认', url: 'https://github.com/ada/recent/issues/1', body: 'HUMAN_REQUIRED 请你确认', createdAt: at(1), updatedAt: at(1), inScopeRepo: true, repoAccess: 'maintain' })
    const node = repo('ada/recent', at(1))
    if (failure === 'missing-push') delete node.pushedAt
    if (failure === 'invalid-push') node.pushedAt = 'not-a-date'
    const fetchImpl: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as Request
      if (request.query.includes('viewer { login }')) return json({ data: { viewer: { login: 'ada' } } })
      return json({ data: failure === 'missing-alias' ? {} : { r0: failure === 'partial-null' ? null : node },
        ...(failure === 'partial-null' ? { errors: [{ path: ['r0'], type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] } : {}) })
    }
    const result = await collectWaiting({ token: 'fixture', config: scopeConfig(), watchedRepos: ['ada/recent'], repoFetchWindow: '7d', now: NOW, fetchImpl,
      memory: { ...emptyWaitingMemory(), humanIssues: [old] } })
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.memory.humanIssues).toEqual([old])
  })

  it.each(['overview', 'waiting'] as const)('%s changes the scope during cooldown without bypassing quota protection or retaining a full-range scan', async kind => {
    const dir = mkdtempSync(path.join(tmpdir(), `arckeep-${kind}-window-cooldown-`))
    const settings = settingsFor(dir)
    settings.setRepoFetchWindow('all')
    const config = scopeConfig()
    config.sources.assignee = true
    settings.setWaiting(config)
    const reset = new Date(NOW.getTime() + 60_000).toISOString()
    const identityHash = waitingTokenIdentityHash({ token: 'fixture', via: 'env' })
    const old = blankRecord({ kind: 'issue', repo: 'ada/old', number: 1, title: '请你确认', url: 'https://github.com/ada/old/issues/1', body: 'HUMAN_REQUIRED 请你确认', updatedAt: at(20), createdAt: at(20), inScopeRepo: true, repoAccess: 'maintain' })
    const direct = blankRecord({ kind: 'issue', repo: 'other/direct', number: 2, title: '请你确认', url: 'https://github.com/other/direct/issues/2', body: '请你确认', updatedAt: at(20), createdAt: at(20), fromAssignee: true })
    const cacheFile = path.join(dir, `${kind}.json`)
    writeFileSync(cacheFile, JSON.stringify({ version: kind === 'overview' ? 2 : 1, repoFetchWindow: 'all', identityHash,
      rows: [{ name: 'ada/old', url: 'https://github.com/ada/old', group: 'active', warnings: [], archived: false, error: null }],
      memory: { ...emptyWaitingMemory(), humanIssues: [old], assignee: [direct] }, refreshedAt: at(1) }))
    let calls = 0
    const deps = { env: { GITHUB_TOKEN: 'fixture' }, readGh: async () => ({ ok: false as const, reason: 'not-installed' as const }),
      fetchImpl: (async () => { calls += 1; return new Response('rate limit exceeded', { status: 429, headers: { 'x-ratelimit-reset': String(Date.parse(reset) / 1000) } }) }) as typeof fetch }
    const service = kind === 'overview'
      ? new OverviewService(settings, cacheFile, { ...deps, now: () => NOW })
      : new WaitingService(settings, { cache: cacheFile, dismissals: path.join(dir, 'dismissals.json') }, { ...deps, clock: createWaitingClock(() => NOW) })
    services.push(service)
    const limited = await service.refresh()
    expect(limited.rows.some(row => ('name' in row ? row.name : row.repo) === 'ada/old')).toBe(true)
    const beforeSwitch = calls
    settings.setRepoFetchWindow('7d')
    const next = await service.refresh()
    expect(calls).toBe(beforeSwitch)
    expect(next.rateLimitResetAt).toBe(reset)
    expect(next.repoFetchWindow).toBe('7d')
    expect(next.rows.some(row => ('name' in row ? row.name : row.repo) === 'ada/old')).toBe(false)
    if (kind === 'waiting') expect(next.rows.some(row => 'repo' in row && row.repo === 'other/direct')).toBe(true)
  })
})
