import type { GithubRecord } from './types.js'

export interface ApoDecisionRequest {
  id: string
  rev: number
  type: string
  targets: number[]
  requestAt: string
  requestText: string
}

type Fields = Record<string, string>

function marker(body: string, kind: 'apo-decision' | 'apo-decision-result'): Fields | null {
  const first = body.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? ''
  const match = new RegExp(`^<!-- ${kind} v1 \\| (.*?) -->$`).exec(first)
  if (!match?.[1]) return null
  const fields: Fields = {}
  for (const part of match[1].split('|')) {
    const at = part.indexOf(':')
    if (at < 0) return null
    const key = part.slice(0, at).trim()
    if (!key || Object.hasOwn(fields, key)) return null
    fields[key] = part.slice(at + 1).trim()
  }
  if (!/^D-[1-9]\d*$/.test(fields.id ?? '') || !/^[1-9]\d*$/.test(fields.rev ?? '')) return null
  return fields
}

function requestOf(body: string): Fields | null {
  const fields = marker(body, 'apo-decision')
  if (!fields) return null
  if (!/^#[1-9]\d*(?: +#[1-9]\d*)*$/.test(fields.target ?? '') || !fields.type || !/^@[A-Za-z0-9][A-Za-z0-9-]*$/.test(fields.disposer ?? '')) return null
  return fields
}

function resultOf(body: string): Fields | null {
  const fields = marker(body, 'apo-decision-result')
  return fields && ['批准 A', '改用 B', '退回', '撤回'].includes(fields.result ?? '') && fields.reply ? fields : null
}

/** A disposer reply word on the first line. `id` is null when the reply carries no D-n prefix. */
function replyOf(body: string): { id: string | null } | null {
  const first = body.replace(/^\uFEFF/, '').trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
  const match = /^(?:(D-[1-9]\d*)\s*[:：]?\s*)?(?:批准 A|改用 B|退回(?:[:：].*)?|全部按推荐|同意|可以|按推荐|FREEZE ACK|EXCEPTION ACCEPT|EXCEPTION REJECT|PHASE ACCEPT|PHASE RETURN(?:\s.*)?)$/u.exec(first)
  return match ? { id: match[1] ?? null } : null
}

function excerpt(body: string, id: string, rev: number, type: string): string {
  const lines = body.split(/\r?\n/).slice(1).map(line => line.replace(/^[#>*\-\s]+/, '').replace(/\s+/g, ' ').trim()).filter(Boolean)
  const lead = lines[0]?.slice(0, 120) ?? ''
  return `${id} rev ${rev}（${type}）${lead ? `：${lead}` : ''}`
}

/**
 * Formal APO v0.3.1 decision requests still waiting on the viewer. Only a marker on the first line of a
 * body or comment counts; the newest rev of an id replaces older ones, and a result or the disposer's own
 * reply after the request settles it. Anything malformed or ambiguous is left out, never guessed.
 */
export function pendingApoDecisions(record: GithubRecord): ApoDecisionRequest[] {
  const viewer = record.viewerLogin?.toLowerCase()
  if (!viewer) return []
  const truncated = record.commentsTruncated || (record.commentsTruncated === undefined && record.comments.length >= 8)
  const entries = [
    ...(truncated ? [] : [{ body: record.body, createdAt: record.createdAt, authorLogin: record.authorLogin }]),
    ...record.comments
  ].map(entry => ({ ...entry, at: Date.parse(entry.createdAt) })).filter(entry => Number.isFinite(entry.at)).sort((a, b) => a.at - b.at)

  const latest = new Map<string, { fields: Fields, rev: number, at: number, body: string }>()
  const seen = new Set<string>()
  const ambiguous = new Set<string>()
  for (const entry of entries) {
    const fields = requestOf(entry.body)
    if (!fields) continue
    const key = `${fields.id}#${fields.rev}`
    if (seen.has(key)) ambiguous.add(fields.id!)
    seen.add(key)
    const rev = Number(fields.rev)
    const old = latest.get(fields.id!)
    if (!old || rev > old.rev) latest.set(fields.id!, { fields, rev, at: entry.at, body: entry.body })
  }

  const open = [...latest.entries()].filter(([id, request]) => !ambiguous.has(id) && request.fields.disposer!.slice(1).toLowerCase() === viewer)
  const pending = open.filter(([id, request]) => !entries.some(entry => {
    if (entry.at < request.at) return false
    const result = resultOf(entry.body)
    return Boolean(result && result.id === id && Number(result.rev) === request.rev)
  }))
  const answered = new Set<string>()
  for (const entry of entries) {
    if (entry.authorLogin?.toLowerCase() !== viewer) continue
    const reply = replyOf(entry.body)
    if (!reply) continue
    const first = entry.body.trim().split(/\r?\n/, 1)[0]!.trim()
    const targets = reply.id || /^全部按推荐$/.test(first)
      ? pending.filter(([id, request]) => (reply.id === null || reply.id === id) && request.at <= entry.at)
      : pending.filter(([, request]) => request.at <= entry.at).length === 1 ? pending.filter(([, request]) => request.at <= entry.at) : []
    for (const [id] of targets) answered.add(id)
  }
  return pending.filter(([id]) => !answered.has(id)).map(([id, request]) => ({
    id,
    rev: request.rev,
    type: request.fields.type!,
    targets: [...request.fields.target!.matchAll(/#(\d+)/g)].map(match => Number(match[1])),
    requestAt: new Date(request.at).toISOString(),
    requestText: excerpt(request.body, id, request.rev, request.fields.type!)
  })).sort((a, b) => Date.parse(a.requestAt) - Date.parse(b.requestAt))
}
