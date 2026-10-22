// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderOverview } from '../src/renderer/overview-page.js'
import { readCommandCenter } from '../src/shared/overview/command-center.js'
import { retainCommandCenter } from '../src/shared/overview/command-center-types.js'
import type { OverviewRow, OverviewSnapshot } from '../src/shared/overview/types.js'
import type { ArckeepApi } from '../src/shared/types.js'
import { CC_BODY, CC_NOW, CC_REPO, ccNode, labelConnection, searchConnection } from './fixtures/command-center.js'

function row(name: string, minutes: number, status: string): OverviewRow {
  const repo = `example/${name}`
  const timestamp = new Date(Date.parse(CC_NOW) - minutes * 60_000).toISOString()
  const center = ccNode({ url: `https://github.com/${repo}/issues/1`, body: CC_BODY.replaceAll(CC_REPO, repo).replace('| **Status word** | verification |', `| Status word | ${status} |`), repository: { nameWithOwner: repo } })
  return { name: repo, url: `https://github.com/${repo}`, lastActivityAt: timestamp, lastCommitAt: timestamp, openPrCount: 1, ciState: 'success', warnings: [],
    group: 'active', archived: false, error: null, stallBasis: { at: timestamp, source: 'commit', lastCommitAt: timestamp, lastIssueActivityAt: null },
    commandCenter: readCommandCenter({ repo, labeled: labelConnection([center]), english: searchConnection(), chinese: searchConnection(), checkedAt: CC_NOW }) }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}
async function page(rows: OverviewRow[], navigate = vi.fn()) {
  vi.useFakeTimers(); vi.setSystemTime(new Date(CC_NOW))
  const snapshot: OverviewSnapshot = { rows, auth: 'ok', refreshing: false, refreshedAt: CC_NOW, sourceErrors: [], notices: [], rateLimitResetAt: null }
  const refresh = vi.fn(async () => snapshot)
  const open = vi.fn(async () => ({ ok: true }))
  const startClaudeSession = vi.fn(async () => ({ ok: true as const, data: { id: '123e4567-e89b-42d3-a456-426614174000' } }))
  window.arckeep = { getOverview: async () => snapshot, refreshOverview: refresh, openExternal: open, startClaudeSession } as unknown as ArckeepApi
  const host = document.createElement('main'); document.body.append(host)
  await renderOverview(host, navigate)
  return { host, refresh, open, navigate, startClaudeSession }
}
const cards = (host: HTMLElement) => [...host.querySelectorAll('.project-card .waiting-title-text')].map(node => node.textContent)
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.useRealTimers() })

describe('project progress board', () => {
  it('shows Command Center state, gates, next action and original links while retaining repository health', async () => {
    const { host, open } = await page([row('one', 1, 'verification')])
    expect(host.textContent).toContain('项目进度看板')
    expect(host.querySelector('.cc-badge')?.textContent).toBe('验证中')
    expect(host.querySelector('[aria-current="step"]')?.textContent).toBe('验证中')
    expect(host.textContent).toContain('是否 PHASE ACCEPT')
    expect(host.textContent).toContain('未逐项核验 Phase ACCEPT')
    expect(host.querySelectorAll('.cc-phases .cc-phase')).toHaveLength(3)
    expect(host.querySelector('.cc-health')?.textContent).toContain('最近活动 1 分钟前')
    const origin = [...host.querySelectorAll('a')].find(anchor => anchor.textContent === 'Command Center #1')!
    origin.click()
    expect(open).toHaveBeenCalledWith('https://github.com/example/one/issues/1')
    expect(host.querySelector('progress, [role="progressbar"]')).toBeNull()
    expect(host.querySelector('.apo-comment-button')).toBeNull()
  })

  it('filters and sorts locally without another network refresh; defaults to newest', async () => {
    const { host, refresh } = await page([row('blocked', 30, 'blocked'), row('newest', 1, 'implementation'), row('review', 10, 'awaiting Accept')])
    expect(cards(host)).toEqual(['example/newest', 'example/review', 'example/blocked'])
    const filter = [...host.querySelectorAll<HTMLButtonElement>('.cc-board-filter')].find(button => button.textContent?.startsWith('阻塞'))!
    filter.click()
    expect(cards(host)).toEqual(['example/blocked'])
    host.querySelector<HTMLButtonElement>('.cc-board-filter')!.click()
    const sort = host.querySelector<HTMLSelectElement>('.list-sort select')!
    sort.value = 'oldest'; sort.dispatchEvent(new Event('change'))
    expect(cards(host)).toEqual(['example/blocked', 'example/review', 'example/newest'])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('opens the exact session created or reactivated from a project card', async () => {
    const navigate = vi.fn()
    const { host, navigate: actualNavigate, startClaudeSession } = await page([row('one', 1, 'verification')], navigate)

    host.querySelector<HTMLButtonElement>('.project-claude-actions .primary')!.click()
    await Promise.resolve()

    expect(startClaudeSession).toHaveBeenCalledWith('example/one', 'example/one')
    expect(actualNavigate).toHaveBeenCalledWith('claude', {
      repo: 'example/one', sessionId: '123e4567-e89b-42d3-a456-426614174000'
    })
  })

  it('does not navigate to Claude after the user has left the overview', async () => {
    const navigate = vi.fn()
    const { host, startClaudeSession } = await page([row('one', 1, 'verification')], navigate)
    const pending = deferred<{ ok: true, data: { id: string } }>()
    startClaudeSession.mockImplementation(() => pending.promise as never)

    host.querySelector<HTMLButtonElement>('.project-claude-actions .primary')!.click()
    host.replaceChildren(document.createElement('section'))
    pending.resolve({ ok: true, data: { id: '123e4567-e89b-42d3-a456-426614174000' } })
    await Promise.resolve()
    await Promise.resolve()

    expect(navigate).not.toHaveBeenCalled()
  })

  it('does not count cached blocked observations as fresh blocked states', async () => {
    const cached = row('cached', 30, 'blocked')
    cached.commandCenter = retainCommandCenter(cached.commandCenter, 'offline', CC_NOW)
    const { host } = await page([cached])
    expect(host.querySelector('.cc-badge')?.textContent).toBe('缓存 · 阻塞')
    expect(host.textContent).toContain('本次读取失败，下面是上次记录')
    const blocked = [...host.querySelectorAll('.cc-board-filter')].find(button => button.textContent?.startsWith('阻塞'))!
    expect(blocked.textContent).toBe('阻塞0')
    const maintenance = [...host.querySelectorAll<HTMLButtonElement>('.cc-board-filter')].find(button => button.textContent?.startsWith('待核对'))!
    maintenance.click()
    expect(cards(host)).toEqual(['example/cached'])
  })

  it('shows distinct states for old cache, absent CC, multiple candidates and unsupported body', async () => {
    const rows = ['legacy', 'absent', 'multiple', 'unsupported'].map((name, index) => row(name, index + 1, 'verification'))
    delete rows[0]!.commandCenter
    rows[1]!.commandCenter = { kind: 'missing', checkedAt: CC_NOW }
    rows[2]!.commandCenter = { kind: 'ambiguous', candidates: [], truncated: true, checkedAt: CC_NOW }
    rows[3]!.commandCenter = { kind: 'unsupported', source: { number: 1, title: 'CC', url: 'https://github.com/example/unsupported/issues/1', updatedAt: CC_NOW }, message: '请核对摘要', checkedAt: CC_NOW }
    const { host } = await page(rows)
    expect([...host.querySelectorAll('.cc-badge')].map(badge => badge.textContent)).toEqual(['尚未读取', '未接入总控台', '总控台待核对', '格式待核对'])
    expect(host.textContent).toContain('查询范围不完整')
    expect(host.textContent).not.toContain('已完成')
  })

  it('keeps archived projects separate and opens stale groups for a matching status filter', async () => {
    const old = { ...row('quiet', 40, 'blocked'), group: 'stale' as const }
    const archived = { ...row('archive', 50, 'blocked'), group: 'archived' as const, archived: true }
    const { host } = await page([old, archived])
    const blocked = [...host.querySelectorAll<HTMLButtonElement>('.cc-board-filter')].find(button => button.textContent?.startsWith('阻塞'))!
    expect(blocked.textContent).toBe('阻塞1')
    blocked.click()
    expect(host.querySelector<HTMLDetailsElement>('.stale-group')?.open).toBe(true)
    expect(host.querySelector<HTMLDetailsElement>('.archived-group')?.open).toBe(false)
  })
})
