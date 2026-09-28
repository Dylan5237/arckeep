import { earlierIso, laterIso, repoIsOnWaitingPage, waitingDays } from './days.js'
import { compileUserRegexList } from './rules.js'
import { WAITING_REASONS, type GithubRecord, type ReasonDetail, type WaitingConfig, type WaitingDraft } from './types.js'

export interface ClassifiedReason {
  reason: string
  at: string | null
  estimated: boolean
}

function currentComment(record: GithubRecord): { body: string, createdAt: string } | null {
  if (record.comments.length === 0) return null
  return record.comments[record.comments.length - 1] ?? null
}

/** Latest comment when one exists, otherwise the body. Labels are separate. */
export function currentHumanText(record: GithubRecord): string {
  const comment = currentComment(record)
  return comment ? comment.body : record.body
}

export function textMatches(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => {
    pattern.lastIndex = 0
    return pattern.test(text)
  })
}

export function humanSignal(record: GithubRecord, config: WaitingConfig): ClassifiedReason | null {
  if (record.kind !== 'issue') return null
  const keywords = compileUserRegexList(config.humanKeywords, '人工动作关键词')
  const resolved = compileUserRegexList(config.resolvedSignals, '已解决信号')
  const text = currentHumanText(record)
  if (textMatches(text, resolved)) return null
  const labels = new Set(config.humanLabels.map(label => label.toLowerCase()))
  const labelHit = record.labels.some(label => labels.has(label.toLowerCase()))
  const textHit = textMatches(text, keywords)
  if (!labelHit && !textHit) return null

  const comment = currentComment(record)
  let at: string | null = null
  let estimated = false
  if (textHit && comment) {
    at = comment.createdAt
  } else if (textHit) {
    at = record.createdAt
  }
  if (labelHit) {
    const wanted = labels
    const event = record.labelEvents.find(item => wanted.has(item.name.toLowerCase()))
    const labelAt = event?.at ?? null
    if (!at) {
      at = labelAt
      estimated = !labelAt
      if (!at) at = record.updatedAt
    } else if (labelAt) {
      at = earlierIso(at, labelAt)
    }
  }
  if (!at) {
    at = record.updatedAt
    estimated = true
  }
  return { reason: WAITING_REASONS.human, at, estimated }
}

function fallbackUpdated(reason: string, record: GithubRecord, at: string | null): ClassifiedReason {
  if (at) return { reason, at, estimated: false }
  return { reason, at: record.updatedAt, estimated: true }
}

export function classifyRecord(record: GithubRecord, config: WaitingConfig, now: Date): WaitingDraft | null {
  const reasons: ClassifiedReason[] = []
  if (config.sources.assignee && record.fromAssignee) {
    reasons.push(fallbackUpdated(WAITING_REASONS.assignee, record, record.assignedAt))
  }
  if (config.sources.reviewRequested && record.fromReview && record.kind === 'pr') {
    reasons.push(fallbackUpdated(WAITING_REASONS.review, record, record.reviewRequestedAt))
  }
  if (config.sources.mentions && record.fromMention) {
    reasons.push(fallbackUpdated(WAITING_REASONS.mention, record, record.mentionedAt))
  }
  // Empty repos and repos with no push for more than 30 days stay off the
  // repo-scoped sources only. An assignment, review request, or mention in a
  // quiet repo is still an explicit ask.
  const repoScoped = repoIsOnWaitingPage({ isEmpty: record.repoIsEmpty, pushedAt: record.repoPushedAt }, now)
  if (repoScoped && config.sources.openPrs && record.kind === 'pr' && !record.isDraft && (record.fromOpenPr || record.inScopeRepo)) {
    const at = laterIso(record.lastPushedAt, record.updatedAt)
    reasons.push({ reason: WAITING_REASONS.openPr, at, estimated: false })
  }
  if (repoScoped && config.sources.humanIssues && record.inScopeRepo) {
    const human = humanSignal(record, config)
    if (human) reasons.push(human)
  }
  if (reasons.length === 0) return null
  return draftFromReasons({
    id: `${record.kind}:${record.repo}#${record.number}`,
    repo: record.repo,
    number: record.number,
    type: record.kind,
    title: record.title,
    url: record.url,
    updatedAt: record.updatedAt,
    reasons
  }, now)
}

export function draftFromReasons(input: {
  id: string
  repo: string
  number: number | null
  type: WaitingDraft['type']
  title: string
  url: string
  updatedAt: string
  reasons: ClassifiedReason[]
}, now: Date): WaitingDraft {
  const unique: ClassifiedReason[] = []
  for (const reason of input.reasons) {
    if (!unique.some(item => item.reason === reason.reason)) unique.push(reason)
  }
  let best = unique[0]
  let bestDays = best ? scored(best, now).days : 0
  for (const reason of unique.slice(1)) {
    const score = scored(reason, now)
    if (!best || score.days > bestDays || (score.days === bestDays && best.estimated && !score.estimated)) {
      best = { ...reason, estimated: score.estimated }
      bestDays = score.days
    }
  }
  const chosen = best ? scored(best, now) : { days: 0, estimated: true }
  return {
    id: input.id,
    repo: input.repo,
    number: input.number,
    type: input.type,
    title: input.title,
    url: input.url,
    reasons: unique.map(reason => reason.reason),
    waitingDays: chosen.days,
    daysEstimated: chosen.estimated,
    updatedAt: input.updatedAt,
    reasonDetails: unique.map(reason => ({ reason: reason.reason, at: reason.at, estimated: reason.estimated }))
  }
}

function scored(reason: ClassifiedReason, now: Date): { days: number, estimated: boolean } {
  if (!reason.at) return { days: 0, estimated: true }
  return { days: waitingDays(reason.at, now), estimated: reason.estimated }
}

export function reasonDetails(draft: WaitingDraft): ReasonDetail[] {
  return draft.reasonDetails
}
