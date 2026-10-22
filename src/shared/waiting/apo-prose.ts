import { Lexer, type Token } from 'marked'

export interface ApoProseBlock { text: string, depth: number | null, requests: boolean }
const TOKENS = /(?<![A-Za-z0-9_])(?:FREEZE ACK|EXCEPTION ACCEPT|PHASE ACCEPT)(?![A-Za-z0-9_])/
export const APO_SKIPPED_HEADING = /示例|规范|教程|历史|背景|需求|验收标准|example|documentation|history|specification/i

export function apoWithdraws(markdown: string, token: string): boolean {
  const literal = new RegExp(`(?<![A-Za-z0-9_])${token}(?![A-Za-z0-9_])`)
  let skipped: number | null = null
  let conditioned = false
  for (const block of apoProseBlocks(markdown)) {
    if (block.depth !== null) {
      if (skipped !== null && block.depth <= skipped) skipped = null
      if (APO_SKIPPED_HEADING.test(block.text)) skipped = block.depth
      conditioned = conditionalRequest(block.text)
      continue
    }
    if (conditionalRequest(block.text)) conditioned = true
    if (skipped !== null || conditioned || !block.requests) continue
    if (literal.test(block.text) && /取消.*请求|(?:无需|不用|不要|不需要|不必).*(?:评论|回复)|已(?:评论|回复)|已经.*(?:接受|确认)|\b(?:no longer|no need|do not|don't|not required|cancelled|canceled|withdrawn)\b/iu.test(block.text)) return true
  }
  return false
}

function inlineText(tokens: Token[]): string | null {
  const parts: string[] = []
  for (const token of tokens) {
    if (token.type === 'html' || token.type === 'image' || token.type === 'del') return null
    if (token.type === 'link' && 'href' in token && typeof token.href === 'string') {
      // Link labels can hide or contradict the actual destination.
      const label = 'text' in token && typeof token.text === 'string' && /^@[A-Za-z0-9-]+$/.test(token.text) ? `${token.text} ` : ''
      parts.push(`${label}${token.href}`)
    } else if (token.type === 'codespan' && 'text' in token && typeof token.text === 'string') {
      if (TOKENS.test(token.text) && !/^(?:FREEZE ACK|EXCEPTION ACCEPT|PHASE ACCEPT)$/.test(token.text.trim())) return null
      parts.push(token.text)
    } else if ('tokens' in token && Array.isArray(token.tokens)) {
      const nested = inlineText(token.tokens as Token[])
      if (nested === null) return null
      parts.push(nested)
    } else if (token.type === 'br') parts.push('\n')
    else if ('text' in token && typeof token.text === 'string') parts.push(token.text)
  }
  return parts.join('')
}

/** CommonMark/GFM structure controls what is prose. Code and block quotes never enter this list. */
export function apoProseBlocks(markdown: string): ApoProseBlock[] {
  const blocks: ApoProseBlock[] = []
  const visit = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === 'heading' && 'tokens' in token && Array.isArray(token.tokens) && 'depth' in token) {
        const text = inlineText(token.tokens as Token[])
        if (text !== null) blocks.push({ text, depth: Number(token.depth), requests: false })
      } else if ((token.type === 'paragraph' || token.type === 'text') && 'tokens' in token && Array.isArray(token.tokens)) {
        const text = inlineText(token.tokens as Token[])
        if (text !== null && text.trim()) blocks.push({ text: text.trim(), depth: null, requests: true })
      } else if (token.type === 'list' && 'items' in token && Array.isArray(token.items)) {
        for (const item of token.items) if (!item.checked) visit(item.tokens as Token[])
      } else if (token.type === 'table' && 'header' in token && 'rows' in token) {
        const rows = [token.header, ...token.rows] as Array<Array<{ tokens: Token[] }>>
        for (const row of rows) {
          const cells = row.map(cell => inlineText(cell.tokens))
          if (cells.every(cell => cell !== null)) blocks.push({ text: cells.join(' | '), depth: null, requests: false })
        }
      }
    }
  }
  visit(Lexer.lex(markdown, { gfm: true }))
  return blocks
}

export function apoDeclaredDisposers(markdown: string): string[] {
  const text = apoProseBlocks(markdown).map(block => block.text).join('\n')
  const declared = [...text.matchAll(/(?:处置人|\bdisposer\b)\s*(?:[:：|]\s*)?@([A-Za-z0-9-]+)\b/giu)]
  return declared.map(match => match[1]?.toLowerCase() ?? '')
}

export function apoDisposerMatches(markdown: string, viewer: string): boolean {
  return apoDeclaredDisposers(markdown).every(login => login === viewer.toLowerCase())
}

export type ApoDecision = 'FREEZE ACK' | 'EXCEPTION ACCEPT' | 'EXCEPTION REJECT' | 'PHASE ACCEPT' | 'PHASE RETURN'
export function apoDecision(markdown: string): ApoDecision | null {
  const first = apoProseBlocks(markdown).find(block => block.requests)?.text.split(/\r?\n/)[0]?.trim() ?? ''
  if (/^(?:FREEZE ACK|EXCEPTION ACCEPT|EXCEPTION REJECT|PHASE ACCEPT)$/.test(first)) return first as ApoDecision
  if (/^PHASE RETURN(?:\s|$)/.test(first)) return 'PHASE RETURN'
  return null
}

export function conditionalRequest(text: string): boolean {
  return /如果|若|假设|仅当|只有|一旦|前提|待.+(?:通过|完成|批准|合并|修复)|当.+(?:通过|完成|满足|批准).{0,20}(?:时|后)|(?:通过|完成|批准|合并|修复|验证|满足).{0,16}(?:后|之后|以后|再)|\b(?:if|unless|once|until|after|provided|when)\b/iu.test(text)
}
