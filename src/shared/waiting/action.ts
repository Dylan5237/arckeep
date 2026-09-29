import type { WaitingItemType } from './types.js'

export const WAITING_ACTIONS = ['要你动手', '待你审合', '待你推送', '待办'] as const

export type WaitingAction = (typeof WAITING_ACTIONS)[number]

/** One chip per row: what the user should do, independent of how the row was found. */
export function primaryAction(type: WaitingItemType, reasons: readonly string[]): WaitingAction {
  if (type === 'todo' || reasons.includes('待办')) return '待办'
  if (
    reasons.includes('待你审/合')
    || reasons.includes('请求 review')
    || (type === 'pr' && reasons.includes('指派'))
  ) return '待你审合'
  if (type === 'local-branch' || reasons.includes('没推送')) return '待你推送'
  return '要你动手'
}
