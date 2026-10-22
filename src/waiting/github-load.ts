import { githubData, githubErrorMessages, githubGraphql } from '../github/client.js'
import { parseIssueTree, parseRepoNode, parseSearchPayload, type RepoBatchItem } from '../shared/waiting/parse-github.js'
import { tasklistIssueRefs } from '../shared/waiting/sub-issues.js'
import { keywordToSearchTerms, chunkSearchText } from '../shared/waiting/rules.js'
import { repoIsParked } from '../shared/waiting/text-scan.js'
import { GithubAuthError, GithubRateLimitError, earlierReset } from '../shared/waiting/rate-limit.js'
import type { GithubRecord, SourceError, WaitingConfig } from '../shared/waiting/types.js'
import { createGithubRequestScheduler, mapConcurrentOrdered, MAX_GITHUB_REQUESTS, type GithubRequestScheduler } from '../github/concurrency.js'
import { isCancellation, throwIfCancelled } from '../shared/task-scope.js'
import { recentRepoPage, repoPushedInWindow, repoPushCutoff, type RepoFetchWindow } from '../shared/repo-fetch-window.js'
import { repositoryScopeData, repositoryScopePage } from '../github/repository-scope.js'

const ISSUE_FIELDS = `
  number title url body state createdAt updatedAt
  author { login }
  labels(first: 20) { nodes { name } }
  comments(last: 8) { totalCount nodes { body createdAt author { login } } }
  timelineItems(last: 20, itemTypes: [ASSIGNED_EVENT, LABELED_EVENT]) {
    nodes {
      __typename
      ... on AssignedEvent { createdAt actor { login } assignee { ... on User { login } } }
      ... on LabeledEvent { createdAt label { name } }
    }
  }
`

interface IssueSchema {
  withParent: boolean
  withSubIssues: boolean
  subIssuesFallbackConfirmed: boolean
  withTopics: boolean
}

type ChildSelection = 'probe' | 'full'

function childIssueFields(schema: IssueSchema): string {
  const parent = schema.withParent ? 'parent { number }' : ''
  return `
    number title url body state createdAt updatedAt
    author { login }
    labels(first: 10) { nodes { name } }
    comments(last: 4) { totalCount nodes { body createdAt author { login } } }
    ${parent}
  `
}

function issueSelection(schema: IssueSchema, childSelection: ChildSelection = 'probe'): string {
  const parent = schema.withParent ? 'parent { number }' : ''
  const sub = schema.withSubIssues
    ? childSelection === 'probe'
      ? 'subIssues(first: 1) { nodes { number } }'
      : `subIssues(first: 20) { nodes { ${childIssueFields(schema)} } }`
    : ''
  return `${ISSUE_FIELDS} ${parent} ${sub}`
}

function relaxSchema(message: string, schema: IssueSchema): boolean {
  if (schema.withTopics && /repositoryTopics|RepositoryTopic/i.test(message)) {
    schema.withTopics = false
    return true
  }
  if (schema.withSubIssues && /subIssues/i.test(message)
    && /does(?:n't| not) exist|cannot query field|unknown field|undefinedfield|not defined/i.test(message)) {
    schema.withSubIssues = false
    return true
  }
  if (schema.withParent && /parent/i.test(message)) {
    schema.withParent = false
    return true
  }
  return false
}

function mergeRelaxedSchema(target: IssueSchema, source: IssueSchema): void {
  target.withParent = target.withParent && source.withParent
  target.withSubIssues = target.withSubIssues && source.withSubIssues
  target.subIssuesFallbackConfirmed ||= source.subIssuesFallbackConfirmed
  target.withTopics = target.withTopics && source.withTopics
}

const PR_FIELDS = `
  number title url body createdAt updatedAt isDraft
  author { login }
  labels(first: 10) { nodes { name } }
  comments(last: 8) { totalCount nodes { body createdAt author { login } } }
  commits(last: 1) { nodes { commit { pushedDate committedDate } } }
  reviews(last: 5) { nodes { submittedAt } }
  timelineItems(last: 20, itemTypes: [ASSIGNED_EVENT, REVIEW_REQUESTED_EVENT, LABELED_EVENT]) {
    nodes {
      __typename
      ... on AssignedEvent { createdAt actor { login } assignee { ... on User { login } } }
      ... on ReviewRequestedEvent { createdAt actor { login } requestedReviewer { ... on User { login } } }
      ... on LabeledEvent { createdAt label { name } }
    }
  }
`

function searchQuery(schema: IssueSchema): string {
  const issueFields = issueSelection(schema)
  return `
    query($q: String!, $after: String) {
      search(query: $q, type: ISSUE, first: 40, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on Issue {
            ${issueFields}
            repository { ${repoMeta(schema)} }
          }
          ... on PullRequest {
            ${PR_FIELDS}
            repository { ${repoMeta(schema)} }
          }
        }
      }
    }
  `
}

export interface GithubSourceBundle {
  assignee: GithubRecord[]
  reviewRequested: GithubRecord[]
  mentions: GithubRecord[]
  openPrs: GithubRecord[]
  humanIssues: GithubRecord[]
}

export interface GithubLoadResult {
  bySource: GithubSourceBundle
  fresh: Record<keyof GithubSourceBundle, boolean>
  errors: SourceError[]
  notices: string[]
  rateLimitResetAt: string | null
  auth: 'ok' | 'invalid'
  parkedRepos: string[]
}

function repoMeta(schema: IssueSchema, withPermission = true): string {
  const topics = schema.withTopics ? 'repositoryTopics(first: 20) { nodes { topic { name } } }' : ''
  return `nameWithOwner description isEmpty pushedAt isFork ${withPermission ? 'viewerPermission' : ''} owner { login } ${topics}`
}

interface ScopeRepo {
  owner: string
  name: string
  full: string
  isEmpty: boolean
  pushedAt: string | null
  access: 'maintain' | 'watch'
  isFork: boolean
  viewerOwns: boolean
  queryIssues: boolean
  queryPulls: boolean
  description: string
  topics: string[]
}

function splitRepo(full: string): { owner: string, name: string } | null {
  const [owner, name] = full.split('/')
  if (!owner || !name || full.split('/').length !== 2) return null
  return { owner, name }
}

async function graphqlRelax(
  token: string,
  fetchImpl: typeof fetch,
  queryFor: (schema: IssueSchema) => string,
  variables: Record<string, unknown>,
  schema: IssueSchema,
  scheduler: GithubRequestScheduler,
  onAttemptSchema?: (schema: IssueSchema) => void
): Promise<unknown> {
  const localSchema = { ...schema }
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    onAttemptSchema?.({ ...localSchema })
    try {
      const payload = await githubGraphql(token, queryFor(localSchema), variables, fetchImpl, scheduler)
      if (!localSchema.withSubIssues && githubErrorMessages(payload).length === 0) {
        localSchema.subIssuesFallbackConfirmed = true
      }
      onAttemptSchema?.({ ...localSchema })
      mergeRelaxedSchema(schema, localSchema)
      return payload
    } catch (error) {
      if (isCancellation(error)) throw error
      const message = error instanceof Error ? error.message : ''
      if (!relaxSchema(message, localSchema)) {
        mergeRelaxedSchema(schema, localSchema)
        throw error
      }
      last = error
    }
  }
  mergeRelaxedSchema(schema, localSchema)
  throw last instanceof Error ? last : new Error('GitHub GraphQL 查询失败')
}

function loginFromViewer(viewer: unknown): string {
  const login = viewer && typeof viewer === 'object' && 'login' in viewer && typeof viewer.login === 'string'
    ? viewer.login
    : ''
  if (!login) throw new Error('GitHub 响应里没有用户名')
  return login
}

async function viewerLogin(token: string, fetchImpl: typeof fetch, scheduler: GithubRequestScheduler): Promise<string> {
  const payload = await githubGraphql(token, 'query { viewer { login } }', {}, fetchImpl, scheduler)
  return loginFromViewer(githubData(payload).viewer)
}

function issuesPageStatus(node: unknown): 'complete' | 'more' | 'unknown' {
  const connection = node && typeof node === 'object' && 'issues' in node ? node.issues : null
  if (!connection || typeof connection !== 'object' || !('nodes' in connection) || !Array.isArray(connection.nodes)
    || connection.nodes.some(item => !item || typeof item !== 'object')
    || !('pageInfo' in connection) || !connection.pageInfo || typeof connection.pageInfo !== 'object') return 'unknown'
  const pageInfo = connection.pageInfo
  if ('hasNextPage' in pageInfo && pageInfo.hasNextPage === false) return 'complete'
  if ('hasNextPage' in pageInfo && pageInfo.hasNextPage === true
    && 'endCursor' in pageInfo && typeof pageInfo.endCursor === 'string' && pageInfo.endCursor) return 'more'
  return 'unknown'
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function childProbeStatus(node: Record<string, unknown>): 'empty' | 'has-children' | 'unknown' {
  const connection = node.subIssues
  if (!isObjectRecord(connection) || !Array.isArray(connection.nodes)) return 'unknown'
  if (connection.nodes.length === 0) return 'empty'
  const first = connection.nodes[0]
  if (!isObjectRecord(first) || !Number.isInteger(first.number) || Number(first.number) < 1) return 'unknown'
  return 'has-children'
}

function validLabelConnection(value: unknown): boolean {
  return isObjectRecord(value) && Array.isArray(value.nodes)
    && value.nodes.every(label => isObjectRecord(label) && typeof label.name === 'string')
}

function validCommentConnection(value: unknown): boolean {
  return isObjectRecord(value) && Array.isArray(value.nodes)
    && value.nodes.every(comment => isObjectRecord(comment)
      && typeof comment.body === 'string'
      && typeof comment.createdAt === 'string'
      && 'author' in comment)
}

function validFullChildConnection(value: unknown, schema: IssueSchema): value is Record<string, unknown> {
  if (!isObjectRecord(value) || !Array.isArray(value.nodes)) return false
  return value.nodes.every(child => {
    if (!isObjectRecord(child)
      || !Number.isInteger(child.number) || Number(child.number) < 1
      || typeof child.title !== 'string'
      || typeof child.url !== 'string'
      || typeof child.body !== 'string'
      || typeof child.state !== 'string'
      || typeof child.createdAt !== 'string'
      || typeof child.updatedAt !== 'string'
      || !('author' in child)
      || !validLabelConnection(child.labels)
      || !validCommentConnection(child.comments)) return false
    if (!schema.withParent) return true
    if (!('parent' in child)) return false
    return child.parent === null || (isObjectRecord(child.parent)
      && Number.isInteger(child.parent.number) && Number(child.parent.number) > 0)
  })
}

interface ChildHydrationTarget {
  key: string
  owner: string
  name: string
  number: number
  indexes: number[]
}

interface ChildHydrationResult {
  connections: Map<string, Record<string, unknown>>
  complete: boolean
  downgraded: boolean
  errors: unknown[]
  stopFurther: boolean
}

function childHydrationQuery(targets: readonly ChildHydrationTarget[], schema: IssueSchema): string {
  const vars: string[] = []
  const fields: string[] = []
  for (let index = 0; index < targets.length; index += 1) {
    vars.push(`$o${index}: String!`, `$n${index}: String!`, `$i${index}: Int!`)
    const subIssues = schema.withSubIssues
      ? `subIssues(first: 20) { nodes { ${childIssueFields(schema)} } }`
      : ''
    fields.push(`r${index}: repository(owner: $o${index}, name: $n${index}) {
      issue(number: $i${index}) { number ${subIssues} }
    }`)
  }
  return `query(${vars.join(', ')}) { ${fields.join('\n')} }`
}

async function fetchChildConnections(
  token: string,
  fetchImpl: typeof fetch,
  targets: readonly ChildHydrationTarget[],
  schema: IssueSchema,
  scheduler: GithubRequestScheduler
): Promise<ChildHydrationResult> {
  const connections = new Map<string, Record<string, unknown>>()
  const errors: unknown[] = []
  let complete = true
  if (targets.length === 0) return { connections, complete, downgraded: false, errors, stopFurther: false }
  if (scheduler.stopped) {
    if (isCancellation(scheduler.stopped)) throw scheduler.stopped
    return { connections, complete: false, downgraded: false, errors: [scheduler.stopped], stopFurther: true }
  }
  if (!schema.withSubIssues) {
    return {
      connections,
      complete: schema.subIssuesFallbackConfirmed,
      downgraded: schema.subIssuesFallbackConfirmed,
      errors,
      stopFurther: true
    }
  }

  const batches: ChildHydrationTarget[][] = []
  for (let offset = 0; offset < targets.length; offset += 20) batches.push(targets.slice(offset, offset + 20))
  const loaded = await mapConcurrentOrdered(batches, MAX_GITHUB_REQUESTS, async batch => {
    if (scheduler.stopped) {
      if (isCancellation(scheduler.stopped)) throw scheduler.stopped
      return { connections: new Map<string, Record<string, unknown>>(), complete: false, downgraded: false, stopFurther: true, errors: [scheduler.stopped] }
    }
    if (!schema.withSubIssues) {
      return {
        connections: new Map<string, Record<string, unknown>>(),
        complete: schema.subIssuesFallbackConfirmed,
        downgraded: schema.subIssuesFallbackConfirmed,
        stopFurther: true,
        errors: []
      }
    }
    const variables: Record<string, string | number> = {}
    batch.forEach((target, index) => {
      variables[`o${index}`] = target.owner
      variables[`n${index}`] = target.name
      variables[`i${index}`] = target.number
    })
    try {
      let querySchema = { ...schema }
      const payload = await graphqlRelax(
        token,
        fetchImpl,
        currentSchema => childHydrationQuery(batch, currentSchema),
        variables,
        schema,
        scheduler,
        currentSchema => { querySchema = currentSchema }
      )
      const data = githubData(payload)
      const partialErrors = githubErrorMessages(payload)
      const found = new Map<string, Record<string, unknown>>()
      let batchComplete = partialErrors.length === 0
      batch.forEach((target, index) => {
        if (!querySchema.withSubIssues) return
        const repo = data[`r${index}`]
        const issue = isObjectRecord(repo) ? repo.issue : undefined
        const connection = isObjectRecord(issue) ? issue.subIssues : undefined
        if (!validFullChildConnection(connection, querySchema)) {
          batchComplete = false
          return
        }
        found.set(target.key, connection)
      })
      return {
        connections: found,
        complete: batchComplete && (!querySchema.withSubIssues || found.size === batch.length),
        downgraded: !querySchema.withSubIssues && querySchema.subIssuesFallbackConfirmed,
        stopFurther: !querySchema.withSubIssues || scheduler.stopped !== null,
        errors: partialErrors.map(item => new Error(item.message))
      }
    } catch (error) {
      if (isCancellation(error)) throw error
      return {
        connections: new Map<string, Record<string, unknown>>(),
        complete: false,
        downgraded: false,
        stopFurther: !schema.withSubIssues || scheduler.stopped !== null,
        errors: [error]
      }
    }
  }, result => result.stopFurther)

  for (const batch of loaded) {
    if (!batch) {
      if (!schema.subIssuesFallbackConfirmed || scheduler.stopped !== null) complete = false
      continue
    }
    if (!batch.complete) complete = false
    errors.push(...(batch.errors ?? []))
    for (const [key, connection] of batch.connections) connections.set(key, connection)
  }
  return {
    connections,
    complete,
    downgraded: schema.subIssuesFallbackConfirmed && scheduler.stopped === null,
    errors,
    stopFurther: scheduler.stopped !== null || !schema.withSubIssues
  }
}

async function hydrateIssueNodes(
  token: string,
  fetchImpl: typeof fetch,
  nodes: readonly unknown[],
  queryHadErrors: boolean,
  responseSchema: IssueSchema,
  currentSchema: IssueSchema,
  scheduler: GithubRequestScheduler
): Promise<{ nodes: unknown[], complete: boolean, errors: unknown[] }> {
  const hydrated = [...nodes]
  const targets = new Map<string, ChildHydrationTarget>()
  const targetByIndex = new Map<number, string>()
  let complete = !queryHadErrors

  const clearProbe = (index: number): void => {
    const node = hydrated[index]
    if (isObjectRecord(node)) hydrated[index] = { ...node, subIssues: { nodes: [] } }
  }

  nodes.forEach((value, index) => {
    if (!isObjectRecord(value) || value.__typename === 'PullRequest') return
    if (value.__typename && value.__typename !== 'Issue') return
    if (!responseSchema.withSubIssues) {
      clearProbe(index)
      if (!responseSchema.subIssuesFallbackConfirmed) complete = false
      return
    }
    const status = queryHadErrors ? 'unknown' : childProbeStatus(value)
    if (status === 'empty') return
    if (!currentSchema.withSubIssues) {
      clearProbe(index)
      if (!currentSchema.subIssuesFallbackConfirmed) complete = false
      return
    }

    const number = value.number
    const repository = isObjectRecord(value.repository) ? value.repository.nameWithOwner : undefined
    const parts = typeof repository === 'string' ? splitRepo(repository) : null
    if (!Number.isInteger(number) || Number(number) < 1 || !parts) {
      complete = false
      clearProbe(index)
      return
    }
    const key = `${String(repository).toLowerCase()}#${Number(number)}`
    const existing = targets.get(key)
    if (existing) existing.indexes.push(index)
    else targets.set(key, { key, ...parts, number: Number(number), indexes: [index] })
    targetByIndex.set(index, key)
  })

  const fetched = await fetchChildConnections(token, fetchImpl, [...targets.values()], currentSchema, scheduler)
  if (!fetched.complete) complete = false
  for (const [index, key] of targetByIndex) {
    const connection = fetched.connections.get(key)
    const node = hydrated[index]
    if (!isObjectRecord(node)) {
      complete = false
      continue
    }
    if (!connection) {
      hydrated[index] = { ...node, subIssues: { nodes: [] } }
      if (!fetched.downgraded) complete = false
      continue
    }
    hydrated[index] = { ...node, subIssues: connection }
  }
  const errors = [...fetched.errors]
  if (!complete && !queryHadErrors && errors.length === 0) {
    errors.push(new Error('GitHub 子 issue 数据不完整，已保留上次结果'))
  }
  return { nodes: hydrated, complete, errors }
}

function validateDirectIssueTrees(
  nodes: readonly unknown[],
  queryHadErrors: boolean,
  schema: IssueSchema
): { nodes: unknown[], complete: boolean } {
  const safe = [...nodes]
  let complete = !queryHadErrors
  safe.forEach((value, index) => {
    if (!isObjectRecord(value) || value.__typename === 'PullRequest') return
    if (value.__typename && value.__typename !== 'Issue') return
    if (!schema.withSubIssues) {
      safe[index] = { ...value, subIssues: { nodes: [] } }
      if (!schema.subIssuesFallbackConfirmed) complete = false
      return
    }
    if (!validFullChildConnection(value.subIssues, schema)) {
      complete = false
      safe[index] = { ...value, subIssues: { nodes: [] } }
    }
  })
  return { nodes: safe, complete }
}

const REPO_PAGE_SIZE = 40
const REPO_CONTENT_BATCH = 3

const PUSH_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE'])

function readScopeNode(
  node: unknown,
  viewer: string,
  origin: 'owned' | 'watching' | 'explicit'
): ScopeRepo | null {
  if (!node || typeof node !== 'object') return null
  const name = 'nameWithOwner' in node && typeof node.nameWithOwner === 'string' ? node.nameWithOwner : ''
  const parts = splitRepo(name)
  if (!parts) return null
  const isEmpty = 'isEmpty' in node && node.isEmpty === true
  const pushedAt = 'pushedAt' in node && typeof node.pushedAt === 'string' ? node.pushedAt : null
  const ownerLogin = 'owner' in node && node.owner && typeof node.owner === 'object' && 'login' in node.owner
    && typeof node.owner.login === 'string'
    ? node.owner.login
    : ''
  const isFork = 'isFork' in node && node.isFork === true
  const permission = 'viewerPermission' in node && typeof node.viewerPermission === 'string'
    ? node.viewerPermission.toUpperCase()
    : ''
  const hasPermission = 'viewerPermission' in node || 'isFork' in node || ownerLogin.length > 0
  const viewerOwns = ownerLogin
    ? ownerLogin.toLowerCase() === viewer.toLowerCase()
    : origin === 'owned'
  let access: 'maintain' | 'watch' = 'watch'
  if (origin === 'owned') access = 'maintain'
  else if (!hasPermission && origin === 'explicit') access = 'watch'
  else if (!hasPermission) access = 'watch'
  else {
    const canPush = PUSH_PERMISSIONS.has(permission)
    const foreignFork = isFork && !viewerOwns
    access = (viewerOwns || canPush) && !foreignFork ? 'maintain' : 'watch'
  }
  return {
    ...parts,
    full: name,
    isEmpty,
    pushedAt,
    access,
    isFork,
    viewerOwns: origin === 'owned' ? true : viewerOwns,
    queryIssues: false,
    queryPulls: false,
    description: 'description' in node && typeof node.description === 'string' ? node.description : '',
    topics: topicsFromNode(node)
  }
}

function topicsFromNode(node: object): string[] {
  if (!('repositoryTopics' in node)) return []
  const connection = node.repositoryTopics
  if (!connection || typeof connection !== 'object' || !('nodes' in connection) || !Array.isArray(connection.nodes)) return []
  const names: string[] = []
  for (const item of connection.nodes) {
    if (!item || typeof item !== 'object') continue
    const topic = 'topic' in item && item.topic && typeof item.topic === 'object' && 'name' in item.topic && typeof item.topic.name === 'string'
      ? item.topic.name
      : 'name' in item && typeof item.name === 'string'
        ? item.name
        : ''
    if (topic && !names.includes(topic)) names.push(topic)
  }
  return names
}

async function discoverRepos(
  token: string,
  fetchImpl: typeof fetch,
  connection: 'repositories' | 'watching',
  limit: number,
  viewer: string,
  schema: IssueSchema,
  scheduler: GithubRequestScheduler,
  cutoff: number | null,
  initialPage?: unknown
): Promise<{ repos: ScopeRepo[], truncated: boolean }> {
  const repos: ScopeRepo[] = []
  let cursor: string | null = null
  let truncated = false
  const field = connection === 'repositories'
    ? `repositories(first: ${REPO_PAGE_SIZE}, after: $cursor, ownerAffiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC})`
    : `watching(first: ${REPO_PAGE_SIZE}, after: $cursor, orderBy: {field: PUSHED_AT, direction: DESC})`
  const pageCap = Math.max(1, Math.ceil(Math.max(limit, 1) / REPO_PAGE_SIZE) + 1)
  for (let page = 0; page < pageCap && repos.length < limit; page += 1) {
    let listed = page === 0 ? initialPage : undefined
    if (listed === undefined) {
      const payload = await graphqlRelax(token, fetchImpl, currentSchema => `
      query($cursor: String) {
        viewer {
          ${field} {
            pageInfo { hasNextPage endCursor }
            nodes { ${repoMeta(currentSchema, connection !== 'repositories')} }
          }
        }
      }
    `, { cursor }, schema, scheduler)
      const viewerNode = repositoryScopeData(payload).viewer
      listed = viewerNode && typeof viewerNode === 'object' && connection in viewerNode
        ? (viewerNode as Record<string, unknown>)[connection]
        : null
    }
    const batch = repositoryScopePage(listed)
    const recent = recentRepoPage(batch.nodes, cutoff)
    for (const node of recent.nodes) {
      const repo = readScopeNode(node, viewer, connection === 'repositories' ? 'owned' : 'watching')
      if (!repo) continue
      if (repos.length >= limit) {
        truncated = true
        break
      }
      repos.push(repo)
    }
    if (repos.length >= limit && batch.cursor && !recent.reachedCutoff) truncated = true
    if (truncated || recent.reachedCutoff || !batch.cursor) break
    if (page === pageCap - 1) {
      truncated = true
      break
    }
    cursor = batch.cursor
  }
  return { repos, truncated }
}

function metadataQuery(count: number, schema: IssueSchema): string {
  const vars: string[] = []
  const fields: string[] = []
  for (let index = 0; index < count; index += 1) {
    vars.push(`$o${index}: String!`, `$n${index}: String!`)
    fields.push(`r${index}: repository(owner: $o${index}, name: $n${index}) { ${repoMeta(schema)} }`)
  }
  return `query(${vars.join(', ')}) { ${fields.join('\n')} }`
}

async function loadExplicit(
  token: string,
  fetchImpl: typeof fetch,
  repos: readonly string[],
  viewer: string,
  schema: IssueSchema,
  scheduler: GithubRequestScheduler,
  cutoff: number | null
): Promise<ScopeRepo[]> {
  const slices: string[][] = []
  for (let offset = 0; offset < repos.length; offset += 20) slices.push(repos.slice(offset, offset + 20))
  const loaded = await mapConcurrentOrdered(slices, 2, async slice => {
    const variables: Record<string, string> = {}
    slice.forEach((full, index) => {
      const parts = splitRepo(full)
      variables[`o${index}`] = parts?.owner ?? ''
      variables[`n${index}`] = parts?.name ?? ''
    })
    const payload = await graphqlRelax(token, fetchImpl, currentSchema => metadataQuery(slice.length, currentSchema), variables, schema, scheduler)
    const data = repositoryScopeData(payload)
    const found: ScopeRepo[] = []
    slice.forEach((full, index) => {
      const node = data[`r${index}`]
      if (!node || typeof node !== 'object') throw new Error(`GitHub 返回的仓库范围数据不完整：${full}`)
      repoPushedInWindow(node, cutoff) // Validate that a missing timestamp is not treated as never pushed.
      const name = 'nameWithOwner' in node && typeof node.nameWithOwner === 'string' ? node.nameWithOwner : full
      const parts = splitRepo(name)
      if (!parts) return
      const repo = readScopeNode(node, viewer, 'explicit')
      if (!repo) return
      found.push({ ...repo, ...parts, full: name })
    })
    return found
  })
  return loaded.flatMap(items => items ?? [])
}

function contentQuery(count: number, schema: IssueSchema, includePulls: boolean): string {
  const vars: string[] = []
  const fields: string[] = []
  const issueFields = issueSelection(schema)
  for (let index = 0; index < count; index += 1) {
    vars.push(`$o${index}: String!`, `$n${index}: String!`, `$ia${index}: String`)
    if (includePulls) vars.push(`$pa${index}: String`)
    const pulls = includePulls
      ? `
        pullRequests(states: OPEN, first: 40, after: $pa${index}, orderBy: {field: UPDATED_AT, direction: DESC}) {
          pageInfo { hasNextPage endCursor }
          nodes { ${PR_FIELDS} }
        }`
      : ''
    fields.push(`
      r${index}: repository(owner: $o${index}, name: $n${index}) {
        nameWithOwner
        description
        ${schema.withTopics ? 'repositoryTopics(first: 20) { nodes { topic { name } } }' : ''}
        isEmpty
        pushedAt
        issues(states: OPEN, first: 40, after: $ia${index}, orderBy: {field: UPDATED_AT, direction: DESC}) {
          pageInfo { hasNextPage endCursor }
          nodes { ${issueFields} }
        }${pulls}
      }
    `)
  }
  return `query(${vars.join(', ')}) { ${fields.join('\n')} }`
}

interface CursorRepo extends ScopeRepo {
  issueCursor: string | null
  pullCursor: string | null
}

async function loadRepoContents(
  token: string,
  fetchImpl: typeof fetch,
  repos: ScopeRepo[],
  login: string,
  schema: IssueSchema,
  scheduler: GithubRequestScheduler
): Promise<{
  issues: GithubRecord[]
  pullRequests: GithubRecord[]
  completeIssueRepos: string[]
  childTreesComplete: boolean
  hydrationErrors: unknown[]
}> {
  const issues: GithubRecord[] = []
  const pullRequests: GithubRecord[] = []
  const completeIssueRepos = new Set<string>()
  const incompleteIssueRepos = new Set<string>()
  const hydrationErrors: unknown[] = []
  let childTreesComplete = true
  let pending: CursorRepo[] = repos.map(repo => ({ ...repo, issueCursor: null, pullCursor: null }))
  for (let page = 0; page < 4 && pending.length > 0; page += 1) {
    const nextPending: CursorRepo[] = []
    const groups = [
      pending.filter(repo => !repo.queryPulls),
      pending.filter(repo => repo.queryPulls)
    ]
    const slices: Array<{ repos: CursorRepo[], includePulls: boolean }> = []
    for (const group of groups) {
      const includePulls = group.some(repo => repo.queryPulls)
      for (let offset = 0; offset < group.length; offset += REPO_CONTENT_BATCH) {
        slices.push({ repos: group.slice(offset, offset + REPO_CONTENT_BATCH), includePulls })
      }
    }
    const loaded = await mapConcurrentOrdered(slices, MAX_GITHUB_REQUESTS, async ({ repos: slice, includePulls }) => {
      const variables: Record<string, string | null> = {}
      slice.forEach((repo, index) => {
        variables[`o${index}`] = repo.owner
        variables[`n${index}`] = repo.name
        variables[`ia${index}`] = repo.issueCursor
        if (includePulls) variables[`pa${index}`] = repo.pullCursor
      })
      let requestSchema = { ...schema }
      const payload = await graphqlRelax(
        token,
        fetchImpl,
        currentSchema => contentQuery(slice.length, currentSchema, includePulls),
        variables,
        schema,
        scheduler,
        currentSchema => { requestSchema = currentSchema }
      )
      const data = githubData(payload)
      const partialErrors = githubErrorMessages(payload)
      const hasErrors = partialErrors.length > 0
      const combinedIssues: unknown[] = []
      const issueRanges = new Map<number, { start: number, end: number }>()
      slice.forEach((repo, index) => {
        const node = data[`r${index}`]
        const connection = isObjectRecord(node) ? node.issues : undefined
        const rawNodes = isObjectRecord(connection) && Array.isArray(connection.nodes) ? connection.nodes : []
        const start = combinedIssues.length
        const repoName = isObjectRecord(node) && typeof node.nameWithOwner === 'string' ? node.nameWithOwner : repo.full
        const isEmpty = isObjectRecord(node) && node.isEmpty === true
        const pushedAt = isObjectRecord(node) && typeof node.pushedAt === 'string' ? node.pushedAt : null
        combinedIssues.push(...rawNodes.map(issue => isObjectRecord(issue)
          ? { ...issue, __typename: 'Issue', repository: { nameWithOwner: repoName, isEmpty, pushedAt } }
          : issue))
        issueRanges.set(index, { start, end: combinedIssues.length })
      })
      const hydrated = await hydrateIssueNodes(token, fetchImpl, combinedIssues, hasErrors, requestSchema, schema, scheduler)
      hydrationErrors.push(...partialErrors.map(item => new Error(item.message)), ...hydrated.errors)
      if (hydrated.nodes.length !== combinedIssues.length) childTreesComplete = false
      const parsedItems: Array<{ repo: CursorRepo, parsed: RepoBatchItem }> = []
      const complete: string[] = []
      const incomplete: string[] = []
      slice.forEach((repo, index) => {
        const node = data[`r${index}`]
        const range = issueRanges.get(index)
        const connection = isObjectRecord(node) ? node.issues : undefined
        const hydratedNode = isObjectRecord(node) && isObjectRecord(connection) && range
          ? { ...node, issues: { ...connection, nodes: hydrated.nodes.slice(range.start, range.end) } }
          : node
        const parsed: RepoBatchItem | null = parseRepoNode(hydratedNode, login)
        // A missing connection/cursor or a partial GraphQL result cannot prove full coverage.
        if (repo.queryIssues) {
          const status = issuesPageStatus(node)
          if (hasErrors || !hydrated.complete || !parsed || status === 'unknown') incomplete.push(repo.full.toLowerCase())
          else if (status === 'complete') complete.push(repo.full.toLowerCase())
        }
        if (parsed) parsedItems.push({ repo, parsed })
      })
      if (slice.some(repo => repo.queryIssues) && !hydrated.complete) childTreesComplete = false
      return { parsedItems, includePulls, complete, incomplete, hydrationErrors }
    })
    for (const batch of loaded) {
      if (!batch) continue
      for (const full of batch.incomplete) {
        incompleteIssueRepos.add(full)
        completeIssueRepos.delete(full)
      }
      for (const full of batch.complete) {
        if (!incompleteIssueRepos.has(full)) completeIssueRepos.add(full)
      }
      for (const { repo, parsed } of batch.parsedItems) {
        issues.push(...parsed.issues)
        if (batch.includePulls) pullRequests.push(...parsed.pullRequests)
        const pullCursor = batch.includePulls ? parsed.pullCursor : null
        if (parsed.issueCursor || pullCursor) {
          nextPending.push({
            ...repo,
            issueCursor: parsed.issueCursor,
            pullCursor
          })
        }
      }
    }
    pending = nextPending
  }
  return {
    issues,
    pullRequests,
    completeIssueRepos: [...completeIssueRepos],
    childTreesComplete,
    hydrationErrors
  }
}

interface GithubSearchResult {
  records: GithubRecord[]
  complete: boolean
  errors: unknown[]
}

async function searchAll(
  token: string,
  fetchImpl: typeof fetch,
  queryText: string,
  login: string,
  flags: { fromAssignee?: boolean, fromReview?: boolean, fromMention?: boolean, fromAuthor?: boolean },
  state: IssueSchema,
  scheduler: GithubRequestScheduler
): Promise<GithubSearchResult> {
  const records: GithubRecord[] = []
  const errors: unknown[] = []
  let complete = true
  let after: string | null = null
  for (let page = 0; page < 4; page += 1) {
    let requestSchema = { ...state }
    const payload = await graphqlRelax(
      token,
      fetchImpl,
      currentSchema => searchQuery(currentSchema),
      { q: queryText, after },
      state,
      scheduler,
      currentSchema => { requestSchema = currentSchema }
    )
    const search = githubData(payload).search
    const partialErrors = githubErrorMessages(payload)
    const searchRecord = isObjectRecord(search) ? search : null
    const rawNodes = searchRecord && Array.isArray(searchRecord.nodes) ? searchRecord.nodes : []
    const hydrated = await hydrateIssueNodes(token, fetchImpl, rawNodes, partialErrors.length > 0, requestSchema, state, scheduler)
    errors.push(...partialErrors.map(item => new Error(item.message)), ...hydrated.errors)
    if (!hydrated.complete) complete = false
    records.push(...parseSearchPayload({ search: searchRecord ? { ...searchRecord, nodes: hydrated.nodes } : search }, { login, ...flags }))
    const pageInfo = search && typeof search === 'object' && 'pageInfo' in search
      ? (search as { pageInfo?: { hasNextPage?: boolean, endCursor?: string } }).pageInfo
      : undefined
    if (!pageInfo || typeof pageInfo.hasNextPage !== 'boolean') {
      complete = false
      break
    }
    if (!pageInfo.hasNextPage) break
    if (typeof pageInfo.endCursor !== 'string' || !pageInfo.endCursor) {
      complete = false
      break
    }
    if (page === 3) {
      complete = false
      break
    }
    after = pageInfo.endCursor
  }
  if (!complete && errors.length === 0) {
    errors.push(new Error('GitHub 搜索结果不完整，已保留上次结果'))
  }
  return { records, complete, errors }
}

export function humanSearchQueries(config: WaitingConfig, repos: readonly string[]): string[] {
  const terms = [
    ...config.humanKeywords.flatMap(keywordToSearchTerms),
    ...config.humanLabels.map(label => `label:"${label.replace(/"/g, '')}"`)
  ]
  const unique = [...new Set(terms.map(term => term.trim()).filter(Boolean))]
  if (unique.length === 0 || repos.length === 0) return []
  const queries: string[] = []
  for (let offset = 0; offset < repos.length; offset += 8) {
    const repoClause = repos.slice(offset, offset + 8).map(repo => `repo:${repo}`).join(' OR ')
    const prefix = `is:issue is:open (${repoClause}) (`
    const chunks = chunkSearchText(prefix, unique.map(term => (term.includes(' ') && !term.startsWith('label:') ? `"${term}"` : term)))
    for (const chunk of chunks) queries.push(`${chunk})`)
  }
  return queries.slice(0, 12)
}

function sourceFailure(source: string, error: unknown): { error: SourceError, resetAt: string | null, auth: boolean } {
  if (error instanceof GithubAuthError) {
    return { error: { source, message: error.message }, resetAt: null, auth: true }
  }
  if (error instanceof GithubRateLimitError) {
    return { error: { source, message: 'GitHub 速率限制，本页保留上次结果' }, resetAt: error.resetAt, auth: false }
  }
  const message = error instanceof Error ? error.message : '来源失败'
  return { error: { source, message }, resetAt: null, auth: false }
}

function absorbPartialFailures(
  source: string,
  errors: readonly unknown[],
  bucket: { errors: SourceError[], resetAt: string | null, authInvalid: boolean }
): void {
  for (const error of errors) {
    const failure = sourceFailure(source, error)
    bucket.errors.push(failure.error)
    bucket.resetAt = earlierReset(bucket.resetAt, failure.resetAt)
    if (failure.auth) bucket.authInvalid = true
  }
}

async function runSource<T>(
  source: string,
  enabled: boolean,
  task: () => Promise<T>,
  empty: T,
  bucket: { errors: SourceError[], resetAt: string | null, authInvalid: boolean }
): Promise<T | undefined> {
  if (!enabled) return empty
  try {
    return await task()
  } catch (error) {
    if (isCancellation(error)) throw error
    const failure = sourceFailure(source, error)
    bucket.errors.push(failure.error)
    bucket.resetAt = earlierReset(bucket.resetAt, failure.resetAt)
    if (failure.auth) bucket.authInvalid = true
    return undefined
  }
}

async function loadTasklistIssues(
  token: string,
  fetchImpl: typeof fetch,
  records: readonly GithubRecord[],
  login: string,
  schema: IssueSchema,
  scheduler: GithubRequestScheduler
): Promise<GithubSearchResult> {
  const known = new Set(records.map(record => `${record.repo.toLowerCase()}#${record.number}`))
  const missing: { owner: string, name: string, number: number, parentNumber: number | null }[] = []
  const seen = new Set<string>()
  for (const record of records) {
    if (record.kind !== 'issue') continue
    for (const ref of tasklistIssueRefs(record.body, record.repo)) {
      const key = `${ref.repo.toLowerCase()}#${ref.number}`
      if (known.has(key) || seen.has(key)) continue
      const parts = splitRepo(ref.repo)
      if (!parts) continue
      seen.add(key)
      missing.push({
        ...parts,
        number: ref.number,
        parentNumber: ref.repo.toLowerCase() === record.repo.toLowerCase() ? record.number : null
      })
      if (missing.length >= 20) break
    }
    if (missing.length >= 20) break
  }
  const slices: typeof missing[] = []
  for (let offset = 0; offset < missing.length; offset += 8) slices.push(missing.slice(offset, offset + 8))
  const loaded = await mapConcurrentOrdered(slices, 2, async slice => {
    const variables: Record<string, string | number> = {}
    slice.forEach((item, index) => {
      variables[`o${index}`] = item.owner
      variables[`n${index}`] = item.name
      variables[`i${index}`] = item.number
    })
    const vars = slice.map((_, index) => `$o${index}: String!, $n${index}: String!, $i${index}: Int!`).join(', ')
    let requestSchema = { ...schema }
    const payload = await graphqlRelax(
      token,
      fetchImpl,
      currentSchema => {
        const fields = slice.map((_, index) => `
          r${index}: repository(owner: $o${index}, name: $n${index}) {
            nameWithOwner isEmpty pushedAt
            issue(number: $i${index}) { ${issueSelection(currentSchema, 'full')} }
          }
        `).join('\n')
        return `query(${vars}) { ${fields} }`
      },
      variables,
      schema,
      scheduler,
      currentSchema => { requestSchema = currentSchema }
    )
    const data = githubData(payload)
    const found: GithubRecord[] = []
    const tasklistPayload = isObjectRecord(payload) && Array.isArray(payload.errors)
      ? { ...payload, errors: payload.errors.filter(error => {
        if (!isObjectRecord(error) || !Array.isArray(error.path) || error.path.length !== 2
          || typeof error.path[0] !== 'string' || error.path[1] !== 'issue'
          || typeof error.message !== 'string') return true
        const alias = /^r(\d+)$/.exec(error.path[0])
        const missing = /^Could not resolve to an Issue with the number of (\d+)\.?$/i.exec(error.message)
        const repository = data[error.path[0]]
        return !(alias && missing && slice[Number(alias[1])]?.number === Number(missing[1])
          && isObjectRecord(repository) && repository.issue === null)
      }) }
      : payload
    const partialErrors = githubErrorMessages(tasklistPayload)
    let complete = partialErrors.length === 0
    slice.forEach((item, index) => {
      const repoNode = data[`r${index}`]
      if (!isObjectRecord(repoNode) || !('issue' in repoNode)) {
        complete = false
        return
      }
      const name = 'nameWithOwner' in repoNode && typeof repoNode.nameWithOwner === 'string'
        ? repoNode.nameWithOwner
        : `${item.owner}/${item.name}`
      const issue = (repoNode as { issue?: unknown }).issue
      // An explicit null is a valid lookup miss (for example, a PR number in a task list).
      if (issue === null) return
      if (!isObjectRecord(issue)) {
        complete = false
        return
      }
      const direct = validateDirectIssueTrees([{
        ...issue,
        __typename: 'Issue',
        repository: { nameWithOwner: name },
        parent: item.parentNumber === null ? undefined : { number: item.parentNumber }
      }], partialErrors.length > 0, requestSchema)
      if (!direct.complete) complete = false
      found.push(...direct.nodes.flatMap(node => parseIssueTree(node, { login, inScopeRepo: true })))
    })
    return { records: found, complete, errors: partialErrors.map(item => new Error(item.message)) }
  })
  const foundRecords = loaded.flatMap(items => items?.records ?? [])
  const complete = loaded.every(items => items?.complete === true)
  const errors = loaded.flatMap(items => items?.errors ?? [])
  if (!complete && errors.length === 0) {
    errors.push(new Error('GitHub 子 issue 查询结果不完整，已保留上次结果'))
  }
  return { records: foundRecords, complete, errors }
}

export async function loadGithubRecords(options: {
  token: string
  config: WaitingConfig
  watchedRepos: readonly string[]
  repoFetchWindow?: RepoFetchWindow
  now?: Date
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}): Promise<GithubLoadResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const cutoff = repoPushCutoff(options.repoFetchWindow ?? 'all', options.now ?? new Date())
  const scheduler = createGithubRequestScheduler({ signal: options.signal })
  try {
  const bucket = {
    errors: [] as SourceError[],
    notices: [] as string[],
    resetAt: null as string | null,
    authInvalid: false
  }
  const bySource: GithubSourceBundle = {
    assignee: [],
    reviewRequested: [],
    mentions: [],
    openPrs: [],
    humanIssues: []
  }
  const fresh: GithubLoadResult['fresh'] = {
    assignee: false,
    reviewRequested: false,
    mentions: false,
    openPrs: false,
    humanIssues: false
  }
  const searchState: IssueSchema = {
    withParent: true, withSubIssues: true, subIssuesFallbackConfirmed: false, withTopics: true
  }
  let login = ''
  let initialScope: Record<string, unknown> | null = null
  let initialScopeError: unknown
  try {
    if (options.watchedRepos.length > 0) {
      login = await viewerLogin(options.token, fetchImpl, scheduler)
    } else {
      try {
        const payload = await graphqlRelax(options.token, fetchImpl, schema => `
        query {
          viewer {
            login
            repositories(first: ${REPO_PAGE_SIZE}, ownerAffiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC}) {
              pageInfo { hasNextPage endCursor }
              nodes { ${repoMeta(schema, false)} }
            }
            watching(first: ${REPO_PAGE_SIZE}, orderBy: {field: PUSHED_AT, direction: DESC}) {
              pageInfo { hasNextPage endCursor }
              nodes { ${repoMeta(schema)} }
            }
          }
        }
      `, {}, searchState, scheduler)
        const viewer = repositoryScopeData(payload).viewer
        login = loginFromViewer(viewer)
        initialScope = viewer as Record<string, unknown>
      } catch (error) {
        if (isCancellation(error) || error instanceof GithubAuthError || error instanceof GithubRateLimitError) throw error
        initialScopeError = error
        login = await viewerLogin(options.token, fetchImpl, scheduler)
      }
    }
  } catch (error) {
    if (isCancellation(error)) throw error
    const failure = sourceFailure('GitHub', error)
    return {
      bySource,
      fresh,
      errors: [failure.error],
      notices: [],
      rateLimitResetAt: failure.resetAt,
      auth: failure.auth ? 'invalid' : 'ok',
      parkedRepos: []
    }
  }
  throwIfCancelled(options.signal)

  let scope: ScopeRepo[] = []
  let scopeFresh = false
  try {
    if (initialScopeError) throw initialScopeError
    const limit = options.config.maxScopeRepos
    let discovered: ScopeRepo[] = []
    let truncated = false
    if (options.watchedRepos.length > 0) {
      const names = cutoff === null ? options.watchedRepos.slice(0, limit) : options.watchedRepos
      const explicit = await loadExplicit(options.token, fetchImpl, names, login, searchState, scheduler, cutoff)
      const recent = explicit.filter(repo => repoPushedInWindow(repo, cutoff))
      truncated = cutoff === null ? options.watchedRepos.length > limit : recent.length > limit
      discovered = recent.slice(0, limit)
    } else {
      const owned = await discoverRepos(options.token, fetchImpl, 'repositories', limit, login, searchState, scheduler, cutoff, initialScope?.repositories)
      const room = Math.max(0, limit - owned.repos.length)
      let watchingRepos: ScopeRepo[] = []
      let watchingTruncated = false
      if (room > 0) {
        const watching = await discoverRepos(options.token, fetchImpl, 'watching', room, login, searchState, scheduler, cutoff, initialScope?.watching)
        watchingRepos = watching.repos
        watchingTruncated = watching.truncated
      } else if (!owned.truncated) {
        const peek = await discoverRepos(options.token, fetchImpl, 'watching', 1, login, searchState, scheduler, cutoff, initialScope?.watching)
        watchingTruncated = peek.repos.length > 0
      }
      truncated = owned.truncated || watchingTruncated
      discovered = [...owned.repos, ...watchingRepos]
    }
    if (truncated) {
      bucket.notices.push(`仓库数量达到上限 ${limit}，其余仓库没有继续查询。到设置里调高「仓库数量上限」。`)
    }
    const seen = new Set<string>()
    scope = []
    for (const repo of discovered) {
      if (seen.has(repo.full.toLowerCase())) continue
      seen.add(repo.full.toLowerCase())
      scope.push(repo)
    }
    scopeFresh = true
  } catch (error) {
    if (isCancellation(error)) throw error
    const failure = sourceFailure('仓库范围', error)
    bucket.errors.push(failure.error)
    bucket.resetAt = earlierReset(bucket.resetAt, failure.resetAt)
    if (failure.auth) bucket.authInvalid = true
  }
  throwIfCancelled(options.signal)

  const scopeByName = new Map(scope.map(repo => [repo.full.toLowerCase(), repo]))
  const planned = scope.flatMap(repo => {
    const maintain = repo.access === 'maintain'
    const queryIssues = maintain && options.config.sources.humanIssues
    const queryPulls = !repo.isEmpty && options.config.sources.openPrs && (
      maintain || options.config.openPrScope === 'watching'
    )
    if (!queryIssues && !queryPulls) return []
    return [{ ...repo, queryIssues, queryPulls }]
  })
  const wantContents = planned.length > 0
  const contentScope = planned
  const contentsEnabled = wantContents && contentScope.length > 0 && !bucket.authInvalid && !scheduler.stopped
  const markScope = (records: GithubRecord[]): GithubRecord[] => records.map(record => {
    const known = scopeByName.get(record.repo.toLowerCase())
    if (!known) return { ...record, viewerLogin: record.viewerLogin || login }
    return {
      ...record,
      viewerLogin: record.viewerLogin || login,
      inScopeRepo: true,
      repoAccess: known.access,
      isFork: known.isFork,
      viewerOwnsRepo: known.viewerOwns,
      repoDescription: record.repoDescription || known.description,
      repoTopics: record.repoTopics.length > 0 ? record.repoTopics : known.topics
    }
  })

  const maintainNames = scope.filter(repo => repo.access === 'maintain').map(repo => repo.full)
  const watchNames = scope.filter(repo => repo.access === 'watch').map(repo => repo.full)
  const authorEnabled = watchNames.length > 0 && (
    options.config.sources.openPrs || options.config.sources.humanIssues || options.config.sources.mentions
  ) && !bucket.authInvalid && !scheduler.stopped
  const authorQueries: string[] = []
  for (let offset = 0; offset < watchNames.length; offset += 8) {
    const repoClause = watchNames.slice(offset, offset + 8).map(repo => `repo:${repo}`).join(' OR ')
    authorQueries.push(`author:@me is:open (${repoClause})`)
  }
  const sourceBuckets = Array.from({ length: 6 }, () => ({
    errors: [] as SourceError[], resetAt: null as string | null, authInvalid: false
  }))
  const contentsAndHuman = (async () => {
    const contents = await runSource('仓库内容', contentsEnabled,
      () => loadRepoContents(options.token, fetchImpl, contentScope, login, searchState, scheduler),
      undefined, sourceBuckets[0]!)
    if (contents) absorbPartialFailures('仓库内容', contents.hydrationErrors, sourceBuckets[0]!)
    throwIfCancelled(options.signal)
    const complete = new Set(contents?.completeIssueRepos ?? [])
    const humanQueries = humanSearchQueries(options.config, maintainNames.filter(full => !complete.has(full.toLowerCase())))
    const humanEnabled = options.config.sources.humanIssues && humanQueries.length > 0 && !bucket.authInvalid && !scheduler.stopped
    const humanSearch = await runSource('要人动手', humanEnabled, async () => {
      const pages = await mapConcurrentOrdered(humanQueries, MAX_GITHUB_REQUESTS, queryText =>
        searchAll(options.token, fetchImpl, queryText, login, {}, searchState, scheduler))
      return {
        records: pages.flatMap(page => page?.records ?? []).map(record => ({ ...record, inScopeRepo: true })),
        complete: pages.every(page => page?.complete === true),
        errors: pages.flatMap(page => page?.errors ?? [])
      }
    }, undefined, sourceBuckets[4]!)
    if (humanSearch) absorbPartialFailures('要人动手', humanSearch.errors, sourceBuckets[4]!)
    return { contents, humanSearch, humanEnabled }
  })()
  const [{ contents, humanSearch, humanEnabled }, assignee, review, mentions, author] = await Promise.all([
    contentsAndHuman,
    runSource('指派', options.config.sources.assignee && !bucket.authInvalid && !scheduler.stopped,
      () => searchAll(options.token, fetchImpl, 'assignee:@me is:open', login, { fromAssignee: true }, searchState, scheduler),
      undefined, sourceBuckets[1]!),
    runSource('请求 review', options.config.sources.reviewRequested && !bucket.authInvalid && !scheduler.stopped,
      () => searchAll(options.token, fetchImpl, 'review-requested:@me is:pr is:open', login, { fromReview: true }, searchState, scheduler),
      undefined, sourceBuckets[2]!),
    runSource('提及', options.config.sources.mentions && !bucket.authInvalid && !scheduler.stopped,
      () => searchAll(options.token, fetchImpl, 'mentions:@me is:open', login, { fromMention: true }, searchState, scheduler),
      undefined, sourceBuckets[3]!),
    runSource('作者', authorEnabled, async () => {
      const pages = await mapConcurrentOrdered(authorQueries, MAX_GITHUB_REQUESTS, queryText =>
        searchAll(options.token, fetchImpl, queryText, login, { fromAuthor: true }, searchState, scheduler))
      return {
        records: pages.flatMap(page => page?.records ?? []),
        complete: pages.every(page => page?.complete === true),
        errors: pages.flatMap(page => page?.errors ?? [])
      }
    }, undefined, sourceBuckets[5]!)
  ])
  throwIfCancelled(options.signal)
  if (assignee) absorbPartialFailures('指派', assignee.errors, sourceBuckets[1]!)
  if (review) absorbPartialFailures('请求 review', review.errors, sourceBuckets[2]!)
  if (mentions) absorbPartialFailures('提及', mentions.errors, sourceBuckets[3]!)
  if (author) absorbPartialFailures('作者', author.errors, sourceBuckets[5]!)
  for (const sourceBucket of sourceBuckets) {
    bucket.errors.push(...sourceBucket.errors)
    bucket.resetAt = earlierReset(bucket.resetAt, sourceBucket.resetAt)
    bucket.authInvalid ||= sourceBucket.authInvalid
  }
  if (contents) {
    bySource.openPrs = contents.pullRequests.map(record => ({ ...record, inScopeRepo: true, fromOpenPr: true }))
    bySource.humanIssues = contents.issues.map(record => ({ ...record, inScopeRepo: true }))
    fresh.openPrs = true
  }
  if (scopeFresh && !contentsEnabled) fresh.openPrs = true
  if (assignee) {
    bySource.assignee = markScope(assignee.records)
    fresh.assignee = assignee.complete
  }
  if (review) {
    bySource.reviewRequested = markScope(review.records)
    fresh.reviewRequested = review.complete
  }
  if (mentions) {
    bySource.mentions = markScope(mentions.records)
    fresh.mentions = mentions.complete
  }
  if (humanSearch) bySource.humanIssues.push(...humanSearch.records)
  if (author) {
    bySource.humanIssues.push(...markScope(author.records.map(record => ({ ...record, fromAuthor: true }))))
  }
  const humanFailed = (contentsEnabled && !contents)
    || !!contents && !contents.childTreesComplete
    || (humanEnabled && (!humanSearch || !humanSearch.complete))
    || (authorEnabled && (!author || !author.complete))
  fresh.humanIssues = !humanFailed && (scopeFresh || !!(contents || humanSearch || author))

  const pooled = [
    ...bySource.assignee,
    ...bySource.reviewRequested,
    ...bySource.mentions,
    ...bySource.openPrs,
    ...bySource.humanIssues
  ]
  const needsTasklist = pooled.some(record => record.kind === 'issue' && tasklistIssueRefs(record.body, record.repo).length > 0)
  const linkedEnabled = needsTasklist && !bucket.authInvalid && !scheduler.stopped
  const linked = await runSource(
    '子 issue',
    linkedEnabled,
    () => loadTasklistIssues(options.token, fetchImpl, pooled, login, searchState, scheduler),
    undefined,
    bucket
  )
  throwIfCancelled(options.signal)
  if (linked) {
    absorbPartialFailures('子 issue', linked.errors, bucket)
    bySource.humanIssues = [...bySource.humanIssues, ...linked.records]
    fresh.humanIssues = !humanFailed && linked.complete
  } else if (needsTasklist) {
    fresh.humanIssues = false
  }

  bySource.assignee = markScope(bySource.assignee)
  bySource.reviewRequested = markScope(bySource.reviewRequested)
  bySource.mentions = markScope(bySource.mentions)
  bySource.openPrs = markScope(bySource.openPrs)
  bySource.humanIssues = markScope(bySource.humanIssues)

  const parked = new Set<string>()
  for (const repo of scope) {
    if (repoIsParked(repo.description, repo.topics, options.config.parkedMarkers)) parked.add(repo.full)
  }
  for (const record of Object.values(bySource).flat()) {
    if (repoIsParked(record.repoDescription, record.repoTopics, options.config.parkedMarkers)) parked.add(record.repo)
  }

  return {
    bySource,
    fresh,
    errors: bucket.errors,
    notices: bucket.notices,
    rateLimitResetAt: bucket.resetAt,
    auth: bucket.authInvalid ? 'invalid' : 'ok',
    parkedRepos: [...parked]
  }
  } finally {
    scheduler.dispose()
  }
}
