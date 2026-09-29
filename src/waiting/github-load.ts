import { parseIssueTree, parseRepoNode, parseSearchPayload, type RepoBatchItem } from '../shared/waiting/parse-github.js'
import { tasklistIssueRefs } from '../shared/waiting/sub-issues.js'
import { keywordToSearchTerms, chunkSearchText } from '../shared/waiting/rules.js'
import { GithubAuthError, GithubRateLimitError, earlierReset, rateLimitFromResponse } from '../shared/waiting/rate-limit.js'
import type { GithubRecord, SourceError, WaitingConfig } from '../shared/waiting/types.js'

const API = 'https://api.github.com/graphql'

const ISSUE_FIELDS = `
  number title url body createdAt updatedAt
  author { login }
  labels(first: 20) { nodes { name } }
  comments(last: 8) { nodes { body createdAt } }
  timelineItems(last: 20, itemTypes: [ASSIGNED_EVENT, LABELED_EVENT]) {
    nodes {
      __typename
      ... on AssignedEvent { createdAt assignee { ... on User { login } } }
      ... on LabeledEvent { createdAt label { name } }
    }
  }
`

interface IssueSchema {
  withParent: boolean
  withSubIssues: boolean
}

function issueSelection(schema: IssueSchema): string {
  const parent = schema.withParent ? 'parent { number }' : ''
  const sub = schema.withSubIssues
    ? `subIssues(first: 20) { nodes {
        number title url body state createdAt updatedAt
        author { login }
        labels(first: 10) { nodes { name } }
        comments(last: 4) { nodes { body createdAt } }
        ${parent}
      } }`
    : ''
  return `${ISSUE_FIELDS} ${parent} ${sub}`
}

function relaxSchema(message: string, schema: IssueSchema): boolean {
  if (schema.withSubIssues && /subIssues/i.test(message)) {
    schema.withSubIssues = false
    return true
  }
  if (schema.withParent && /parent/i.test(message)) {
    schema.withParent = false
    return true
  }
  return false
}

const PR_FIELDS = `
  number title url body createdAt updatedAt isDraft
  author { login }
  labels(first: 10) { nodes { name } }
  comments(last: 8) { nodes { body createdAt } }
  commits(last: 1) { nodes { commit { committedDate } } }
  timelineItems(last: 20, itemTypes: [ASSIGNED_EVENT, REVIEW_REQUESTED_EVENT, LABELED_EVENT]) {
    nodes {
      __typename
      ... on AssignedEvent { createdAt assignee { ... on User { login } } }
      ... on ReviewRequestedEvent { createdAt requestedReviewer { ... on User { login } } }
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
            repository { nameWithOwner isEmpty pushedAt isFork viewerPermission owner { login } }
          }
          ... on PullRequest {
            ${PR_FIELDS}
            repository { nameWithOwner isEmpty pushedAt isFork viewerPermission owner { login } }
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
}

const REPO_META = 'nameWithOwner isEmpty pushedAt isFork viewerPermission owner { login }'

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
}

function splitRepo(full: string): { owner: string, name: string } | null {
  const [owner, name] = full.split('/')
  if (!owner || !name || full.split('/').length !== 2) return null
  return { owner, name }
}

async function graphql(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: typeof fetch
): Promise<unknown> {
  let response: Response
  try {
    response = await fetchImpl(API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Arckeep',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({ query, variables })
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '网络错误'
    throw new Error(`连不上 GitHub：${message}`)
  }
  const bodyText = await response.text()
  if (response.status === 401) throw new GithubAuthError()
  const resetAt = rateLimitFromResponse(response.status, response.headers, bodyText)
  if (resetAt) throw new GithubRateLimitError(resetAt)
  let payload: unknown
  try {
    payload = JSON.parse(bodyText) as unknown
  } catch {
    throw new Error(`GitHub 响应无法解析（HTTP ${response.status}）`)
  }
  if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`)
  if (payload && typeof payload === 'object' && payload !== null && 'errors' in payload) {
    const errors = (payload as { errors?: unknown }).errors
    const messages = Array.isArray(errors)
      ? errors.map(error => (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') ? error.message : '')
      : []
    const rate = messages.some(message => /rate limit/i.test(message))
    if (rate) {
      const headerReset = rateLimitFromResponse(403, response.headers, messages.join('\n'))
      throw new GithubRateLimitError(headerReset ?? new Date(Date.now() + 60_000).toISOString())
    }
    const data = (payload as { data?: unknown }).data
    if (data === null || data === undefined) {
      throw new Error(messages.filter(Boolean).join('；') || 'GitHub GraphQL 查询失败')
    }
  }
  return payload
}

async function graphqlRelax(
  token: string,
  fetchImpl: typeof fetch,
  queryFor: () => string,
  variables: Record<string, unknown>,
  schema: IssueSchema
): Promise<unknown> {
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await graphql(token, queryFor(), variables, fetchImpl)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (!relaxSchema(message, schema)) throw error
      last = error
    }
  }
  throw last instanceof Error ? last : new Error('GitHub GraphQL 查询失败')
}

function dataOf(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {}
  const data = (payload as { data?: unknown }).data
  if (!data || typeof data !== 'object') return {}
  return data as Record<string, unknown>
}

async function viewerLogin(token: string, fetchImpl: typeof fetch): Promise<string> {
  const payload = await graphql(token, 'query { viewer { login } }', {}, fetchImpl)
  const data = dataOf(payload)
  const viewer = data.viewer
  const login = viewer && typeof viewer === 'object' && 'login' in viewer && typeof viewer.login === 'string'
    ? viewer.login
    : ''
  if (!login) throw new Error('GitHub 响应里没有用户名')
  return login
}

function connectionPage(value: unknown): { nodes: unknown[], cursor: string | null } {
  if (!value || typeof value !== 'object') return { nodes: [], cursor: null }
  const connection = value as { nodes?: unknown, pageInfo?: { hasNextPage?: boolean, endCursor?: string } }
  const nodes = Array.isArray(connection.nodes) ? connection.nodes : []
  const cursor = connection.pageInfo?.hasNextPage && connection.pageInfo.endCursor
    ? connection.pageInfo.endCursor
    : null
  return { nodes, cursor }
}

const REPO_PAGE_SIZE = 40

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
    queryPulls: false
  }
}

async function discoverRepos(
  token: string,
  fetchImpl: typeof fetch,
  connection: 'repositories' | 'watching',
  limit: number,
  viewer: string
): Promise<{ repos: ScopeRepo[], truncated: boolean }> {
  const repos: ScopeRepo[] = []
  let cursor: string | null = null
  let truncated = false
  const field = connection === 'repositories'
    ? `repositories(first: ${REPO_PAGE_SIZE}, after: $cursor, ownerAffiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC})`
    : `watching(first: ${REPO_PAGE_SIZE}, after: $cursor)`
  const pageCap = Math.max(1, Math.ceil(Math.max(limit, 1) / REPO_PAGE_SIZE) + 1)
  for (let page = 0; page < pageCap && repos.length < limit; page += 1) {
    const payload = await graphql(token, `
      query($cursor: String) {
        viewer {
          ${field} {
            pageInfo { hasNextPage endCursor }
            nodes { ${REPO_META} }
          }
        }
      }
    `, { cursor }, fetchImpl)
    const viewerNode = dataOf(payload).viewer
    const listed = viewerNode && typeof viewerNode === 'object' && connection in viewerNode
      ? (viewerNode as Record<string, unknown>)[connection]
      : null
    const batch = connectionPage(listed)
    for (const node of batch.nodes) {
      const repo = readScopeNode(node, viewer, connection === 'repositories' ? 'owned' : 'watching')
      if (!repo) continue
      if (repos.length >= limit) {
        truncated = true
        break
      }
      repos.push(repo)
    }
    if (repos.length >= limit && batch.cursor) truncated = true
    if (truncated || !batch.cursor) break
    if (page === pageCap - 1) {
      truncated = true
      break
    }
    cursor = batch.cursor
  }
  return { repos, truncated }
}

function metadataQuery(count: number): string {
  const vars: string[] = []
  const fields: string[] = []
  for (let index = 0; index < count; index += 1) {
    vars.push(`$o${index}: String!`, `$n${index}: String!`)
    fields.push(`r${index}: repository(owner: $o${index}, name: $n${index}) { ${REPO_META} }`)
  }
  return `query(${vars.join(', ')}) { ${fields.join('\n')} }`
}

async function loadExplicit(token: string, fetchImpl: typeof fetch, repos: readonly string[], viewer: string): Promise<ScopeRepo[]> {
  const found: ScopeRepo[] = []
  for (let offset = 0; offset < repos.length; offset += 20) {
    const slice = repos.slice(offset, offset + 20)
    const variables: Record<string, string> = {}
    slice.forEach((full, index) => {
      const parts = splitRepo(full)
      variables[`o${index}`] = parts?.owner ?? ''
      variables[`n${index}`] = parts?.name ?? ''
    })
    const payload = await graphql(token, metadataQuery(slice.length), variables, fetchImpl)
    const data = dataOf(payload)
    slice.forEach((full, index) => {
      const node = data[`r${index}`]
      if (!node || typeof node !== 'object') return
      const name = 'nameWithOwner' in node && typeof node.nameWithOwner === 'string' ? node.nameWithOwner : full
      const parts = splitRepo(name)
      if (!parts) return
      const repo = readScopeNode(node, viewer, 'explicit')
      if (!repo) return
      found.push({ ...repo, ...parts, full: name })
    })
  }
  return found
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
  schema: IssueSchema
): Promise<{ issues: GithubRecord[], pullRequests: GithubRecord[] }> {
  const issues: GithubRecord[] = []
  const pullRequests: GithubRecord[] = []
  let pending: CursorRepo[] = repos.map(repo => ({ ...repo, issueCursor: null, pullCursor: null }))
  for (let page = 0; page < 4 && pending.length > 0; page += 1) {
    const nextPending: CursorRepo[] = []
    const groups = [
      pending.filter(repo => !repo.queryPulls),
      pending.filter(repo => repo.queryPulls)
    ]
    for (const group of groups) {
      if (group.length === 0) continue
      const includePulls = group.some(repo => repo.queryPulls)
      for (let offset = 0; offset < group.length; offset += 8) {
        const slice = group.slice(offset, offset + 8)
        const variables: Record<string, string | null> = {}
        slice.forEach((repo, index) => {
          variables[`o${index}`] = repo.owner
          variables[`n${index}`] = repo.name
          variables[`ia${index}`] = repo.issueCursor
          if (includePulls) variables[`pa${index}`] = repo.pullCursor
        })
        const payload = await graphqlRelax(
          token,
          fetchImpl,
          () => contentQuery(slice.length, schema, includePulls),
          variables,
          schema
        )
        const data = dataOf(payload)
        slice.forEach((repo, index) => {
          const parsed: RepoBatchItem | null = parseRepoNode(data[`r${index}`], login)
          if (!parsed) return
          issues.push(...parsed.issues)
          if (includePulls) pullRequests.push(...parsed.pullRequests)
          const pullCursor = includePulls ? parsed.pullCursor : null
          if (parsed.issueCursor || pullCursor) {
            nextPending.push({
              ...repo,
              issueCursor: parsed.issueCursor,
              pullCursor
            })
          }
        })
      }
    }
    pending = nextPending
  }
  return { issues, pullRequests }
}

async function searchAll(
  token: string,
  fetchImpl: typeof fetch,
  queryText: string,
  login: string,
  flags: { fromAssignee?: boolean, fromReview?: boolean, fromMention?: boolean, fromAuthor?: boolean },
  state: IssueSchema
): Promise<GithubRecord[]> {
  const records: GithubRecord[] = []
  let after: string | null = null
  for (let page = 0; page < 4; page += 1) {
    const payload = await graphqlRelax(
      token,
      fetchImpl,
      () => searchQuery(state),
      { q: queryText, after },
      state
    )
    const search = dataOf(payload).search
    records.push(...parseSearchPayload({ search }, { login, ...flags }))
    const pageInfo = search && typeof search === 'object' && 'pageInfo' in search
      ? (search as { pageInfo?: { hasNextPage?: boolean, endCursor?: string } }).pageInfo
      : undefined
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break
    after = pageInfo.endCursor
  }
  return records
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
  schema: IssueSchema
): Promise<GithubRecord[]> {
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
  const found: GithubRecord[] = []
  for (let offset = 0; offset < missing.length; offset += 8) {
    const slice = missing.slice(offset, offset + 8)
    const variables: Record<string, string | number> = {}
    slice.forEach((item, index) => {
      variables[`o${index}`] = item.owner
      variables[`n${index}`] = item.name
      variables[`i${index}`] = item.number
    })
    const vars = slice.map((_, index) => `$o${index}: String!, $n${index}: String!, $i${index}: Int!`).join(', ')
    const fields = slice.map((_, index) => `
      r${index}: repository(owner: $o${index}, name: $n${index}) {
        nameWithOwner isEmpty pushedAt
        issue(number: $i${index}) { ${issueSelection(schema)} }
      }
    `).join('\n')
    const payload = await graphqlRelax(
      token,
      fetchImpl,
      () => `query(${vars}) { ${fields} }`,
      variables,
      schema
    )
    const data = dataOf(payload)
    slice.forEach((item, index) => {
      const repoNode = data[`r${index}`]
      if (!repoNode || typeof repoNode !== 'object' || !('issue' in repoNode)) return
      const name = 'nameWithOwner' in repoNode && typeof repoNode.nameWithOwner === 'string'
        ? repoNode.nameWithOwner
        : `${item.owner}/${item.name}`
      const issue = (repoNode as { issue?: unknown }).issue
      if (!issue || typeof issue !== 'object') return
      found.push(...parseIssueTree({
        ...issue,
        __typename: 'Issue',
        repository: { nameWithOwner: name },
        parent: item.parentNumber === null ? undefined : { number: item.parentNumber }
      }, { login, inScopeRepo: true }))
    })
  }
  return found
}

export async function loadGithubRecords(options: {
  token: string
  config: WaitingConfig
  watchedRepos: readonly string[]
  fetchImpl?: typeof fetch
}): Promise<GithubLoadResult> {
  const fetchImpl = options.fetchImpl ?? fetch
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
  const searchState: IssueSchema = { withParent: true, withSubIssues: true }
  let login = ''
  try {
    login = await viewerLogin(options.token, fetchImpl)
  } catch (error) {
    const failure = sourceFailure('GitHub', error)
    return {
      bySource,
      fresh,
      errors: [failure.error],
      notices: [],
      rateLimitResetAt: failure.resetAt,
      auth: failure.auth ? 'invalid' : 'ok'
    }
  }

  let scope: ScopeRepo[] = []
  try {
    const limit = options.config.maxScopeRepos
    let discovered: ScopeRepo[] = []
    let truncated = false
    if (options.watchedRepos.length > 0) {
      truncated = options.watchedRepos.length > limit
      discovered = await loadExplicit(options.token, fetchImpl, options.watchedRepos.slice(0, limit), login)
    } else {
      const owned = await discoverRepos(options.token, fetchImpl, 'repositories', limit, login)
      const room = Math.max(0, limit - owned.repos.length)
      let watchingRepos: ScopeRepo[] = []
      let watchingTruncated = false
      if (room > 0) {
        const watching = await discoverRepos(options.token, fetchImpl, 'watching', room, login)
        watchingRepos = watching.repos
        watchingTruncated = watching.truncated
      } else if (!owned.truncated) {
        const peek = await discoverRepos(options.token, fetchImpl, 'watching', 1, login)
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
  } catch (error) {
    const failure = sourceFailure('仓库范围', error)
    bucket.errors.push(failure.error)
    bucket.resetAt = earlierReset(bucket.resetAt, failure.resetAt)
    if (failure.auth) bucket.authInvalid = true
  }

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
  const contentsEnabled = wantContents && contentScope.length > 0 && !bucket.authInvalid
  const contents = await runSource(
    '仓库内容',
    contentsEnabled,
    () => loadRepoContents(options.token, fetchImpl, contentScope, login, searchState),
    undefined,
    bucket
  )
  if (contents) {
    bySource.openPrs = contents.pullRequests.map(record => ({ ...record, inScopeRepo: true, fromOpenPr: true }))
    bySource.humanIssues = contents.issues.map(record => ({ ...record, inScopeRepo: true }))
    fresh.openPrs = true
    fresh.humanIssues = true
  }

  const markScope = (records: GithubRecord[]): GithubRecord[] => records.map(record => {
    const known = scopeByName.get(record.repo.toLowerCase())
    if (!known) return { ...record, viewerLogin: record.viewerLogin || login }
    return {
      ...record,
      viewerLogin: record.viewerLogin || login,
      inScopeRepo: true,
      repoAccess: known.access,
      isFork: known.isFork,
      viewerOwnsRepo: known.viewerOwns
    }
  })

  const assignee = await runSource(
    '指派',
    options.config.sources.assignee && !bucket.authInvalid,
    () => searchAll(options.token, fetchImpl, 'assignee:@me is:open', login, { fromAssignee: true }, searchState),
    undefined,
    bucket
  )
  if (assignee) {
    bySource.assignee = markScope(assignee)
    fresh.assignee = true
  }

  const review = await runSource(
    '请求 review',
    options.config.sources.reviewRequested && !bucket.authInvalid,
    () => searchAll(options.token, fetchImpl, 'review-requested:@me is:pr is:open', login, { fromReview: true }, searchState),
    undefined,
    bucket
  )
  if (review) {
    bySource.reviewRequested = markScope(review)
    fresh.reviewRequested = true
  }

  const mentions = await runSource(
    '提及',
    options.config.sources.mentions && !bucket.authInvalid,
    () => searchAll(options.token, fetchImpl, 'mentions:@me is:open', login, { fromMention: true }, searchState),
    undefined,
    bucket
  )
  if (mentions) {
    bySource.mentions = markScope(mentions)
    fresh.mentions = true
  }

  const maintainNames = scope.filter(repo => repo.access === 'maintain').map(repo => repo.full)
  const humanQueries = humanSearchQueries(options.config, maintainNames)
  const humanSearch = await runSource(
    '要人动手',
    options.config.sources.humanIssues && humanQueries.length > 0 && !bucket.authInvalid,
    async () => {
      const found: GithubRecord[] = []
      for (const queryText of humanQueries) {
        const page = await searchAll(options.token, fetchImpl, queryText, login, {}, searchState)
        found.push(...page.map(record => ({ ...record, inScopeRepo: true })))
      }
      return found
    },
    undefined,
    bucket
  )
  if (humanSearch) {
    bySource.humanIssues = [...bySource.humanIssues, ...humanSearch]
    fresh.humanIssues = true
  }

  const watchNames = scope.filter(repo => repo.access === 'watch').map(repo => repo.full)
  const authorEnabled = watchNames.length > 0 && (
    options.config.sources.openPrs || options.config.sources.humanIssues || options.config.sources.mentions
  )
  const author = await runSource(
    '作者',
    authorEnabled && !bucket.authInvalid,
    async () => {
      const found: GithubRecord[] = []
      for (let offset = 0; offset < watchNames.length; offset += 8) {
        const repoClause = watchNames.slice(offset, offset + 8).map(repo => `repo:${repo}`).join(' OR ')
        const queryText = `author:@me is:open (${repoClause})`
        const page = await searchAll(options.token, fetchImpl, queryText, login, { fromAuthor: true }, searchState)
        found.push(...page)
      }
      return found
    },
    undefined,
    bucket
  )
  if (author) {
    bySource.humanIssues = [...bySource.humanIssues, ...markScope(author.map(record => ({ ...record, fromAuthor: true })))]
    fresh.humanIssues = true
  }

  const pooled = [
    ...bySource.assignee,
    ...bySource.reviewRequested,
    ...bySource.mentions,
    ...bySource.openPrs,
    ...bySource.humanIssues
  ]
  const needsTasklist = pooled.some(record => record.kind === 'issue' && tasklistIssueRefs(record.body, record.repo).length > 0)
  const linked = await runSource(
    '子 issue',
    needsTasklist && !bucket.authInvalid,
    () => loadTasklistIssues(options.token, fetchImpl, pooled, login, searchState),
    undefined,
    bucket
  )
  if (linked) {
    bySource.humanIssues = [...bySource.humanIssues, ...linked]
    fresh.humanIssues = true
  }

  bySource.assignee = markScope(bySource.assignee)
  bySource.reviewRequested = markScope(bySource.reviewRequested)
  bySource.mentions = markScope(bySource.mentions)
  bySource.openPrs = markScope(bySource.openPrs)
  bySource.humanIssues = markScope(bySource.humanIssues)

  return {
    bySource,
    fresh,
    errors: bucket.errors,
    notices: bucket.notices,
    rateLimitResetAt: bucket.resetAt,
    auth: bucket.authInvalid ? 'invalid' : 'ok'
  }
}
