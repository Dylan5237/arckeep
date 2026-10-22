import { isApoRepoName } from './apo-actions.js'
import { pendingApoDecisions } from './apo-decision.js'
import type { GithubRecord } from './types.js'

export const APO_REPLY_CHOICES = ['批准 A', '改用 B', '退回'] as const
export type ApoReplyChoice = (typeof APO_REPLY_CHOICES)[number]
export const APO_REPLY_REASON_LIMIT = 200

export interface ApoDecisionAction {
  id: string
  decisionId: string
  rev: number
  decisionType: string
  source: { repo: string, number: number, kind: 'issue' | 'pr' }
  viewerLogin: string
  requestAt: string
  requestText: string
  state?: 'sent' | 'unknown'
}

/** The single line posted for the disposer, always carrying the D-n id; null when the choice or reason is unusable. */
export function apoReplyText(decisionId: string, choice: unknown, reason?: unknown): string | null {
  if (!/^D-[1-9]\d*$/.test(decisionId) || !APO_REPLY_CHOICES.includes(choice as ApoReplyChoice)) return null
  if (choice !== '退回') return reason === undefined || reason === '' ? `${decisionId} ${choice as string}` : null
  if (typeof reason !== 'string') return null
  const text = [...reason.replace(/\s+/g, ' ')].filter(char => char >= ' ' && char.charCodeAt(0) !== 127).join('').trim()
  return text && text.length <= APO_REPLY_REASON_LIMIT ? `${decisionId} 退回：${text}` : null
}

/** Pending formal decision requests the viewer can answer with one reply on the same thread. */
export function pendingApoDecisionActions(record: GithubRecord): ApoDecisionAction[] {
  if (!record.viewerLogin || !isApoRepoName(record.repo)) return []
  const source = { repo: record.repo, number: record.number, kind: record.kind }
  return pendingApoDecisions(record).map(request => ({
    id: JSON.stringify([record.viewerLogin!.toLowerCase(), source.repo.toLowerCase(), source.number, request.id, request.rev, request.requestAt]),
    decisionId: request.id,
    rev: request.rev,
    decisionType: request.type,
    source,
    viewerLogin: record.viewerLogin!,
    requestAt: request.requestAt,
    requestText: request.requestText
  }))
}
