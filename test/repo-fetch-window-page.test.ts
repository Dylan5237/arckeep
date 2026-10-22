// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderOverview } from '../src/renderer/overview-page.js'
import { renderWaiting } from '../src/renderer/waiting-page.js'
import { renderRepoFetchWindowSettings } from '../src/renderer/repo-fetch-window.js'
import type { AppState, ArckeepApi } from '../src/shared/types.js'
import type { RepoFetchWindow } from '../src/shared/repo-fetch-window.js'

const base = (repoFetchWindow: RepoFetchWindow) => ({ repoFetchWindow, rows: [], refreshedAt: null, refreshing: false, auth: 'ok' as const, rateLimitResetAt: null, sourceErrors: [], notices: [],
  showIgnored: false, hiddenCount: 0, hiddenRepos: [], todosAvailable: true, maybeWhenEmpty: null, maybeWhenListed: null })
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve() }
const host = () => { const node = document.createElement('main'); document.body.append(node); return node }
const control = (node: HTMLElement) => node.querySelector<HTMLSelectElement>('[aria-label="仓库推送时间范围"]')!
afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks() })

describe('repository push window controls', () => {
  it.each(['overview', 'waiting'] as const)('%s shows all five choices, saves once, refreshes with the new range, and shares it with the other page', async kind => {
    let selected: RepoFetchWindow = '7d'
    const save = vi.fn(async (value: RepoFetchWindow) => { selected = value; return { ok: true, data: { repoFetchWindow: value } } })
    const refresh = vi.fn(async () => base(selected))
    window.arckeep = { setRepoFetchWindow: save, getOverview: async () => base(selected), refreshOverview: refresh,
      getWaiting: async () => base(selected), refreshWaiting: refresh } as unknown as ArckeepApi
    const target = host()
    await (kind === 'overview' ? renderOverview(target, () => {}) : renderWaiting(target, () => {}))
    expect(control(target).value).toBe('7d')
    expect([...control(target).options].map(option => [option.value, option.textContent])).toEqual([
      ['3d', '近 3 天'], ['7d', '近 7 天'], ['15d', '近 15 天'], ['30d', '近 30 天'], ['all', '全部仓库']
    ])
    control(target).value = '15d'
    control(target).dispatchEvent(new Event('change'))
    await settle()
    expect(save).toHaveBeenCalledExactlyOnceWith('15d')
    expect(refresh).toHaveBeenLastCalledWith(true)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(control(target).value).toBe('15d')
    expect(control(target).disabled).toBe(false)
    const other = host()
    await (kind === 'overview' ? renderWaiting(other, () => {}) : renderOverview(other, () => {}))
    expect(control(other).value).toBe('15d')
    expect(save).toHaveBeenCalledTimes(1)
  })

  it.each(['overview', 'waiting'] as const)('%s restores the prior selector and surfaces save failures without querying GitHub', async kind => {
    const refresh = vi.fn(async () => base('7d'))
    window.arckeep = { setRepoFetchWindow: async () => ({ ok: false, error: '配置文件无法写入' }), getOverview: async () => base('7d'), refreshOverview: refresh,
      getWaiting: async () => base('7d'), refreshWaiting: refresh } as unknown as ArckeepApi
    const target = host()
    await (kind === 'overview' ? renderOverview(target, () => {}) : renderWaiting(target, () => {}))
    control(target).value = 'all'; control(target).dispatchEvent(new Event('change'))
    await settle()
    expect(control(target).value).toBe('7d')
    expect(target.textContent).toContain('配置文件无法写入')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(control(target).disabled).toBe(false)
  })

  it('settings presents the same shared defaults and prevents repeated saves while the write is pending', async () => {
    let finish!: (value: unknown) => void
    const save = vi.fn(() => new Promise(resolve => { finish = resolve }))
    window.arckeep = { setRepoFetchWindow: save } as unknown as ArckeepApi
    const rerender = vi.fn(async () => {})
    const card = renderRepoFetchWindowSettings({ repoFetchWindow: '7d' } as AppState, rerender)
    document.body.append(card)
    expect(card.textContent).toContain('直接指派')
    control(card).value = '3d'
    const button = card.querySelector('button')!
    button.click(); button.click()
    expect(save).toHaveBeenCalledExactlyOnceWith('3d')
    expect(button.disabled).toBe(true)
    expect(control(card).disabled).toBe(true)
    finish({ ok: true, data: { repoFetchWindow: '3d' } })
    await settle()
    expect(rerender).toHaveBeenCalledTimes(1)
    expect(button.disabled).toBe(false)
  })

  it('does not navigate back to a settings card that was left before saving finished', async () => {
    let finish!: (value: unknown) => void
    window.arckeep = { setRepoFetchWindow: () => new Promise(resolve => { finish = resolve }) } as unknown as ArckeepApi
    const target = host()
    const rerender = vi.fn(async () => { target.textContent = '设置'; })
    const card = renderRepoFetchWindowSettings({ repoFetchWindow: '7d' } as AppState, rerender)
    target.append(card)
    card.querySelector('button')!.click()
    target.textContent = '提示词库'
    finish({ ok: true, data: { repoFetchWindow: '7d' } })
    await settle()
    expect(rerender).not.toHaveBeenCalled()
    expect(target.textContent).toBe('提示词库')
  })
})
