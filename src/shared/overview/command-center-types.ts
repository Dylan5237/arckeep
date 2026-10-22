export type CommandCenterStatus = 'backlog' | 'implementation' | 'blocked' | 'verification' | 'awaiting-accept' | 'recorded-done' | 'unknown'

export interface CommandCenterText {
  text: string
  links: Array<{ label: string, url: string }>
}

export interface CommandCenterSource {
  number: number
  title: string
  url: string
  updatedAt: string
}

export interface CommandCenterField {
  label: string
  value: CommandCenterText
}

export interface CommandCenterPhase {
  reference: CommandCenterText
  problem: CommandCenterText
  status: CommandCenterStatus
  statusText: CommandCenterText
  result: CommandCenterText
}

export interface CommandCenterContent {
  format: 'table' | 'narrative'
  currentPhase: CommandCenterText | null
  status: CommandCenterStatus
  statusText: CommandCenterText | null
  lastClosedPhase: CommandCenterText | null
  openGates: CommandCenterText | null
  nextAction: CommandCenterText | null
  /** APO v0.3.1 §1「待你决定」: the pending formal decision requests as written by the generator. */
  pendingDecision: CommandCenterText | null
  /** From the 项目设置 section; null when it is absent, ambiguous or an older template. */
  processMode: 'light' | 'standard' | null
  summary: CommandCenterText | null
  declaredUpdatedOn: string | null
  fields: CommandCenterField[]
  phases: CommandCenterPhase[]
  phaseNotes: CommandCenterText | null
  blocks: CommandCenterField[]
  warnings: string[]
}

export interface CommandCenterRecord {
  source: CommandCenterSource
  content: CommandCenterContent
  checkedAt: string
}

export type CommandCenterRead =
  | ({ kind: 'ready' } & CommandCenterRecord)
  | { kind: 'missing', checkedAt: string }
  | { kind: 'ambiguous', candidates: CommandCenterSource[], truncated: boolean, checkedAt: string }
  | { kind: 'unsupported', source: CommandCenterSource, message: string, checkedAt: string }
  | { kind: 'unavailable', message: string, checkedAt: string, previous?: CommandCenterRecord }

export const COMMAND_CENTER_STATUS_LABELS: Record<CommandCenterStatus, string> = {
  backlog: '计划中', implementation: '实现中', blocked: '阻塞', verification: '验证中',
  'awaiting-accept': '等待验收', 'recorded-done': '记录完成', unknown: '状态未明确'
}

export function commandCenterRecord(read: CommandCenterRead | undefined): CommandCenterRecord | null {
  if (read?.kind === 'ready') return read
  return read?.kind === 'unavailable' ? read.previous ?? null : null
}

/** Failed reads retain a clearly labelled prior observation, never a fresh status. */
export function retainCommandCenter(
  previous: CommandCenterRead | undefined, message: string, checkedAt: string
): CommandCenterRead {
  const record = commandCenterRecord(previous)
  return { kind: 'unavailable', message, checkedAt, ...(record ? { previous: record } : {}) }
}

/** Disk caches are older or untrusted data too; only the current display contract is reusable. */
export function isCommandCenterRead(value: unknown, repo: string): value is CommandCenterRead {
  const object = (item: unknown): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item))
  const stamp = (item: unknown) => typeof item === 'string' && Number.isFinite(Date.parse(item))
  const safeLink = (item: unknown) => {
    if (typeof item !== 'string') return false
    try { const url = new URL(item); return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port } catch { return false }
  }
  const source = (item: unknown) => object(item) && Number.isSafeInteger(item.number) && Number(item.number) > 0
    && typeof item.title === 'string' && typeof item.url === 'string' && item.url.toLowerCase() === `https://github.com/${repo}/issues/${item.number}`.toLowerCase() && stamp(item.updatedAt)
  const text = (item: unknown) => object(item) && typeof item.text === 'string' && Array.isArray(item.links)
    && item.links.every(link => object(link) && typeof link.label === 'string' && safeLink(link.url))
  const status = (item: unknown) => typeof item === 'string' && Object.hasOwn(COMMAND_CENTER_STATUS_LABELS, item)
  const content = (item: unknown) => object(item) && (item.format === 'table' || item.format === 'narrative') && status(item.status)
    && ['currentPhase', 'statusText', 'lastClosedPhase', 'openGates', 'nextAction', 'pendingDecision', 'summary', 'phaseNotes'].every(key => item[key] === null || text(item[key]))
    && (item.processMode === null || item.processMode === 'light' || item.processMode === 'standard')
    && (item.declaredUpdatedOn === null || (typeof item.declaredUpdatedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.declaredUpdatedOn)))
    && Array.isArray(item.fields) && item.fields.every(field => object(field) && typeof field.label === 'string' && text(field.value))
    && Array.isArray(item.blocks) && item.blocks.every(block => object(block) && typeof block.label === 'string' && text(block.value))
    && Array.isArray(item.phases) && item.phases.every(phase => object(phase) && text(phase.reference) && text(phase.problem) && text(phase.result) && text(phase.statusText) && status(phase.status))
    && Array.isArray(item.warnings) && item.warnings.every(warning => typeof warning === 'string')
  const record = (item: unknown) => object(item) && source(item.source) && content(item.content) && stamp(item.checkedAt)
  if (!object(value) || !stamp(value.checkedAt)) return false
  if (value.kind === 'ready') return record(value)
  if (value.kind === 'missing') return true
  if (value.kind === 'unsupported') return source(value.source) && typeof value.message === 'string'
  if (value.kind === 'ambiguous') return Array.isArray(value.candidates) && value.candidates.every(source) && typeof value.truncated === 'boolean'
  if (value.kind === 'unavailable') return typeof value.message === 'string' && (value.previous === undefined || record(value.previous))
  return false
}
