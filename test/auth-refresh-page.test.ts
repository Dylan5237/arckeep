// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderOverview } from '../src/renderer/overview-page.js'
import { renderWaiting } from '../src/renderer/waiting-page.js'
import type { ArckeepApi } from '../src/shared/types.js'
import type { OverviewSnapshot } from '../src/shared/overview/types.js'
import type { WaitingSnapshot } from '../src/shared/waiting/types.js'

type PageKind = 'overview' | 'waiting'
type Snapshot = OverviewSnapshot | WaitingSnapshot

function snapshot(kind: PageKind, auth: Snapshot['auth'], refreshing = false): Snapshot {
  const base: OverviewSnapshot = {
    auth, refreshing, rows: [], refreshedAt: null, rateLimitResetAt: null, sourceErrors: [], notices: []
  }
  if (auth === 'invalid') base.sourceErrors = [{ source: 'GitHub', message: 'GitHub 认证无效或已过期' }]
  if (kind === 'overview') return base
  return {
    ...base, rows: [], showIgnored: false, hiddenCount: 0, hiddenRepos: [], todosAvailable: true,
    maybeWhenEmpty: null, maybeWhenListed: null
  } as WaitingSnapshot
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}

function start(kind: PageKind, initial: Snapshot, result: Promise<Snapshot>) {
  window.arckeep = {
    getOverview: async () => initial,
    getWaiting: async () => initial,
    refreshOverview: () => result,
    refreshWaiting: () => result
  } as unknown as ArckeepApi
  const target = document.createElement('main')
  document.body.append(target)
  const rendered = kind === 'overview' ? renderOverview(target, () => {}) : renderWaiting(target, () => {})
  return { target, rendered }
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe.each<PageKind>(['overview', 'waiting'])('%s authentication progress', kind => {
  it('shows checking progress without a missing-auth warning while the first authentication query is pending', async () => {
    const pending = deferred<Snapshot>()
    const { target, rendered } = start(kind, snapshot(kind, 'unknown'), pending.promise)
    await settle()
    expect(target.textContent).toContain('正在检查 GitHub 认证')
    expect(target.querySelector('.auth-alert')).toBeNull()
    expect(target.textContent).not.toContain('未配置 GitHub 认证')
    expect(target.textContent).not.toContain('认证无效或已过期')
    pending.resolve(snapshot(kind, 'ok'))
    await rendered
    expect(target.querySelector('.auth-alert')).toBeNull()
  })

  it.each(['missing', 'invalid'] as const)('still shows the real %s result after the query completes', async auth => {
    const pending = deferred<Snapshot>()
    const { target, rendered } = start(kind, snapshot(kind, 'unknown'), pending.promise)
    await settle()
    expect(target.querySelector('.auth-alert')).toBeNull()
    pending.resolve(snapshot(kind, auth))
    await rendered
    expect(target.querySelector('.auth-alert')?.textContent).toContain(
      auth === 'missing' ? '未配置 GitHub 认证' : 'GitHub 认证无效或已过期'
    )
  })

  it.each(['missing', 'invalid'] as const)('does not repeat a previous %s warning while checking again', async auth => {
    const pending = deferred<Snapshot>()
    const { target, rendered } = start(kind, snapshot(kind, auth), pending.promise)
    await settle()
    expect(target.querySelector('.auth-alert')).toBeNull()
    expect(target.textContent).toContain('正在检查 GitHub 认证')
    expect(target.textContent).not.toContain('认证无效或已过期')
    expect(target.textContent).not.toContain('未配置 GitHub 认证')
    pending.resolve(snapshot(kind, 'ok'))
    await rendered
    expect(target.querySelector('.auth-alert')).toBeNull()
  })

  it('reports a failed query as a refresh error and leaves retry available', async () => {
    const pending = deferred<Snapshot>()
    const { target, rendered } = start(kind, snapshot(kind, 'unknown'), pending.promise)
    pending.reject(new Error('认证查询暂时失败'))
    await rendered
    expect(target.querySelector('.auth-alert')).toBeNull()
    expect(target.textContent).toContain('认证查询暂时失败')
    const button = [...target.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '刷新')
    expect(button?.disabled).toBe(false)
  })
})
