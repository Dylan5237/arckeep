// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWaiting } from '../src/renderer/waiting-page.js'
import { renderOverview } from '../src/renderer/overview-page.js'
import type { ArckeepApi } from '../src/shared/types.js'
import type { WaitingRow, WaitingSnapshot } from '../src/shared/waiting/types.js'
import type { OverviewRow, OverviewSnapshot } from '../src/shared/overview/types.js'
import { pendingApoActions } from '../src/shared/waiting/apo-actions.js'
import { pendingApoDecisionActions } from '../src/shared/waiting/apo-reply.js'
import { blankRecord } from '../src/shared/waiting/parse-github.js'

const now = new Date('2026-10-12T03:00:00Z')
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString()
function waitingRow(id: string, minutes: number): WaitingRow {
  return { id, repo: `ada/${id}`, number: 42, type: 'issue', title: id, url: `https://github.com/ada/${id}/issues/42`,
    action: '要你动手', reasons: ['要人动手'], waitingDays: 0, daysEstimated: false,
    updatedAt: minutesAgo(minutes), waitingSince: minutesAgo(minutes), ignored: false, parentNumber: null,
    parent: null, childCount: 0, signalText: '请你核对', ownRequest: false, tier: 'strong' }
}
function overviewRow(id: string, minutes: number): OverviewRow {
  return { name: `ada/${id}`, url: `https://github.com/ada/${id}`, lastCommitAt: minutesAgo(1440),
    lastActivityAt: minutesAgo(minutes), openPrCount: 0, ciState: 'none', warnings: [], group: 'active',
    stallBasis: { at: minutesAgo(minutes), source: 'issue', lastCommitAt: minutesAgo(1440), lastIssueActivityAt: minutesAgo(minutes) },
    archived: false, error: null }
}
const base = { refreshedAt: now.toISOString(), refreshing: false, auth: 'ok' as const, rateLimitResetAt: null, sourceErrors: [], notices: [] }
const waiting = (rows: WaitingRow[]): WaitingSnapshot => ({ ...base, rows, showIgnored: false, hiddenCount: 0, hiddenRepos: [], todosAvailable: true, maybeWhenEmpty: null, maybeWhenListed: null })
const overview = (rows: OverviewRow[]): OverviewSnapshot => ({ ...base, rows })
function host() { const result = document.createElement('main'); document.body.append(result); return result }
async function settle() { for (let n = 0; n < 20; n++) await Promise.resolve() }

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('shared sorting in both pages', () => {
  it.each(['waiting', 'overview'] as const)('%s defaults to newest activity and changes order without a GitHub refresh', async kind => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const snap = kind === 'waiting' ? waiting([waitingRow('older', 90), waitingRow('newer', 3)]) : overview([overviewRow('older', 90), overviewRow('newer', 3)])
    const refresh = vi.fn(async () => snap)
    window.arckeep = { getWaiting: async () => snap, refreshWaiting: refresh, getOverview: async () => snap, refreshOverview: refresh } as unknown as ArckeepApi
    const target = host()
    await (kind === 'waiting' ? renderWaiting(target, () => {}) : renderOverview(target, () => {}))
    const ids = () => [...target.querySelectorAll('.waiting-title-text')].map(node => node.textContent?.replace('ada/', ''))
    expect(ids()).toEqual(['newer', 'older'])
    if (kind === 'overview') {
      expect(target.querySelector('.overview-row .waiting-meta')?.textContent).toContain('最近活动 3 分钟前')
      expect(target.querySelector('.overview-row')?.textContent).not.toContain('0 天')
    }
    const control = target.querySelector('.list-sort select')! as HTMLSelectElement
    control.value = 'oldest'; control.dispatchEvent(new Event('change'))
    expect(ids()).toEqual(['older', 'newer'])
    expect(localStorage.getItem(`arckeep.list-order.${kind}`)).toBe('oldest')
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('displays minutes and hours, uses real reason times, and emphasizes repository/number', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const snap = waiting([waitingRow('newer', 3), { ...waitingRow('older', 90), updatedAt: minutesAgo(1) }])
    window.arckeep = { getWaiting: async () => snap, refreshWaiting: async () => snap } as ArckeepApi
    const target = host(); await renderWaiting(target, () => {})
    expect([...target.querySelectorAll('.days')].map(node => node.textContent)).toEqual(['1 小时', '3 分钟'])
    expect([...target.querySelectorAll('.waiting-row')].some(row => row.textContent?.includes('0 天'))).toBe(false)
    expect(target.querySelector('.waiting-repo')?.tagName).toBe('STRONG')
    expect(target.querySelector('.waiting-number')?.textContent).toBe('#42')
  })

  it('keeps saved sorting choices independent and handles invalid local preferences', async () => {
    localStorage.setItem('arckeep.list-order.waiting', 'invalid')
    localStorage.setItem('arckeep.list-order.overview', 'oldest')
    const snap = waiting([waitingRow('newer', 3)])
    window.arckeep = { getWaiting: async () => snap, refreshWaiting: async () => snap } as ArckeepApi
    const target = host(); await renderWaiting(target, () => {})
    expect(target.querySelector<HTMLSelectElement>('.list-sort select')?.value).toBe('newest')
    expect(localStorage.getItem('arckeep.list-order.overview')).toBe('oldest')
  })
})

describe('waiting quick comment interaction', () => {
  function actionRow() {
    const row = waitingRow('contract', 3)
    row.quickActions = pendingApoActions(blankRecord({ repo: row.repo, number: 42, kind: 'issue', title: row.title,
      url: row.url, body: '请 @ada 在本 Issue 评论 EXCEPTION ACCEPT', createdAt: row.updatedAt, updatedAt: row.updatedAt, viewerLogin: 'ada' }))
    return row
  }

  it('sends on an explicit click, prevents double clicks, and retains the sent state across sorting', async () => {
    const row = actionRow(), snap = waiting([row])
    let resolve!: (result: { ok: true, data: { state: 'sent' } }) => void
    const response = new Promise<{ ok: true, data: { state: 'sent' } }>(done => { resolve = done })
    const send = vi.fn(() => response)
    window.arckeep = { getWaiting: async () => snap, refreshWaiting: async () => snap, commentWaitingApo: send } as unknown as ArckeepApi
    const target = host(); await renderWaiting(target, () => {})
    expect(send).not.toHaveBeenCalled()
    const button = target.querySelector<HTMLButtonElement>('.apo-comment-button')!
    expect(button.textContent).toBe('EXCEPTION ACCEPT')
    expect(button.title).toContain('ada/contract #42')
    button.click(); button.click()
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(row.id, row.quickActions?.[0]?.id)
    expect(target.querySelector<HTMLButtonElement>('.apo-comment-button')?.disabled).toBe(true)
    resolve({ ok: true, data: { state: 'sent' } }); await settle()
    const sort = target.querySelector('select')!; sort.value = 'name'; sort.dispatchEvent(new Event('change'))
    expect(target.querySelector('.apo-comment-status')?.textContent).toBe('已评论')
    expect(target.querySelector<HTMLButtonElement>('.apo-comment-button')?.disabled).toBe(true)
  })

  it('uses a separate read-only check after an unknown result, without another send', async () => {
    const snap = waiting([actionRow()])
    const send = vi.fn(async () => ({ ok: true, data: { state: 'unknown' } }))
    const check = vi.fn(async () => ({ ok: true, data: { state: 'sent' } }))
    window.arckeep = { getWaiting: async () => snap, refreshWaiting: async () => snap, commentWaitingApo: send, checkWaitingApo: check } as unknown as ArckeepApi
    const target = host(); await renderWaiting(target, () => {})
    target.querySelector<HTMLButtonElement>('.apo-comment-button')!.click(); await settle()
    expect(target.querySelector<HTMLButtonElement>('.apo-comment-button')?.disabled).toBe(true)
    target.querySelector<HTMLButtonElement>('.apo-check')!.click(); await settle()
    expect(check).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledOnce()
    expect(target.querySelector('.apo-comment-status')?.textContent).toBe('已评论')
  })

  it('shows permission failures and does not offer approval buttons on weak or ignored rows', async () => {
    const row = actionRow(), snap = waiting([row, { ...actionRow(), id: 'weak', tier: 'weak' }, { ...actionRow(), id: 'ignored', ignored: true }])
    const send = vi.fn(async () => ({ ok: false, error: 'GitHub 权限不足，请检查认证权限' }))
    window.arckeep = { getWaiting: async () => snap, refreshWaiting: async () => snap, commentWaitingApo: send } as unknown as ArckeepApi
    const target = host(); await renderWaiting(target, () => {})
    expect(target.querySelectorAll('.apo-comment-button')).toHaveLength(1)
    target.querySelector<HTMLButtonElement>('.apo-comment-button')!.click(); await settle()
    expect(target.querySelector('.apo-comment-status')?.textContent).toContain('权限不足')
    expect(target.querySelector<HTMLButtonElement>('.apo-comment-button')?.disabled).toBe(false)
  })
})

describe('waiting decision reply interaction', () => {
  function decisionRow(id = 'decision') {
    const row = waitingRow(id, 3)
    row.decisionActions = pendingApoDecisionActions(blankRecord({ repo: row.repo, number: 42, kind: 'issue', title: row.title,
      url: row.url, body: '<!-- apo-decision v1 | id: D-3 | rev: 1 | type: 最终验收 | target: #42 | disposer: @ada -->\n请验收', createdAt: row.updatedAt, updatedAt: row.updatedAt, viewerLogin: 'ada' }))
    return row
  }
  const buttons = (target: HTMLElement) => [...target.querySelectorAll<HTMLButtonElement>('.apo-decision-button')]
  const choiceButton = (target: HTMLElement, text: string) => buttons(target).find(button => button.dataset.apoDecision?.endsWith(`:${text}`))!

  it('sends nothing until a button is clicked, then sends the chosen reply once and locks every choice', async () => {
    const row = decisionRow(), snap = waiting([row])
    const reply = vi.fn(async () => ({ ok: true, data: { state: 'sent' } }))
    window.arckeep = { getWaiting: async () => snap, refreshWaiting: async () => snap, replyWaitingDecision: reply } as unknown as ArckeepApi
    const target = host(); await renderWaiting(target, () => {})
    expect(reply).not.toHaveBeenCalled()
    expect(target.querySelector('.apo-decision-label')?.textContent).toBe('D-3 · 最终验收')
    expect(buttons(target).map(button => button.textContent)).toEqual(['批准 A', '改用 B', '退回'])
    const approve = choiceButton(target, '批准 A')
    approve.click(); approve.click()
    expect(reply).toHaveBeenCalledOnce()
    expect(reply).toHaveBeenCalledWith(row.id, row.decisionActions?.[0]?.id, '批准 A', undefined)
    await settle()
    expect(target.querySelector('.apo-decision .apo-comment-status')?.textContent).toBe('已回复')
    expect(buttons(target).every(button => button.disabled)).toBe(true)
  })

  it('keeps 退回 disabled until a reason is typed, sends it, and remembers it across a re-render', async () => {
    const row = decisionRow(), snap = waiting([row])
    const reply = vi.fn(async () => ({ ok: false, error: 'GitHub 权限不足，请检查认证权限' }))
    window.arckeep = { getWaiting: async () => snap, refreshWaiting: async () => snap, replyWaitingDecision: reply } as unknown as ArckeepApi
    const target = host(); await renderWaiting(target, () => {})
    expect(choiceButton(target, '退回').disabled).toBe(true)
    const input = target.querySelector<HTMLInputElement>('.apo-decision-reason')!
    input.value = '  缺回放步骤  '; input.dispatchEvent(new Event('input'))
    expect(choiceButton(target, '退回').disabled).toBe(false)
    const sort = target.querySelector('select')!; sort.value = 'name'; sort.dispatchEvent(new Event('change'))
    expect(target.querySelector<HTMLInputElement>('.apo-decision-reason')?.value).toBe('  缺回放步骤  ')
    choiceButton(target, '退回').click(); await settle()
    expect(reply).toHaveBeenCalledWith(row.id, row.decisionActions?.[0]?.id, '退回', '  缺回放步骤  ')
    expect(target.querySelector('.apo-decision .apo-comment-status')?.textContent).toContain('权限不足')
    expect(choiceButton(target, '批准 A').disabled).toBe(false)
  })

  it('uses a separate read-only check after an unknown result, without another send', async () => {
    const snap = waiting([decisionRow()])
    const reply = vi.fn(async () => ({ ok: true, data: { state: 'unknown' } }))
    const check = vi.fn(async () => ({ ok: true, data: { state: 'sent' } }))
    window.arckeep = { getWaiting: async () => snap, refreshWaiting: async () => snap, replyWaitingDecision: reply, checkWaitingDecision: check } as unknown as ArckeepApi
    const target = host(); await renderWaiting(target, () => {})
    choiceButton(target, '改用 B').click(); await settle()
    expect(buttons(target).every(button => button.disabled)).toBe(true)
    target.querySelector<HTMLButtonElement>('.apo-decision .apo-check')!.click(); await settle()
    expect(check).toHaveBeenCalledWith(snap.rows[0]!.id, snap.rows[0]!.decisionActions?.[0]?.id)
    expect(reply).toHaveBeenCalledOnce()
    expect(target.querySelector('.apo-decision .apo-comment-status')?.textContent).toBe('已回复')
  })

  it('shows a persisted unknown state with only the check button, and no buttons on weak or ignored rows', async () => {
    const pending = decisionRow()
    pending.decisionActions![0]!.state = 'unknown'
    const snap = waiting([pending, { ...decisionRow(), id: 'weak', tier: 'weak' }, { ...decisionRow(), id: 'ignored', ignored: true }])
    window.arckeep = { getWaiting: async () => snap, refreshWaiting: async () => snap } as unknown as ArckeepApi
    const target = host(); await renderWaiting(target, () => {})
    expect(target.querySelectorAll('.apo-decision')).toHaveLength(1)
    expect(buttons(target).every(button => button.disabled)).toBe(true)
    expect(target.querySelector('.apo-decision .apo-check')).not.toBeNull()
    expect(target.querySelector('.apo-decision .apo-comment-status')?.textContent).toContain('结果待核实')
  })
})
