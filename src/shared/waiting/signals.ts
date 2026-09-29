export type SignalVerdict = 'action' | 'resolved' | 'none'

interface Hit {
  index: number
  end: number
}

const WORD_NEGATION = /(?:\bno\b|\bnot\b|\bwithout\b|\bnever\b|n't|没有|不是|并未|并非)/i
const SHORT_NEGATION = /(?:未|无|非|不)\s*$/u
const DESCRIPTIVE = /(?:文案|例如|比如|称为|叫做|显示|写成|字样|示例|描述|界面|流程|功能是|功能会|功能里|功能上)/u
const OWNER_REQUEST = /请\s*主人|请拒收|请接收|请确认|需要用户|待你验收|待用户|等用户|需要你|等你|待验收|拒收|接收/u

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

/** A resolved token in the same sentence as no/not/未/不/没有/不是 is not a resolution. */
export function isNegatedSignal(text: string, index: number): boolean {
  const prefix = sentencePrefix(text, index)
  if (WORD_NEGATION.test(prefix)) return true
  if (SHORT_NEGATION.test(prefix)) return true
  return /(?:未|不)[^\n。！？.!?]{0,8}$/u.test(prefix)
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
  const rest = text.slice(end).replace(/^[\s,，.。:：;；!！?？)）\]】"'“”]+/u, '')
  if (!rest) return []
  return rest.split(/[\s,，.。:：;；!！?？]+/u).filter(token => token.length > 0 && !/^[\])】"'“”]+$/u.test(token))
}

/**
 * Judge one comment or body. An action signal in this text beats a resolved
 * token. A resolved token counts only when it is not negated and nothing after
 * it still asks for action — a short closing statement, not a step that passed.
 */
function liveActions(text: string, patterns: readonly RegExp[]): Hit[] {
  return collectHits(text, patterns).filter(hit => !isNegatedSignal(text, hit.index) && !descriptiveMention(text, hit.index))
}

function liveResolved(text: string, patterns: readonly RegExp[]): Hit[] {
  return collectHits(text, patterns).filter(hit => !isNegatedSignal(text, hit.index))
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
