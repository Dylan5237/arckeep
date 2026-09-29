export type SignalVerdict = 'action' | 'resolved' | 'none'

interface Hit {
  index: number
  end: number
}

const WORD_NEGATION = /(?:\bno\b|\bnot\b|\bwithout\b|\bnever\b|n't|没有|不是|并未|并非)/i
const SHORT_NEGATION = /(?:未|无|非)\s*$/u

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

/** A resolved token preceded by no/not/未/没有/不是 is not a resolution. */
export function isNegatedSignal(text: string, index: number): boolean {
  const prefix = text.slice(Math.max(0, index - 24), index)
  if (WORD_NEGATION.test(prefix)) return true
  return SHORT_NEGATION.test(prefix)
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
export function evaluateSignals(
  text: string,
  actionPatterns: readonly RegExp[],
  resolvedPatterns: readonly RegExp[]
): SignalVerdict {
  const actions = collectHits(text, actionPatterns).filter(hit => !isNegatedSignal(text, hit.index))
  const resolved = collectHits(text, resolvedPatterns).filter(hit => !isNegatedSignal(text, hit.index))
  const actionAfter = (end: number): boolean => actions.some(hit => hit.index >= end)
  const closesItem = (hit: Hit): boolean => !actionAfter(hit.end) && tokensAfter(text, hit.end).length <= 3
  const whole = resolved.filter(closesItem)
  if (whole.length > 0) return 'resolved'
  if (actions.length > 0) return 'action'
  return 'none'
}
