import { primaryAction } from './action.js'
import { earlierIso, laterIso, waitingDays } from './days.js'
import { actionableProse, explainHumanWait, isSpecIssue, waitingExcerpt, type WaitScan } from './human-text.js'
import { escapeRegex } from './parse-github.js'
import { compileUserRegexList } from './rules.js'
import { explainAction, evaluateSignals } from './signals.js'
import { WAITING_REASONS, type GithubRecord, type ReasonDetail, type WaitingConfig, type WaitingDraft, type WaitingSignal } from './types.js'

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

function literalWord(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (/^[A-Za-z0-9_ -]+$/.test(value)) return new RegExp(`\\b${escaped}\\b`, 'i')
  return new RegExp(escaped, 'i')
}

function waitScan(record: GithubRecord, config: WaitingConfig): WaitScan {
  const roles = compileUserRegexList(config.roleNames, '角色称呼')
  const login = record.viewerLogin ? [literalWord(record.viewerLogin)] : []
  return {
    roles,
    asks: compileUserRegexList(config.roleAskPhrases, '角色请求'),
    headers: config.statusHeaders,
    userWords: [...roles, ...login, literalWord('用户'), literalWord('user'), /你/u],
    otherActors: compileUserRegexList(config.otherActors, '非用户负责人'),
    selfSteps: compileUserRegexList(config.selfStepPhrases, '自己未完成的步骤'),
    specIssue: record.kind === 'issue' && isSpecIssue(record.title, record.labels, record.body, config.specMarkers)
  }
}

function latestCommentResolved(record: GithubRecord, keywords: readonly RegExp[], resolved: readonly RegExp[]): boolean {
  const latest = record.comments[record.comments.length - 1]
  if (!latest) return false
  return evaluateSignals(actionableProse(latest.body), keywords, resolved) === 'resolved'
}

/**
 * An ask in the title, body, or any comment, using the same action, negation,
 * and closing-comment judgment as other human waits.
 */
function openPrAsk(record: GithubRecord, config: WaitingConfig): { signal: WaitingSignal, at: string | null } | null {
  const keywords = compileUserRegexList(config.humanKeywords, '人工动作关键词')
  const resolved = compileUserRegexList(config.resolvedSignals, '已解决信号')
  if (latestCommentResolved(record, keywords, resolved)) return null
  const scan = waitScan(record, config)
  const title = explainAction(record.title, keywords, resolved)
  if (title) return { signal: { rule: title.rule, excerpt: title.excerpt }, at: record.createdAt || null }
  const body = explainHumanWait(record.body, currentHumanText(record), [], new Set(), keywords, resolved, scan)
  if (body) {
    const comment = currentComment(record)
    const at = body.source === 'current' && comment ? comment.createdAt : record.createdAt || null
    return { signal: { rule: body.rule, excerpt: body.excerpt }, at }
  }
  for (let index = record.comments.length - 1; index >= 0; index -= 1) {
    const comment = record.comments[index]
    if (!comment) continue
    const hit = explainAction(actionableProse(comment.body), keywords, resolved)
    if (hit) return { signal: { rule: hit.rule, excerpt: hit.excerpt }, at: comment.createdAt || null }
  }
  return null
}

function quietOpenPrSignal(days: number): WaitingSignal {
  const rule = `${days} 天无动静`
  return { rule, excerpt: rule }
}

function ensureExcerpt(signal: WaitingSignal): WaitingSignal {
  const excerpt = signal.excerpt.trim()
  if (excerpt) return { rule: signal.rule, excerpt }
  return { rule: signal.rule, excerpt: signal.rule || '等待' }
}

function isQuietRule(rule: string): boolean {
  return /^\d+ 天无动静$/u.test(rule)
}

function classifyBlanketOpenPr(
  record: GithubRecord,
  config: WaitingConfig,
  now: Date
): (ClassifiedReason & { signal: WaitingSignal }) | null {
  if (!blanketOpenPr(record, config)) return null
  if (!openPrNeedsGate(record)) {
    const at = laterIso(record.lastPushedAt, record.updatedAt)
    const ask = openPrAsk(record, config)
    const signal = ask
      ? { rule: WAITING_REASONS.openPr, excerpt: `${WAITING_REASONS.openPr} · ${ask.signal.excerpt}` }
      : { rule: WAITING_REASONS.openPr, excerpt: WAITING_REASONS.openPr }
    return { reason: WAITING_REASONS.openPr, at, estimated: !at, signal }
  }
  const ask = openPrAsk(record, config)
  if (ask) {
    return {
      reason: WAITING_REASONS.openPr,
      at: ask.at,
      estimated: !ask.at,
      signal: ask.signal
    }
  }
  const activity = openPrActivityAt(record)
  const quietDays = config.openPrQuietDays
  // Whole days: N days of silence counts. Anything newer is still in progress.
  if (activity && waitingDays(activity, now) < quietDays) return null
  return {
    reason: WAITING_REASONS.openPr,
    at: activity,
    estimated: !activity,
    signal: quietOpenPrSignal(quietDays)
  }
}

export function humanSignal(record: GithubRecord, config: WaitingConfig): (ClassifiedReason & { signal: WaitingSignal }) | null {
  if (record.kind !== 'issue') return null
  const keywords = compileUserRegexList(config.humanKeywords, '人工动作关键词')
  const resolved = compileUserRegexList(config.resolvedSignals, '已解决信号')
  const wanted = new Set(config.humanLabels.map(label => label.toLowerCase()))
  const hit = explainHumanWait(record.body, currentHumanText(record), record.labels, wanted, keywords, resolved, waitScan(record, config))
  if (!hit) return null
  const comment = currentComment(record)
  let at: string | null = null
  let estimated = false
  if (hit.source === 'current' && comment) {
    at = comment.createdAt
  } else if (hit.source !== 'label') {
    at = record.createdAt
  }
  if (hit.source === 'label' || hit.rule === '标签') {
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
  return {
    reason: WAITING_REASONS.human,
    at,
    estimated,
    signal: { rule: hit.rule, excerpt: hit.excerpt }
  }
}

function authorNeedsAction(record: GithubRecord, config: WaitingConfig): (ClassifiedReason & { signal: WaitingSignal }) | null {
  if (!record.fromAuthor || record.repoAccess !== 'watch') return null
  const keywords = compileUserRegexList(config.humanKeywords, '人工动作关键词')
  const resolved = compileUserRegexList(config.resolvedSignals, '已解决信号')
  const hit = explainHumanWait(record.body, currentHumanText(record), [], new Set(), keywords, resolved, waitScan(record, config))
  if (!hit || hit.rule === '标签') return null
  const comment = currentComment(record)
  const fromComment = hit.source === 'current' && comment
  return {
    reason: WAITING_REASONS.human,
    at: fromComment ? comment.createdAt : record.createdAt || record.updatedAt,
    estimated: !fromComment && !record.createdAt,
    signal: { rule: hit.rule, excerpt: hit.excerpt }
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
  let mentionSignal: WaitingSignal | null = null
  if (config.sources.mentions && mentionQualifies(record, config, now)) {
    reasons.push(fallbackUpdated(WAITING_REASONS.mention, record, record.mentionedAt))
    const keywords = compileUserRegexList(config.humanKeywords, '人工动作关键词')
    const resolved = compileUserRegexList(config.resolvedSignals, '已解决信号')
    const excerpt = waitingExcerpt(record.body, record.comments, keywords, resolved)
    const recentMention = withinRecent(record.mentionedAt, now, config.mentionRecentDays)
      || record.comments.some(comment => withinRecent(comment.createdAt, now, config.mentionRecentDays))
    const mentionRule = recentMention || config.mentionPolicy === 'any' ? '提及' : '过时提及旁仍有等待'
    mentionSignal = { rule: mentionRule, excerpt: excerpt || mentionRule }
  }
  let openPrSignal: WaitingSignal | null = null
  const openPr = classifyBlanketOpenPr(record, config, now)
  if (openPr) {
    reasons.push(openPr)
    openPrSignal = openPr.signal
  }
  if (config.sources.humanIssues && repoHumanAllowed(record)) {
    const human = humanSignal(record, config)
    if (human) reasons.push(human)
  }
  const authored = authorNeedsAction(record, config)
  if (authored && !reasons.some(reason => reason.reason === WAITING_REASONS.human)) reasons.push(authored)
  if (reasons.length === 0) return null
  const humanReason = reasons.find(reason => reason.reason === WAITING_REASONS.human) as (ClassifiedReason & { signal?: WaitingSignal }) | undefined
  const textSignal = humanReason?.signal
    ?? (openPrSignal && !isQuietRule(openPrSignal.rule) && openPrSignal.rule !== WAITING_REASONS.openPr ? openPrSignal : null)
  const reviewReason = reasons.some(reason => reason.reason === WAITING_REASONS.review)
  const assigneeReason = reasons.some(reason => reason.reason === WAITING_REASONS.assignee)
  let signal: WaitingSignal
  if (reviewReason && !humanReason?.signal) {
    signal = {
      rule: WAITING_REASONS.review,
      excerpt: textSignal ? `${WAITING_REASONS.review} · ${textSignal.excerpt}` : WAITING_REASONS.review
    }
  } else if (assigneeReason && !humanReason?.signal && !mentionSignal) {
    signal = {
      rule: WAITING_REASONS.assignee,
      excerpt: textSignal ? `${WAITING_REASONS.assignee} · ${textSignal.excerpt}` : WAITING_REASONS.assignee
    }
  } else {
    signal = humanReason?.signal ?? mentionSignal ?? openPrSignal ?? { rule: reasons[0]?.reason ?? '等待', excerpt: '' }
  }
  signal = ensureExcerpt(signal)
  return draftFromReasons({
    id: `${record.kind}:${record.repo}#${record.number}`,
    repo: record.repo,
    number: record.number,
    type: record.kind,
    title: record.title,
    url: record.url,
    updatedAt: record.updatedAt,
    parentNumber: record.parentNumber,
    reasons,
    signal
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
  signal?: WaitingSignal
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
    signal: ensureExcerpt(input.signal ?? { rule: reasons[0] ?? '等待', excerpt: '' })
  }
}

function scored(reason: ClassifiedReason, now: Date): { days: number, estimated: boolean } {
  if (!reason.at) return { days: 0, estimated: true }
  return { days: waitingDays(reason.at, now), estimated: reason.estimated }
}

export function reasonDetails(draft: WaitingDraft): ReasonDetail[] {
  return draft.reasonDetails
}
