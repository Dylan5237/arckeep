import { evaluateSignals, isNegatedSignal } from './signals.js'
import type { GithubRecord, WaitingConfig } from './types.js'

const FENCE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g
const EXCLUDED_CHINESE = ['需求', '功能说明', '功能描述', '功能设计', '验收标准', '用户故事', '背景', '设计', '规格', '路线图', '变更记录', '更新日志', '历史', '人员', '成员', '花名册', '分析报告', '误报分析', '复盘']
const EXCLUDED_ASCII = /^(?:spec|feature|prd|roadmap|changelog|history|roster|people)\b/i
const STATUS_HEADING = /^(?:状态|现状|进度|当前状态|一眼状态)$/u
const STATUS_ASCII = /^(?:current status|status)\b/i
const ROSTER_HEADER = /负责人|人员|成员|owner|assignee|roster|people|花名册/i
const CHECKLIST_HEADER = /步骤|清单|checklist|任务|task|step/i

export interface ScannedText {
  text: string
  at: string | null
}

export function stripFences(markdown: string): string {
  return markdown.replace(FENCE, '\n')
}

function excludedHeading(title: string): boolean {
  const cleaned = title.trim().replace(/[:：]\s*$/u, '')
  if (EXCLUDED_CHINESE.some(item => cleaned === item || cleaned.startsWith(`${item} `) || cleaned.startsWith(`${item}：`) || cleaned.startsWith(`${item}:`))) return true
  return EXCLUDED_ASCII.test(cleaned)
}

function statusHeading(title: string): boolean {
  const cleaned = title.trim().replace(/[:：]\s*$/u, '')
  return STATUS_HEADING.test(cleaned) || STATUS_ASCII.test(cleaned)
}

function bodyLine(line: string): string {
  if (/^\s*>/.test(line)) return ''
  return line.replace(/`[^`\n]*`/g, ' ')
}

function headingOf(line: string): { level: number, title: string } | null {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trim())
  if (!match?.[1] || !match[2]) return null
  return {
    level: match[1].length,
    title: match[2].trim().replace(/[:：]\s*$/u, '')
  }
}

function isTableLine(line: string): boolean {
  return /^\s*\|.+\|\s*$/.test(line)
}

function tableHeader(line: string): string {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
}

function isSeparatorRow(line: string): boolean {
  const cells = tableHeader(line).split('|').map(cell => cell.trim())
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell))
}

function parsedTable(block: readonly string[]): { cells: string[], nextAction: string[] } {
  const rows = block
    .filter(line => !isSeparatorRow(line))
    .map(line => tableHeader(line).split('|').map(cell => cell.trim()))
  if (rows.length < 2) return { cells: [], nextAction: [] }
  const header = rows[0] ?? []
  const nextIndexes = header
    .map((cell, index) => (/^下一步(?:行动)?$/u.test(cell) || /^next action$/i.test(cell) ? index : -1))
    .filter(index => index >= 0)
  const cells: string[] = []
  const nextAction: string[] = []
  for (const row of rows.slice(1)) {
    for (const index of nextIndexes) {
      const cell = row[index] ?? ''
      if (cell) nextAction.push(cell)
    }
    for (const cell of row) {
      if (cell) cells.push(cell)
    }
  }
  return { cells, nextAction }
}

/**
 * 请…裁决 / 请…确认, and the same shape: 请 or please, then a configured
 * request verb or action. Used for a 下一步 / Next Action cell.
 */
function shapedAskClause(clause: string, config: WaitingConfig): string | null {
  const opener = /请|\bplease\b/iu.exec(clause)
  if (!opener || opener.index === undefined || !opener[0]) return null
  const words = [...new Set([...config.requestVerbs, ...config.requestActions].map(word => word.trim()).filter(Boolean))]
    .filter(word => word !== '请' && word.toLowerCase() !== 'please')
  const after = clause.slice(opener.index + opener[0].length, opener.index + opener[0].length + 32)
  for (const word of words) {
    const pattern = /^[A-Za-z]+$/.test(word)
      ? new RegExp(`\\b${escapeLiteral(word)}\\b`, 'iu')
      : new RegExp(escapeLiteral(word), 'iu')
    const found = pattern.exec(after)
    if (!found || found.index === undefined || !found[0]) continue
    const end = opener.index + opener[0].length + found.index + found[0].length
    if (isNegatedSignal(clause, opener.index, end)) continue
    return clipSentence(clause)
  }
  return null
}

/**
 * A 下一步 / Next Action cell. 请…裁决 and 请…确认 count.
 * A later clause such as「PASS 暂不改变」does not cancel the earlier ask.
 */
function columnShapedAsk(cell: string, config: WaitingConfig): string | null {
  for (const clause of clausesOf(cell)) {
    if (isNegativeSentence(clause) || isCitationOnly(clause) || EXCERPT_DENIAL.test(clause)) continue
    const ask = shapedAskClause(clause, config)
    if (ask) return ask
  }
  return null
}

function skipTable(lines: readonly string[], index: number): { next: number, text: string, skipped: boolean } {
  const block: string[] = []
  let cursor = index
  while (cursor < lines.length && isTableLine(lines[cursor] ?? '')) {
    block.push(lines[cursor] ?? '')
    cursor += 1
  }
  const header = block.find(line => !isSeparatorRow(line)) ?? ''
  const skipped = ROSTER_HEADER.test(header) || CHECKLIST_HEADER.test(header)
  return { next: cursor, text: skipped ? '' : block.join('\n'), skipped }
}

function takeLines(lines: readonly string[], start: number, untilHeading: boolean): { text: string[], next: number } {
  const kept: string[] = []
  let index = start
  while (index < lines.length) {
    if (untilHeading && headingOf(lines[index] ?? '')) break
    if (isTableLine(lines[index] ?? '')) {
      const table = skipTable(lines, index)
      index = table.next
      if (table.text) kept.push(table.text)
      continue
    }
    const visible = bodyLine(lines[index] ?? '')
    if (visible.trim()) kept.push(visible)
    index += 1
  }
  return { text: kept, next: index }
}

/**
 * `leadingOnly` keeps the opening prose and the first 状态/现状 section.
 * Spec, roadmap, history, roster, and checklist tables stay out either way.
 */
export function readableBody(markdown: string, leadingOnly: boolean): string {
  const lines = stripFences(markdown).split(/\r?\n/)
  if (!leadingOnly) {
    const kept: string[] = []
    let skipLevel: number | null = null
    for (let index = 0; index < lines.length;) {
      const heading = headingOf(lines[index] ?? '')
      if (heading) {
        if (skipLevel !== null && heading.level <= skipLevel) skipLevel = null
        if (excludedHeading(heading.title)) skipLevel = heading.level
        index += 1
        continue
      }
      if (skipLevel !== null) {
        index += 1
        continue
      }
      const taken = takeLines(lines, index, true)
      kept.push(...taken.text)
      index = taken.next
    }
    return kept.join('\n').trim()
  }
  const kept: string[] = []
  let index = 0
  let sawStatus = false
  while (index < lines.length) {
    const heading = headingOf(lines[index] ?? '')
    if (!heading) {
      const taken = takeLines(lines, index, true)
      if (!sawStatus) kept.push(...taken.text)
      index = taken.next
      continue
    }
    if (statusHeading(heading.title) && !sawStatus) {
      sawStatus = true
      index += 1
      const taken = takeLines(lines, index, true)
      kept.push(...taken.text)
      index = taken.next
      break
    }
    if (!sawStatus && !excludedHeading(heading.title) && kept.length > 0) break
    const level = heading.level
    index += 1
    while (index < lines.length) {
      const next = headingOf(lines[index] ?? '')
      if (next && next.level <= level) break
      index += 1
    }
  }
  return kept.join('\n').trim()
}

interface StatusPiece {
  text: string
  nextAction: string[]
}

/** Every status subsection, from its heading through the next heading of the same level. */
function statusPieces(markdown: string): StatusPiece[] {
  const lines = stripFences(markdown).split(/\r?\n/)
  const sections: StatusPiece[] = []
  let index = 0
  while (index < lines.length) {
    const heading = headingOf(lines[index] ?? '')
    if (!heading || !statusHeading(heading.title)) {
      index += 1
      continue
    }
    const level = heading.level
    index += 1
    const kept: string[] = []
    const nextAction: string[] = []
    while (index < lines.length) {
      const next = headingOf(lines[index] ?? '')
      if (next && next.level <= level) break
      if (isTableLine(lines[index] ?? '')) {
        const block: string[] = []
        while (index < lines.length && isTableLine(lines[index] ?? '')) {
          block.push(lines[index] ?? '')
          index += 1
        }
        const parsed = parsedTable(block)
        kept.push(...parsed.cells)
        nextAction.push(...parsed.nextAction)
        continue
      }
      const visible = bodyLine(lines[index] ?? '')
      if (visible.trim()) kept.push(visible)
      index += 1
    }
    const text = kept.join('\n').trim()
    if (text) sections.push({ text, nextAction })
  }
  return sections
}

export function statusSectionTexts(markdown: string): string[] {
  return statusPieces(markdown).map(piece => piece.text)
}

export function statusNextActionCells(markdown: string): string[] {
  return statusPieces(markdown).flatMap(piece => piece.nextAction)
}

export function latestStatusText(markdown: string): string {
  const sections = statusSectionTexts(markdown)
  return sections[sections.length - 1] ?? ''
}

const CLOSED_STATUS = /(?:closed|done|已关闭)/giu

/** The latest status subsection says the work is done or closed. No subsection means it is still open. */
export function statusIsDoneOrClosed(text: string, config: WaitingConfig): boolean {
  if (!text.trim()) return false
  if (openRemainderAsk(text)) return false
  const resolved = config.resolvedSignals.map(pattern => safeRegex(pattern))
  if (evaluateSignals(text, [], resolved) === 'resolved') return true
  for (const match of text.matchAll(CLOSED_STATUS)) {
    const at = match.index ?? 0
    if (!isNegatedSignal(text, at, at + match[0].length)) return true
  }
  return false
}

export function latestComment(record: GithubRecord): (ScannedText & { own: boolean }) | null {
  const viewer = (record.viewerLogin ?? '').trim().toLowerCase()
  for (let index = record.comments.length - 1; index >= 0; index -= 1) {
    const comment = record.comments[index]
    if (!comment?.body.trim()) continue
    const author = (comment.authorLogin ?? '').trim().toLowerCase()
    return {
      text: stripFences(comment.body).trim(),
      at: comment.createdAt || null,
      own: Boolean(viewer && author && author === viewer)
    }
  }
  return null
}

function openRemainderAsk(text: string): boolean {
  return splitSentences(text).some(sentence => remainderRequest(sentence.text) !== null)
}

/** A next step aimed at someone else. It is not the user's request and does not close one. */
function otherPersonsNextStep(text: string): boolean {
  return OTHER_PERSON_STEP.test(text) && /\bsync\b/i.test(text)
}

export function commentCloses(text: string, config: WaitingConfig): boolean {
  if (!text.trim()) return false
  if (otherPersonsNextStep(text)) {
    const rest = text.replace(/compare on a machine/gi, ' ').replace(/\bsync\b/gi, ' ')
    if (!rest.trim()) return false
    return commentCloses(rest, config)
  }
  if (openRemainderAsk(text)) return false
  const keywords = config.humanKeywords.map(pattern => safeRegex(pattern))
  const resolved = config.resolvedSignals.map(pattern => safeRegex(pattern))
  return evaluateSignals(text, keywords, resolved) === 'resolved'
}

function passIsTheOnlyClose(text: string, config: WaitingConfig): boolean {
  if (!/\bPASS\b/i.test(text)) return false
  return !commentCloses(text.replace(/\bPASS\b/gi, ' '), config)
}

/** PASS closes a next-action cell only when that same clause names the cell's ask. */
function commentClosesNextAction(comment: string, cellExcerpt: string, config: WaitingConfig): boolean {
  if (!comment.trim() || !commentCloses(comment, config)) return false
  if (!passIsTheOnlyClose(comment, config)) return true
  return clausesOf(comment).some(clause => {
    if (!/\bPASS\b/i.test(clause)) return false
    if (/裁决/u.test(cellExcerpt) && /裁决/u.test(clause)) return true
    if (/确认/u.test(cellExcerpt) && /确认/u.test(clause)) return true
    return false
  })
}

function firstNextAction(record: GithubRecord, config: WaitingConfig): string | null {
  for (const cell of statusNextActionCells(record.body)) {
    const ask = columnShapedAsk(cell, config)
    if (ask) return ask
  }
  return null
}

/**
 * A closing comment drops the row. A PASS comment, or a next step for someone
 * else, does not drop an open 下一步 / Next Action cell.
 */
export function commentClosesRecord(record: GithubRecord, config: WaitingConfig): boolean {
  const comment = latestComment(record)
  if (!comment?.text || !commentCloses(comment.text, config)) return false
  const ask = firstNextAction(record, config)
  if (!ask) return true
  return commentClosesNextAction(comment.text, ask, config)
}

function safeRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return /$^/
  }
}

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function splitSentences(text: string): { text: string, index: number }[] {
  const found: { text: string, index: number }[] = []
  let start = 0
  const push = (end: number) => {
    const slice = text.slice(start, end)
    if (slice.trim()) found.push({ text: slice, index: start })
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ''
    const next = text[index + 1] ?? ''
    const boundary = /[。！？!?\n]/.test(char) || (char === '.' && (next === '' || /\s/.test(next)))
    if (!boundary) continue
    push(index + 1)
    start = index + 1
  }
  push(text.length)
  return found
}

function mentionsOtherPerson(sentence: string, viewer: string): boolean {
  const me = viewer.trim().toLowerCase()
  for (const match of sentence.matchAll(/@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)/g)) {
    const login = (match[1] ?? '').toLowerCase()
    if (!login) continue
    if (!me || login !== me) return true
  }
  return false
}

function patternHits(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => {
    pattern.lastIndex = 0
    return pattern.test(text)
  })
}

/** The sentence that names the viewer. Empty when the source has no such sentence. */
export function mentionSentence(record: GithubRecord): string {
  const login = (record.viewerLogin ?? '').trim()
  const needles = [login ? `@${login}` : '', login].filter(needle => needle.length > 0)
  const chunks: string[] = []
  for (let index = record.comments.length - 1; index >= 0; index -= 1) {
    const comment = record.comments[index]
    if (comment?.body) chunks.push(stripFences(comment.body))
  }
  if (record.body) chunks.push(stripFences(record.body))
  for (const chunk of chunks) {
    for (const sentence of splitSentences(chunk)) {
      const text = sentence.text.replace(/\s+/g, ' ').trim()
      if (!text || isCitationOnly(text) || isNegativeSentence(text)) continue
      const folded = text.toLowerCase()
      const named = needles.length > 0
        ? needles.some(needle => folded.includes(needle.toLowerCase()))
        : /@[A-Za-z0-9]/.test(text)
      if (named) return text.slice(0, 160)
    }
  }
  return ''
}

export function userPatterns(record: GithubRecord, config: WaitingConfig): RegExp[] {
  const compiled = config.roleNames.map(pattern => safeRegex(pattern))
  const login = (record.viewerLogin ?? '').trim()
  const named = login ? [new RegExp(`@?${escapeLiteral(login)}\\b`, 'i')] : []
  return [...compiled, ...named, /用户/u, /\buser\b/i, /你/u]
}

function verbAt(sentence: string, verbs: readonly string[]): { start: number, end: number }[] {
  const found: { start: number, end: number }[] = []
  for (const verb of verbs) {
    const token = verb.trim()
    if (!token) continue
    const pattern = /^[A-Za-z]+$/.test(token)
      ? new RegExp(`\\b${escapeLiteral(token)}\\b`, 'giu')
      : new RegExp(escapeLiteral(token), 'giu')
    for (const match of sentence.matchAll(pattern)) {
      const start = match.index ?? 0
      const end = start + match[0].length
      const next = sentence[end] ?? ''
      if (token === '等' && /[待于着]/.test(next)) continue
      found.push({ start, end })
    }
  }
  return found
}

function verbThen(sentence: string, verbs: readonly string[], later: readonly string[]): { start: number, end: number } | null {
  for (const verb of verbAt(sentence, verbs)) {
    const window = sentence.slice(verb.start, verb.end + 48)
    for (const action of later) {
      if (!action.trim()) continue
      const actionPattern = /^[A-Za-z]+$/.test(action.trim())
        ? new RegExp(`\\b${escapeLiteral(action.trim())}\\b`, 'iu')
        : new RegExp(escapeLiteral(action.trim()), 'iu')
      const found = actionPattern.exec(window.slice(verb.end - verb.start))
      if (!found) continue
      const end = verb.end + (found.index ?? 0) + found[0].length
      if (isNegatedSignal(sentence, verb.start, end)) continue
      return { start: verb.start, end }
    }
  }
  return null
}

export interface TextHit {
  rule: string
  excerpt: string
  at: string | null
  /** The hit is the signed-in user's own latest explicit request. */
  own?: boolean
}

function clipSentence(sentence: string): string {
  return sentence.replace(/\s+/g, ' ').trim().slice(0, 160)
}

/**
 * An explicit request: a configured verb plus an action in the same sentence.
 * In a comment this counts without naming the user, unless the sentence
 * @-mentions someone else. Elsewhere it must also name the user or a role,
 * or the verb itself must sit next to that name.
 */
export function explicitRequest(sentence: string, config: WaitingConfig, viewer: string, names: readonly RegExp[]): string | null {
  if (skipDenied(sentence)) return null
  if (mentionsOtherPerson(sentence, viewer)) return null
  if (verbThen(sentence, config.requestVerbs, config.requestActions)) return clipSentence(sentence)
  if (!patternHits(sentence, names)) return null
  for (const verb of verbAt(sentence, config.requestVerbs)) {
    if (isNegatedSignal(sentence, verb.start, verb.end)) continue
    const window = sentence.slice(Math.max(0, verb.start - 16), Math.min(sentence.length, verb.end + 16))
    if (patternHits(window, names)) return clipSentence(sentence)
  }
  return null
}

export function ackRequest(sentence: string, config: WaitingConfig, names: readonly RegExp[]): string | null {
  for (const token of config.ackTokens) {
    if (!token.trim()) continue
    const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}_])(${escapeLiteral(token.trim())})(?=$|[^\\p{L}\\p{N}_])`, 'gu')
    for (const match of sentence.matchAll(pattern)) {
      const tokenText = match[1] ?? token
      const start = (match.index ?? 0) + match[0].lastIndexOf(tokenText)
      const end = start + tokenText.length
      if (isNegatedSignal(sentence, start, end)) continue
      const hasVerb = config.requestVerbs.some(verb => verb.trim() && sentence.toLowerCase().includes(verb.trim().toLowerCase()))
      if (!hasVerb || !patternHits(sentence, names)) continue
      return clipSentence(sentence)
    }
  }
  return null
}

const REMAINDER_CUE = /只剩|仍须|下一步|\bNext\b/iu
const REMAINDER_ASK = /验收|截图|接受|\baccept\b|提供截图|provide a screenshot|run it and look|跑一下看看|运行一下看看/giu
const CHECKLIST_USER_ACTION = /提供截图|provide a screenshot|视觉验收|visual acceptance|run it on (?:your|their)(?: own)? machine|在(?:你|用户)(?:自己)?的?机器上跑/iu
const CITATION_PHRASE = /(?:支持|见|参见|详见|同|\bsee\b|\bcf\.?)\s*#\d+/iu
const CITATION_LEAD = /^(?:支持|见|同)\s*#\d+/u
const NEGATIVE_SENTENCE = /不构成|并不构成|不算|不能算|并不代表|does not count|do not count|does not constitute|doesn't constitute|not constitute/iu
const EXCERPT_DENIAL = /不能|不构成|不是|暂不/u
const USER_WAIT_TOKEN = /USER_ACTION_REQUIRED|WAITING_USER|USER_NEEDED_NEXT/iu
const DECISION_HEADING = /待拍板|待确认|待裁决/u
const OTHER_PERSON_STEP = /compare on a machine/i

function isCheckedTask(sentence: string): boolean {
  return /^\s*[-*+]\s+\[[xX]\]\s+/u.test(sentence)
}

function uncheckedTaskText(sentence: string): string | null {
  const match = /^\s*[-*+]\s+\[ \]\s+(.+)$/u.exec(sentence.trim())
  const text = match?.[1]?.trim() ?? ''
  return text || null
}

function stripQuotedSpans(sentence: string): string {
  return sentence
    .replace(/「[^」]*」/gu, ' ')
    .replace(/『[^』]*』/gu, ' ')
    .replace(/“[^”]*”/gu, ' ')
    .replace(/"[^"\n]*"/g, ' ')
}

function clausesOf(sentence: string): string[] {
  const parts = sentence.split(/[,，;；]/u).map(part => part.trim()).filter(Boolean)
  return parts.length > 0 ? parts : [sentence.trim()].filter(Boolean)
}

/**
 * The main clause is 支持 #N, 见 #N, or 同 #N.
 * Quoted text in that sentence is not a request, and the sentence is not an excerpt.
 * An unquoted request after the citation, such as「见 #7 之后请确认」, stays a request.
 */
function citationGoverns(sentence: string, config: WaitingConfig): boolean {
  const bare = stripQuotedSpans(sentence).replace(/\s+/g, ' ').trim()
  if (!CITATION_LEAD.test(bare)) return false
  const rest = bare.replace(CITATION_LEAD, '').replace(/^[\s:：,，、\-—;；]+/u, '')
  if (!rest) return true
  if (verbThen(rest, config.requestVerbs, config.requestActions)) return false
  return !(REMAINDER_CUE.test(rest) && new RegExp(REMAINDER_ASK.source, 'iu').test(rest))
}

/** A sentence whose only content is a cross-reference such as 支持 #N, 见 #N, or 同 #N. */
export function isCitationOnly(sentence: string): boolean {
  const text = stripQuotedSpans(sentence).replace(/\s+/g, ' ').trim()
  if (!CITATION_PHRASE.test(text)) return false
  const leftover = text
    .replace(/@[A-Za-z0-9-]+/g, '')
    .replace(/(?:支持|见|参见|详见|同|\bsee\b|\bcf\.?)\s*#\d+/giu, '')
    .replace(/https?:\/\/\S+/giu, '')
    .replace(/[\s。.#,，、:：;；!！?？()（）[\]【】"'“”]/gu, '')
  return leftover.length === 0
}

/** A sentence that says the thing does not count, does not constitute approval, or otherwise denies the request. */
export function isNegativeSentence(sentence: string): boolean {
  return NEGATIVE_SENTENCE.test(sentence)
}

function skipDenied(sentence: string): boolean {
  return isCheckedTask(sentence) || isCitationOnly(sentence) || isNegativeSentence(sentence)
}

function remainderAsk(fragment: string): boolean {
  const pattern = new RegExp(REMAINDER_ASK.source, 'giu')
  for (const match of fragment.matchAll(pattern)) {
    const start = match.index ?? 0
    if (!match[0] || isNegatedSignal(fragment, start, start + match[0].length)) continue
    return true
  }
  return false
}

/**
 * PASS negates only the clause that names that item.
 * After a comma or semicolon, 只剩 or 仍须 together with 验收 or 截图 stays a request.
 * A cue that sits before PASS in the same clause, such as「只剩截图 PASS」, does not.
 */
function remainderInFragment(fragment: string): string | null {
  const text = fragment.trim()
  if (!text || isNegativeSentence(text) || EXCERPT_DENIAL.test(text) || !REMAINDER_CUE.test(text) || !remainderAsk(text)) return null
  const pass = /\bPASS\b/iu.exec(text)
  if (pass && pass.index !== undefined && !isNegatedSignal(text, pass.index, pass.index + pass[0].length)) {
    const after = text.slice(pass.index + pass[0].length)
    const cue = REMAINDER_CUE.exec(after)
    if (!cue || cue.index === undefined || !remainderAsk(after.slice(cue.index))) return null
    return clipSentence(after.slice(cue.index))
  }
  const cue = REMAINDER_CUE.exec(text)
  if (!cue || cue.index === undefined) return null
  return clipSentence(text.slice(cue.index))
}

function remainderRequest(sentence: string): string | null {
  if (isCheckedTask(sentence) || isCitationOnly(sentence)) return null
  const whole = remainderInFragment(sentence)
  if (whole) return whole
  for (const clause of clausesOf(sentence)) {
    if (clause === sentence.trim()) continue
    const hit = remainderInFragment(clause)
    if (hit) return hit
  }
  return null
}

function uncheckedTaskRequest(sentence: string, config: WaitingConfig, viewer: string, names: readonly RegExp[]): string | null {
  const text = uncheckedTaskText(sentence)
  if (!text || isCitationOnly(text) || isNegativeSentence(text)) return null
  if (CHECKLIST_USER_ACTION.test(text)) return clipSentence(text)
  return explicitRequest(text, config, viewer, names)
}

function headerOnLine(line: string, header: string): { excerpt: string, target: string } | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const heading = /^(?:#{1,6}\s+)?(.+)$/.exec(trimmed)
  const content = (heading?.[1] ?? trimmed).replace(/^(?:[*_]{1,3})/, '').replace(/(?:[*_]{1,3})$/, '')
  const body = escapeLiteral(header.trim()).replace(/ /g, '\\s+')
  const match = new RegExp(`^(${body})(?=$|[^\\p{L}\\p{N}_])`, 'u').exec(content)
  if (!match?.[1]) return null
  const target = content.slice(match[1].length).replace(/^[\s*:：|—\-[\]]+/u, '').replace(/^(?:on|by|for)\s+/iu, '')
  const object = (target.split(/[。.!?\n,，;；]/u)[0] ?? '').replace(/[\s*:：|—\-[\]]+$/u, '').trim()
  return { excerpt: trimmed.replace(/\s+/g, ' ').slice(0, 160), target: object }
}

export function statusHeaderHit(text: string, config: WaitingConfig, names: readonly RegExp[]): string | null {
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    for (const header of config.statusHeaders) {
      const found = headerOnLine(line, header)
      if (!found) continue
      const tokenAt = found.excerpt.toLowerCase().indexOf(header.trim().toLowerCase())
      if (tokenAt >= 0 && isNegatedSignal(found.excerpt, tokenAt, tokenAt + header.trim().length)) continue
      const key = header.trim().toLowerCase().replace(/\s+/g, ' ')
      if (key === 'blocked') {
        if (found.target && !patternHits(found.target, names)) continue
      } else if (key === 'waiting on') {
        if (!found.target || !patternHits(found.target, names)) continue
      }
      return found.excerpt
    }
  }
  return null
}

function sentenceRequest(sentence: string, config: WaitingConfig, viewer: string, names: readonly RegExp[]): string | null {
  if (isCheckedTask(sentence) || isCitationOnly(sentence) || citationGoverns(sentence, config)) return null
  if (isNegativeSentence(sentence) && !clausesOf(sentence).some(clause => !isNegativeSentence(clause) && !EXCERPT_DENIAL.test(clause))) return null
  const matched = explicitRequest(sentence, config, viewer, names)
    ?? remainderRequest(sentence)
    ?? uncheckedTaskRequest(sentence, config, viewer, names)
  if (!matched) return null
  if (!EXCERPT_DENIAL.test(matched)) return matched
  for (const clause of clausesOf(sentence)) {
    if (EXCERPT_DENIAL.test(clause) || isNegativeSentence(clause)) continue
    const piece = explicitRequest(clause, config, viewer, names)
      ?? remainderRequest(clause)
      ?? uncheckedTaskRequest(clause, config, viewer, names)
    if (piece && !EXCERPT_DENIAL.test(piece)) return piece
  }
  return null
}

function scanPlace(text: string, at: string | null, config: WaitingConfig, viewer: string, names: readonly RegExp[]): TextHit | null {
  if (otherPersonsNextStep(text) && !commentCloses(text, config)) return null
  const waited = userWaitTokenHit(text)
  if (waited) return { rule: '明确请求', excerpt: waited, at }
  const header = statusHeaderHit(text, config, names)
  if (header && !isNegativeSentence(header) && !EXCERPT_DENIAL.test(header)) return { rule: '状态头', excerpt: header, at }
  for (const sentence of splitSentences(text)) {
    const ack = ackRequest(sentence.text, config, names)
    if (ack && !skipDenied(sentence.text)) return { rule: '需 ACK', excerpt: ack, at }
    const request = sentenceRequest(sentence.text, config, viewer, names)
    if (request) return { rule: '明确请求', excerpt: request, at }
  }
  return null
}

function ownRequest(text: string, at: string | null, config: WaitingConfig, viewer: string, names: readonly RegExp[]): TextHit | null {
  for (const sentence of splitSentences(text)) {
    const request = sentenceRequest(sentence.text, config, viewer, names)
    if (request) return { rule: '明确请求', excerpt: request, at, own: true }
  }
  return null
}

/**
 * USER_ACTION_REQUIRED, WAITING_USER, or USER_NEEDED_NEXT.
 * A parenthetical on the same line, such as "(no Phase PASS)" or "(not claimed)",
 * negates PASS only. A negation placed before the token still cancels the token.
 */
function userWaitTokenLine(line: string): string | null {
  const match = new RegExp(USER_WAIT_TOKEN.source, 'iu').exec(line)
  if (!match || match.index === undefined || !match[0]) return null
  const before = line.slice(Math.max(0, match.index - 24), match.index)
  if (/(?:\bno\b|\bnot\b|没有|不是|并未|并非|未|不)\s*$/iu.test(before)) return null
  if (EXCERPT_DENIAL.test(line) && EXCERPT_DENIAL.test(match[0])) return null
  return clipSentence(line)
}

/** A Next section immediately after a user-wait token, when the user must finish a step. */
function nextSectionAfterToken(text: string): string | null {
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    if (!userWaitTokenLine(lines[index] ?? '')) continue
    let cursor = index + 1
    while (cursor < lines.length && !(lines[cursor] ?? '').trim()) cursor += 1
    const heading = headingOf(lines[cursor] ?? '')
    if (!heading || !/^next$/i.test(heading.title)) continue
    const kept: string[] = []
    for (let inner = cursor + 1; inner < lines.length; inner += 1) {
      if (headingOf(lines[inner] ?? '')) break
      const visible = (lines[inner] ?? '').trim()
      if (visible) kept.push(visible)
    }
    const body = kept.join(' ')
    if (/user must finish/i.test(body)) return clipSentence(body)
  }
  return null
}

function userWaitTokenHit(text: string): string | null {
  const follow = nextSectionAfterToken(text)
  if (follow) return follow
  for (const line of text.split(/\r?\n/)) {
    const token = userWaitTokenLine(line)
    if (token) return token
  }
  return null
}

function titleReviewOnly(title: string, verbs: readonly { start: number, end: number }[]): boolean {
  return verbs.length > 0 && verbs.every(hit => title.slice(hit.start, hit.end).toLowerCase() === 'review')
}

/** The bare word review is not a request unless 请, 待, needs, or please is in the same title. */
function titleAllowsReview(title: string): boolean {
  return /请|待|\bneeds\b|\bplease\b/iu.test(title)
}

/** The title alone. A configured request verb is enough; the body does not have to repeat it. */
function titleRequest(title: string, config: WaitingConfig): TextHit | null {
  const text = title.replace(/\s+/g, ' ').trim()
  if (!text || isNegativeSentence(text)) return null
  const follow = nextSectionAfterToken(text)
  if (follow) return { rule: '明确请求', excerpt: follow, at: null }
  const token = userWaitTokenLine(text)
  if (token) return { rule: '明确请求', excerpt: token, at: null }
  const verbs = verbAt(text, config.requestVerbs)
  if (verbs.length === 0) return null
  if (titleReviewOnly(text, verbs) && !titleAllowsReview(text)) return null
  return { rule: '明确请求', excerpt: clipSentence(text), at: null }
}

/**
 * Newest comment first. A comment that closes the matter blocks older requests.
 * A placeholder or acknowledgement does not, so an earlier explicit request still counts.
 * Only the newest comment is marked as the signed-in user's own request.
 */
function commentThreadHit(record: GithubRecord, config: WaitingConfig, viewer: string, names: readonly RegExp[]): TextHit | null {
  const viewerLogin = viewer.trim().toLowerCase()
  let newest = true
  let scannedOther = false
  for (let index = record.comments.length - 1; index >= 0; index -= 1) {
    const comment = record.comments[index]
    if (!comment?.body.trim()) continue
    const text = stripFences(comment.body).trim()
    if (!text) continue
    if (commentCloses(text, config)) return null
    const author = (comment.authorLogin ?? '').trim().toLowerCase()
    const own = Boolean(viewerLogin && author && author === viewerLogin)
    const at = comment.createdAt || null
    if (newest) {
      newest = false
      const hit = own ? ownRequest(text, at, config, viewer, names) : scanPlace(text, at, config, viewer, names)
      if (hit) return hit
      if (!own) scannedOther = true
      continue
    }
    if (!own && !scannedOther) {
      scannedOther = true
      const hit = scanPlace(text, at, config, viewer, names)
      if (hit) return hit
      continue
    }
    const earlier = ownRequest(text, at, config, viewer, names)
    if (earlier) return { rule: earlier.rule, excerpt: earlier.excerpt, at }
  }
  return null
}

/** Unchecked user checklist items anywhere outside an excluded section, not only under 状态. */
function checklistHit(markdown: string, at: string | null, config: WaitingConfig, viewer: string, names: readonly RegExp[]): TextHit | null {
  const lines = stripFences(markdown).split(/\r?\n/)
  let skipLevel: number | null = null
  for (const line of lines) {
    const heading = headingOf(line)
    if (heading) {
      if (skipLevel !== null && heading.level <= skipLevel) skipLevel = null
      if (excludedHeading(heading.title)) skipLevel = heading.level
      continue
    }
    if (skipLevel !== null || /^\s*>/.test(line)) continue
    const request = uncheckedTaskRequest(line.replace(/`[^`\n]*`/g, ' '), config, viewer, names)
    if (request && !EXCERPT_DENIAL.test(request)) return { rule: '明确请求', excerpt: request, at }
  }
  return null
}

/** A heading line that itself contains 待拍板, 待确认, or 待裁决. Prose under it does not count. */
function decisionHeadingHit(markdown: string, at: string | null): TextHit | null {
  const lines = stripFences(markdown).split(/\r?\n/)
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue
    const heading = headingOf(line)
    if (!heading || !DECISION_HEADING.test(heading.title) || EXCERPT_DENIAL.test(heading.title)) continue
    return { rule: '明确请求', excerpt: clipSentence(heading.title), at }
  }
  return null
}

function titleThenNext(record: GithubRecord): TextHit | null {
  const title = record.title.replace(/\s+/g, ' ').trim()
  if (!userWaitTokenLine(title)) return null
  const follow = nextSectionAfterToken(`${title}\n${stripFences(record.body)}`)
  if (!follow) return null
  return { rule: '明确请求', excerpt: follow, at: record.createdAt || null }
}

export function strongText(record: GithubRecord, config: WaitingConfig): TextHit | null {
  const names = userPatterns(record, config)
  const viewer = record.viewerLogin ?? ''
  if (commentClosesRecord(record, config)) return null
  const fromComments = commentThreadHit(record, config, viewer, names)
  if (fromComments) return fromComments
  for (const cell of statusNextActionCells(record.body)) {
    const ask = columnShapedAsk(cell, config)
    if (ask) return { rule: '明确请求', excerpt: ask, at: record.createdAt || null }
  }
  const heading = decisionHeadingHit(record.body, record.createdAt || null)
  if (heading) return heading
  const tasks = checklistHit(record.body, record.createdAt || null, config, viewer, names)
  if (tasks) return tasks
  const followBody = nextSectionAfterToken(stripFences(record.body))
  if (followBody) return { rule: '明确请求', excerpt: followBody, at: record.createdAt || null }
  const titledNext = titleThenNext(record)
  if (titledNext) return titledNext
  for (const section of statusSectionTexts(record.body)) {
    const hit = scanPlace(section, record.createdAt || null, config, viewer, names)
    if (hit) return hit
  }
  const leading = readableBody(record.body, true)
  if (leading) {
    const hit = scanPlace(leading, record.createdAt || null, config, viewer, names)
    if (hit) return hit
  }
  if (record.kind === 'pr') {
    const body = readableBody(record.body, false)
    if (body) {
      const hit = scanPlace(body, record.createdAt || null, config, viewer, names)
      if (hit) return hit
    }
  }
  const fromTitle = titleRequest(record.title, config)
  if (fromTitle) return { ...fromTitle, at: record.createdAt || null }
  return null
}

export function weakKeyword(record: GithubRecord, config: WaitingConfig): string | null {
  const patterns = config.humanKeywords.map(pattern => safeRegex(pattern))
  const chunks = [
    readableBody(record.body, false),
    ...record.comments.map(comment => stripFences(comment.body))
  ]
  for (const chunk of chunks) {
    if (!chunk.trim()) continue
    if (evaluateSignals(chunk, patterns, []) !== 'action') continue
    const match = chunk.match(patterns.find(pattern => {
      pattern.lastIndex = 0
      return pattern.test(chunk)
    }) ?? /$^/)
    const excerpt = (match?.[0] ? chunk.slice(Math.max(0, (match.index ?? 0) - 24), (match.index ?? 0) + match[0].length + 36) : chunk)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160)
    if (excerpt) return excerpt
  }
  return null
}

export function labelMatches(name: string, patterns: readonly string[]): boolean {
  const label = name.trim().toLowerCase()
  return patterns.some(pattern => {
    const raw = pattern.trim().toLowerCase()
    if (!raw) return false
    const token = raw.endsWith('*') ? raw.slice(0, -1) : raw
    return token.length > 0 && label.includes(token)
  })
}

export function matchedLabel(names: readonly string[], patterns: readonly string[]): string | null {
  return names.find(name => labelMatches(name, patterns)) ?? null
}

export function repoIsParked(description: string, topics: readonly string[], markers: readonly string[]): boolean {
  const sources = [description, ...topics]
  return markers.some(marker => {
    const token = marker.trim()
    if (!token) return false
    if (/^[A-Za-z0-9_-]+$/.test(token)) {
      const pattern = new RegExp(`(?:^|[^A-Za-z0-9_-])${escapeLiteral(token)}(?:$|[^A-Za-z0-9_-])`, 'i')
      return sources.some(source => pattern.test(source))
    }
    const folded = token.toLowerCase()
    return sources.some(source => source.toLowerCase().includes(folded))
  })
}

export function whenLabel(iso: string | null): string {
  if (!iso) return '时间未知'
  const day = iso.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : '时间未知'
}
