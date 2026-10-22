import { COMMAND_CENTER_STATUS_LABELS, commandCenterRecord, type CommandCenterRead, type CommandCenterRecord, type CommandCenterText } from '../shared/overview/command-center-types'
import { localAbsolute, relativeLabel } from '../shared/time'

export type ProgressFilter = 'all' | 'running' | 'review' | 'blocked' | 'maintenance'

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text) node.textContent = text
  return node
}

export function progressCategory(read: CommandCenterRead | undefined): ProgressFilter {
  if (read?.kind !== 'ready' || read.content.status === 'unknown') return 'maintenance'
  if (read.content.status === 'implementation') return 'running'
  if (read.content.status === 'verification' || read.content.status === 'awaiting-accept') return 'review'
  if (read.content.status === 'blocked') return 'blocked'
  return 'all'
}

export function commandCenterBadge(read: CommandCenterRead | undefined): HTMLElement {
  const record = commandCenterRecord(read)
  const cached = read?.kind === 'unavailable' && Boolean(record)
  const status = record?.content.status ?? 'unknown'
  const label = record ? `${cached ? '缓存 · ' : ''}${COMMAND_CENTER_STATUS_LABELS[status]}`
    : read?.kind === 'missing' ? '未接入总控台'
      : read?.kind === 'ambiguous' ? '总控台待核对'
        : read?.kind === 'unavailable' ? '读取失败'
          : read?.kind === 'unsupported' ? '格式待核对' : '尚未读取'
  return el('span', `cc-badge cc-status-${cached ? 'unknown' : status}`, label)
}

function link(label: string, url: string, open: (url: string) => void): HTMLAnchorElement {
  const anchor = el('a', 'cc-link', label)
  anchor.href = url
  anchor.addEventListener('click', event => { event.preventDefault(); open(url) })
  return anchor
}

function text(value: CommandCenterText, open: (url: string) => void, compact = false): HTMLElement {
  const host = el('div', 'cc-value')
  host.append(el('p', compact ? 'cc-prose cc-compact' : 'cc-prose', value.text))
  if (value.links.length) {
    const links = el('div', 'cc-links')
    for (const target of value.links.slice(0, compact ? 4 : 30)) links.append(link(target.label, target.url, open))
    host.append(links)
  }
  return host
}

function field(label: string, value: CommandCenterText | null, open: (url: string) => void): HTMLElement {
  const host = el('div', 'cc-field')
  host.append(el('h3', '', label))
  host.append(value ? text(value, open, true) : el('p', 'cc-unfilled', '总控台未填写'))
  return host
}

function source(record: Pick<CommandCenterRecord, 'source' | 'checkedAt'>, open: (url: string) => void): HTMLElement {
  const footer = el('footer', 'cc-source')
  const origin = link(`Command Center #${record.source.number}`, record.source.url, open)
  origin.title = record.source.title
  const updated = el('span', '', `Issue 更新 ${relativeLabel(record.source.updatedAt, new Date())}`)
  updated.title = localAbsolute(record.source.updatedAt)
  const checked = el('span', '', `读取 ${relativeLabel(record.checkedAt, new Date())}`)
  checked.title = localAbsolute(record.checkedAt)
  footer.append(origin, updated, checked)
  return footer
}

function details(record: CommandCenterRecord, open: (url: string) => void): HTMLElement {
  const { content } = record
  const host = el('details', 'cc-details')
  host.append(el('summary', '', `阶段与总控台详情${content.phases.length ? ` · ${content.phases.length} 个阶段` : ''}`))
  const body = el('div', 'cc-details-body')
  if (content.phases.length) {
    body.append(el('h3', '', '阶段索引'))
    const phases = el('ol', 'cc-phases')
    for (const phase of content.phases) {
      const item = el('li', `cc-phase cc-status-${phase.status}`)
      const head = el('div', 'cc-phase-head')
      head.append(text(phase.reference, open), el('span', 'cc-phase-status', COMMAND_CENTER_STATUS_LABELS[phase.status]))
      item.append(head)
      if (phase.problem.text) item.append(text(phase.problem, open))
      if (phase.statusText.text) item.append(el('p', 'cc-phase-note', `状态原文：${phase.statusText.text}`))
      if (phase.result.text) item.append(text(phase.result, open))
      phases.append(item)
    }
    body.append(phases)
    body.append(el('p', 'cc-explainer', '阶段状态来自总控台记录；未逐项核验 Phase ACCEPT。'))
  }
  if (content.phaseNotes) {
    body.append(el('h3', '', '阶段索引原文'), text(content.phaseNotes, open))
  }
  if (content.summary) body.append(el('h3', '', '当前摘要原文'), text(content.summary, open))
  if (content.fields.length) {
    body.append(el('h3', '', '一眼状态原文'))
    const facts = el('dl', 'cc-facts')
    for (const fact of content.fields) {
      const value = el('dd', '')
      value.append(text(fact.value, open))
      facts.append(el('dt', '', fact.label), value)
    }
    body.append(facts)
  }
  if (content.blocks.length) {
    body.append(el('h3', '', '例外 / 阻塞'))
    for (const block of content.blocks) {
      const item = el('div', 'cc-block')
      item.append(el('strong', '', block.label), text(block.value, open))
      body.append(item)
    }
  }
  if (content.declaredUpdatedOn) body.append(el('p', 'cc-explainer', `总控台声明更新时间：${content.declaredUpdatedOn}`))
  host.append(body)
  return host
}

export function commandCenterPanel(read: CommandCenterRead | undefined, open: (url: string) => void): HTMLElement {
  const host = el('div', 'cc-panel')
  const record = commandCenterRecord(read)
  if (read?.kind === 'unavailable') host.append(el('p', 'cc-read-warning', `${read.previous ? '本次读取失败，下面是上次记录。' : ''}${read.message}`))
  if (!record) {
    if (!read) host.append(el('p', 'cc-unfilled', '尚未读取 Command Center，刷新后显示进度。'))
    if (read?.kind === 'missing') {
      host.append(el('p', 'cc-unfilled', '未发现开放的 Command Center。'))
      host.append(el('p', 'cc-explainer', '识别 type:command-center 标签，或 [Command Center] / [项目总控台] 标题。'))
    }
    if (read?.kind === 'ambiguous') {
      host.append(el('p', 'cc-read-warning', read.truncated ? '候选查询范围不完整，无法确定唯一总控台。' : '发现多个总控台，请核对当前项目控制面。'))
      for (const candidate of read.candidates) host.append(link(`#${candidate.number} ${candidate.title}`, candidate.url, open))
    }
    if (read?.kind === 'unsupported') {
      host.append(el('p', 'cc-read-warning', read.message), source(read, open))
    }
    if (read && read.kind !== 'unsupported') {
      const checked = el('p', 'cc-explainer', `查询 ${relativeLabel(read.checkedAt, new Date())}`)
      checked.title = localAbsolute(read.checkedAt)
      host.append(checked)
    }
    return host
  }
  const { content } = record
  host.append(field('当前阶段', content.currentPhase, open))
  if (content.processMode) host.append(el('p', 'cc-explainer', content.processMode === 'light' ? '流程档位：轻量（light）' : '流程档位：标准（standard）'))
  if (content.status === 'unknown' && content.statusText) host.append(field('状态原文', content.statusText, open))
  if (content.format === 'narrative' && content.summary) host.append(text(content.summary, open, true))
  const stages = ['backlog', 'implementation', 'verification', 'awaiting-accept'] as const
  if (stages.includes(content.status as (typeof stages)[number])) {
    const rail = el('ol', 'cc-stage-rail')
    rail.setAttribute('aria-label', '当前阶段状态')
    for (const stage of stages) {
      const item = el('li', stage === content.status ? 'is-current' : '', COMMAND_CENTER_STATUS_LABELS[stage])
      if (stage === content.status) item.setAttribute('aria-current', 'step')
      rail.append(item)
    }
    host.append(rail)
  }
  const actions = el('div', 'cc-actions')
  actions.append(field('门禁 / 阻塞', content.openGates, open), field('下一动作', content.nextAction, open))
  host.append(actions)
  if (content.pendingDecision && content.pendingDecision.text.trim() !== '无') host.append(field('待你决定', content.pendingDecision, open))
  if (content.lastClosedPhase?.text && content.lastClosedPhase.text !== '—') {
    const closed = el('div', 'cc-last-closed')
    closed.append(el('span', '', '最近关闭阶段'), text(content.lastClosedPhase, open, true))
    host.append(closed)
  }
  for (const warning of content.warnings) host.append(el('p', 'cc-format-warning', warning))
  host.append(details(record, open), source(record, open))
  return host
}
