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
    todosAvailable: false,
    ...partial
  }
}

export function screenshotWaitingSnapshot(scene: ScreenshotScene): WaitingSnapshot {
  if (scene === 'waiting' || scene === 'waiting-narrow') {
    const rows = sampleWaitingRows().sort((left, right) => right.waitingDays - left.waitingDays || left.title.localeCompare(right.title))
    return base({ rows, hiddenCount: 4 })
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
  setShowIgnored: (value?: unknown) => IpcResult<WaitingSnapshot>
  advanceDays: (days?: unknown) => IpcResult<WaitingSnapshot>
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
    setShowIgnored: () => ok(),
    advanceDays: () => ({ ok: false, error: '测试钩子未开启' })
  }
}
