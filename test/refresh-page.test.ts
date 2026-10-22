// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderOverview } from '../src/renderer/overview-page.js'
import { renderWaiting } from '../src/renderer/waiting-page.js'
import type { ArckeepApi } from '../src/shared/types.js'
import type { OverviewSnapshot } from '../src/shared/overview/types.js'
import { assembleWaiting } from '../src/shared/waiting/assemble.js'
import { defaultWaitingConfig } from '../src/shared/waiting/rules.js'
import { partitionDismissals } from '../src/shared/waiting/snooze.js'
import type { WaitingSnapshot } from '../src/shared/waiting/types.js'

const now = new Date('2026-10-08T00:00:00.000Z')
function overview(name = 'example/cached'): OverviewSnapshot {
  return {
    rows: [{ name, url: `https://github.com/${name}`, lastCommitAt: now.toISOString(), openPrCount: 0,
      ciState: 'success', warnings: [], group: 'active',
      stallBasis: { at: now.toISOString(), source: 'commit', lastCommitAt: now.toISOString(), lastIssueActivityAt: null },
      archived: false, error: null }],
    refreshedAt: now.toISOString(), refreshing: false, auth: 'ok', rateLimitResetAt: null, sourceErrors: [], notices: []
  }
}
function waiting(title = '缓存里的个人待办'): WaitingSnapshot {
  const drafts = assembleWaiting({ records: [], statusDocs: [], branches: [], todos: [{
    id: 'todo-1', title, createdAt: now.toISOString(), updatedAt: now.toISOString()
  }], config: defaultWaitingConfig(), now })
  return {
    rows: partitionDismissals(drafts, {}, now, false).rows,
    refreshedAt: now.toISOString(), refreshing: false, auth: 'ok', rateLimitResetAt: null, sourceErrors: [], notices: [],
    showIgnored: false, hiddenCount: 0, hiddenRepos: [], todosAvailable: true, maybeWhenEmpty: null, maybeWhenListed: null
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed })
  return { promise, resolve, reject }
}
function host(): HTMLElement {
  const node = document.createElement('main')
  document.body.append(node)
  return node
}
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}
function refreshButton(target: HTMLElement): HTMLButtonElement {
  const button = [...target.querySelectorAll<HTMLButtonElement>('button')].find(item => /^(刷新|正在刷新)$/.test(item.textContent ?? ''))
  if (!button) throw new Error('Missing refresh button')
  return button
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('cached refresh pages', () => {
  it('shows overview cache immediately while a background refresh is pending', async () => {
    const refreshed = deferred<OverviewSnapshot>()
    const refresh = vi.fn(() => refreshed.promise)
    window.arckeep = { getOverview: async () => overview(), refreshOverview: refresh } as unknown as ArckeepApi
    const target = host()
    const rendered = renderOverview(target, () => {})
    await settle()
    expect(target.textContent).toContain('example/cached')
    expect(refreshButton(target).disabled).toBe(true)
    expect(refresh).toHaveBeenCalledWith(false)
    refreshed.resolve(overview('example/fresh'))
    await rendered
    expect(target.textContent).toContain('example/fresh')
    expect(target.textContent).not.toContain('example/cached')
    expect(refreshButton(target).disabled).toBe(false)
  })

  it('keeps waiting rows through manual refresh and a rejected request', async () => {
    const refreshed = deferred<WaitingSnapshot>()
    const refresh = vi.fn<ArckeepApi['refreshWaiting']>().mockResolvedValueOnce(waiting()).mockImplementationOnce(() => refreshed.promise)
    window.arckeep = { getWaiting: async () => waiting(), refreshWaiting: refresh } as unknown as ArckeepApi
    const target = host()
    await renderWaiting(target, () => {})
    refreshButton(target).click()
    await settle()
    expect(refresh).toHaveBeenLastCalledWith(true)
    expect(target.textContent).toContain('缓存里的个人待办')
    expect(refreshButton(target).disabled).toBe(true)
    refreshed.reject(new Error('请求超时'))
    await settle()
    expect(target.textContent).toContain('缓存里的个人待办')
    expect(target.textContent).toContain('请求超时')
    expect(refreshButton(target).disabled).toBe(false)
  })

  it('keeps overview rows after manual refresh fails', async () => {
    const refresh = vi.fn<ArckeepApi['refreshOverview']>().mockResolvedValueOnce(overview()).mockRejectedValueOnce(new Error('网络暂时不可用'))
    window.arckeep = { getOverview: async () => overview(), refreshOverview: refresh } as unknown as ArckeepApi
    const target = host()
    await renderOverview(target, () => {})
    refreshButton(target).click()
    await settle()
    expect(refresh).toHaveBeenLastCalledWith(true)
    expect(target.textContent).toContain('example/cached')
    expect(target.textContent).toContain('网络暂时不可用')
    expect(refreshButton(target).disabled).toBe(false)
  })

  it('shows waiting cache during initial loading and ignores results after leaving', async () => {
    const refreshed = deferred<WaitingSnapshot>()
    const refresh = vi.fn(() => refreshed.promise)
    window.arckeep = { getWaiting: async () => waiting(), refreshWaiting: refresh } as unknown as ArckeepApi
    const target = host()
    const rendered = renderWaiting(target, () => {})
    await settle()
    expect(target.textContent).toContain('缓存里的个人待办')
    expect(refresh).toHaveBeenCalledWith(false)
    const before = target.textContent
    target.remove()
    refreshed.resolve(waiting('迟到的结果'))
    await rendered
    expect(target.textContent).toBe(before)
  })

  it('still fetches fresh data when the cache cannot be read', async () => {
    const refresh = vi.fn(async () => overview())
    window.arckeep = {
      getOverview: async () => { throw new Error('读取失败') }, refreshOverview: refresh
    } as unknown as ArckeepApi
    const target = host()
    await renderOverview(target, () => {})
    expect(refresh).toHaveBeenCalledWith(false)
    expect(target.textContent).toContain('example/cached')
    expect(refreshButton(target).disabled).toBe(false)
  })
})
