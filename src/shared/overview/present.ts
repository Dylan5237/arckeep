import { relativeLabel } from '../time.js'
import type { CiState, OverviewRow, OverviewWarning } from './types.js'

const CI_NOTE: Partial<Record<CiState, string>> = {
  success: 'CI 通过',
  pending: 'CI 进行中',
  none: '无 CI'
}

/** Colored chips. 陈旧 stays in the collapsed group and is not repeated on the row. */
export function visibleWarningChips(row: OverviewRow): OverviewWarning[] {
  if (row.archived || row.error) return []
  return row.warnings.filter(item => item.kind !== '陈旧')
}

/** Quiet CI states stay in the gray secondary line. Failure is the colored chip. */
export function ciSecondaryNote(row: OverviewRow): string | null {
  if (row.error || row.archived) return null
  if (row.ciState === 'failure' || row.ciState === 'unknown') return null
  return CI_NOTE[row.ciState] ?? null
}

export function overviewMetaText(row: OverviewRow, now: Date): string {
  if (row.error) return row.error
  const parts = [row.lastActivityAt ? `最近活动 ${relativeLabel(row.lastActivityAt, now)}`
    : row.lastCommitAt ? relativeLabel(row.lastCommitAt, now) : '尚无提交']
  if (row.openPrCount > 0) parts.push(`${row.openPrCount} 个 PR 待合并`)
  const ci = ciSecondaryNote(row)
  if (ci) parts.push(ci)
  return parts.join(' · ')
}

export function canRemoveFromWatchList(row: OverviewRow): boolean {
  return Boolean(row.error) && row.fromWatchList === true
}
