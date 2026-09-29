import { primaryAction } from './action.js'
import { earlierIso, laterIso, waitingDays } from './days.js'
import { escapeRegex } from './parse-github.js'
import { compileUserRegexList } from './rules.js'
import { evaluateSignals } from './signals.js'
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

function mentionsLogin(text: string, login: string): boolean {
  if (!login) return false
  const pattern = new RegExp(`@${escapeRegex(login)}\\b`, 'i')
  return pattern.test(text)
}

function paragraphs(text: string): string[] {
  const parts = text.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean)
  return parts.length > 0 ? parts : []
}

function actionNearMention(text: string, login: string, keywords: readonly RegExp[]): boolean {
  if (!login || !mentionsLogin(text, login)) return false
  const blocks = paragraphs(text)
  const slices = blocks.length > 0 ? blocks : [text]
  const at = new RegExp(`@${escapeRegex(login)}`, 'ig')
  for (const block of slices) {
    if (!mentionsLogin(block, login)) continue
    if (evaluateSignals(block, keywords, []) === 'action') return true
    for (const match of block.matchAll(at)) {
      const index = match.index ?? 0
      const windowText = block.slice(Math.max(0, index - 80), index + login.length + 81)
      if (evaluateSignals(windowText, keywords, []) === 'action') return true
    }
  }
  return false
}

function withinRecent(iso: string | null, now: Date, days: number): boolean {
  if (!iso) return false
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return false
  return now.getTime() - at <= days * 86_400_000 && at <= now.getTime() + 86_400_000
}

/**
 * A bare @mention in an old issue body is not a pending action.
 * Keep it when the user asked to keep every mention, when the mention is in a
 * recent comment, or when an action signal sits next to the mention or in the
 * latest comment.
 */
export function mentionQualifies(record: GithubRecord, config: WaitingConfig, now: Date): boolean {
  if (!record.fromMention) return false
  if (config.mentionPolicy === 'any') return true
  const keywords = compileUserRegexList(config.humanKeywords, '人工动作关键词')
  const login = record.viewerLogin
  const recent = record.comments.some(comment => {
    if (!withinRecent(comment.createdAt, now, config.mentionRecentDays)) return false
    if (!login) return true
    return mentionsLogin(comment.body, login)
  })
  if (recent) return true
  if (!login && withinRecent(record.mentionedAt, now, config.mentionRecentDays)) return true
  if (actionNearMention(record.body, login, keywords)) return true
  if (record.comments.some(comment => actionNearMention(comment.body, login, keywords))) return true
  const latest = currentComment(record)
  if (latest && evaluateSignals(latest.body, keywords, []) === 'action') return true
  if (!login && evaluateSignals(currentHumanText(record), keywords, []) === 'action') return true
  return false
}

function foreignFork(record: GithubRecord): boolean {
  return record.isFork === true && record.viewerOwnsRepo !== true
}

/** Open non-draft PRs the user is expected to review because they can push. */
export function blanketOpenPr(record: GithubRecord, config: WaitingConfig): boolean {
  if (!config.sources.openPrs || record.kind !== 'pr' || record.isDraft) return false
  if (foreignFork(record)) return false
  const access = record.repoAccess ?? 'unknown'
  if (access === 'watch') {
    return config.openPrScope === 'watching' && (record.fromOpenPr || record.inScopeRepo)
  }
  if (access === 'maintain') return record.fromOpenPr || record.inScopeRepo
  return record.fromOpenPr === true
}

export function humanSignal(record: GithubRecord, config: WaitingConfig): ClassifiedReason | null {
  if (record.kind !== 'issue') return null
  const keywords = compileUserRegexList(config.humanKeywords, '人工动作关键词')
  const resolved = compileUserRegexList(config.resolvedSignals, '已解决信号')
  const text = currentHumanText(record)
  const verdict = evaluateSignals(text, keywords, resolved)
  if (verdict === 'resolved') return null
  const labels = new Set(config.humanLabels.map(label => label.toLowerCase()))
  const labelHit = record.labels.some(label => labels.has(label.toLowerCase()))
  const textHit = verdict === 'action'
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

function authorNeedsAction(record: GithubRecord, config: WaitingConfig): ClassifiedReason | null {
  if (!record.fromAuthor || record.repoAccess !== 'watch') return null
  const keywords = compileUserRegexList(config.humanKeywords, '人工动作关键词')
  const resolved = compileUserRegexList(config.resolvedSignals, '已解决信号')
  if (evaluateSignals(currentHumanText(record), keywords, resolved) !== 'action') return null
  const comment = currentComment(record)
  return {
    reason: WAITING_REASONS.human,
    at: comment?.createdAt ?? record.updatedAt,
    estimated: !comment
  }
}

function fallbackUpdated(reason: string, record: GithubRecord, at: string | null): ClassifiedReason {
  if (at) return { reason, at, estimated: false }
  return { reason, at: record.updatedAt, estimated: true }
}

function repoHumanAllowed(record: GithubRecord): boolean {
  if (!record.inScopeRepo) return false
  return (record.repoAccess ?? 'unknown') !== 'watch'
}

export function classifyRecord(record: GithubRecord, config: WaitingConfig, now: Date): WaitingDraft | null {
  const reasons: ClassifiedReason[] = []
  if (config.sources.assignee && record.fromAssignee) {
    reasons.push(fallbackUpdated(WAITING_REASONS.assignee, record, record.assignedAt))
  }
  if (config.sources.reviewRequested && record.fromReview && record.kind === 'pr') {
    reasons.push(fallbackUpdated(WAITING_REASONS.review, record, record.reviewRequestedAt))
  }
  if (config.sources.mentions && mentionQualifies(record, config, now)) {
    reasons.push(fallbackUpdated(WAITING_REASONS.mention, record, record.mentionedAt))
  }
  if (blanketOpenPr(record, config)) {
    const at = laterIso(record.lastPushedAt, record.updatedAt)
    reasons.push({ reason: WAITING_REASONS.openPr, at, estimated: false })
  }
  if (config.sources.humanIssues && repoHumanAllowed(record)) {
    const human = humanSignal(record, config)
    if (human) reasons.push(human)
  }
  const authored = authorNeedsAction(record, config)
  if (authored && !reasons.some(reason => reason.reason === WAITING_REASONS.human)) reasons.push(authored)
  if (reasons.length === 0) return null
  return draftFromReasons({
    id: `${record.kind}:${record.repo}#${record.number}`,
    repo: record.repo,
    number: record.number,
    type: record.kind,
    title: record.title,
    url: record.url,
    updatedAt: record.updatedAt,
    parentNumber: record.parentNumber,
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
  parentNumber?: number | null
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
  const reasons = unique.map(reason => reason.reason)
  return {
    id: input.id,
    repo: input.repo,
    number: input.number,
    type: input.type,
    title: input.title,
    url: input.url,
    reasons,
    action: primaryAction(input.type, reasons),
    waitingDays: chosen.days,
    daysEstimated: chosen.estimated,
    updatedAt: input.updatedAt,
    reasonDetails: unique.map(reason => ({ reason: reason.reason, at: reason.at, estimated: reason.estimated })),
    parentNumber: input.parentNumber ?? null,
    parent: null,
    childCount: 0
  }
}

function scored(reason: ClassifiedReason, now: Date): { days: number, estimated: boolean } {
  if (!reason.at) return { days: 0, estimated: true }
  return { days: waitingDays(reason.at, now), estimated: reason.estimated }
}

export function reasonDetails(draft: WaitingDraft): ReasonDetail[] {
  return draft.reasonDetails
}
