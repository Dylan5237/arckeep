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

/** Every status subsection, from its heading through the next heading of the same level. */
export function statusSectionTexts(markdown: string): string[] {
  const lines = stripFences(markdown).split(/\r?\n/)
  const sections: string[] = []
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
    while (index < lines.length) {
      const next = headingOf(lines[index] ?? '')
      if (next && next.level <= level) break
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
    const text = kept.join('\n').trim()
    if (text) sections.push(text)
  }
  return sections
}

export function latestStatusText(markdown: string): string {
  const sections = statusSectionTexts(markdown)
  return sections[sections.length - 1] ?? ''
}

const CLOSED_STATUS = /(?:closed|done|已关闭)/giu

/** The latest status subsection says the work is done or closed. No subsection means it is still open. */
export function statusIsDoneOrClosed(text: string, config: WaitingConfig): boolean {
  if (!text.trim()) return false
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

export function latestOtherComment(record: GithubRecord): ScannedText | null {
  const viewer = (record.viewerLogin ?? '').trim().toLowerCase()
  for (let index = record.comments.length - 1; index >= 0; index -= 1) {
    const comment = record.comments[index]
    if (!comment) continue
    const author = (comment.authorLogin ?? '').trim().toLowerCase()
    if (viewer && author && author === viewer) continue
    return { text: stripFences(comment.body).trim(), at: comment.createdAt || null }
  }
  return null
}

export function commentCloses(text: string, config: WaitingConfig): boolean {
  if (!text.trim()) return false
  const keywords = config.humanKeywords.map(pattern => safeRegex(pattern))
  const resolved = config.resolvedSignals.map(pattern => safeRegex(pattern))
  return evaluateSignals(text, keywords, resolved) === 'resolved'
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
      if (!text) continue
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

function scanPlace(text: string, at: string | null, config: WaitingConfig, viewer: string, names: readonly RegExp[]): TextHit | null {
  const header = statusHeaderHit(text, config, names)
  if (header) return { rule: '状态头', excerpt: header, at }
  for (const sentence of splitSentences(text)) {
    const ack = ackRequest(sentence.text, config, names)
    if (ack) return { rule: '需 ACK', excerpt: ack, at }
    const request = explicitRequest(sentence.text, config, viewer, names)
    if (request) return { rule: '明确请求', excerpt: request, at }
  }
  return null
}

function ownRequest(text: string, at: string | null, config: WaitingConfig, viewer: string, names: readonly RegExp[]): TextHit | null {
  for (const sentence of splitSentences(text)) {
    const request = explicitRequest(sentence.text, config, viewer, names)
    if (request) return { rule: '明确请求', excerpt: request, at, own: true }
  }
  return null
}

export function strongText(record: GithubRecord, config: WaitingConfig): TextHit | null {
  const names = userPatterns(record, config)
  const viewer = record.viewerLogin ?? ''
  const latest = latestComment(record)
  const latestClosed = Boolean(latest?.text && commentCloses(latest.text, config))
  if (latest?.text && !latestClosed) {
    if (latest.own) {
      const own = ownRequest(latest.text, latest.at, config, viewer, names)
      if (own) return own
    } else {
      const hit = scanPlace(latest.text, latest.at, config, viewer, names)
      if (hit) return hit
    }
    if (latest.own) {
      const earlier = latestOtherComment(record)
      if (earlier?.text) {
        const hit = scanPlace(earlier.text, earlier.at, config, viewer, names)
        if (hit) return hit
      }
    }
  }
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
