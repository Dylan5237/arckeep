import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApoCommentService } from '../src/main/apo-comment-service.js'
import { WaitingService } from '../src/main/waiting-service.js'
import type { SettingsService } from '../src/main/settings-service.js'
import { TaskScope } from '../src/shared/task-scope.js'
import { pendingApoDecisionActions } from '../src/shared/waiting/apo-reply.js'
import { blankRecord } from '../src/shared/waiting/parse-github.js'
import { defaultWaitingConfig } from '../src/shared/waiting/rules.js'
import { emptyWaitingMemory } from '../src/waiting/collect.js'
import { waitingTokenIdentityHash } from '../src/waiting/token.js'

const time = '2026-10-12T02:00:00Z'
const tasks: TaskScope[] = []
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const request = (id = 'D-3', rev = 1) =>
  `<!-- apo-decision v1 | id: ${id} | rev: ${rev} | type: 最终验收 | target: #7 | disposer: @ada -->\n## 请你验收\n\n导出报表已完成。`
type Comment = { body: string, created_at: string, user: { login: string } }

function setup(body = request()) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'arckeep-apo-reply-')), 'receipts.json')
  const scope = new TaskScope()
  tasks.push(scope)
  const record = blankRecord({ repo: 'ada/demo', number: 7, kind: 'issue', title: '导出报表',
    url: 'https://github.com/ada/demo/issues/7', body, createdAt: time, updatedAt: time, viewerLogin: 'ada', authorLogin: 'agent' })
  const action = pendingApoDecisionActions(record)[0]!
  const remote = { login: 'ada', body, updated: time, state: 'open', comments: [] as Comment[], postStatus: 201, postError: null as Error | null }
  const posts: string[] = []
  const calls: Array<{ url: string, init?: RequestInit }> = []
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const address = String(url)
    calls.push({ url: address, init })
    if (address.endsWith('/user')) return json({ login: remote.login })
    if (init?.method === 'POST') {
      const text = (JSON.parse(String(init.body)) as { body: string }).body
      posts.push(text)
      if (remote.postError) throw remote.postError
      return json({ body: text, user: { login: 'ada' }, html_url: 'https://github.com/ada/demo/issues/7#issuecomment-99' }, remote.postStatus)
    }
    if (address.includes('/comments?')) return json(remote.comments)
    return json({ number: 7, title: '导出报表', state: remote.state, comments: remote.comments.length, body: remote.body,
      created_at: time, updated_at: remote.updated, user: { login: 'agent' } })
  }) as unknown as typeof fetch
  const resolveToken = vi.fn(async () => 'private-token')
  const makeService = () => new ApoCommentService({ file, tasks: scope, resolveToken, fetchImpl })
  return { file, scope, action, record, remote, posts, calls, fetchImpl, resolveToken, makeService, service: makeService() }
}

afterEach(async () => {
  for (const scope of tasks.splice(0)) await scope.drain()
})

describe('APO decision reply boundary', () => {
  it.each([
    [['批准 A'], 'D-3 批准 A'],
    [['改用 B'], 'D-3 改用 B'],
    [['退回', '缺回放步骤'], 'D-3 退回：缺回放步骤']
  ])('posts exactly one reply for %j, then deduplicates it across restarts', async (args, expected) => {
    const fixture = setup()
    expect(await fixture.service.reply(fixture.action, args[0], args[1])).toMatchObject({ ok: true, data: { state: 'sent' } })
    expect(fixture.posts).toEqual([expected])
    expect(fixture.calls.find(call => call.init?.method === 'POST')?.url).toBe('https://api.github.com/repos/ada/demo/issues/7/comments')
    expect(fixture.service.replyState(fixture.action)).toBe('sent')
    await fixture.makeService().reply(fixture.action, args[0], args[1])
    expect(fixture.posts).toHaveLength(1)
    expect(readFileSync(fixture.file, 'utf8')).not.toContain('private-token')
  })

  it.each([
    ['退回', undefined], ['退回', '   '], ['退回', 'x'.repeat(201)], ['批准 A', '多余原因'], ['全部按推荐', undefined], ['同意', undefined]
  ])('makes no request for an unusable reply %s / %s', async (choice, reason) => {
    const fixture = setup()
    expect(await fixture.service.reply(fixture.action, choice, reason)).toMatchObject({ ok: false })
    expect(fixture.calls).toHaveLength(0)
  })

  it.each(['closed', 'superseded', 'answered', 'account'] as const)('sends nothing when the request is stale: %s', async change => {
    const fixture = setup()
    if (change === 'closed') fixture.remote.state = 'closed'
    if (change === 'superseded') fixture.remote.comments = [{ body: request('D-3', 2), created_at: '2026-10-12T02:01:00Z', user: { login: 'agent' } }]
    if (change === 'answered') fixture.remote.comments = [{ body: 'D-3 批准 A', created_at: '2026-10-12T02:01:00Z', user: { login: 'ada' } }]
    if (change === 'account') fixture.remote.login = 'someone'
    expect(await fixture.service.reply(fixture.action, '批准 A')).toMatchObject({ ok: false })
    expect(fixture.posts).toEqual([])
  })

  it('refuses when the thread changes between the read and the write', async () => {
    const fixture = setup()
    fixture.resolveToken.mockImplementationOnce(async () => 'private-token').mockImplementationOnce(async () => {
      fixture.remote.updated = '2026-10-12T02:10:00Z'
      return 'private-token'
    })
    expect(await fixture.service.reply(fixture.action, '批准 A')).toMatchObject({ ok: false })
    expect(fixture.posts).toEqual([])
    expect(fixture.service.replyState(fixture.action)).toBeUndefined()
  })

  it('refuses when the token changes between the read and the write', async () => {
    const fixture = setup()
    fixture.resolveToken.mockResolvedValueOnce('private-token').mockResolvedValueOnce('changed-token')
    expect(await fixture.service.reply(fixture.action, '批准 A')).toMatchObject({ ok: false })
    expect(fixture.posts).toEqual([])
  })

  it('refuses when the request now names another disposer', async () => {
    const fixture = setup()
    fixture.remote.body = request().replace('@ada', '@bob')
    expect(await fixture.service.reply(fixture.action, '批准 A')).toMatchObject({ ok: false })
    expect(fixture.posts).toEqual([])
  })

  it('deduplicates a double click while the first reply is in flight', async () => {
    const fixture = setup()
    const first = fixture.service.reply(fixture.action, '批准 A')
    const second = fixture.service.reply(fixture.action, '改用 B')
    expect(await second).toMatchObject({ ok: false })
    expect(await first).toMatchObject({ ok: true })
    expect(fixture.posts).toEqual(['D-3 批准 A'])
  })

  it.each([401, 403, 404, 422, 429])('does not claim success for an explicit HTTP %i rejection', async status => {
    const fixture = setup()
    fixture.remote.postStatus = status
    expect(await fixture.service.reply(fixture.action, '批准 A')).toMatchObject({ ok: false })
    expect(fixture.service.replyState(fixture.action)).toBeUndefined()
  })

  it.each(['error', 'server'] as const)('keeps an unknown %s outcome, blocks a different answer, and resolves only by a read-only check', async failure => {
    const fixture = setup()
    if (failure === 'error') fixture.remote.postError = new Error('private-token details')
    else fixture.remote.postStatus = 503
    expect(await fixture.service.reply(fixture.action, '批准 A')).toEqual({ ok: true, data: { state: 'unknown' } })
    const restarted = fixture.makeService()
    expect(restarted.replyState(fixture.action)).toBe('unknown')
    expect(await restarted.checkReply(fixture.action)).toEqual({ ok: true, data: { state: 'unknown' } })
    const revised = { ...fixture.action, id: `${fixture.action.id}new` }
    expect(await restarted.reply(revised, '改用 B')).toMatchObject({ ok: true, data: { state: 'unknown' } })
    expect(fixture.posts).toHaveLength(1)
    fixture.remote.postError = null
    fixture.remote.state = 'closed'
    fixture.remote.comments = [{ body: 'D-3 批准 A', created_at: new Date().toISOString(), user: { login: 'ada' } }]
    expect(await restarted.checkReply(fixture.action)).toEqual({ ok: true, data: { state: 'sent' } })
    expect(restarted.replyState(fixture.action)).toBe('sent')
    expect(fixture.posts).toHaveLength(1)
  })

  it('check without any receipt never touches the network', async () => {
    const fixture = setup()
    expect(await fixture.service.checkReply(fixture.action)).toEqual({ ok: true, data: { state: 'unknown' } })
    expect(fixture.calls).toHaveLength(0)
  })

  it('fails closed on a corrupt journal', async () => {
    const fixture = setup()
    writeFileSync(fixture.file, '{bad json')
    expect(fixture.makeService().replyState(fixture.action)).toBe('unknown')
    expect(await fixture.makeService().reply(fixture.action, '批准 A')).toMatchObject({ ok: false })
    expect(fixture.calls).toHaveLength(0)
  })

  it('allows only a visible, current row and a known action id through the waiting service', async () => {
    const fixture = setup()
    const cache = path.join(path.dirname(fixture.file), 'waiting-cache.json')
    writeFileSync(cache, JSON.stringify({ version: 1, refreshedAt: time, configKey: null,
      identityHash: waitingTokenIdentityHash({ token: 'private-token', via: 'env' }),
      memory: { ...emptyWaitingMemory(), humanIssues: [{ ...fixture.record, inScopeRepo: true, repoAccess: 'maintain' }] } }))
    const settings = { getSettings: () => ({ waiting: defaultWaitingConfig(), watchedRepos: [], repoFetchWindow: 'all', patCiphertext: null }), readSavedPat: () => null } as unknown as SettingsService
    const waiting = new WaitingService(settings, { cache, dismissals: path.join(path.dirname(cache), 'dismissals.json') }, {
      env: { GITHUB_TOKEN: 'private-token' }, readGh: async () => ({ ok: false, reason: 'not-installed' }), tasks: fixture.scope,
      fetchImpl: (input, init) => String(input).endsWith('/graphql') ? Promise.resolve(json({}, 500)) : fixture.fetchImpl(input, init)
    })
    await waiting.refresh(false)
    const row = waiting.current().rows[0]!
    expect(row.decisionActions).toHaveLength(1)
    expect(await waiting.replyDecision('arbitrary-row', fixture.action.id, '批准 A', undefined)).toMatchObject({ ok: false })
    expect(await waiting.replyDecision(row.id, 'D-3', '批准 A', undefined)).toMatchObject({ ok: false })
    expect(await waiting.replyDecision(row.id, fixture.action.id, '批准 A', 42)).toMatchObject({ ok: false })
    waiting.ignore(row.id)
    expect(await waiting.replyDecision(row.id, fixture.action.id, '批准 A', undefined)).toMatchObject({ ok: false })
    waiting.restore(row.id)
    expect(await waiting.replyDecision(row.id, fixture.action.id, '退回', '范围不对')).toMatchObject({ ok: true, data: { state: 'sent' } })
    expect(waiting.current().rows[0]?.decisionActions?.[0]?.state).toBe('sent')
    expect(fixture.posts).toEqual(['D-3 退回：范围不对'])
  })
})
