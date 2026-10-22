import { describe, expect, it } from 'vitest'
import { pendingApoActions, APO_COMMENT_TOKENS } from '../src/shared/waiting/apo-actions.js'
import { blankRecord } from '../src/shared/waiting/parse-github.js'
import { classifyRecord } from '../src/shared/waiting/classify.js'
import { defaultWaitingConfig } from '../src/shared/waiting/rules.js'
import { mergeRecords } from '../src/shared/waiting/assemble.js'

const time = '2026-10-12T02:00:00.000Z'
function record(body: string) {
  return blankRecord({ repo: 'ada/demo', number: 7, kind: 'issue', title: '架构例外',
    url: 'https://github.com/ada/demo/issues/7', body, createdAt: time, updatedAt: time,
    authorLogin: 'agent', viewerLogin: 'ada', repoAccess: 'maintain', viewerOwnsRepo: true, inScopeRepo: true })
}

describe('APO comment request detection', () => {
  it.each(APO_COMMENT_TOKENS)('offers an exact %s comment addressed to the current user', token => {
    const actions = pendingApoActions(record(`请 @ada 在本 Issue 评论 \`${token}\`。`))
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ token, target: { repo: 'ada/demo', number: 7 } })
  })

  it('supports a token on the line immediately after a directed comment request', () => {
    expect(pendingApoActions(record('请处置人 @ada 在本 Issue 回复：\n`EXCEPTION ACCEPT`'))).toHaveLength(1)
  })

  it('directs a PR request to the named exception Issue, preserving repository underscores', () => {
    const item = { ...record('请 @ada 到 other/with_under#42 评论 EXCEPTION ACCEPT'), kind: 'pr' as const }
    expect(pendingApoActions(item)[0]?.target).toEqual({ repo: 'other/with_under', number: 42, url: 'https://github.com/other/with_under/issues/42' })
  })

  it.each([
    '```md\n请用户评论 EXCEPTION ACCEPT\n```',
    '~~~\n请用户评论 EXCEPTION ACCEPT\n~~~',
    '```\n请用户评论 EXCEPTION ACCEPT',
    '> 请用户评论 EXCEPTION ACCEPT',
    '    请用户评论 EXCEPTION ACCEPT',
    '“请用户评论 EXCEPTION ACCEPT”',
    '<!-- 请用户评论 EXCEPTION ACCEPT -->',
    '<!-- 请用户评论 EXCEPTION ACCEPT',
    '## 示例\n请用户评论 EXCEPTION ACCEPT',
    '## 规范\n请用户评论 EXCEPTION ACCEPT',
    '- [x] 请用户评论 EXCEPTION ACCEPT',
    '请用户不要评论 EXCEPTION ACCEPT',
    '如果测试通过，请用户评论 EXCEPTION ACCEPT',
    '无需用户评论 EXCEPTION ACCEPT',
    '例如，请用户评论 EXCEPTION ACCEPT',
    '请 @someone 评论 EXCEPTION ACCEPT',
    '请 agent 评论 EXCEPTION ACCEPT',
    'EXCEPTION ACCEPT',
    '请用户确认 EXCEPTION ACCEPT',
    '请用户评论 EXCEPTION ACCEPT，相关 #8 和 #9',
    '请用户在 https://evil.example/issues/7 评论 EXCEPTION ACCEPT',
    '请用户评论 PHASE ACCEPT 或 FREEZE ACK'
  ])('does not turn quoted, stale, conditional, or ambiguous content into a button: %s', text => {
    expect(pendingApoActions(record(text))).toEqual([])
  })

  it.each([
    '如果回归测试全部通过：\n请 @ada 在本 Issue 评论 PHASE ACCEPT',
    '如果回归测试全部通过：\n\n请 @ada 在本 Issue 评论 PHASE ACCEPT',
    '若回归测试全部通过：\n\n请 @ada 在本 Issue 评论 PHASE ACCEPT',
    '当回归测试全部通过时，请 @ada 在本 Issue 评论 PHASE ACCEPT',
    '待回归测试全部通过后，请 @ada 在本 Issue 评论 PHASE ACCEPT',
    '请 @ada 在本 Issue 评论 PHASE ACCEPT\n\n前提：回归测试全部通过',
    '````markdown\n```\n请 @ada 评论 EXCEPTION ACCEPT\n````',
    '> 示例内容：\n请 @ada 评论 EXCEPTION ACCEPT',
    '示例\n====\n请 @ada 评论 EXCEPTION ACCEPT',
    '请 @ada 评论 EXCEPTION ACCEPTED',
    '处置人：@owner\n请处置人在本 Issue 评论 EXCEPTION ACCEPT',
    '处置人：@owner\n\n请 @ada 在本 Issue 评论 EXCEPTION ACCEPT',
    '请处置人在本 Issue 评论 EXCEPTION ACCEPT',
    '请 @ada 到下面的例外 Issue 评论 EXCEPTION ACCEPT',
    '请 @ada 评论 `EXCEPTION ACCEPT extra-body`',
    '引用：请 @ada 在本 Issue 评论 EXCEPTION ACCEPT',
    '他说“请 @ada 在本 Issue 评论 EXCEPTION ACCEPT”',
    '请 @ada 评论 EXCEPTION ACCEPT 并附上理由',
    '请 @ada 在 https://github.com/ada/demo/issues/7/invalid 评论 EXCEPTION ACCEPT'
  ])('rejects adversarial Markdown, actor, condition and literal-token cases: %s', body => {
    expect(pendingApoActions(record(body))).toEqual([])
  })

  it('does not use an unrelated reference before the request as a target', () => {
    expect(pendingApoActions(record('验证证据见 #42；请 @ada 评论 EXCEPTION ACCEPT'))).toEqual([])
    expect(pendingApoActions(record('背景参考 other/design#42，请 @ada 评论 EXCEPTION ACCEPT'))).toEqual([])
  })

  it('binds a following target link and does not confuse a following evidence link with the destination', () => {
    for (const separator of ['\n', '\n\n']) {
      const item = record(`请 @ada 到下面的例外 Issue 评论 EXCEPTION ACCEPT：${separator}https://github.com/other/design/issues/42`)
      expect(pendingApoActions(item)[0]?.target.number).toBe(42)
      expect(pendingApoActions(item)[0]?.target.repo).toBe('other/design')
    }
    const item = record('请 @ada 在本 Issue 评论 EXCEPTION ACCEPT，验证证据见 #42')
    expect(pendingApoActions(item)[0]?.target.number).toBe(7)
    expect(pendingApoActions(record('处置人：@ada\n\n请处置人在本 Issue 评论 EXCEPTION ACCEPT'))).toHaveLength(1)
  })

  it('rejects traversal repository names and keeps separately targeted requests independent', () => {
    expect(pendingApoActions(record('请 @ada 在 ada/..#42 评论 EXCEPTION ACCEPT'))).toEqual([])
    const item = record('请 @ada 在 #42 评论 EXCEPTION ACCEPT\n请 @ada 在 #43 评论 EXCEPTION ACCEPT')
    expect(pendingApoActions(item).map(action => action.target.number)).toEqual([42, 43])
    item.comments.push({ body: 'EXCEPTION ACCEPT', authorLogin: 'ada', createdAt: '2026-10-12T02:01:00Z' })
    expect(pendingApoActions(item).map(action => action.target.number)).toEqual([42, 43])
    item.comments.push({ body: '不需要用户再评论 EXCEPTION ACCEPT', authorLogin: 'agent', createdAt: '2026-10-12T02:02:00Z' })
    expect(pendingApoActions(item)).toEqual([])
  })

  it('keeps valid requests after skipped sections and recognizes the signed-in account decision', () => {
    const item = record('## 示例\n请用户评论 FREEZE ACK\n## 下一步\n请 @ada 评论 EXCEPTION ACCEPT')
    expect(pendingApoActions(item).map(action => action.token)).toEqual(['EXCEPTION ACCEPT'])
    item.comments.push({ body: 'EXCEPTION ACCEPT\n已核对影响范围', authorLogin: 'ada', createdAt: '2026-10-12T02:01:00Z' })
    expect(pendingApoActions(item)).toEqual([])
  })

  it('only clears a decision by its named user, and allows a newer explicit request', () => {
    const item = record('请 @ada 评论 EXCEPTION ACCEPT')
    item.comments.push({ body: 'EXCEPTION ACCEPT', authorLogin: 'other', createdAt: '2026-10-12T02:01:00Z' })
    expect(pendingApoActions(item)).toHaveLength(1)
    item.comments.push({ body: 'EXCEPTION REJECT', authorLogin: 'ada', createdAt: '2026-10-12T02:02:00Z' })
    expect(pendingApoActions(item)).toEqual([])
    item.comments.push({ body: '请 @ada 在本 Issue 评论 EXCEPTION ACCEPT', authorLogin: 'agent', createdAt: '2026-10-12T02:03:00Z' })
    expect(pendingApoActions(item)).toHaveLength(1)
  })

  it('binds a button to the source revision and admits exact APO requests to the strong list', () => {
    const item = record('请 @ada 评论 EXCEPTION ACCEPT')
    const action = pendingApoActions(item)[0]
    item.updatedAt = '2026-10-12T02:03:00Z'
    expect(pendingApoActions(item)[0]?.id).not.toBe(action?.id)
    const draft = classifyRecord(item, defaultWaitingConfig(), new Date('2026-10-12T03:00:00Z'))
    expect(draft?.tier).toBe('strong')
    expect(draft?.quickActions?.[0]?.token).toBe('EXCEPTION ACCEPT')
  })

  it('does not revive a body request when earlier decisions were omitted from the comment window', () => {
    const item = record('请 @ada 评论 EXCEPTION ACCEPT')
    item.commentsTruncated = true
    expect(pendingApoActions(item)).toEqual([])
    item.comments.push({ body: '请 @ada 在 #7 评论 EXCEPTION ACCEPT', authorLogin: 'agent', createdAt: '2026-10-12T02:01:00Z' })
    expect(pendingApoActions(item)).toHaveLength(1)
  })

  it('merges fresh activity, edited body and matching comment-window metadata together', () => {
    const older = record('请 @ada 评论 EXCEPTION ACCEPT')
    const fresh = { ...record('不需要用户评论 EXCEPTION ACCEPT'), updatedAt: '2026-10-12T02:02:00Z', commentsTruncated: true }
    const merged = mergeRecords([older, fresh])[0]!
    expect(merged.updatedAt).toBe(fresh.updatedAt)
    expect(merged.body).toBe(fresh.body)
    expect(merged.commentsTruncated).toBe(true)
    expect(pendingApoActions(merged)).toEqual([])
  })
})
