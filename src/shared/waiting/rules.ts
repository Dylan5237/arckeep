import type { MentionPolicy, OpenPrScope, StatusDocRule, WaitingConfig, WaitingSources } from './types.js'

export class WaitingConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WaitingConfigError'
  }
}

const DEFAULT_KEYWORDS = [
  'USER_ACTION_REQUIRED',
  'HUMAN_REQUIRED',
  'needs-human',
  'needs-dylan',
  '等 ?Dylan',
  '请 ?Dylan',
  '需要你',
  '等你',
  '待验收',
  '请确认',
  '截图',
  '请拒收',
  '请接收',
  '需要用户',
  '待你验收',
  '待用户',
  '等用户',
  '请主人',
  '请拍板',
  '明示接受或拒收'
]

const DEFAULT_REQUEST_VERBS = ['请', '需', 'please', 'need', '等']

const DEFAULT_REQUEST_ACTIONS = ['确认', '接受', '拒收', '验收', '决定', 'review', 'approve', 'confirm', 'accept']

const DEFAULT_ACK_TOKENS = ['ACK']

const DEFAULT_PARKED_MARKERS = ['parked', '搁置']

const DEFAULT_LABELS = [
  'pending',
  'waiting',
  'needs-*',
  'blocked',
  '等待',
  'needs-human',
  'needs-dylan'
]

const DEFAULT_RESOLVED = [
  '已验收',
  '已完成',
  '\\bPASS\\b',
  '无需操作',
  '不需要用户',
  '不需要你'
]

const DEFAULT_ROLES = ['主人', 'owner', '维护者', '负责人', 'maintainer']

const DEFAULT_STATUS_HEADERS = [
  'NEEDS USER ACTION',
  'BLOCKED',
  'WAITING ON',
  'ACTION REQUIRED',
  'USER_ACTION_REQUIRED',
  'HUMAN_REQUIRED'
]

const DEFAULT_SPEC_MARKERS = ['需求', '功能', 'spec', 'feature', 'PRD']

const DEFAULT_OTHER_ACTORS = ['agent', 'bot', '助手']

const DEFAULT_SELF_STEPS = ['我还没', '自己还没', '我来做']

/** Asks aimed at a role name.「请确认」also lives in the keyword list. */
export const DEFAULT_ROLE_ASKS = [
  '明示接受或拒收',
  '接受或拒收',
  '请拍板',
  '请确认',
  '请.{0,12}(?:确认|拍板|拒收|接收|接受)'
]

/** Enough for a large personal account. Hitting it shows a notice instead of dropping repos quietly. */
export const DEFAULT_MAX_SCOPE_REPOS = 400

/** Comments newer than this still count as a live mention without an action signal. */
export const DEFAULT_MENTION_RECENT_DAYS = 14

/** Whole days without a push, comment, or review before a quiet open PR counts. */
export const DEFAULT_OPEN_PR_QUIET_DAYS = 3

export function defaultWaitingSources(): WaitingSources {
  return {
    assignee: true,
    reviewRequested: true,
    mentions: true,
    todos: true,
    statusDocs: true,
    openPrs: true,
    humanIssues: true,
    localBranches: false
  }
}

export function defaultWaitingConfig(): WaitingConfig {
  return {
    sources: defaultWaitingSources(),
    humanKeywords: [...DEFAULT_KEYWORDS],
    humanLabels: [...DEFAULT_LABELS],
    resolvedSignals: [...DEFAULT_RESOLVED],
    statusDocRules: [],
    localRepoDirs: [],
    maxScopeRepos: DEFAULT_MAX_SCOPE_REPOS,
    openPrScope: 'maintain',
    mentionPolicy: 'action-or-recent',
    mentionRecentDays: DEFAULT_MENTION_RECENT_DAYS,
    openPrQuietDays: DEFAULT_OPEN_PR_QUIET_DAYS,
    roleNames: [...DEFAULT_ROLES],
    roleAskPhrases: [...DEFAULT_ROLE_ASKS],
    statusHeaders: [...DEFAULT_STATUS_HEADERS],
    specMarkers: [...DEFAULT_SPEC_MARKERS],
    otherActors: [...DEFAULT_OTHER_ACTORS],
    selfStepPhrases: [...DEFAULT_SELF_STEPS],
    requestVerbs: [...DEFAULT_REQUEST_VERBS],
    requestActions: [...DEFAULT_REQUEST_ACTIONS],
    ackTokens: [...DEFAULT_ACK_TOKENS],
    parkedMarkers: [...DEFAULT_PARKED_MARKERS],
    showIgnored: false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function stringList(value: unknown, limit: number, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new WaitingConfigError(`${label}格式无效`)
  if (value.length > limit) throw new WaitingConfigError(`${label}过多`)
  const items: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw new WaitingConfigError(`${label}无效`)
    const text = entry.trim()
    if (!text) continue
    if (text.length > 200) throw new WaitingConfigError(`${label}过长`)
    if (!items.includes(text)) items.push(text)
  }
  return items
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export function compileUserRegex(pattern: string, label: string): RegExp {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    throw new WaitingConfigError(`${label}无效：${pattern}`)
  }
}

export function compileUserRegexList(patterns: readonly string[], label: string): RegExp[] {
  return patterns.map(pattern => compileUserRegex(pattern, label))
}

function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T, label: string): T {
  if (value === undefined) return fallback
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T
  throw new WaitingConfigError(`${label}无效`)
}

function dayWindow(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 365) {
    throw new WaitingConfigError(`${label}应为 1 到 365 的整数`)
  }
  return value
}

function scopeRepoLimit(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2000) {
    throw new WaitingConfigError('仓库数量上限应为 1 到 2000 的整数')
  }
  return value
}

function parseRule(value: unknown): StatusDocRule {
  if (!isRecord(value)) throw new WaitingConfigError('状态文档规则无效')
  const repo = typeof value.repo === 'string' ? value.repo.trim() : ''
  const target = typeof value.target === 'string' ? value.target.trim() : ''
  const pattern = typeof value.pattern === 'string' ? value.pattern.trim() : ''
  if (!REPO_PATTERN.test(repo)) throw new WaitingConfigError(`状态文档仓库格式应为 owner/repo：${repo || '空'}`)
  if (!target || target.length > 300 || target.includes('..') || target.startsWith('/') || target.includes('\\')) {
    throw new WaitingConfigError('状态文档目标应为仓库内文件路径或 Issue 号')
  }
  if (!/^#?\d+$/.test(target) && !/^[A-Za-z0-9_./-]+$/.test(target)) {
    throw new WaitingConfigError('状态文档目标应为仓库内文件路径或 Issue 号')
  }
  if (!pattern) throw new WaitingConfigError('状态文档正则不能为空')
  return { repo, target, pattern }
}

export function parseWaitingConfig(input: unknown, options?: { validatePatterns?: boolean }): WaitingConfig {
  const defaults = defaultWaitingConfig()
  if (input === undefined || input === null) return defaults
  if (!isRecord(input)) throw new WaitingConfigError('等我处理的规则无效')
  const sourcesRaw = isRecord(input.sources) ? input.sources : {}
  const sources: WaitingSources = {
    assignee: bool(sourcesRaw.assignee, defaults.sources.assignee),
    reviewRequested: bool(sourcesRaw.reviewRequested, defaults.sources.reviewRequested),
    mentions: bool(sourcesRaw.mentions, defaults.sources.mentions),
    todos: bool(sourcesRaw.todos, defaults.sources.todos),
    statusDocs: bool(sourcesRaw.statusDocs, defaults.sources.statusDocs),
    openPrs: bool(sourcesRaw.openPrs, defaults.sources.openPrs),
    humanIssues: bool(sourcesRaw.humanIssues, defaults.sources.humanIssues),
    localBranches: bool(sourcesRaw.localBranches, defaults.sources.localBranches)
  }
  const humanKeywords = input.humanKeywords === undefined
    ? defaults.humanKeywords
    : stringList(input.humanKeywords, 50, '人工动作关键词')
  const humanLabels = input.humanLabels === undefined
    ? defaults.humanLabels
    : stringList(input.humanLabels, 50, '人工动作标签')
  const resolvedSignals = input.resolvedSignals === undefined
    ? defaults.resolvedSignals
    : stringList(input.resolvedSignals, 50, '已解决信号')
  let statusDocRules: StatusDocRule[] = []
  if (input.statusDocRules !== undefined) {
    if (!Array.isArray(input.statusDocRules)) throw new WaitingConfigError('状态文档规则格式无效')
    if (input.statusDocRules.length > 40) throw new WaitingConfigError('状态文档规则过多')
    statusDocRules = input.statusDocRules.map(parseRule)
  }
  const localRepoDirs: string[] = []
  if (input.localRepoDirs !== undefined) {
    if (!Array.isArray(input.localRepoDirs)) throw new WaitingConfigError('本地仓目录格式无效')
    if (input.localRepoDirs.length > 40) throw new WaitingConfigError('本地仓目录过多')
    for (const entry of input.localRepoDirs) {
      if (typeof entry !== 'string') throw new WaitingConfigError('本地仓目录无效')
      const dir = entry.trim()
      if (!dir) continue
      if (dir.length > 500 || dir.startsWith('-')) throw new WaitingConfigError('本地仓目录无效')
      if (!localRepoDirs.includes(dir)) localRepoDirs.push(dir)
    }
  }
  const config: WaitingConfig = {
    sources,
    humanKeywords,
    humanLabels,
    resolvedSignals,
    statusDocRules,
    localRepoDirs,
    maxScopeRepos: scopeRepoLimit(input.maxScopeRepos, defaults.maxScopeRepos),
    openPrScope: choice<OpenPrScope>(input.openPrScope, ['maintain', 'watching'], defaults.openPrScope, '待你审/合范围'),
    mentionPolicy: choice<MentionPolicy>(input.mentionPolicy, ['action-or-recent', 'any'], defaults.mentionPolicy, '提及规则'),
    mentionRecentDays: dayWindow(input.mentionRecentDays, defaults.mentionRecentDays, '提及的最近天数'),
    openPrQuietDays: dayWindow(input.openPrQuietDays, defaults.openPrQuietDays, '待你审/合的无动静天数'),
    roleNames: input.roleNames === undefined ? defaults.roleNames : stringList(input.roleNames, 40, '角色称呼'),
    roleAskPhrases: input.roleAskPhrases === undefined ? defaults.roleAskPhrases : stringList(input.roleAskPhrases, 40, '角色请求'),
    statusHeaders: input.statusHeaders === undefined ? defaults.statusHeaders : stringList(input.statusHeaders, 40, '状态头'),
    specMarkers: input.specMarkers === undefined ? defaults.specMarkers : stringList(input.specMarkers, 40, '需求类标记'),
    otherActors: input.otherActors === undefined ? defaults.otherActors : stringList(input.otherActors, 40, '非用户负责人'),
    selfStepPhrases: input.selfStepPhrases === undefined ? defaults.selfStepPhrases : stringList(input.selfStepPhrases, 40, '自己未完成的步骤'),
    requestVerbs: input.requestVerbs === undefined ? defaults.requestVerbs : stringList(input.requestVerbs, 40, '请求动词'),
    requestActions: input.requestActions === undefined ? defaults.requestActions : stringList(input.requestActions, 40, '请求动作'),
    ackTokens: input.ackTokens === undefined ? defaults.ackTokens : stringList(input.ackTokens, 20, 'ACK 词'),
    parkedMarkers: input.parkedMarkers === undefined ? defaults.parkedMarkers : stringList(input.parkedMarkers, 40, '搁置标记'),
    showIgnored: bool(input.showIgnored, false)
  }
  if (options?.validatePatterns) validateWaitingPatterns(config)
  return config
}

export function validateWaitingPatterns(config: WaitingConfig): void {
  compileUserRegexList(config.humanKeywords, '人工动作关键词')
  compileUserRegexList(config.resolvedSignals, '已解决信号')
  compileUserRegexList(config.roleNames, '角色称呼')
  compileUserRegexList(config.roleAskPhrases, '角色请求')
  compileUserRegexList(config.statusHeaders, '状态头')
  compileUserRegexList(config.specMarkers, '需求类标记')
  compileUserRegexList(config.otherActors, '非用户负责人')
  compileUserRegexList(config.selfStepPhrases, '自己未完成的步骤')
  for (const rule of config.statusDocRules) {
    compileUserRegex(rule.pattern, '状态文档正则')
  }
}

/** Turn a user keyword into GitHub search literals. Regex stays in the classifier. */
export function keywordToSearchTerms(pattern: string): string[] {
  const normalized = pattern.trim().replace(/\\s\*/g, ' ?').replace(/\\s\?/g, ' ?').replace(/\\s/g, ' ')
  if (/[\\()[\]{}|+*^$]/.test(normalized)) {
    const bits = normalized.match(/[\p{L}\p{N}_-]{2,}/gu) ?? []
    return [...new Set(bits)]
  }
  const parts = normalized.split(' ?')
  if (parts.length === 1) return [normalized]
  const variants = new Set<string>()
  const gaps = parts.length - 1
  const total = gaps > 6 ? 2 : 1 << gaps
  if (gaps > 6) return [...new Set([parts.join(''), parts.join(' ')].filter(Boolean))]
  for (let mask = 0; mask < total; mask += 1) {
    let text = parts[0] ?? ''
    for (let index = 1; index < parts.length; index += 1) {
      text += (mask & (1 << (index - 1))) ? ' ' : ''
      text += parts[index] ?? ''
    }
    const trimmed = text.trim()
    if (trimmed) variants.add(trimmed)
  }
  return [...variants]
}

export function chunkSearchText(prefix: string, parts: readonly string[], limit = 240): string[] {
  if (parts.length === 0) return prefix ? [prefix] : []
  const queries: string[] = []
  let current: string[] = []
  let length = prefix.length
  for (const part of parts) {
    const extra = part.length + (current.length > 0 ? 4 : 0)
    if (current.length > 0 && length + extra > limit) {
      queries.push(`${prefix}${current.join(' OR ')}`)
      current = [part]
      length = prefix.length + part.length
      continue
    }
    current.push(part)
    length += extra
  }
  if (current.length > 0) queries.push(`${prefix}${current.join(' OR ')}`)
  return queries
}
