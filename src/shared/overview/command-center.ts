import { Lexer, type Token } from 'marked'
import type { CommandCenterContent, CommandCenterField, CommandCenterPhase, CommandCenterRead, CommandCenterSource, CommandCenterStatus, CommandCenterText } from './command-center-types.js'

export const COMMAND_CENTER_LABEL_LIMIT = 4
export const COMMAND_CENTER_TITLE_LIMIT = 6
const MAX_BODY_LENGTH = 80_000
const MAX_PHASES = 30
const MAX_BLOCKS = 30
const NON_CURRENT_HEADING = /历史|快照|示例|归档|教程|\b(?:history|historical|snapshot|examples?|archives?|archived|tutorial)\b/i

type FieldKey = 'currentPhase' | 'statusText' | 'lastClosedPhase' | 'openGates' | 'nextAction'
interface Section { title: string, tokens: Token[] }
interface Candidate extends CommandCenterSource { body: string }

export function commandCenterStatus(value: string): CommandCenterStatus {
  const text = value.trim().toLowerCase().replace(/^status\s*[:：]\s*/, '')
  if (text === '已 freeze / 实施中') return 'implementation'
  const qualified = /^(in-progress|implementation|backlog|blocked|verification)\s*\/\s*[a-z]+(?:_[a-z0-9]+)+$/.exec(text)
  if (qualified) return commandCenterStatus(qualified[1]!)
  const match = /^(awaiting accept|awaiting-accept|in-progress|in progress|in_progress|implementation|backlog|blocked|verification|done|accepted|计划中|待开始|实现中|实施中|进行中|阻塞|验证中|等待验收|待验收|已完成)(?:$|\s*[（(：])/.exec(text)
  if (!match) return 'unknown'
  switch (match[1]) {
    case 'backlog': case '计划中': case '待开始': return 'backlog'
    case 'in-progress': case 'in progress': case 'in_progress': case 'implementation': case '实现中': case '实施中': case '进行中': return 'implementation'
    case 'blocked': case '阻塞': return 'blocked'
    case 'verification': case '验证中': return 'verification'
    case 'awaiting accept': case 'awaiting-accept': case '等待验收': case '待验收': return 'awaiting-accept'
    case 'done': case 'accepted': case '已完成': return 'recorded-done'
    default: return 'unknown'
  }
}

function githubLink(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) return null
    return url.href
  } catch { return null }
}

function textOf(tokens: Token[], repo: string): CommandCenterText {
  const links: CommandCenterText['links'] = []
  const visit = (items: Token[], bareReferences = true): string => items.map(token => {
    if (token.type === 'html' || token.type === 'image' || token.type === 'del') return ''
    if (token.type === 'br') return '\n'
    if (token.type === 'link' && 'href' in token && typeof token.href === 'string') {
      const label = 'tokens' in token && Array.isArray(token.tokens) ? visit(token.tokens as Token[], false) : String(token.text ?? '')
      const url = githubLink(token.href)
      if (url) links.push({ label: label || url, url })
      return label
    }
    if ('tokens' in token && Array.isArray(token.tokens)) return visit(token.tokens as Token[], bareReferences && token.type !== 'del')
    const text = 'text' in token && typeof token.text === 'string' ? token.text : ''
    if (bareReferences && token.type === 'text') {
      for (const match of text.matchAll(/(?<![A-Za-z0-9/#])#([1-9]\d*)\b/g)) {
        links.push({ label: match[0], url: `https://github.com/${repo}/issues/${match[1]}` })
      }
    }
    return text
  }).join('')
  const text = visit(tokens).trim()
  return { text, links: [...new Map(links.map(link => [link.url, link])).values()] }
}

function plain(text: string): CommandCenterText { return { text, links: [] } }
function combine(parts: CommandCenterText[], delimiter = '\n'): CommandCenterText | null {
  const kept = parts.filter(part => part.text)
  return kept.length ? { text: kept.map(part => part.text).join(delimiter), links: [...new Map(kept.flatMap(part => part.links).map(link => [link.url, link])).values()] } : null
}

/** HTML details are often retained history. Do not flatten their nested prose into current facts. */
function withoutDetails(tokens: Token[]): Token[] {
  let detailsDepth = 0
  return tokens.filter(token => {
    if (token.type === 'html') {
      const raw = token.raw
      const opens = [...raw.matchAll(/<details(?:\s|>)/gi)].length
      const closes = [...raw.matchAll(/<\/details\s*>/gi)].length
      const wasInside = detailsDepth > 0
      detailsDepth = Math.max(0, detailsDepth + opens - closes)
      if (wasInside || opens || closes) return false
    }
    return detailsDepth === 0
  })
}

function sections(markdown: string, repo: string): Section[] {
  const result: Section[] = []
  let current: Section | null = null
  let skippedDepth: number | null = null
  for (const token of withoutDetails(Lexer.lex(markdown.replace(/^\uFEFF+/, ''), { gfm: true }))) {
    if (token.type === 'heading' && 'depth' in token) {
      const depth = Number(token.depth)
      const title = textOf(token.tokens as Token[], repo).text
      if (skippedDepth !== null && depth <= skippedDepth) skippedDepth = null
      if (skippedDepth === null && NON_CURRENT_HEADING.test(title)) skippedDepth = depth
      if (skippedDepth !== null) continue
      if (depth <= 2) {
        current = { title, tokens: [] }
        result.push(current)
        continue
      }
    }
    if (skippedDepth === null && current) current.tokens.push(token)
  }
  return result
}

function prose(tokens: Token[], repo: string, includeQuotes = true): CommandCenterText[] {
  const result: CommandCenterText[] = []
  for (const token of withoutDetails(tokens)) {
    if ((token.type === 'paragraph' || token.type === 'text') && 'tokens' in token && Array.isArray(token.tokens)) {
      result.push(textOf(token.tokens as Token[], repo))
    } else if (includeQuotes && token.type === 'blockquote' && 'tokens' in token && Array.isArray(token.tokens)) {
      result.push(...prose(token.tokens as Token[], repo))
    } else if (token.type === 'list' && 'items' in token && Array.isArray(token.items)) {
      for (const item of token.items) result.push(...prose(item.tokens as Token[], repo, includeQuotes))
    }
  }
  return result.filter(part => part.text)
}

function currentTokens(tokens: Token[], repo: string): Token[] {
  let skippedDepth: number | null = null
  return tokens.filter(token => {
    if (token.type === 'heading' && 'depth' in token && 'tokens' in token) {
      const depth = Number(token.depth)
      if (skippedDepth !== null && depth <= skippedDepth) skippedDepth = null
      if (skippedDepth === null && NON_CURRENT_HEADING.test(textOf(token.tokens as Token[], repo).text)) skippedDepth = depth
    }
    return skippedDepth === null
  })
}

function tables(tokens: Token[], repo: string): CommandCenterText[][][] {
  const result: CommandCenterText[][][] = []
  for (const token of tokens) {
    if (token.type === 'table' && 'header' in token && 'rows' in token) {
      result.push(([token.header, ...token.rows] as Array<Array<{ tokens: Token[] }>>).map(row => row.map(cell => textOf(cell.tokens, repo))))
    }
  }
  return result
}

function fieldKey(label: string): FieldKey | null {
  const key = label.trim().toLowerCase().replace(/\s+/g, ' ')
  if (/^(current phase|当前阶段|stage|阶段)(?:$|\s*\/)/.test(key)) return 'currentPhase'
  if (/^(status word|current status|status|当前状态|状态)(?:$|\s*\/)/.test(key)) return 'statusText'
  if (/^(last closed phase|最近关闭阶段|上个已关闭阶段|已关闭阶段)(?:$|\s*\/)/.test(key)) return 'lastClosedPhase'
  if (/^(open gates|门禁|未决门禁|待处理门禁|恢复条件)(?:$|\s*\/)/.test(key)) return 'openGates'
  if (/^(single next action|next action|唯一下一动作|下一动作|下一步)(?:$|\s*\/)/.test(key)) return 'nextAction'
  return null
}

function headerIndex(header: CommandCenterText[], pattern: RegExp): number { return header.findIndex(cell => pattern.test(cell.text)) }

function hasStatusLead(value: string): boolean {
  return /^(?:status\s*[:：]\s*)?(?:awaiting accept|awaiting-accept|in[- _]progress|implementation|backlog|blocked|verification|done|accepted|计划中|待开始|实现中|实施中|进行中|阻塞|验证中|等待验收|待验收|已完成)(?:$|[\s（(：/—–])/i.test(value.trim())
}

function phaseIndex(section: Section | undefined, repo: string): { phases: CommandCenterPhase[], notes: CommandCenterText | null, truncated: boolean } {
  const phases: CommandCenterPhase[] = []
  let truncated = false
  for (const table of tables(section?.tokens ?? [], repo)) {
    const header = table[0] ?? []
    const refIndex = headerIndex(header, /phase issue|阶段(?:\s*issue|事项|编号)?/i)
    const statusIndex = headerIndex(header, /^status$|状态/i)
    if (refIndex < 0 || statusIndex < 0) continue
    const problemIndex = headerIndex(header, /core problem|problem|核心问题|目标|问题/i)
    const resultIndex = headerIndex(header, /^result$|结果|结论/i)
    for (const row of table.slice(1)) {
      const reference = row[refIndex]
      if (!reference?.text) continue
      if (phases.length >= MAX_PHASES) { truncated = true; continue }
      const statusText = row[statusIndex] ?? plain('')
      phases.push({ reference, statusText, status: commandCenterStatus(statusText.text), problem: row[problemIndex] ?? plain(''), result: row[resultIndex] ?? plain('') })
    }
  }
  return { phases, notes: combine(prose(section?.tokens ?? [], repo)), truncated }
}

export function parseCommandCenterBody(body: string, repo: string): CommandCenterContent | null {
  if (body.length > MAX_BODY_LENGTH) return null
  const all = sections(body, repo)
  const summaries = all.filter(section => /^(?:1[.、．]\s*)?(?:one[- ]glance|一眼状态|当前一句话状态|当前状态)/i.test(section.title) || /^section\s+1\s*[—:-]\s*current phase/i.test(section.title))
  if (summaries.length !== 1) return null
  const section = summaries[0]!
  const liveTokens = currentTokens(section.tokens, repo)
  const fields: CommandCenterField[] = []
  const values: Partial<Record<FieldKey, CommandCenterText | null>> = {}
  const warnings: string[] = []
  const conflicting = new Set<FieldKey>()
  const contextualDescriptions: CommandCenterField[] = []
  const put = (field: CommandCenterField) => {
    fields.push(field)
    const key = fieldKey(field.label)
    if (!key || !field.value.text) return
    if (values[key] && values[key]?.text !== field.value.text) {
      conflicting.add(key)
      warnings.push(`「${field.label}」存在冲突记录，请核对原总控台`)
    } else values[key] = field.value
  }
  const summaryTables = tables(liveTokens, repo)
  // Only two-column summary tables describe field/value facts. Release source tables are not status fields.
  for (const table of summaryTables) {
    if (table[0]?.length !== 2 || !/^(field|item|字段|项目)$/i.test(table[0]?.[0]?.text ?? '')) continue
    for (const row of table.slice(1)) if (row[0] && row[1]) put({ label: row[0].text, value: row[1] })
  }
  const summaryProse = prose(liveTokens, repo)
  for (const part of prose(liveTokens, repo, false)) {
    let field: CommandCenterField | null = null
    const flush = () => {
      if (!field) return
      const key = fieldKey(field.label)
      // A contextual “当前状态：等待...” sentence is a summary. Explicit Status fields,
      // including unrecognized values, must participate in conflict detection.
      const contextual = /^(current status|当前状态)$/i.test(field.label) && !hasStatusLead(field.value.text)
      if (contextual) { fields.push(field); contextualDescriptions.push(field) }
      else if (key) put(field)
    }
    for (const line of part.text.split('\n')) {
      const split = line.search(/[:：]/)
      const label = split < 0 ? '' : line.slice(0, split).trim()
      if (fieldKey(label)) {
        flush()
        const value = line.slice(split + 1).trim()
        field = { label, value: { text: value, links: part.links.filter(link => value.includes(link.label) || value.includes(link.url)) } }
      } else if (field) {
        field.value.text += `\n${line}`
        field.value.links.push(...part.links.filter(link => (line.includes(link.label) || line.includes(link.url)) && !field!.value.links.some(existing => existing.url === link.url)))
      }
    }
    flush()
  }
  // Free descriptions may supplement a declared working/blocked state. They cannot
  // silently endorse a completion record, irrespective of declaration order.
  if (contextualDescriptions.length && commandCenterStatus(values.statusText?.text ?? '') === 'recorded-done') {
    conflicting.add('statusText')
    warnings.push('状态记录与当前状态描述并存，请核对原总控台')
  }
  for (const key of conflicting) values[key] = null
  const updated = summaryProse.map(part => part.text).join('\n').match(/(?:Updated|更新(?:日期|时间)?)\s*[:：]\s*(\d{4}-\d{2}-\d{2})(?=$|[^\d])/i)?.[1] ?? null
  const updatedTime = updated ? Date.parse(`${updated}T00:00:00.000Z`) : Number.NaN
  const validUpdated = updated && Number.isFinite(updatedTime) && new Date(updatedTime).toISOString().startsWith(updated) ? updated : null
  const phaseSections = all.filter(item => /^(?:\d+[.、．]\s*)?(?:phase index|阶段索引)(?:$|\s*\/)/i.test(item.title))
  const indexed = phaseIndex(phaseSections.length === 1 ? phaseSections[0] : undefined, repo)
  if (phaseSections.length > 1) warnings.push('存在多个阶段索引，请核对原总控台')
  if (indexed.truncated) warnings.push(`阶段索引超过 ${MAX_PHASES} 项，完整列表请查看原总控台`)
  const blockSections = all.filter(item => /^(?:\d+[.、．]\s*)?(?:open exceptions|exceptions|未决例外|阻塞与例外)(?:$|\s*\/)/i.test(item.title))
  const blocks: CommandCenterField[] = []
  let blocksTruncated = false
  const addBlock = (block: CommandCenterField) => {
    if (blocks.length >= MAX_BLOCKS) blocksTruncated = true
    else blocks.push(block)
  }
  for (const blockSection of blockSections) {
    for (const table of tables(blockSection.tokens, repo)) {
      for (const row of table.slice(1)) {
        if (row[0]) {
          const value = combine(row.slice(1), ' · ') ?? plain('')
          addBlock({ label: row[0].text, value: { ...value, links: [...row[0].links, ...value.links] } })
        }
      }
    }
    for (const part of prose(blockSection.tokens, repo)) addBlock({ label: '例外 / 阻塞', value: part })
  }
  if (blocksTruncated) warnings.push(`例外 / 阻塞记录超过 ${MAX_BLOCKS} 项，完整列表请查看原总控台`)
  if (!values.currentPhase) warnings.push('总控台未明确当前阶段')
  if (!values.statusText || commandCenterStatus(values.statusText.text) === 'unknown') warnings.push('总控台未提供可识别的明确状态')
  if (!values.nextAction) warnings.push('总控台未填写下一动作')
  return {
    format: summaryTables.some(table => /^(field|item|字段|项目)$/i.test(table[0]?.[0]?.text ?? '')) ? 'table' : 'narrative', currentPhase: values.currentPhase ?? null,
    statusText: values.statusText ?? null, status: commandCenterStatus(values.statusText?.text ?? ''),
    lastClosedPhase: values.lastClosedPhase ?? null, openGates: values.openGates ?? null, nextAction: values.nextAction ?? null,
    summary: combine(summaryProse.filter(part => {
      if (/^(Updated|更新(?:日期|时间)?)\s*[:：]/i.test(part.text)) return false
      const split = part.text.search(/[:：]/)
      const key = split < 0 ? null : fieldKey(part.text.slice(0, split))
      return !key || (key === 'statusText' && commandCenterStatus(part.text.slice(split + 1)) === 'unknown')
    })),
    declaredUpdatedOn: validUpdated, fields, phases: indexed.phases, phaseNotes: indexed.notes, blocks, warnings: [...new Set(warnings)]
  }
}

export function isCommandCenterTitle(title: string): boolean {
  return /^\s*\[(?:command center|project command center|项目总控台(?:\s*\/\s*project command center)?)\](?:\s|$)/i.test(title)
    || /^\s*(?:project command center|command center|项目总控台)(?:\s*[:：—-]|$)/i.test(title)
}

function candidates(connection: unknown, repo: string, requireTitle: boolean): Candidate[] {
  if (!connection || typeof connection !== 'object' || !('nodes' in connection) || !Array.isArray(connection.nodes)) return []
  return connection.nodes.flatMap((node: unknown): Candidate[] => {
    if (!node || typeof node !== 'object') return []
    const value = node as Partial<Candidate> & { state?: unknown, repository?: { nameWithOwner?: unknown } }
    if (value.state !== 'OPEN' || !Number.isSafeInteger(value.number) || Number(value.number) < 1 || typeof value.title !== 'string' || typeof value.body !== 'string' || typeof value.url !== 'string' || typeof value.updatedAt !== 'string') return []
    if (value.repository?.nameWithOwner && String(value.repository.nameWithOwner).toLowerCase() !== repo.toLowerCase()) return []
    const expected = `https://github.com/${repo}/issues/${value.number}`
    if (value.url.toLowerCase() !== expected.toLowerCase() || !Number.isFinite(Date.parse(value.updatedAt))) return []
    if (requireTitle && !isCommandCenterTitle(value.title)) return []
    return [{ number: Number(value.number), title: value.title, url: value.url, updatedAt: value.updatedAt, body: value.body }]
  })
}

function complete(connection: unknown, search: boolean): boolean {
  if (!connection || typeof connection !== 'object') return false
  const value = connection as { nodes?: unknown, totalCount?: unknown, issueCount?: unknown, pageInfo?: { hasNextPage?: unknown } }
  if (!Array.isArray(value.nodes) || typeof value.pageInfo?.hasNextPage !== 'boolean') return false
  const count = search ? value.issueCount : value.totalCount
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= value.nodes.length && value.pageInfo.hasNextPage === false
}

/** Label and title discovery are bounded parts of the existing repository batch, with no per-repo follow-up. */
export function readCommandCenter(options: {
  repo: string, labeled: unknown, english: unknown, chinese: unknown, checkedAt: string, error?: string
}): CommandCenterRead {
  const { repo, labeled, english, chinese, checkedAt } = options
  if (options.error) return { kind: 'unavailable', message: options.error, checkedAt }
  if ([labeled, english, chinese].some(value => value === undefined || value === null)) {
    return { kind: 'unavailable', message: 'GitHub 未返回完整的总控台查询结果', checkedAt }
  }
  const labeledCandidates = candidates(labeled, repo, false)
  const labelNodes = labeled && typeof labeled === 'object' && 'nodes' in labeled && Array.isArray(labeled.nodes) ? labeled.nodes : []
  if (labeledCandidates.length !== labelNodes.length) return { kind: 'unavailable', message: '总控台候选数据不完整或来源不一致', checkedAt }
  const observations = [...labeledCandidates, ...candidates(english, repo, true), ...candidates(chinese, repo, true)]
  const byNumber = new Map<number, Candidate>()
  for (const candidate of observations) {
    const previous = byNumber.get(candidate.number)
    if (previous && (previous.body !== candidate.body || previous.updatedAt !== candidate.updatedAt || previous.title !== candidate.title)) {
      return { kind: 'unavailable', message: '读取期间总控台发生变化，请重新刷新', checkedAt }
    }
    byNumber.set(candidate.number, candidate)
  }
  const found = [...byNumber.values()]
  const truncated = !complete(labeled, false) || !complete(english, true) || !complete(chinese, true)
  if (truncated || found.length > 1) return {
    kind: 'ambiguous', candidates: found.map(({ body: _body, ...source }) => source), truncated, checkedAt
  }
  const candidate = found[0]
  if (!candidate) return { kind: 'missing', checkedAt }
  const { body, ...source } = candidate
  const content = parseCommandCenterBody(body, repo)
  if (!content) return { kind: 'unsupported', source, message: '未识别唯一的当前状态摘要，请查看原总控台', checkedAt }
  return { kind: 'ready', source, content, checkedAt }
}
