import { sampleOverviewErrorRows, sampleOverviewRows } from '../shared/overview/sample.js'
import type { OverviewSnapshot } from '../shared/overview/types.js'
import type { ScreenshotScene } from './screenshot-scene.js'

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
  if (scene === 'overview' || scene === 'overview-narrow') return base({ rows: sampleOverviewRows() })
  if (scene === 'overview-empty') return base({ rows: [] })
  if (scene === 'overview-no-token') return base({ auth: 'missing', refreshedAt: null, rows: [] })
  if (scene === 'overview-invalid-token') return base({ auth: 'invalid', refreshedAt: null, rows: [] })
  if (scene === 'overview-loading') return base({ refreshing: true, refreshedAt: null, rows: [] })
  if (scene === 'overview-row-error') return base({ rows: sampleOverviewErrorRows() })
  return base({})
}

export function createScreenshotOverview(scene: ScreenshotScene): {
  current: () => OverviewSnapshot
  refresh: () => Promise<OverviewSnapshot>
} {
  const snapshot = screenshotOverviewSnapshot(scene)
  const refresh = scene === 'overview-loading'
    ? () => new Promise<OverviewSnapshot>(() => {})
    : () => Promise.resolve(snapshot)
  return {
    current: () => snapshot,
    refresh
  }
}
