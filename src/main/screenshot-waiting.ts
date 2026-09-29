import { sampleWaitingRows } from '../shared/waiting/sample.js'
import type { WaitingSnapshot } from '../shared/waiting/types.js'
import type { IpcResult } from '../shared/types.js'
import type { ScreenshotScene } from './screenshot-scene.js'

function base(partial: Partial<WaitingSnapshot>): WaitingSnapshot {
  return {
    rows: [],
    refreshedAt: '2026-09-28T09:40:00.000Z',
    refreshing: false,
    auth: 'ok',
    rateLimitResetAt: null,
    sourceErrors: [],
    notices: [],
    showIgnored: false,
    hiddenCount: 3,
    hiddenRepos: [],
    todosAvailable: false,
    ...partial
  }
}

export function screenshotWaitingSnapshot(scene: ScreenshotScene): WaitingSnapshot {
  if (scene === 'waiting' || scene === 'waiting-narrow' || scene === 'waiting-hover' || scene === 'waiting-ignore' || scene === 'waiting-related' || scene === 'waiting-related-open') {
    const rows = sampleWaitingRows().sort((left, right) => right.waitingDays - left.waitingDays || left.title.localeCompare(right.title))
    return base({ rows, hiddenCount: 4 })
  }
  if (scene === 'waiting-watch') {
    const rows = sampleWaitingRows()
      .filter(row => row.repo === 'northwind/ledger')
      .slice(0, 3)
      .map((row, index) => index === 2
        ? { ...row, repo: 'stranger/public', title: '指派给你的那一条', reasons: ['指派'], action: '要你动手', type: 'issue' as const }
        : row)
    return base({
      rows,
      hiddenCount: 0,
      notices: []
    })
  }
  if (scene === 'waiting-family') {
    const repo = 'northwind/ledger'
    const parent = sampleWaitingRows().find(row => row.type === 'issue')
    const baseRow = parent ?? sampleWaitingRows()[0]
    if (!baseRow) return base({ hiddenCount: 0, rows: [] })
    const child = (number: number, title: string, days: number): typeof baseRow => ({
      ...baseRow,
      id: `sample:${repo}#${number}`,
      repo,
      number,
      type: 'issue',
      title,
      url: `https://github.com/${repo}/issues/${number}`,
      reasons: ['要人动手'],
      action: '要你动手',
      waitingDays: days,
      daysEstimated: false,
      parentNumber: 40,
      parent: `https://github.com/${repo}/issues/40`,
      childCount: 0,
      tier: 'strong',
      ignored: false
    })
    return base({
      hiddenCount: 0,
      rows: [
        {
          ...baseRow,
          id: `sample:${repo}#40`,
          repo,
          number: 40,
          type: 'issue',
          title: '确认导出范围',
          url: `https://github.com/${repo}/issues/40`,
          reasons: ['要人动手'],
          action: '要你动手',
          waitingDays: 6,
          daysEstimated: false,
          parentNumber: null,
          parent: null,
          childCount: 2,
          tier: 'strong',
          ignored: false
        },
        child(41, '核对导出的列名', 4),
        child(42, '看空状态的截图', 2)
      ]
    })
  }
  if (scene === 'waiting-hidden') {
    const rows = sampleWaitingRows().sort((left, right) => right.waitingDays - left.waitingDays || left.title.localeCompare(right.title))
    const todo = rows.find(row => row.type === 'todo')
    const others = rows.filter(row => row !== todo)
    const faded = [
      ...(todo ? [{ ...todo, ignored: true, title: '把等我的待办先放下', action: '待办', reasons: ['待办'], waitingDays: 20 }] : []),
      ...others.slice(0, 3).map(row => ({ ...row, ignored: true }))
    ]
    return base({
      rows: [...faded, ...others.slice(3, 14)],
      showIgnored: true,
      hiddenCount: faded.length,
      hiddenRepos: ['stranger/public'],
      todosAvailable: true
    })
  }
  if (scene === 'waiting-maybe-only') {
    const rows = sampleWaitingRows().filter(row => row.tier === 'weak')
    return base({ rows, hiddenCount: 0 })
  }
  if (scene === 'waiting-empty') return base({ hiddenCount: 0, rows: [] })
  if (scene === 'waiting-no-token') return base({ auth: 'missing', refreshedAt: null, hiddenCount: 0 })
  if (scene === 'waiting-invalid-token') return base({ auth: 'invalid', refreshedAt: null, hiddenCount: 0 })
  if (scene === 'waiting-loading') return base({ refreshing: true, refreshedAt: null, hiddenCount: 0 })
  if (scene === 'waiting-rate-limit') {
    const rows = sampleWaitingRows().sort((left, right) => right.waitingDays - left.waitingDays).slice(0, 8)
    return base({
      rows,
      rateLimitResetAt: '2026-09-28T18:30:00.000Z',
      sourceErrors: [{ source: '提及', message: 'GitHub 速率限制，本页保留上次结果' }]
    })
  }
  return base({ hiddenCount: 0 })
}

export function createScreenshotWaiting(scene: ScreenshotScene): {
  current: () => WaitingSnapshot
  refresh: () => Promise<WaitingSnapshot>
  snooze: (id?: unknown, days?: unknown) => IpcResult<WaitingSnapshot>
  ignore: (id?: unknown) => IpcResult<WaitingSnapshot>
  restore: (id?: unknown) => IpcResult<WaitingSnapshot>
  hideRepo: (repo?: unknown) => IpcResult<WaitingSnapshot>
  unhideRepo: (repo?: unknown) => IpcResult<WaitingSnapshot>
  setShowIgnored: (value?: unknown) => IpcResult<WaitingSnapshot>
  advanceDays: (days?: unknown) => IpcResult<WaitingSnapshot>
  observedGithubRepos: () => readonly string[]
  observedLocalLinks: () => readonly { github: string, path: string }[]
} {
  const snapshot = screenshotWaitingSnapshot(scene)
  const refresh = scene === 'waiting-loading'
    ? () => new Promise<WaitingSnapshot>(() => {})
    : () => Promise.resolve(snapshot)
  const ok = (): IpcResult<WaitingSnapshot> => ({ ok: true, data: snapshot })
  return {
    current: () => snapshot,
    refresh,
    snooze: () => ok(),
    ignore: () => ok(),
    restore: () => ok(),
    hideRepo: () => ok(),
    unhideRepo: () => ok(),
    setShowIgnored: () => ok(),
    advanceDays: () => ({ ok: false, error: '测试钩子未开启' }),
    observedGithubRepos: () => [],
    observedLocalLinks: () => []
  }
}
