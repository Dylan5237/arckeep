import { primaryAction } from './action.js'
import { laterIso, waitingDays } from './days.js'
import { pendingApoActions } from './apo-actions.js'
import { waitingExcerpt } from './human-text.js'
import { escapeRegex } from './parse-github.js'
import { compileUserRegexList } from './rules.js'
import { evaluateSignals } from './signals.js'
import { commentClosesRecord, labelMatches, latestComment, latestStatusText, matchedLabel, mentionSentence, repoIsParked, statusIsDoneOrClosed, strongText, whenLabel } from './text-scan.js'
import { WAITING_REASONS, type GithubRecord, type ReasonDetail, type WaitingConfig, type WaitingDraft, type WaitingSignal, type WaitingTier } from './types.js'

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
  const resolved = compileUserRegexList(config.resolvedSignals, '已解决信号')
  return waitingExcerpt(record.body, record.comments, keywords, resolved) !== null
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

/**
 * Own and writable repos do not list every open pull. A watched repo the user
 * opted into still lists every non-draft, which is the older explicit choice.
 */
function openPrNeedsGate(record: GithubRecord): boolean {
  return (record.repoAccess ?? 'unknown') !== 'watch'
}

/** Latest of open, push, issue comment, and submitted review. `updatedAt` is not activity. */
export function openPrActivityAt(record: GithubRecord): string | null {
  let at: string | null = record.createdAt || null
  at = laterIso(at, record.lastPushedAt)
  for (const comment of record.comments) at = laterIso(at, comment.createdAt || null)
  return laterIso(at, record.lastReviewAt ?? null)
}

function quietOpenPrSignal(record: GithubRecord, days: number): WaitingSignal {
  const rule = `${days} 天无动静`
  const activity = openPrActivityAt(record)
  const when = whenLabel(activity)
  return {
    rule,
    excerpt: `最近活动 ${when}，已连续 ${days} 天没有 push、评论或 review`
  }
}

function ensureExcerpt(signal: WaitingSignal): WaitingSignal {
  const excerpt = signal.excerpt.trim()
  const kept = excerpt ? { rule: signal.rule, excerpt } : { rule: signal.rule, excerpt: signal.rule || '等待' }
  return signal.own ? { ...kept, own: true } : kept
}

function fallbackUpdated(reason: string, record: GithubRecord, at: string | null): ClassifiedReason {
  if (at) return { reason, at, estimated: false }
  return { reason, at: record.updatedAt, estimated: true }
}

function repoHumanAllowed(record: GithubRecord): boolean {
  if (!record.inScopeRepo) return false
  return (record.repoAccess ?? 'unknown') !== 'watch'
}

function reviewExcerpt(record: GithubRecord): string {
  const who = record.reviewRequestedBy?.trim() || '有人'
  const when = whenLabel(record.reviewRequestedAt)
  const viewer = (record.viewerLogin ?? '').trim()
  const target = viewer ? ` @${viewer}` : '你'
  return `${who} 在 ${when} 请求${target} review`
}

function assignExcerpt(record: GithubRecord): string {
  const who = record.assignedBy?.trim() || '有人'
  return `${who} 在 ${whenLabel(record.assignedAt)} 把这件事指派给你`
}

function labelExcerpt(record: GithubRecord, name: string): { excerpt: string, at: string | null } {
  const event = [...record.labelEvents].reverse().find(item => item.name.toLowerCase() === name.toLowerCase())
    ?? record.labelEvents.find(item => labelMatches(item.name, [name]))
  const at = event?.at ?? null
  return { excerpt: `标签 ${name}，标于 ${whenLabel(at)}`, at }
}

function quietPull(record: GithubRecord, config: WaitingConfig, now: Date): (ClassifiedReason & { signal: WaitingSignal }) | null {
  if (!blanketOpenPr(record, config) || !openPrNeedsGate(record)) return null
  const activity = openPrActivityAt(record)
  if (activity && waitingDays(activity, now) < config.openPrQuietDays) return null
  return {
    reason: WAITING_REASONS.openPr,
    at: activity,
    estimated: !activity,
    signal: quietOpenPrSignal(record, config.openPrQuietDays)
  }
}

export function classifyRecord(record: GithubRecord, config: WaitingConfig, now: Date): WaitingDraft | null {
  const comment = latestComment(record)
  const closed = commentClosesRecord(record, config)
  const passComment = /\bPASS\b/i.test(comment?.text ?? '')
  const assignmentOpen = !closed && !statusIsDoneOrClosed(latestStatusText(record.body), config)
  const text = closed ? null : strongText(record, config)
  const labelName = closed || !config.sources.humanIssues ? null : matchedLabel(record.labels, config.humanLabels)
  const label = labelName && (repoHumanAllowed(record) || record.repoAccess !== 'watch')
    ? labelExcerpt(record, labelName)
    : null
  const review = config.sources.reviewRequested && record.fromReview && record.kind === 'pr'
  const assigned = config.sources.assignee && record.fromAssignee
  const quiet = closed && !passComment ? null : quietPull(record, config, now)
  const watchedAuthor = !closed
    && record.fromAuthor
    && record.repoAccess === 'watch'
    && record.kind === 'pr'
    && text !== null
  const humanAllowed = config.sources.humanIssues && (repoHumanAllowed(record) || watchedAuthor)
  const prTextAllowed = record.kind === 'pr' && (
    blanketOpenPr(record, config)
    || record.fromAuthor
    || record.fromReview
    || record.repoAccess === 'maintain'
    || record.repoAccess === 'unknown'
  )
  const textReason = watchedAuthor
    ? WAITING_REASONS.human
    : record.kind === 'pr'
      ? WAITING_REASONS.openPr
      : WAITING_REASONS.human
  const showText = Boolean(text && (record.kind === 'issue' ? humanAllowed : prTextAllowed))
  const optedOpen = !closed && blanketOpenPr(record, config) && !openPrNeedsGate(record)

  const reasons: ClassifiedReason[] = []
  let tier: WaitingTier = 'weak'
  let signal: WaitingSignal | null = null
  const quickActions = !closed && config.sources.humanIssues ? pendingApoActions(record) : []
  const firstAction = quickActions[0]
  if (firstAction && (humanAllowed || prTextAllowed)) {
    reasons.push(fallbackUpdated(WAITING_REASONS.human, record, firstAction.requestAt))
    tier = 'strong'
    signal = { rule: 'APO 人工评论', excerpt: firstAction.requestText }
  }

  if (review) {
    reasons.push(fallbackUpdated(WAITING_REASONS.review, record, record.reviewRequestedAt))
    tier = 'strong'
    signal = { rule: WAITING_REASONS.review, excerpt: reviewExcerpt(record) }
  }
  if (assigned && assignmentOpen) {
    reasons.push(fallbackUpdated(WAITING_REASONS.assignee, record, record.assignedAt))
    tier = 'strong'
    signal = signal ?? { rule: WAITING_REASONS.assignee, excerpt: assignExcerpt(record) }
  } else if (assigned && (showText || label || review)) {
    reasons.push(fallbackUpdated(WAITING_REASONS.assignee, record, record.assignedAt))
    tier = 'strong'
  }
  if (showText && text && textReason) {
    reasons.push(fallbackUpdated(textReason, record, text.at))
    tier = 'strong'
    if (!review) signal = text.own ? { rule: text.rule, excerpt: text.excerpt, own: true } : { rule: text.rule, excerpt: text.excerpt }
    else signal = { rule: signal?.rule ?? text.rule, excerpt: `${signal?.excerpt ?? reviewExcerpt(record)}。${text.excerpt}` }
  }
  if (label && (humanAllowed || record.kind === 'pr')) {
    reasons.push(fallbackUpdated(record.kind === 'pr' ? WAITING_REASONS.openPr : WAITING_REASONS.human, record, label.at))
    tier = 'strong'
    signal = signal ?? { rule: '标签', excerpt: label.excerpt }
  }
  if (quiet && !reasons.some(reason => reason.reason === WAITING_REASONS.openPr)) {
    reasons.push(quiet)
    tier = 'strong'
    if (!signal || signal.rule === WAITING_REASONS.assignee) signal = quiet.signal
  }
  if (optedOpen && !reasons.some(reason => reason.reason === WAITING_REASONS.openPr)) {
    const at = laterIso(record.lastPushedAt, record.updatedAt)
    reasons.push(fallbackUpdated(WAITING_REASONS.openPr, record, at))
    tier = 'strong'
    signal = signal ?? {
      rule: WAITING_REASONS.openPr,
      excerpt: `关注仓库里的非草稿 PR，最近更新 ${whenLabel(at)}`
    }
  }
  if (tier !== 'strong' && config.sources.mentions && mentionQualifies(record, config, now)) {
    reasons.push(fallbackUpdated(WAITING_REASONS.mention, record, record.mentionedAt))
    signal = signal ?? { rule: '只是提及', excerpt: mentionSentence(record) }
  }
  if (assigned && (quiet || optedOpen) && !reasons.some(reason => reason.reason === WAITING_REASONS.assignee)) {
    reasons.unshift(fallbackUpdated(WAITING_REASONS.assignee, record, record.assignedAt))
  }
  if (reasons.length === 0) return null
  if (tier === 'strong' && review && text) {
    signal = { rule: WAITING_REASONS.review, excerpt: `${reviewExcerpt(record)}。${text.excerpt}` }
  }
  const draft = draftFromReasons({
    id: `${record.kind}:${record.repo}#${record.number}`,
    repo: record.repo,
    number: record.number,
    type: record.kind,
    title: record.title,
    url: record.url,
    updatedAt: record.updatedAt,
    parentNumber: record.parentNumber,
    reasons,
    signal: signal ?? undefined,
    tier,
    parked: repoIsParked(record.repoDescription ?? '', record.repoTopics ?? [], config.parkedMarkers)
  }, now)
  if (tier === 'strong') draft.quickActions = quickActions
  return draft
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
  signal?: WaitingSignal
  tier?: WaitingTier
  parked?: boolean
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
    childCount: 0,
    signal: ensureExcerpt(input.signal ?? { rule: reasons[0] ?? '等待', excerpt: '' }),
    tier: input.tier ?? 'strong',
    parked: input.parked === true
  }
}

function scored(reason: ClassifiedReason, now: Date): { days: number, estimated: boolean } {
  if (!reason.at) return { days: 0, estimated: true }
  return { days: waitingDays(reason.at, now), estimated: reason.estimated }
}

export function reasonDetails(draft: WaitingDraft): ReasonDetail[] {
  return draft.reasonDetails
}
