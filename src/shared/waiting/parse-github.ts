import type { GithubRecord, RepoAccess } from './types.js'

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
    lastReviewAt: null,
    labelEvents: [],
    fromAssignee: false,
    fromReview: false,
    fromMention: false,
    fromAuthor: false,
    fromOpenPr: false,
    inScopeRepo: false,
    repoAccess: 'unknown',
    authorLogin: '',
    viewerLogin: '',
    isFork: false,
    viewerOwnsRepo: false,
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

const PUSH_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE'])

export function accessFromRepository(repository: Record<string, unknown>, login: string): {
  repoAccess: RepoAccess
  isFork: boolean
  viewerOwnsRepo: boolean
} {
  const ownerLogin = isRecord(repository.owner) ? text(repository.owner.login) : ''
  const hasOwner = ownerLogin.length > 0
  const hasPermission = 'viewerPermission' in repository || 'isFork' in repository || hasOwner
  const viewerOwnsRepo = hasOwner && ownerLogin.toLowerCase() === login.toLowerCase()
  const isFork = repository.isFork === true
  if (!hasPermission) return { repoAccess: 'unknown', isFork: false, viewerOwnsRepo: false }
  const permission = text(repository.viewerPermission).toUpperCase()
  const canPush = PUSH_PERMISSIONS.has(permission)
  const foreignFork = isFork && !viewerOwnsRepo
  const maintain = (viewerOwnsRepo || canPush) && !foreignFork
  return { repoAccess: maintain ? 'maintain' : 'watch', isFork, viewerOwnsRepo }
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

function lastReviewAtOf(node: Record<string, unknown>): string | null {
  let at: string | null = null
  for (const review of connectionNodes(node.reviews).filter(isRecord)) {
    const submitted = text(review.submittedAt) || text(review.createdAt)
    if (!submitted) continue
    if (!at || Date.parse(submitted) > Date.parse(at)) at = submitted
  }
  return at
}

export interface ParseFlags {
  login: string
  fromAssignee?: boolean
  fromReview?: boolean
  fromMention?: boolean
  fromOpenPr?: boolean
  fromAuthor?: boolean
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
  const repository = isRecord(node.repository) ? node.repository : null
  const access = repository ? accessFromRepository(repository, flags.login) : {
    repoAccess: 'unknown' as const,
    isFork: false,
    viewerOwnsRepo: false
  }
  const authorLogin = isRecord(node.author) ? text(node.author.login) : ''
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
    lastReviewAt: lastReviewAtOf(node),
    labelEvents: labelEventsOf(node),
    fromAssignee: flags.fromAssignee === true,
    fromReview: flags.fromReview === true,
    fromMention: flags.fromMention === true,
    fromAuthor: flags.fromAuthor === true,
    fromOpenPr: flags.fromOpenPr === true,
    inScopeRepo: flags.inScopeRepo === true,
    repoAccess: access.repoAccess,
    authorLogin,
    viewerLogin: flags.login,
    isFork: access.isFork,
    viewerOwnsRepo: access.viewerOwnsRepo
  })
  return record
}

function isClosed(node: Record<string, unknown>): boolean {
  return text(node.state).toUpperCase() === 'CLOSED'
}

/**
 * One record for the issue, plus one record per sub-issue. A child keeps its
 * own number and url; it is never copied onto the parent.
 */
export function parseIssueTree(node: unknown, flags: ParseFlags, depth = 2): GithubRecord[] {
  if (!isRecord(node) || isClosed(node)) return []
  const typeName = text(node.__typename)
  if (typeName === 'PullRequest') {
    const pull = parseGithubNode(node, flags)
    return pull ? [pull] : []
  }
  const record = parseGithubNode({ ...node, __typename: typeName || 'Issue' }, flags)
  if (!record || depth <= 0) return record ? [record] : []
  const children = connectionNodes(node.subIssues).flatMap(child => {
    if (!isRecord(child)) return []
    const repository = isRecord(child.repository) ? child.repository : node.repository
    return parseIssueTree({
      ...child,
      __typename: 'Issue',
      repository,
      parent: isRecord(child.parent) ? child.parent : { number: record.number }
    }, {
      login: flags.login,
      inScopeRepo: flags.inScopeRepo === true
    }, depth - 1)
  })
  return [record, ...children]
}

export function parseSearchPayload(payload: unknown, flags: ParseFlags): GithubRecord[] {
  if (!isRecord(payload)) return []
  const search = isRecord(payload.search) ? payload.search : payload
  return connectionNodes(search).flatMap(node => parseIssueTree(node, flags))
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
    .flatMap(issue => parseIssueTree(
      isRecord(issue) ? { ...issue, __typename: 'Issue', repository: { nameWithOwner: name, isEmpty, pushedAt } } : issue,
      { login, inScopeRepo: true }
    ))
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
