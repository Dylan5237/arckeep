import type { GithubRecord } from './types.js'
import { apoProseBlocks, apoDecision, apoDisposerMatches, apoDeclaredDisposers, conditionalRequest, apoWithdraws, APO_SKIPPED_HEADING } from './apo-prose.js'

export const APO_COMMENT_TOKENS = ['FREEZE ACK', 'EXCEPTION ACCEPT', 'PHASE ACCEPT'] as const
export type ApoCommentToken = (typeof APO_COMMENT_TOKENS)[number]
export interface ApoCommentOutcome { state: 'sent' | 'unknown', url?: string }

export interface ApoQuickAction {
  id: string
  token: ApoCommentToken
  source: { repo: string, number: number, kind: 'issue' | 'pr' }
  target: { repo: string, number: number, url: string }
  viewerLogin: string
  requestAt: string
  requestText: string
  state?: 'sent' | 'unknown'
}

export function isApoRepoName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value)
    && !['.', '..'].includes(value.split('/')[1] ?? '')
}
const DENIED = /无需|不用|不要|不需要|不必|取消|已评论|已回复|已经.*(?:接受|确认)|例如|示例|假设|如果|若|(?:\b(?:not|don't|do not|already|example|if|unless)\b)/iu

function hasToken(text: string, token: ApoCommentToken): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${token}(?![A-Za-z0-9_])`).test(text)
}

function targetOf(line: string, record: GithubRecord): ApoQuickAction['target'] | null {
  const refs: Array<{ repo: string, number: number, kind: string, index: number }> = []
  const commentAt = line.search(/评论|回复|\bcomment\b|\breply\b/iu)
  if (commentAt < 0) return null
  const prefix = line.slice(0, commentAt)
  const pointer = /下面|下方|以下|\b(?:below|following|linked)\b/iu.test(prefix)
  // Evidence links after the requested comment are not destinations.
  const destination = pointer ? line : prefix
  let invalidUrl = false
  let rest = destination.replace(/https?:\/\/[^\s)<>]+/giu, (all, index: number) => {
    try {
      const url = new URL(all.replace(/[。，；]+$/u, ''))
      const match = /^\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)\/?$/.exec(url.pathname)
      if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password || !match?.[1] || !match[2] || !match[3]) {
        invalidUrl = true
      } else refs.push({ repo: match[1], kind: match[2], number: Number(match[3]), index })
    } catch { invalidUrl = true }
    return ' '.repeat(all.length)
  })
  if (invalidUrl) return null
  rest = rest.replace(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)/g,
    (all, repo: string, number: string, index: number) => { refs.push({ repo, number: Number(number), kind: 'issues', index }); return ' '.repeat(all.length) })
  for (const match of rest.matchAll(/(?:^|[^\w])#(\d+)\b/g)) refs.push({ repo: record.repo, number: Number(match[1]), kind: 'issues', index: match.index ?? 0 })
  const locationText = prefix.replace(/https?:\/\/[^\s)<>]+/giu, all => ' '.repeat(all.length))
  const locator = [...locationText.matchAll(/在|到|至|于|\b(?:on|in|to)\b/giu)].at(-1)?.index
  if (refs.length > 0 && (locator === undefined || refs.some(ref => ref.index < locator))) return null
  const current = /本\s*(?:Issue|PR|议题)|当前\s*(?:Issue|PR|议题)|\b(?:this|current) (?:issue|pr|pull request)\b/iu.test(prefix)
  if (current && refs.some(ref => ref.repo.toLowerCase() !== record.repo.toLowerCase() || ref.number !== record.number)) return null
  if (refs.length === 0 && (pointer || /指定|别的|另一|\b(?:another)\b/iu.test(prefix))) return null
  if (!current && !pointer && refs.length === 0 && /https?:\/\/|#\d+/.test(line.slice(commentAt))) return null
  if (refs.length === 0 && record.kind === 'pr') return null // APO decisions belong on Phase/Exception Issues.
  const target = refs[0] ?? { repo: record.repo, number: record.number, kind: 'issues' }
  if (refs.some(ref => ref.repo.toLowerCase() !== target.repo.toLowerCase() || ref.number !== target.number)) return null
  if (!isApoRepoName(target.repo) || !Number.isSafeInteger(target.number) || target.number < 1) return null
  if (target.kind !== 'issues') return null
  return { repo: target.repo, number: target.number, url: `https://github.com/${target.repo}/${target.kind}/${target.number}` }
}

function addressedToViewer(line: string, viewer: string, context: string): boolean {
  const mentions = [...line.matchAll(/@([A-Za-z0-9-]+)\b/g)].map(match => match[1]?.toLowerCase())
  if (mentions.length > 0) return mentions.every(login => login === viewer.toLowerCase())
  if (/处置人|\bdisposer\b/iu.test(line)) {
    const disposers = apoDeclaredDisposers(context)
    return disposers.length > 0 && disposers.every(login => login === viewer.toLowerCase())
  }
  return /用户|请你|需要你|等待你|等你|\byou\b/iu.test(line)
}

/** Exact, addressed requests only. Tokens appearing in templates do not imply consent. */
export function pendingApoActions(record: GithubRecord): ApoQuickAction[] {
  if (!record.viewerLogin || !isApoRepoName(record.repo)) return []
  if (![record.body, ...record.comments.map(comment => comment.body)].some(text => APO_COMMENT_TOKENS.some(token => hasToken(text, token)))) return []
  if (!apoDisposerMatches(record.body, record.viewerLogin)) return []
  const pending = new Map<string, ApoQuickAction>()
  const entries = [
    ...(record.commentsTruncated || (record.commentsTruncated === undefined && record.comments.length >= 8) ? []
      : [{ body: record.body, createdAt: record.createdAt, authorLogin: record.authorLogin }]),
    ...record.comments
  ].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  for (const entry of entries) {
    if (!apoDisposerMatches(entry.body, record.viewerLogin)) continue
    const blocks = apoProseBlocks(entry.body)
    const exact = apoDecision(entry.body)
    if (entry.authorLogin?.toLowerCase() === record.viewerLogin.toLowerCase()) {
      for (const token of APO_COMMENT_TOKENS) {
        if (exact === token || (token === 'EXCEPTION ACCEPT' && exact === 'EXCEPTION REJECT')
          || (token === 'PHASE ACCEPT' && exact === 'PHASE RETURN')) {
          for (const [key, action] of pending) if (action.token === token
            && action.target.repo.toLowerCase() === record.repo.toLowerCase() && action.target.number === record.number) pending.delete(key)
        }
      }
    }
    let skipped: number | null = null
    let conditioned = false
    for (const [index, block] of blocks.entries()) {
      if (block.depth !== null) {
        if (skipped !== null && block.depth <= skipped) skipped = null
        if (APO_SKIPPED_HEADING.test(block.text)) skipped = block.depth
        conditioned = conditionalRequest(block.text)
        continue
      }
      if (conditionalRequest(block.text)) conditioned = true
      if (skipped !== null || conditioned || !block.requests) continue
      const next = blocks[index + 1]
      if (next?.requests && conditionalRequest(next.text)) continue
      const separate = block.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
      const requests = separate.length > 1 && separate.every(line => APO_COMMENT_TOKENS.some(token => hasToken(line, token))
        && /评论|回复|\bcomment\b|\breply\b/iu.test(line)) ? separate : [block.text]
      for (const request of requests) {
        let line = request.replace(/^(?:处置人|disposer)\s*[:：]\s*@[A-Za-z0-9-]+\s*\n/iu, '').replace(/\s+/g, ' ').trim()
        if (/下面|下方|以下|\b(?:below|following|linked)\b/iu.test(line) && next?.requests && next.depth === null) line += ` ${next.text}`
        if (line.length > 900 || /^\s*["“「『]/u.test(line) || /\[[xX]\]/.test(line)) continue
        if (APO_COMMENT_TOKENS.filter(token => hasToken(line, token)).length > 1) continue
        for (const token of APO_COMMENT_TOKENS) {
          if (!hasToken(line, token)) continue
          if (apoWithdraws(line, token)) {
            for (const [key, action] of pending) if (action.token === token) pending.delete(key)
            continue
          }
          if (DENIED.test(line) || !addressedToViewer(line, record.viewerLogin, `${record.body}\n${entry.body}`)
            || /(?:并|同时|还需|还要).*(?:填写|附|写|说明|补充)|附上|加上|\bwith (?:a |the )?(?:reason|evidence|explanation)/iu.test(line)) continue
          if (!/^(?:(?:下一步|next action|next)\s*[:：]\s*)?(?:请|需要|需|等待|\bplease\b|\bmust\b|\bawaiting\b|待|等)/iu.test(line)
            || !/评论|回复|\bcomment\b|\breply\b/iu.test(line)) continue
          const target = targetOf(line, record)
          const at = Date.parse(entry.createdAt)
          if (!target || !Number.isFinite(at)) continue
          const requestAt = new Date(at).toISOString()
          const revision = Date.parse(record.updatedAt)
          if (!Number.isFinite(revision)) continue
          const source = { repo: record.repo, number: record.number, kind: record.kind }
          const id = JSON.stringify([record.viewerLogin.toLowerCase(), source.repo.toLowerCase(), source.number,
            token, target.repo.toLowerCase(), target.number, requestAt, new Date(revision).toISOString(), line])
          pending.set(JSON.stringify([token, target.repo.toLowerCase(), target.number]), { id, token, source, target, viewerLogin: record.viewerLogin, requestAt, requestText: line })
        }
      }
    }
  }
  return [...pending.values()]
}
