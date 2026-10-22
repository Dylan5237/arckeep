// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWaiting } from '../src/renderer/waiting-page.js'
import { renderOverview } from '../src/renderer/overview-page.js'
import type { ArckeepApi } from '../src/shared/types.js'
import type { WaitingRow, WaitingSnapshot } from '../src/shared/waiting/types.js'
import type { OverviewRow, OverviewSnapshot } from '../src/shared/overview/types.js'
import { pendingApoActions } from '../src/shared/waiting/apo-actions.js'
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
