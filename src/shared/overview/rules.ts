import type { OverviewConfig } from './types.js'

export class OverviewConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OverviewConfigError'
  }
}

export const DEFAULT_STALE_DAYS = 14
export const DEFAULT_REVIEW_WAIT_DAYS = 3
export const DEFAULT_STALE_REPO_DAYS = 90
export const DEFAULT_AUTO_PUSH_WINDOW_DAYS = 30
export const DEFAULT_OVERVIEW_MAX_REPOS = 400

export function defaultOverviewConfig(): OverviewConfig {
  return {
    staleDays: DEFAULT_STALE_DAYS,
    reviewWaitDays: DEFAULT_REVIEW_WAIT_DAYS,
    staleRepoDays: DEFAULT_STALE_REPO_DAYS,
    autoPushWindowDays: DEFAULT_AUTO_PUSH_WINDOW_DAYS,
    maxScopeRepos: DEFAULT_OVERVIEW_MAX_REPOS
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function dayCount(value: unknown, fallback: number, label: string, min: number, max: number): number {
  if (value === undefined) return fallback
  const parsed = typeof value === 'number' ? value : Number.NaN
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new OverviewConfigError(`${label}必须是 ${min}–${max} 的整数`)
  }
  return parsed
}

export function parseOverviewConfig(raw: unknown): OverviewConfig {
  const defaults = defaultOverviewConfig()
  if (raw === undefined) return defaults
  if (!isRecord(raw)) throw new OverviewConfigError('项目总览的规则格式无效')
  return {
    staleDays: dayCount(raw.staleDays, defaults.staleDays, '停滞天数', 1, 3650),
    reviewWaitDays: dayCount(raw.reviewWaitDays, defaults.reviewWaitDays, 'review 等待天数', 1, 3650),
    staleRepoDays: dayCount(raw.staleRepoDays, defaults.staleRepoDays, '陈旧天数', 1, 3650),
    autoPushWindowDays: dayCount(raw.autoPushWindowDays, defaults.autoPushWindowDays, '自动模式推送窗口', 0, 3650),
    maxScopeRepos: dayCount(raw.maxScopeRepos, defaults.maxScopeRepos, '仓库数量上限', 1, 2000)
  }
}
