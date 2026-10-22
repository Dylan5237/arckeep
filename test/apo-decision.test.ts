import { describe, expect, it } from 'vitest'
import { pendingApoDecisions } from '../src/shared/waiting/apo-decision.js'
import { blankRecord } from '../src/shared/waiting/parse-github.js'
import { classifyRecord } from '../src/shared/waiting/classify.js'
import { defaultWaitingConfig } from '../src/shared/waiting/rules.js'

const t0 = '2026-10-12T02:00:00.000Z'
const t1 = '2026-10-12T03:00:00.000Z'
const t2 = '2026-10-12T04:00:00.000Z'
const request = (id = 'D-3', rev = 1, disposer = '@ada', target = '#7 #8') =>
  `<!-- apo-decision v1 | id: ${id} | rev: ${rev} | type: 最终验收 | target: ${target} | disposer: ${disposer} -->\n## 请你验收\n\n导出报表已完成。`
const result = (id = 'D-3', rev = 1, outcome = '批准 A') => `<!-- apo-decision-result v1 | id: ${id} | rev: ${rev} | result: ${outcome} | reply: 对话 -->`

function record(body: string, comments: Array<{ body: string, createdAt: string, authorLogin?: string }> = [], viewerLogin = 'ada') {
  return { ...blankRecord({ repo: 'ada/demo', number: 7, kind: 'issue', title: '导出报表', url: 'https://github.com/ada/demo/issues/7',
    body, createdAt: t0, updatedAt: t2, authorLogin: 'agent', viewerLogin, repoAccess: 'maintain', viewerOwnsRepo: true, inScopeRepo: true }), comments }
}

describe('APO formal decision requests', () => {
  it('reads a request whose marker is the first line of the body', () => {
    expect(pendingApoDecisions(record(request()))).toEqual([{
      id: 'D-3', rev: 1, type: '最终验收', targets: [7, 8], requestAt: t0, requestText: 'D-3 rev 1（最终验收）：请你验收'
    }])
  })

  it('reads a request posted as a later comment', () => {
    expect(pendingApoDecisions(record('正文', [{ body: request(), createdAt: t1, authorLogin: 'agent' }])).map(item => item.requestAt)).toEqual([t1])
  })

  it.each([
    ['not the first line', `说明\n${request()}`],
    ['inside a code block', `\`\`\`\n${request()}\n\`\`\``],
    ['quoted', `> ${request()}`],
    ['missing disposer', request().replace(/ \| disposer: @ada/, '')],
    ['bad id', request('D-0')],
    ['duplicate field', request().replace('rev: 1', 'rev: 1 | rev: 2')],
    ['someone else is the disposer', request('D-3', 1, '@bob')]
  ])('does not treat a request as pending when it is %s', (_name, body) => {
    expect(pendingApoDecisions(record(body))).toEqual([])
  })

  it('replaces older revisions with the newest and ignores a result for an older revision', () => {
    const comments = [
      { body: result('D-3', 1), createdAt: t1, authorLogin: 'agent' },
      { body: request('D-3', 2), createdAt: t2, authorLogin: 'agent' }
    ]
    expect(pendingApoDecisions(record(request('D-3', 1), comments)).map(item => item.rev)).toEqual([2])
  })

  it.each(['批准 A', '改用 B', '退回', '撤回'])('a recorded result 「%s」 settles the latest revision', outcome => {
    expect(pendingApoDecisions(record(request(), [{ body: result('D-3', 1, outcome), createdAt: t1, authorLogin: 'agent' }]))).toEqual([])
  })

  it('does not accept a malformed result or one posted before the request', () => {
    expect(pendingApoDecisions(record(request(), [{ body: result('D-3', 1, '大概可以'), createdAt: t1 }]))).toHaveLength(1)
    expect(pendingApoDecisions(record('正文', [{ body: result(), createdAt: t0 }, { body: request(), createdAt: t1 }]))).toHaveLength(1)
  })

  it('treats the disposer own reply as an answer, but only for a matching request', () => {
    const reply = (text: string, authorLogin = 'ada') => [{ body: text, createdAt: t1, authorLogin }]
    expect(pendingApoDecisions(record(request(), reply('批准 A')))).toEqual([])
    expect(pendingApoDecisions(record(request(), reply('退回：缺回放步骤')))).toEqual([])
    expect(pendingApoDecisions(record(request(), reply('PHASE ACCEPT')))).toEqual([])
    expect(pendingApoDecisions(record(request(), reply('批准 A', 'agent')))).toHaveLength(1)
    expect(pendingApoDecisions(record(request(), reply('D-9 批准 A')))).toHaveLength(1)
    expect(pendingApoDecisions(record(request(), reply('D-3 改用 B')))).toEqual([])
  })

  it('needs a D-n prefix when several requests are pending, and 全部按推荐 answers all of them', () => {
    const body = request('D-3')
    const second = { body: request('D-4', 1, '@ada', '#9'), createdAt: t1, authorLogin: 'agent' }
    expect(pendingApoDecisions(record(body, [second, { body: '批准 A', createdAt: t2, authorLogin: 'ada' }]))).toHaveLength(2)
    expect(pendingApoDecisions(record(body, [second, { body: 'D-3 批准 A', createdAt: t2, authorLogin: 'ada' }])).map(item => item.id)).toEqual(['D-4'])
    expect(pendingApoDecisions(record(body, [second, { body: '全部按推荐', createdAt: t2, authorLogin: 'ada' }]))).toEqual([])
  })

  it('refuses to guess when the same id and revision are published twice', () => {
    expect(pendingApoDecisions(record(request(), [{ body: request(), createdAt: t1 }]))).toEqual([])
  })

  it('ignores the body when comments were truncated, because a later result may be hidden', () => {
    expect(pendingApoDecisions({ ...record(request()), commentsTruncated: true })).toEqual([])
  })

  it('needs a signed-in user', () => {
    expect(pendingApoDecisions(record(request(), [], ''))).toEqual([])
  })
})

describe('waiting list integration', () => {
  const now = new Date('2026-10-13T00:00:00.000Z')

  it('surfaces a pending formal request as a strong human item with its own rule', () => {
    const draft = classifyRecord(record(request()), defaultWaitingConfig(), now)
    expect(draft).toMatchObject({ tier: 'strong', signal: { rule: 'APO 决策请求' } })
    expect(draft?.signal.excerpt).toContain('D-3 rev 1')
  })

  it('does not list an item whose decision was answered', () => {
    const answered = record(request(), [{ body: result(), createdAt: t1, authorLogin: 'agent' }])
    expect(classifyRecord(answered, defaultWaitingConfig(), now)).toBeNull()
  })
})
