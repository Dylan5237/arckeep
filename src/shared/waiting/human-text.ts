import { explainAction, evaluateSignals } from './signals.js'

const SPEC_HEADING = /^(需求|验收标准|背景|设计|规格)/u
const ANALYSIS_HEADING = /^(分析报告|误报分析|复盘|纯分析)/u
const DONE_CELL = /^(?:已完成|已验收|完成|done|closed|pass|通过|✅|✔|\[x\])$/iu

export interface HumanExplanation {
  rule: string
  excerpt: string
  /** Where the matched text lives, so the waiting clock can use that time. */
  source: 'body' | 'current' | 'label'
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

function pushTable(rows: string[][], into: string[]): void {
  if (rows.length === 0) return
  const separator = rows.findIndex(isSeparator)
  const body = separator >= 0 ? rows.slice(separator + 1) : rows.slice(1)
  const data = body.length > 0 ? body : rows.filter(row => !isSeparator(row))
  for (const row of data) {
    if (isSeparator(row) || rowDone(row)) continue
    const text = row.filter(Boolean).join(' ')
    if (text) into.push(text)
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
export function openStatusFragments(prose: string): string[] {
  const fragments: string[] = []
  let table: string[][] | null = null
  const flush = () => {
    if (!table) return
    pushTable(table, fragments)
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
        if (text) fragments.push(text)
      }
      continue
    }
    const status = statusLine(line)
    if (status) fragments.push(status)
  }
  flush()
  return fragments
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
export function explainHumanWait(
  body: string,
  current: string,
  labelNames: readonly string[],
  wantedLabels: ReadonlySet<string>,
  keywords: readonly RegExp[],
  resolved: readonly RegExp[]
): HumanExplanation | null {
  const bodyProse = actionableProse(body)
  for (const fragment of openStatusFragments(bodyProse)) {
    const hit = firstExplanation(fragment, keywords, resolved, 'body', '正文未完成的状态')
    if (hit) return hit
  }
  const currentProse = actionableProse(current)
  if (evaluateSignals(currentProse, keywords, resolved) === 'resolved') return null
  if (current !== body) {
    for (const fragment of openStatusFragments(currentProse)) {
      const hit = firstExplanation(fragment, keywords, resolved, 'current', '正文未完成的状态')
      if (hit) return hit
    }
  }
  const proseHit = firstExplanation(currentProse, keywords, resolved, current === body ? 'body' : 'current')
  if (proseHit) return proseHit
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
