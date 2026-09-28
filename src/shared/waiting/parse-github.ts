import type { GithubRecord } from './types.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function connectionNodes(value: unknown): unknown[] {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return []
  return value.nodes.filter(node => node != null)
}

export function blankRecord(partial: Pick<GithubRecord, 'kind' | 'repo' | 'number' | 'title' | 'url'> & Partial<GithubRecord>): GithubRecord {
  return {
    repoIsEmpty: false,
    repoPushedAt: null,
    body: '',
    createdAt: partial.updatedAt ?? '',
    updatedAt: '',
    isDraft: false,
    labels: [],
    comments: [],
    parentNumber: null,
    assignedAt: null,
    reviewRequestedAt: null,
    mentionedAt: null,
    lastPushedAt: null,
    labelEvents: [],
    fromAssignee: false,
    fromReview: false,
    fromMention: false,
    fromOpenPr: false,
    inScopeRepo: false,
    ...partial
  }
}

function repoFields(node: Record<string, unknown>): { repo: string, repoIsEmpty: boolean, repoPushedAt: string | null } {
  const repository = isRecord(node.repository) ? node.repository : node
  return {
    repo: text(repository.nameWithOwner),
    repoIsEmpty: repository.isEmpty === true,
    repoPushedAt: typeof repository.pushedAt === 'string' ? repository.pushedAt : null
  }
}

function labelsOf(node: Record<string, unknown>): string[] {
  const names: string[] = []
  for (const label of connectionNodes(node.labels)) {
    if (!isRecord(label)) continue
    const name = text(label.name)
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

function commentsOf(node: Record<string, unknown>): { body: string, createdAt: string }[] {
  const comments = connectionNodes(node.comments)
    .filter(isRecord)
    .map(comment => ({ body: text(comment.body), createdAt: text(comment.createdAt) }))
    .filter(comment => comment.createdAt || comment.body)
  comments.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
  return comments
}

function loginOf(value: unknown): string {
  if (!isRecord(value)) return ''
  if (typeof value.login === 'string') return value.login
  return ''
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function findMentionTime(
  body: string,
  createdAt: string,
  comments: readonly { body: string, createdAt: string }[],
  login: string
): string | null {
  if (!login) return null
  const pattern = new RegExp(`@${escapeRegex(login)}\\b`, 'i')
  let at: string | null = null
  if (pattern.test(body)) at = createdAt || null
  for (const comment of comments) {
    if (pattern.test(comment.body)) at = comment.createdAt || at
  }
  return at
}

function timelineNodes(node: Record<string, unknown>): Record<string, unknown>[] {
  return connectionNodes(node.timelineItems).filter(isRecord)
}

export function assignedAtFor(node: Record<string, unknown>, login: string): string | null {
  let at: string | null = null
  for (const event of timelineNodes(node)) {
    const typeName = text(event.__typename)
    if (typeName && typeName !== 'AssignedEvent') continue
    const assignee = loginOf(event.assignee)
    if (login && assignee && assignee.toLowerCase() !== login.toLowerCase()) continue
    if (!assignee && login) continue
    const createdAt = text(event.createdAt)
    if (!createdAt) continue
    if (!at || Date.parse(createdAt) > Date.parse(at)) at = createdAt
  }
  return at
}

export function reviewRequestedAtFor(node: Record<string, unknown>, login: string): string | null {
  let at: string | null = null
  for (const event of timelineNodes(node)) {
    const typeName = text(event.__typename)
    if (typeName && typeName !== 'ReviewRequestedEvent') continue
    const reviewer = loginOf(event.requestedReviewer)
    if (login && reviewer && reviewer.toLowerCase() !== login.toLowerCase()) continue
    if (!reviewer && login) continue
    const createdAt = text(event.createdAt)
    if (!createdAt) continue
    if (!at || Date.parse(createdAt) > Date.parse(at)) at = createdAt
  }
  return at
}

export function labelEventsOf(node: Record<string, unknown>): { name: string, at: string }[] {
  const events: { name: string, at: string }[] = []
  for (const event of timelineNodes(node)) {
    const typeName = text(event.__typename)
    if (typeName && typeName !== 'LabeledEvent') continue
    const label = isRecord(event.label) ? text(event.label.name) : ''
    const at = text(event.createdAt)
    if (!label || !at) continue
    events.push({ name: label, at })
  }
  return events
}

function lastPush(node: Record<string, unknown>): string | null {
  const commits = connectionNodes(node.commits).filter(isRecord)
  const commit = commits.length > 0 && isRecord(commits[commits.length - 1]?.commit)
    ? commits[commits.length - 1]?.commit
    : null
  if (!isRecord(commit)) return null
  const pushed = text(commit.pushedDate) || text(commit.committedDate)
  return pushed || null
}

export interface ParseFlags {
  login: string
  fromAssignee?: boolean
  fromReview?: boolean
  fromMention?: boolean
  fromOpenPr?: boolean
  inScopeRepo?: boolean
}

export function parseGithubNode(node: unknown, flags: ParseFlags): GithubRecord | null {
  if (!isRecord(node)) return null
  const typeName = text(node.__typename)
  const resolvedKind = typeName === 'PullRequest' || (typeName !== 'Issue' && flags.fromOpenPr === true)
    ? 'pr'
    : 'issue'
  const number = numberValue(node.number)
  const repo = repoFields(node)
  if (!number || !repo.repo) return null
  const comments = commentsOf(node)
  const createdAt = text(node.createdAt)
  const body = text(node.body)
  const record = blankRecord({
    kind: resolvedKind,
    repo: repo.repo,
    repoIsEmpty: repo.repoIsEmpty,
    repoPushedAt: repo.repoPushedAt,
    number,
    title: text(node.title) || `${resolvedKind} #${number}`,
    url: text(node.url),
    body,
    createdAt,
    updatedAt: text(node.updatedAt) || createdAt,
    isDraft: node.isDraft === true,
    labels: labelsOf(node),
    comments,
    parentNumber: isRecord(node.parent) ? numberValue(node.parent.number) : null,
    assignedAt: assignedAtFor(node, flags.login),
    reviewRequestedAt: reviewRequestedAtFor(node, flags.login),
    mentionedAt: flags.fromMention ? findMentionTime(body, createdAt, comments, flags.login) : null,
    lastPushedAt: lastPush(node),
    labelEvents: labelEventsOf(node),
    fromAssignee: flags.fromAssignee === true,
    fromReview: flags.fromReview === true,
    fromMention: flags.fromMention === true,
    fromOpenPr: flags.fromOpenPr === true,
    inScopeRepo: flags.inScopeRepo === true
  })
  return record
}

export function parseSearchPayload(payload: unknown, flags: ParseFlags): GithubRecord[] {
  if (!isRecord(payload)) return []
  const search = isRecord(payload.search) ? payload.search : payload
  return connectionNodes(search)
    .map(node => parseGithubNode(node, flags))
    .filter((record): record is GithubRecord => record !== null)
}

export interface RepoBatchItem {
  repo: string
  isEmpty: boolean
  pushedAt: string | null
  issues: GithubRecord[]
  pullRequests: GithubRecord[]
  issueCursor: string | null
  pullCursor: string | null
}

function nextCursor(connection: unknown): string | null {
  if (!isRecord(connection) || !isRecord(connection.pageInfo)) return null
  if (connection.pageInfo.hasNextPage !== true) return null
  const cursor = connection.pageInfo.endCursor
  return typeof cursor === 'string' && cursor ? cursor : null
}

export function parseRepoNode(node: unknown, login: string): RepoBatchItem | null {
  if (!isRecord(node)) return null
  const name = text(node.nameWithOwner)
  if (!name) return null
  const isEmpty = node.isEmpty === true
  const pushedAt = typeof node.pushedAt === 'string' ? node.pushedAt : null
  const withRepo = (record: GithubRecord): GithubRecord => ({
    ...record,
    repo: name,
    repoIsEmpty: isEmpty,
    repoPushedAt: pushedAt
  })
  const issues = connectionNodes(node.issues)
    .map(issue => parseGithubNode(
      isRecord(issue) ? { ...issue, __typename: 'Issue', repository: { nameWithOwner: name, isEmpty, pushedAt } } : issue,
      { login, inScopeRepo: true }
    ))
    .filter((record): record is GithubRecord => record !== null)
    .map(withRepo)
  const pullRequests = connectionNodes(node.pullRequests)
    .map(pull => parseGithubNode(
      isRecord(pull) ? { ...pull, __typename: 'PullRequest', repository: { nameWithOwner: name, isEmpty, pushedAt } } : pull,
      { login, fromOpenPr: true, inScopeRepo: true }
    ))
    .filter((record): record is GithubRecord => record !== null)
    .map(withRepo)
  return {
    repo: name,
    isEmpty,
    pushedAt,
    issues,
    pullRequests,
    issueCursor: nextCursor(node.issues),
    pullCursor: nextCursor(node.pullRequests)
  }
}
