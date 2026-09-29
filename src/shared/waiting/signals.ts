export type SignalVerdict = 'action' | 'resolved' | 'none'

interface Hit {
  index: number
  end: number
}

const WORD_NEGATION = /(?:\bno\b|\bnot\b|\bwithout\b|\bnever\b|n't|没有|不是|并未|并非)/i
const SHORT_NEGATION = /(?:未|无|非|不)\s*$/u
const INEQUALITY = /(?:不等于|并非等于|不是等于|≠|!==|!=)/gu
const INEQUALITY_TAIL = /(?:不等于|并非等于|不是等于|≠|!==|!=)\s*$/u
const DESCRIPTIVE = /(?:文案|例如|比如|称为|叫做|显示|写成|字样|示例|描述|界面|流程|功能是|功能会|功能里|功能上)/u
const OWNER_REQUEST = /请\s*主人|请拒收|请接收|请确认|请拍板|明示接受或拒收|需要用户|待你验收|待用户|等用户|需要你|等你|待验收|拒收|接收/u

function flagsWithGlobal(pattern: RegExp): string {
  return pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
}

function collectHits(text: string, patterns: readonly RegExp[]): Hit[] {
  const found: Hit[] = []
  for (const pattern of patterns) {
    const global = new RegExp(pattern.source, flagsWithGlobal(pattern))
    for (const match of text.matchAll(global)) {
      const index = match.index ?? 0
      if (!match[0]) continue
      found.push({ index, end: index + match[0].length })
    }
  }
  found.sort((left, right) => left.index - right.index || left.end - right.end)
  return found
}

function sentencePrefix(text: string, index: number): string {
  const paraBreak = text.lastIndexOf('\n\n', Math.max(0, index - 1))
  const paraStart = paraBreak === -1 ? 0 : paraBreak + 2
  const scope = text.slice(paraStart, index)
  let last = -1
  for (const match of scope.matchAll(/[。！？.!?]/g)) {
    if (match.index !== undefined) last = match.index
  }
  return last >= 0 ? scope.slice(last + 1) : scope
}

const ATTACHED_NEGATION = /^[\s:：\-—*]*?(?:not\b|no\b|without\b|never\b|n't|没有|不是|并未|并非|未|不|非|无)/iu

function sentenceEnd(text: string, index: number): number {
  const rest = text.slice(index)
  const match = /[。！？!?\n]|\.(?=\s|$)/.exec(rest)
  if (!match || match.index === undefined) return text.length
  return index + match.index
}

/**
 * Negation is judged inside the keyword's own sentence, both before it and in
 * the words attached after it. A later sentence cannot cancel this keyword,
 * and this keyword's negation cannot reach back into an earlier sentence.
 * 「不等于 / ≠」only cancels the token it is attached to.
 */
export function isNegatedSignal(text: string, index: number, end = index): boolean {
  const prefix = sentencePrefix(text, index)
  if (INEQUALITY_TAIL.test(prefix)) return true
  const stripped = prefix.replace(INEQUALITY, ' ')
  if (WORD_NEGATION.test(stripped)) return true
  if (SHORT_NEGATION.test(stripped)) return true
  if (/(?:未|不)[^\n。！？.!?]{0,8}$/u.test(stripped)) return true
  const after = text.slice(end, sentenceEnd(text, end)).replace(INEQUALITY, ' ')
  return ATTACHED_NEGATION.test(after)
}

function descriptiveMention(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 20), index)
  return DESCRIPTIVE.test(before)
}

function paragraphAt(text: string, index: number): string {
  const startBreak = text.lastIndexOf('\n\n', Math.max(0, index - 1))
  const start = startBreak === -1 ? 0 : startBreak + 2
  const endBreak = text.indexOf('\n\n', index)
  const end = endBreak === -1 ? text.length : endBreak
  return text.slice(start, end)
}

function clip(text: string, index: number, end: number): string {
  const start = Math.max(0, index - 28)
  const stop = Math.min(text.length, end + 36)
  return text.slice(start, stop).replace(/\s+/g, ' ').trim().slice(0, 160)
}

function tokensAfter(text: string, end: number): string[] {
  const bounded = text.slice(end, sentenceEnd(text, end))
  const rest = bounded.replace(/^[\s,，.。:：;；!！?？)）\]】"'“”]+/u, '')
  if (!rest) return []
  return rest.split(/[\s,，.。:：;；!！?？]+/u).filter(token => token.length > 0 && !/^[\])】"'“”]+$/u.test(token))
}

/**
 * Judge one comment or body. An action signal in this text beats a resolved
 * token. A resolved token counts only when it is not negated and nothing after
 * it still asks for action — a short closing statement, not a step that passed.
 */
function liveActions(text: string, patterns: readonly RegExp[]): Hit[] {
  return collectHits(text, patterns).filter(hit => !isNegatedSignal(text, hit.index, hit.end) && !descriptiveMention(text, hit.index))
}

function liveResolved(text: string, patterns: readonly RegExp[]): Hit[] {
  return collectHits(text, patterns).filter(hit => !isNegatedSignal(text, hit.index, hit.end))
}

export function evaluateSignals(
  text: string,
  actionPatterns: readonly RegExp[],
  resolvedPatterns: readonly RegExp[]
): SignalVerdict {
  const actions = liveActions(text, actionPatterns)
  const resolved = liveResolved(text, resolvedPatterns)
  const actionAfter = (end: number): boolean => actions.some(hit => hit.index >= end)
  const closesItem = (hit: Hit): boolean => !actionAfter(hit.end) && tokensAfter(text, hit.end).length <= 3
  const whole = resolved.filter(closesItem)
  if (whole.length > 0) return 'resolved'
  if (actions.length > 0) return 'action'
  return 'none'
}

export interface ActionExplanation {
  rule: string
  excerpt: string
}

/** Name the action rule and keep a short excerpt of the original text. */
export function explainAction(
  text: string,
  actionPatterns: readonly RegExp[],
  resolvedPatterns: readonly RegExp[]
): ActionExplanation | null {
  if (evaluateSignals(text, actionPatterns, resolvedPatterns) !== 'action') return null
  const actions = liveActions(text, actionPatterns)
  const first = actions[0]
  if (!first) return null
  const excerpt = clip(text, first.index, first.end)
  const matched = text.slice(first.index, first.end)
  const paragraph = paragraphAt(text, first.index)
  const negated = collectHits(paragraph, resolvedPatterns).some(hit => isNegatedSignal(paragraph, hit.index))
  if (negated) return { rule: '同一段里的否定式', excerpt }
  if (OWNER_REQUEST.test(matched)) return { rule: '请主人或用户动手', excerpt }
  return { rule: '动作关键词', excerpt }
}

function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function patternHits(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => {
    pattern.lastIndex = 0
    return pattern.test(text)
  })
}

/** A role name plus an explicit ask in the same text, with or without @ or「用户」. */
export function explainRoleAsk(
  text: string,
  roles: readonly RegExp[],
  asks: readonly RegExp[],
  keywords: readonly RegExp[],
  resolved: readonly RegExp[]
): ActionExplanation | null {
  if (!patternHits(text, roles)) return null
  if (explainAction(text, keywords, resolved)) return null
  const directed = explainAction(text, asks, resolved)
  if (!directed) return null
  return { rule: '角色称呼请动手', excerpt: directed.excerpt }
}

function headerPattern(header: string): RegExp {
  const body = escapeLiteral(header.trim()).replace(/ /g, '\\s+')
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])(${body})(?=$|[^\\p{L}\\p{N}_])`, 'giu')
}

function headerTarget(text: string, end: number): string {
  const line = text.slice(end).split(/\r?\n/)[0] ?? ''
  const cleaned = line
    .replace(/^[\s*:：|—\-[\]]+/u, '')
    .replace(/^(?:on|by|for)\s+/iu, '')
  return (cleaned.split(/[。.!?\n,，;；]/u)[0] ?? '')
    .replace(/[\s*:：|—\-[\]]+$/u, '')
    .trim()
}

function headerKey(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * A configured status token. BLOCKED counts when it names the user or names
 * nobody. WAITING ON counts only when the object is the user or a role.
 */
export function explainStatusHeaders(
  text: string,
  headers: readonly string[],
  userWords: readonly RegExp[]
): ActionExplanation | null {
  for (const header of headers) {
    const pattern = headerPattern(header)
    for (const match of text.matchAll(pattern)) {
      const token = match[1] ?? header
      const index = (match.index ?? 0) + match[0].lastIndexOf(token)
      if (isNegatedSignal(text, index)) continue
      const target = headerTarget(text, index + token.length)
      const key = headerKey(header)
      if (key === 'blocked') {
        if (target && !patternHits(target, userWords)) continue
      } else if (key === 'waiting on') {
        if (!target || !patternHits(target, userWords)) continue
      }
      return { rule: '状态头', excerpt: clip(text, index, index + token.length) }
    }
  }
  return null
}
