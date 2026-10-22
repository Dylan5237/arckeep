// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderOverview } from '../src/renderer/overview-page.js'
import { renderWaiting } from '../src/renderer/waiting-page.js'
import type { OverviewSnapshot } from '../src/shared/overview/types.js'
import { assembleWaiting } from '../src/shared/waiting/assemble.js'
import { defaultWaitingConfig } from '../src/shared/waiting/rules.js'
import { partitionDismissals } from '../src/shared/waiting/snooze.js'
import type { WaitingSnapshot } from '../src/shared/waiting/types.js'
import type { ArckeepApi } from '../src/shared/types.js'

type PageKind = 'overview' | 'waiting'
type Snapshot = OverviewSnapshot | WaitingSnapshot
const now = new Date('2026-10-09T00:00:00.000Z')

function snapshot(kind: PageKind, title = '缓存结果'): Snapshot {
  const base = {
    refreshedAt: now.toISOString(), refreshing: false, auth: 'ok' as const,
    rateLimitResetAt: null, sourceErrors: [], notices: []
  }
  if (kind === 'overview') return {
    ...base,
    rows: [{
      name: `example/${title}`, url: `https://github.com/example/${title}`, lastCommitAt: now.toISOString(),
      openPrCount: 0, ciState: 'success', warnings: [], group: 'stale', archived: false, error: null,
      stallBasis: { at: now.toISOString(), source: 'commit', lastCommitAt: now.toISOString(), lastIssueActivityAt: null }
    }]
  }
  const rows = assembleWaiting({
    records: [], statusDocs: [], branches: [], todos: [{
      id: 'todo-1', title, createdAt: now.toISOString(), updatedAt: now.toISOString()
    }], config: defaultWaitingConfig(), now
  })
  return {
    ...base, rows: partitionDismissals(rows, {}, now, false).rows,
    showIgnored: false, hiddenCount: 0, hiddenRepos: [], todosAvailable: true,
    maybeWhenEmpty: null, maybeWhenListed: null
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
}

function start(kind: PageKind, results: Promise<Snapshot>[], cached: Promise<Snapshot> = Promise.resolve(snapshot(kind))) {
  let index = 0
  const refresh = vi.fn(() => results[index++]!)
  window.arckeep = {
    getOverview: () => cached, getWaiting: () => cached,
    refreshOverview: refresh, refreshWaiting: refresh
  } as unknown as ArckeepApi
  const target = document.createElement('main')
  document.body.append(target)
  const rendered = kind === 'overview' ? renderOverview(target, () => {}) : renderWaiting(target, () => {})
  return { target, rendered, refresh }
}

function refreshButton(target: HTMLElement): HTMLButtonElement {
  return target.querySelector<HTMLButtonElement>('.waiting-toolbar button.primary')!
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
})

afterEach(() => {
  document.body.replaceChildren()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe.each<PageKind>(['overview', 'waiting'])('%s refresh elapsed feedback', kind => {
  it('keeps the request active past seven seconds and only updates elapsed text', async () => {
    const pending = deferred<Snapshot>()
    const { target, rendered, refresh } = start(kind, [pending.promise])
    await settle()
    const row = target.querySelector('.overview-row, .waiting-row')!
    const title = row.querySelector<HTMLButtonElement>('.waiting-title')!
    const details = target.querySelector<HTMLDetailsElement>('details')!
    details.open = true
    title.focus()
    await settle()

    await vi.advanceTimersByTimeAsync(7000)
    expect(target.querySelector('.refresh-elapsed')?.textContent).toBe('已用 7 秒')
    expect(refreshButton(target).textContent).toBe('正在刷新')
    expect(refreshButton(target).disabled).toBe(true)
    expect(target.textContent).toContain('缓存结果')
    expect(target.querySelector('.overview-row, .waiting-row')).toBe(row)
    expect(document.activeElement).toBe(title)
    expect(details.open).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    refreshButton(target).click()
    refreshButton(target).click()
    expect(refresh).toHaveBeenCalledTimes(1)

    pending.resolve(snapshot(kind, '最新结果'))
    await rendered
    await settle()
    expect(target.textContent).toContain('最新结果')
    expect(target.querySelector('.refresh-elapsed')).toBeNull()
    expect(refreshButton(target).disabled).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the clock after rejection and leaves cached rows and retry available', async () => {
    const pending = deferred<Snapshot>()
    const { target, rendered } = start(kind, [pending.promise])
    await settle()
    await vi.advanceTimersByTimeAsync(2000)
    expect(target.querySelector('.refresh-elapsed')?.textContent).toBe('已用 2 秒')
    pending.reject(new Error('网络暂时不可用'))
    await rendered
    await settle()
    expect(target.textContent).toContain('缓存结果')
    expect(target.textContent).toContain('网络暂时不可用')
    expect(refreshButton(target).disabled).toBe(false)
    expect(target.querySelector('.refresh-elapsed')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up when the host is reused and never paints a late result over the next page', async () => {
    const pending = deferred<Snapshot>()
    const { target, rendered } = start(kind, [pending.promise])
    await settle()
    await vi.advanceTimersByTimeAsync(2000)
    const nextPage = document.createElement('section')
    nextPage.textContent = '另一个页面'
    target.replaceChildren(nextPage)
    await settle()
    // Disconnection checks also work if an observer callback is delayed.
    await vi.advanceTimersByTimeAsync(1000)
    expect(vi.getTimerCount()).toBe(0)
    pending.resolve(snapshot(kind, '迟到结果'))
    await rendered
    expect(target.firstChild).toBe(nextPage)
    await vi.advanceTimersByTimeAsync(9000)
    expect(target.textContent).toBe('另一个页面')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up when the host disconnects while its request is still pending', async () => {
    const pending = deferred<Snapshot>()
    const { target, rendered } = start(kind, [pending.promise])
    await settle()
    const before = target.textContent
    target.remove()
    await settle()
    await vi.advanceTimersByTimeAsync(1000)
    expect(vi.getTimerCount()).toBe(0)
    pending.resolve(snapshot(kind, '离开后的结果'))
    await rendered
    expect(target.textContent).toBe(before)
  })

  it('does not start a refresh or replace the next page after a delayed cache read', async () => {
    const cached = deferred<Snapshot>()
    const { target, rendered, refresh } = start(kind, [], cached.promise)
    await settle()
    await vi.advanceTimersByTimeAsync(3000)
    expect(target.querySelector('.refresh-elapsed')?.textContent).toBe('已用 3 秒')
    target.replaceChildren(document.createTextNode('新的页面'))
    cached.resolve(snapshot(kind))
    await rendered
    await settle()
    expect(target.textContent).toBe('新的页面')
    expect(refresh).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lets a superseding request own the clock and ignores its predecessor completion', async () => {
    const first = deferred<Snapshot>()
    const second = deferred<Snapshot>()
    const { target, rendered, refresh } = start(kind, [first.promise, second.promise])
    await settle()
    await vi.advanceTimersByTimeAsync(2000)
    // A queued handler can outlive the disabled button which originally owned it.
    refreshButton(target).dispatchEvent(new Event('click', { bubbles: true }))
    await settle()
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(target.querySelector('.refresh-elapsed')?.textContent).toBe('已用 0 秒')
    first.resolve(snapshot(kind, '旧请求结果'))
    await rendered
    await settle()
    await vi.advanceTimersByTimeAsync(3000)
    expect(target.textContent).not.toContain('旧请求结果')
    expect(target.querySelector('.refresh-elapsed')?.textContent).toBe('已用 3 秒')
    expect(refreshButton(target).disabled).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    second.resolve(snapshot(kind, '后一个请求结果'))
    await settle()
    expect(target.textContent).toContain('后一个请求结果')
    expect(vi.getTimerCount()).toBe(0)
  })
})
