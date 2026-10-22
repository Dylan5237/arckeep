import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApoCommentService } from '../src/main/apo-comment-service.js'
import { pendingApoActions } from '../src/shared/waiting/apo-actions.js'
import { blankRecord } from '../src/shared/waiting/parse-github.js'
import { TaskScope } from '../src/shared/task-scope.js'
import { WaitingService } from '../src/main/waiting-service.js'
import type { SettingsService } from '../src/main/settings-service.js'
import { defaultWaitingConfig } from '../src/shared/waiting/rules.js'
import { emptyWaitingMemory } from '../src/waiting/collect.js'
import { waitingTokenIdentityHash } from '../src/waiting/token.js'

const time = '2026-10-12T02:00:00Z'
const tasks: TaskScope[] = []
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const requestBody = '请 @ada 在本 Issue 评论 `EXCEPTION ACCEPT`。'

function setup(body = requestBody) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'arckeep-apo-')), 'receipts.json')
  const scope = new TaskScope()
  tasks.push(scope)
  const record = blankRecord({ repo: 'ada/demo', number: 7, kind: 'issue', title: '例外',
    url: 'https://github.com/ada/demo/issues/7', body, createdAt: time, updatedAt: time, viewerLogin: 'ada', authorLogin: 'agent' })
  const action = pendingApoActions(record)[0]!
  const remote = {
    login: 'ada', body, updated: time, state: 'open',
    comments: [] as Array<{ body: string, created_at: string, user: { login: string } }>,
    targetComments: [] as Array<{ body: string, created_at: string, user: { login: string } }>, targetBody: '',
    postStatus: 201, postError: null as Error | null, hangPost: false, targetState: 'open'
  }
  const calls: Array<{ url: string, init?: RequestInit }> = []
  let postStarted!: () => void
  const started = new Promise<void>(resolve => { postStarted = resolve })
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const address = String(url)
    calls.push({ url: address, init })
    if (address.endsWith('/user')) return json({ login: remote.login })
    if (init?.method === 'POST') {
      postStarted()
      expect(JSON.parse(String(init.body))).toEqual({ body: 'EXCEPTION ACCEPT' })
      if (remote.postError) throw remote.postError
      if (remote.hangPost) return new Promise<Response>(() => {})
      return json({ body: 'EXCEPTION ACCEPT', user: { login: 'ada' }, html_url: `${action.target.url}#issuecomment-99` }, remote.postStatus)
    }
    if (address.includes('/comments?')) {
      const page = Number(new URL(address).searchParams.get('page') ?? '1')
      return json((address.includes('/issues/7/') ? remote.comments : remote.targetComments).slice((page - 1) * 100, page * 100))
    }
    const target = address.endsWith('/issues/42')
    return json({ number: target ? 42 : 7, title: '例外', state: target ? remote.targetState : remote.state,
      comments: target ? remote.targetComments.length : remote.comments.length, body: target ? remote.targetBody : remote.body,
      created_at: time, updated_at: remote.updated, user: { login: 'agent' } })
  }) as unknown as typeof fetch
  const resolveToken = vi.fn(async () => 'private-token')
  const makeService = () => new ApoCommentService({ file, tasks: scope, resolveToken, fetchImpl })
  return { file, scope, action, record, remote, calls, started, fetchImpl, resolveToken, makeService, service: makeService() }
}

afterEach(async () => {
  for (const scope of tasks.splice(0)) await scope.drain()
  vi.useRealTimers()
})

describe('APO comment submission boundary', () => {
  it('performs one exact REST comment, then deduplicates the same request across restarts', async () => {
    const fixture = setup()
    expect(await fixture.service.submit(fixture.action)).toMatchObject({ ok: true, data: { state: 'sent' } })
    const post = fixture.calls.filter(call => call.init?.method === 'POST')
    expect(post).toHaveLength(1)
    expect(post[0]?.url).toBe('https://api.github.com/repos/ada/demo/issues/7/comments')
    expect(post[0]?.init?.redirect).toBe('error')
    expect(fixture.service.state(fixture.action)).toBe('sent')
    await fixture.makeService().submit(fixture.action)
    expect(fixture.calls.filter(call => call.init?.method === 'POST')).toHaveLength(1)
    expect(readFileSync(fixture.file, 'utf8')).not.toContain('private-token')
  })

  it.each(['revision', 'closed', 'cancelled', 'account', 'accepted'] as const)('sends nothing for a stale %s request', async change => {
    const fixture = setup()
    if (change === 'revision') fixture.remote.updated = '2026-10-12T02:01:00Z'
    if (change === 'closed') fixture.remote.state = 'closed'
    if (change === 'cancelled') fixture.remote.body = '无需用户评论 EXCEPTION ACCEPT'
    if (change === 'account') fixture.remote.login = 'someone'
    if (change === 'accepted') fixture.remote.comments = [{ body: 'EXCEPTION ACCEPT', created_at: '2026-10-12T02:01:00Z', user: { login: 'ada' } }]
    expect(await fixture.service.submit(fixture.action)).toMatchObject({ ok: false })
    expect(fixture.calls.some(call => call.init?.method === 'POST')).toBe(false)
  })

  it('posts to the linked exception Issue, and refuses a closed target', async () => {
    const fixture = setup('请 @ada 在 other/design#42 评论 EXCEPTION ACCEPT')
    expect(await fixture.service.submit(fixture.action)).toMatchObject({ ok: true })
    expect(fixture.calls.find(call => call.init?.method === 'POST')?.url).toBe('https://api.github.com/repos/other/design/issues/42/comments')
    const closed = setup('请 @ada 在 other/design#42 评论 EXCEPTION ACCEPT')
    closed.remote.targetState = 'closed'
    expect(await closed.service.submit(closed.action)).toMatchObject({ ok: false })
    expect(closed.calls.some(call => call.init?.method === 'POST')).toBe(false)
  })

  it('checks changed credentials again before the write', async () => {
    const fixture = setup()
    fixture.resolveToken.mockResolvedValueOnce('private-token').mockResolvedValueOnce('changed-token')
    expect(await fixture.service.submit(fixture.action)).toMatchObject({ ok: false })
    expect(fixture.calls.some(call => call.init?.method === 'POST')).toBe(false)
  })

  it.each([
    ['EXCEPTION ACCEPT', 'EXCEPTION REJECT'],
    ['PHASE ACCEPT', 'PHASE RETURN\n缺少验证证据'],
    ['EXCEPTION ACCEPT', '无需用户再评论 EXCEPTION ACCEPT'],
    ['EXCEPTION ACCEPT', 'Please do not comment EXCEPTION ACCEPT; the request is withdrawn']
  ])('does not send %s after a terminal target decision %s', async (token, decision) => {
    const fixture = setup(`请 @ada 在 other/design#42 评论 ${token}`)
    fixture.remote.targetComments.push({ body: decision, created_at: '2026-10-12T02:05:00Z', user: { login: 'ada' } })
    expect(await fixture.service.submit(fixture.action)).toMatchObject({ ok: false })
    expect(fixture.calls.filter(call => call.init?.method === 'POST')).toHaveLength(0)
  })

  it('recognizes an accepted target decision with reasons on page two and does not repeat it', async () => {
    const fixture = setup('请 @ada 在 other/design#42 评论 EXCEPTION ACCEPT')
    fixture.remote.targetComments = Array.from({ length: 100 }, (_, index) => ({ body: `普通评论 ${index}`, created_at: time, user: { login: 'other' } }))
    fixture.remote.targetComments.push({ body: 'EXCEPTION ACCEPT\n已核对影响范围', created_at: '2026-10-12T02:05:00Z', user: { login: 'ada' } })
    expect(await fixture.service.submit(fixture.action)).toMatchObject({ ok: true, data: { state: 'sent' } })
    expect(fixture.calls.some(call => call.url.endsWith('page=2'))).toBe(true)
    expect(fixture.calls.filter(call => call.init?.method === 'POST')).toHaveLength(0)
  })

  it('blocks an explicitly different target disposer and changes arriving during preflight', async () => {
    const fixture = setup('请 @ada 在 other/design#42 评论 EXCEPTION ACCEPT')
    fixture.remote.targetBody = '处置人：@owner'
    expect(await fixture.service.submit(fixture.action)).toMatchObject({ ok: false })
    expect(fixture.calls.some(call => call.init?.method === 'POST')).toBe(false)
    const changing = setup()
    changing.resolveToken.mockImplementationOnce(async () => 'private-token').mockImplementationOnce(async () => {
      changing.remote.updated = '2026-10-12T02:10:00Z'
      return 'private-token'
    })
    expect(await changing.service.submit(changing.action)).toMatchObject({ ok: false })
    expect(changing.calls.some(call => call.init?.method === 'POST')).toBe(false)
  })

  it('deduplicates double-clicks while preflight or the POST is pending', async () => {
    const fixture = setup()
    const a = fixture.service.submit(fixture.action)
    const b = fixture.service.submit(fixture.action)
    expect(await b).toMatchObject({ ok: false })
    expect(await a).toMatchObject({ ok: true })
    expect(fixture.calls.filter(call => call.init?.method === 'POST')).toHaveLength(1)
  })

  it.each([401, 403, 404, 422, 429])('does not claim success for an explicit HTTP %i rejection', async status => {
    const fixture = setup()
    fixture.remote.postStatus = status
    expect(await fixture.service.submit(fixture.action)).toMatchObject({ ok: false })
    expect(fixture.service.state(fixture.action)).toBeUndefined()
    expect(fixture.calls.filter(call => call.init?.method === 'POST')).toHaveLength(1)
  })

  it.each(['error', 'server', 'timeout'] as const)('never replays an unknown %s result, including after restart and a new source revision', async failure => {
    vi.useFakeTimers()
    const fixture = setup()
    if (failure === 'error') fixture.remote.postError = new Error('private-token request details')
    if (failure === 'server') fixture.remote.postStatus = 503
    if (failure === 'timeout') fixture.remote.hangPost = true
    const submitted = fixture.service.submit(fixture.action)
    await fixture.started
    if (failure === 'timeout') await vi.advanceTimersByTimeAsync(15_001)
    expect(await submitted).toEqual({ ok: true, data: { state: 'unknown' } })
    const restarted = fixture.makeService()
    expect(restarted.state(fixture.action)).toBe('unknown')
    const changed = { ...fixture.action, id: `${fixture.action.id}new-revision` }
    expect(await restarted.submit(changed)).toMatchObject({ ok: true, data: { state: 'unknown' } })
    expect(fixture.calls.filter(call => call.init?.method === 'POST')).toHaveLength(1)
  })

  it('read-only result checking never posts, even if an earlier IPC never reached the main process', async () => {
    const fixture = setup()
    expect(await fixture.service.check(fixture.action)).toEqual({ ok: true, data: { state: 'unknown' } })
    expect(fixture.calls).toHaveLength(0)
    fixture.remote.postStatus = 503
    await fixture.service.submit(fixture.action)
    fixture.remote.comments.push({ body: 'EXCEPTION ACCEPT', created_at: new Date().toISOString(), user: { login: 'ada' } })
    fixture.remote.state = 'closed'
    expect(await fixture.service.check(fixture.action)).toEqual({ ok: true, data: { state: 'sent' } })
    expect(fixture.calls.filter(call => call.init?.method === 'POST')).toHaveLength(1)
  })

  it('fails closed on a corrupt journal and on app shutdown', async () => {
    const fixture = setup()
    writeFileSync(fixture.file, '{bad json')
    expect(fixture.makeService().state(fixture.action)).toBe('unknown')
    expect(await fixture.makeService().submit(fixture.action)).toMatchObject({ ok: false })
    fixture.scope.close()
    expect(await fixture.service.submit(fixture.action)).toMatchObject({ ok: false })
    expect(fixture.calls).toHaveLength(0)
  })

  it('allows only a visible current row and known action id through the waiting service boundary', async () => {
    const fixture = setup()
    const cache = path.join(path.dirname(fixture.file), 'waiting-cache.json')
    writeFileSync(cache, JSON.stringify({ version: 1, refreshedAt: time, configKey: null,
      identityHash: waitingTokenIdentityHash({ token: 'private-token', via: 'env' }),
      memory: { ...emptyWaitingMemory(), humanIssues: [{ ...fixture.record, inScopeRepo: true, repoAccess: 'maintain' }] } }))
    const config = defaultWaitingConfig()
    const settings = { getSettings: () => ({ waiting: config, watchedRepos: [], repoFetchWindow: 'all', patCiphertext: null }), readSavedPat: () => null } as unknown as SettingsService
    const waiting = new WaitingService(settings, { cache, dismissals: path.join(path.dirname(cache), 'dismissals.json') }, {
      env: { GITHUB_TOKEN: 'private-token' }, readGh: async () => ({ ok: false, reason: 'not-installed' }), tasks: fixture.scope,
      fetchImpl: (input, init) => String(input).endsWith('/graphql') ? Promise.resolve(json({}, 500)) : fixture.fetchImpl(input, init)
    })
    await waiting.refresh(false)
    const row = waiting.current().rows[0]!
    expect(row.quickActions).toHaveLength(1)
    expect(await waiting.commentApo('arbitrary-row', fixture.action.id)).toMatchObject({ ok: false })
    expect(await waiting.commentApo(row.id, 'EXCEPTION ACCEPT')).toMatchObject({ ok: false })
    waiting.ignore(row.id)
    expect(await waiting.commentApo(row.id, fixture.action.id)).toMatchObject({ ok: false })
    waiting.restore(row.id)
    expect(await waiting.commentApo(row.id, fixture.action.id)).toMatchObject({ ok: true, data: { state: 'sent' } })
    expect(waiting.current().rows[0]?.quickActions?.[0]?.state).toBe('sent')
    expect(fixture.calls.filter(call => call.init?.method === 'POST')).toHaveLength(1)
  })
})
