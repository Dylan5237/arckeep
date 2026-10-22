import { sampleOverviewArchivedRows, sampleOverviewErrorRows, sampleOverviewRows } from '../shared/overview/sample.js'
import type { OverviewSnapshot } from '../shared/overview/types.js'
import type { ScreenshotScene } from './screenshot-scene.js'
import { sampleCommandCenterRows } from '../shared/overview/command-center-sample.js'

function base(partial: Partial<OverviewSnapshot>): OverviewSnapshot {
  return {
    rows: [],
    refreshedAt: '2026-09-28T09:40:00.000Z',
    refreshing: false,
    auth: 'ok',
    rateLimitResetAt: null,
    sourceErrors: [],
    notices: [],
    ...partial
  }
}

export function screenshotOverviewSnapshot(scene: ScreenshotScene): OverviewSnapshot {
  if (scene.startsWith('overview-progress')) return base({ rows: sampleCommandCenterRows(scene === 'overview-progress-errors'), refreshedAt: '2026-10-12T02:10:00.000Z' })
  if (scene === 'overview' || scene === 'overview-narrow' || scene === 'overview-collapsed' || scene === 'overview-chip-hover') {
    return base({ rows: sampleOverviewRows() })
  }
  if (scene === 'overview-empty' || scene === 'overview-auto-empty') return base({ rows: [] })
  if (scene === 'overview-no-token') return base({ auth: 'missing', refreshedAt: null, rows: [] })
  if (scene === 'overview-invalid-token') return base({ auth: 'invalid', refreshedAt: null, rows: [] })
  if (scene === 'overview-loading') return base({ refreshing: true, refreshedAt: null, rows: [] })
  if (scene === 'overview-auth-checking') return base({ auth: 'unknown', refreshing: true, refreshedAt: null, rows: [] })
  if (scene === 'overview-row-error') return base({ rows: sampleOverviewErrorRows() })
  if (scene === 'overview-archived') return base({ rows: sampleOverviewArchivedRows() })
  return base({})
}

export function createScreenshotOverview(scene: ScreenshotScene): {
  current: () => OverviewSnapshot
  refresh: () => Promise<OverviewSnapshot>
} {
  const snapshot = screenshotOverviewSnapshot(scene)
  const refresh = scene === 'overview-loading' || scene === 'overview-auth-checking'
    ? () => new Promise<OverviewSnapshot>(() => {})
    : () => Promise.resolve(snapshot)
  return {
    current: () => snapshot,
    refresh
  }
}
