import { explainAction, explainRoleAsk, explainStatusHeaders, evaluateSignals } from './signals.js'

const SPEC_HEADING = /^(需求|验收标准|背景|设计|规格)/u
const ANALYSIS_HEADING = /^(分析报告|误报分析|复盘|纯分析)/u
const DONE_CELL = /^(?:已完成|已验收|完成|done|closed|pass|通过|✅|✔|\[x\])$/iu

export interface HumanExplanation {
  rule: string
  excerpt: string
  /** Where the matched text lives, so the waiting clock can use that time. */
  source: 'body' | 'current' | 'label'
}

export interface WaitScan {
  roles: readonly RegExp[]
  asks: readonly RegExp[]
  headers: readonly string[]
  userWords: readonly RegExp[]
  otherActors: readonly RegExp[]
  selfSteps: readonly RegExp[]
  specIssue: boolean
}

function stripInline(line: string): string {
  return line
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/「[^」]*」/g, ' ')
    .replace(/『[^』]*』/g, ' ')
    .replace(/“[^”]*”/g, ' ')
    .replace(/"[^"\n]*"/g, ' ')
}

function isSkippedHeading(title: string): boolean {
  const cleaned = title.trim().replace(/[:：]\s*$/u, '')
  return SPEC_HEADING.test(cleaned) || ANALYSIS_HEADING.test(cleaned)
}

/** Drop code, quotes, and spec/analysis sections. Keyword hits there are not a request. */
export function actionableProse(markdown: string): string {
  const withoutFence = markdown.replace(/```[\s\S]*?```/g, '\n').replace(/~~~[\s\S]*?~~~/g, '\n')
  const lines = withoutFence.split(/\r?\n/)
  const kept: string[] = []
  let skipping: number | null = null
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading?.[1] && heading[2]) {
      const level = heading[1].length
      if (skipping !== null && level <= skipping) skipping = null
      if (isSkippedHeading(heading[2])) {
        skipping = level
        continue
      }
    }
    if (skipping !== null) continue
    if (/^\s*>/.test(line)) continue
    kept.push(stripInline(line))
  }
  return kept.join('\n')
}

function cellsOf(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
}

function isSeparator(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell))
}

function rowDone(cells: readonly string[]): boolean {
  return cells.some(cell => DONE_CELL.test(cell) || /\[[xX]\]/.test(cell))
}

function resetPattern(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0
  return pattern.test(text)
}

function ownerKind(owner: string, scan: WaitScan): 'user' | 'other' | 'empty' {
  const text = owner.trim()
  if (!text || text === '-' || text === '—' || text === '无') return 'empty'
  if (scan.userWords.some(pattern => resetPattern(pattern, text))) return 'user'
  return 'other'
}

function selfOwed(text: string, scan: WaitScan): boolean {
  return scan.selfSteps.some(pattern => resetPattern(pattern, text))
}

function explicitAsk(
  text: string,
  keywords: readonly RegExp[],
  resolved: readonly RegExp[],
  scan: WaitScan | null
): boolean {
  if (explainAction(text, keywords, resolved)) return true
  return Boolean(scan && explainAction(text, scan.asks, resolved))
}

function leadingOwner(text: string, scan: WaitScan): 'user' | 'other' | 'empty' {
  const match = /^(?:负责人\s*[:：]\s*)?@?([^\s:：,，]{1,40})\s*[:：]/.exec(text.trim())
  const token = match?.[1] ?? ''
  if (!token) return 'empty'
  if (scan.otherActors.some(pattern => resetPattern(pattern, token))) return 'other'
  if (scan.userWords.some(pattern => resetPattern(pattern, token))) return 'user'
  if (scan.otherActors.length === 0) return 'empty'
  return 'other'
}

function stepCounts(
  text: string,
  owner: 'user' | 'other' | 'empty',
  scan: WaitScan,
  keywords: readonly RegExp[],
  resolved: readonly RegExp[]
): boolean {
  if (!text || selfOwed(text, scan)) return false
  if (owner === 'other') return false
  if (owner === 'user') return true
  return explicitAsk(text, keywords, resolved, scan)
}

function pushTable(
  rows: string[][],
  into: string[],
  scan: WaitScan | null,
  keywords: readonly RegExp[],
  resolved: readonly RegExp[]
): void {
  if (rows.length === 0) return
  const separator = rows.findIndex(isSeparator)
  const header = separator > 0 ? rows[0] ?? [] : []
  const ownerIndex = scan
    ? header.findIndex(cell => /负责人|owner|assignee|指派给/i.test(cell))
    : -1
  const body = separator >= 0 ? rows.slice(separator + 1) : rows.slice(1)
  const data = body.length > 0 ? body : rows.filter(row => !isSeparator(row))
  for (const row of data) {
    if (isSeparator(row) || rowDone(row)) continue
    const text = row.filter(Boolean).join(' ')
    if (!text) continue
    if (!scan) {
      into.push(text)
      continue
    }
    const owner = ownerIndex >= 0 ? ownerKind(row[ownerIndex] ?? '', scan) : 'empty'
    if (stepCounts(text, owner, scan, keywords, resolved)) into.push(text)
  }
}

function statusLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  if (/状态\s*[:：]/u.test(trimmed)) {
    if (/(?:已完成|已验收|完成|\[x\]|✅)/u.test(trimmed) && !/(?:未|不|no)\s*(?:完成|验收|PASS)/iu.test(trimmed)) {
      return null
    }
    return trimmed
  }
  if (/^(?:待用户|等用户|待你验收|需要用户动手)/u.test(trimmed) && !rowDone([trimmed])) return trimmed
  return null
}

/**
 * Unchecked task items, unfinished table rows, and short status lines.
 * Checked or completed rows are not waiting.
 */
export function openStatusFragments(
  prose: string,
  scan: WaitScan | null = null,
  keywords: readonly RegExp[] = [],
  resolved: readonly RegExp[] = []
): string[] {
  const fragments: string[] = []
  let table: string[][] | null = null
  const flush = () => {
    if (!table) return
    pushTable(table, fragments, scan, keywords, resolved)
    table = null
  }
  for (const line of prose.split(/\r?\n/)) {
    if (/^\s*\|.+\|\s*$/.test(line)) {
      table = table ?? []
      table.push(cellsOf(line))
      continue
    }
    flush()
    const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line)
    if (task) {
      if ((task[1] ?? '').toLowerCase() !== 'x') {
        const text = (task[2] ?? '').trim()
        if (!text) continue
        if (!scan || stepCounts(text, leadingOwner(text, scan), scan, keywords, resolved)) fragments.push(text)
      }
      continue
    }
    const status = statusLine(line)
    if (status) fragments.push(status)
  }
  flush()
  return fragments
}

const SPEC_SECTION = /^(需求|功能说明|功能描述|功能设计|验收标准|用户故事|spec|feature|prd)\b/iu
const STATUS_SECTION = /^(状态|现状|进度|当前状态)/u

function specToken(text: string, marker: string): boolean {
  const trimmed = marker.trim()
  if (!trimmed) return false
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (/^[A-Za-z0-9][A-Za-z0-9 _-]*$/i.test(trimmed)) {
    return new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:$|[^A-Za-z0-9])`, 'i').test(text)
  }
  return new RegExp(`(?:^|[\\[【(（\\s])${escaped}(?:$|[\\]】)）\\s:：\\-—/])`, 'u').test(text.trim())
}

function bodyIsMostlySpec(markdown: string): boolean {
  const lines = markdown.replace(/```[\s\S]*?```/g, '\n').replace(/~~~[\s\S]*?~~~/g, '\n').split(/\r?\n/)
  let spec = 0
  let other = 0
  let mode: 'spec' | 'other' = 'other'
  let level = 0
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading?.[1] && heading[2]) {
      const depth = heading[1].length
      const title = heading[2].trim().replace(/[:：]\s*$/u, '')
      if (mode === 'spec' && depth <= level) mode = 'other'
      if (SPEC_SECTION.test(title)) {
        mode = 'spec'
        level = depth
      }
      continue
    }
    if (!line.trim() || /^\s*>/.test(line)) continue
    if (mode === 'spec') spec += 1
    else other += 1
  }
  if (spec === 0) return false
  return other === 0 || spec / (spec + other) >= 0.7
}

/** A requirement or feature issue, by title, label, or a body that is mostly spec. */
export function isSpecIssue(title: string, labels: readonly string[], body: string, markers: readonly string[]): boolean {
  const labeled = [title, ...labels]
  if (labeled.some(text => markers.some(marker => specToken(text, marker)))) return true
  return bodyIsMostlySpec(body)
}

/** Status lines and「状态 / 现状 / 进度」sections. Spec sections stay out. */
export function statusAreaText(markdown: string): string {
  const withoutFence = markdown.replace(/```[\s\S]*?```/g, '\n').replace(/~~~[\s\S]*?~~~/g, '\n')
  const kept: string[] = []
  let skipping: number | null = null
  let status: number | null = null
  for (const line of withoutFence.split(/\r?\n/)) {
    if (/^\s*>/.test(line)) continue
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading?.[1] && heading[2]) {
      const depth = heading[1].length
      const title = heading[2].trim().replace(/[:：]\s*$/u, '')
      if (skipping !== null && depth <= skipping) skipping = null
      if (status !== null && depth <= status) status = null
      if (isSkippedHeading(title)) {
        skipping = depth
        continue
      }
      if (STATUS_SECTION.test(title)) status = depth
      continue
    }
    if (skipping !== null) continue
    const visible = stripInline(line)
    if (status !== null) {
      kept.push(visible)
      continue
    }
    if (statusLine(visible)) kept.push(visible)
  }
  return kept.join('\n')
}

function firstExplanation(
  text: string,
  keywords: readonly RegExp[],
  resolved: readonly RegExp[],
  source: HumanExplanation['source'],
  rule?: string
): HumanExplanation | null {
  const explained = explainAction(text, keywords, resolved)
  if (!explained) return null
  return { rule: rule ?? explained.rule, excerpt: explained.excerpt, source }
}

/**
 * A request aimed at the current user, read from the live text.
 * A resolving latest comment closes the item. Otherwise an unfinished status
 * row in the body still counts, even when a later comment never repeats it.
 */
function fragmentHit(
  fragment: string,
  keywords: readonly RegExp[],
  resolved: readonly RegExp[],
  source: HumanExplanation['source'],
  scan: WaitScan | null
): HumanExplanation | null {
  if (scan) {
    const header = explainStatusHeaders(fragment, scan.headers, scan.userWords)
    if (header) return { rule: header.rule, excerpt: header.excerpt, source }
  }
  const explained = firstExplanation(fragment, keywords, resolved, source, '正文未完成的状态')
  if (explained) return explained
  if (scan && scan.userWords.some(pattern => {
    pattern.lastIndex = 0
    return pattern.test(fragment)
  })) {
    return { rule: '负责人指向用户', excerpt: fragment.replace(/\s+/g, ' ').trim().slice(0, 160), source }
  }
  return null
}

export function explainHumanWait(
  body: string,
  current: string,
  labelNames: readonly string[],
  wantedLabels: ReadonlySet<string>,
  keywords: readonly RegExp[],
  resolved: readonly RegExp[],
  scan: WaitScan | null = null
): HumanExplanation | null {
  const bodyProse = actionableProse(body)
  for (const fragment of openStatusFragments(bodyProse, scan, keywords, resolved)) {
    const hit = fragmentHit(fragment, keywords, resolved, 'body', scan)
    if (hit) return hit
  }
  const currentProse = actionableProse(current)
  if (evaluateSignals(currentProse, keywords, resolved) === 'resolved') return null
  if (scan) {
    const headerText = current === body
      ? statusAreaText(body)
      : `${currentProse}\n${statusAreaText(body)}`
    const header = explainStatusHeaders(headerText, scan.headers, scan.userWords)
    if (header) return { rule: header.rule, excerpt: header.excerpt, source: current === body ? 'body' : 'current' }
  }
  if (current !== body) {
    for (const fragment of openStatusFragments(currentProse, scan, keywords, resolved)) {
      const hit = fragmentHit(fragment, keywords, resolved, 'current', scan)
      if (hit) return hit
    }
  }
  const specBody = scan?.specIssue === true && current === body
  if (scan) {
    const roleText = current !== body
      ? currentProse
      : specBody
        ? statusAreaText(body)
        : currentProse
    if (roleText) {
      const role = explainRoleAsk(roleText, scan.roles, scan.asks, keywords, resolved)
      if (role) return { rule: role.rule, excerpt: role.excerpt, source: current === body ? 'body' : 'current' }
    }
  }
  if (!specBody) {
    const proseHit = firstExplanation(currentProse, keywords, resolved, current === body ? 'body' : 'current')
    if (proseHit) return proseHit
  }
  const label = labelNames.find(name => wantedLabels.has(name.toLowerCase()))
  if (label) return { rule: '标签', excerpt: label, source: 'label' }
  return null
}

/** Waiting text anywhere in the body or comments, after spec/code/quote stripping. */
export function waitingExcerpt(
  body: string,
  comments: readonly { body: string }[],
  keywords: readonly RegExp[],
  resolved: readonly RegExp[]
): string | null {
  const bodyProse = actionableProse(body)
  for (const fragment of openStatusFragments(bodyProse)) {
    const explained = explainAction(fragment, keywords, resolved)
    if (explained) return explained.excerpt
  }
  const current = comments.length > 0 ? (comments[comments.length - 1]?.body ?? body) : body
  if (evaluateSignals(actionableProse(current), keywords, resolved) === 'resolved') return null
  for (const chunk of [body, ...comments.map(comment => comment.body)]) {
    const prose = actionableProse(chunk)
    const explained = explainAction(prose, keywords, resolved)
    if (explained) return explained.excerpt
  }
  return null
}
