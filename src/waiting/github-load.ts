import { repoIsOnWaitingPage } from '../shared/waiting/days.js'
import { parseRepoNode, parseSearchPayload, type RepoBatchItem } from '../shared/waiting/parse-github.js'
import { keywordToSearchTerms, chunkSearchText } from '../shared/waiting/rules.js'
import { GithubAuthError, GithubRateLimitError, earlierReset, rateLimitFromResponse } from '../shared/waiting/rate-limit.js'
import type { GithubRecord, SourceError, WaitingConfig } from '../shared/waiting/types.js'

const API = 'https://api.github.com/graphql'

const ISSUE_FIELDS = `
  number title url body createdAt updatedAt
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

const ISSUE_FIELDS_PARENT = `${ISSUE_FIELDS} parent { number }`

const PR_FIELDS = `
  number title url body createdAt updatedAt isDraft
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

function searchQuery(withParent: boolean): string {
  const issueFields = withParent ? ISSUE_FIELDS_PARENT : ISSUE_FIELDS
  return `
    query($q: String!, $after: String) {
      search(query: $q, type: ISSUE, first: 40, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on Issue {
            ${issueFields}
            repository { nameWithOwner isEmpty pushedAt }
          }
          ... on PullRequest {
            ${PR_FIELDS}
            repository { nameWithOwner isEmpty pushedAt }
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
  rateLimitResetAt: string | null
  auth: 'ok' | 'invalid'
}

interface ScopeRepo {
  owner: string
  name: string
  full: string
  isEmpty: boolean
  pushedAt: string | null
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

async function discoverOwned(token: string, fetchImpl: typeof fetch, now: Date): Promise<ScopeRepo[]> {
  const repos: ScopeRepo[] = []
  let cursor: string | null = null
  for (let page = 0; page < 6; page += 1) {
    const payload = await graphql(token, `
      query($cursor: String) {
        viewer {
          repositories(first: 40, after: $cursor, ownerAffiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC}) {
            pageInfo { hasNextPage endCursor }
            nodes { nameWithOwner isEmpty pushedAt }
          }
        }
      }
    `, { cursor }, fetchImpl)
    const viewer = dataOf(payload).viewer
    const repositories = viewer && typeof viewer === 'object' && 'repositories' in viewer
      ? (viewer as { repositories: unknown }).repositories
      : null
    const batch = connectionPage(repositories)
    let stale = false
    for (const node of batch.nodes) {
      if (!node || typeof node !== 'object') continue
      const name = 'nameWithOwner' in node && typeof node.nameWithOwner === 'string' ? node.nameWithOwner : ''
      const parts = splitRepo(name)
      if (!parts) continue
      const isEmpty = 'isEmpty' in node && node.isEmpty === true
      const pushedAt = 'pushedAt' in node && typeof node.pushedAt === 'string' ? node.pushedAt : null
      if (pushedAt && !repoIsOnWaitingPage({ isEmpty: false, pushedAt }, now)) {
        stale = true
        continue
      }
      repos.push({ ...parts, full: name, isEmpty, pushedAt })
    }
    if (stale || !batch.cursor) break
    cursor = batch.cursor
  }
  return repos
}

async function discoverWatching(token: string, fetchImpl: typeof fetch): Promise<ScopeRepo[]> {
  const repos: ScopeRepo[] = []
  let cursor: string | null = null
  for (let page = 0; page < 4; page += 1) {
    const payload = await graphql(token, `
      query($cursor: String) {
        viewer {
          watching(first: 40, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { nameWithOwner isEmpty pushedAt }
          }
        }
      }
    `, { cursor }, fetchImpl)
    const viewer = dataOf(payload).viewer
    const watching = viewer && typeof viewer === 'object' && 'watching' in viewer
      ? (viewer as { watching: unknown }).watching
      : null
    const batch = connectionPage(watching)
    for (const node of batch.nodes) {
      if (!node || typeof node !== 'object') continue
      const name = 'nameWithOwner' in node && typeof node.nameWithOwner === 'string' ? node.nameWithOwner : ''
      const parts = splitRepo(name)
      if (!parts) continue
      const isEmpty = 'isEmpty' in node && node.isEmpty === true
      const pushedAt = 'pushedAt' in node && typeof node.pushedAt === 'string' ? node.pushedAt : null
      repos.push({ ...parts, full: name, isEmpty, pushedAt })
    }
    if (!batch.cursor) break
    cursor = batch.cursor
  }
  return repos
}

function metadataQuery(count: number): string {
  const vars: string[] = []
  const fields: string[] = []
  for (let index = 0; index < count; index += 1) {
    vars.push(`$o${index}: String!`, `$n${index}: String!`)
    fields.push(`r${index}: repository(owner: $o${index}, name: $n${index}) { nameWithOwner isEmpty pushedAt }`)
  }
  return `query(${vars.join(', ')}) { ${fields.join('\n')} }`
}

async function loadExplicit(token: string, fetchImpl: typeof fetch, repos: readonly string[]): Promise<ScopeRepo[]> {
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
      found.push({
        ...parts,
        full: name,
        isEmpty: 'isEmpty' in node && node.isEmpty === true,
        pushedAt: 'pushedAt' in node && typeof node.pushedAt === 'string' ? node.pushedAt : null
      })
    })
  }
  return found
}

function contentQuery(count: number, withParent: boolean): string {
  const vars: string[] = []
  const fields: string[] = []
  const issueFields = withParent ? ISSUE_FIELDS_PARENT : ISSUE_FIELDS
  for (let index = 0; index < count; index += 1) {
    vars.push(`$o${index}: String!`, `$n${index}: String!`, `$ia${index}: String`, `$pa${index}: String`)
    fields.push(`
      r${index}: repository(owner: $o${index}, name: $n${index}) {
        nameWithOwner
        isEmpty
        pushedAt
        issues(states: OPEN, first: 40, after: $ia${index}, orderBy: {field: UPDATED_AT, direction: DESC}) {
          pageInfo { hasNextPage endCursor }
          nodes { ${issueFields} }
        }
        pullRequests(states: OPEN, first: 40, after: $pa${index}, orderBy: {field: UPDATED_AT, direction: DESC}) {
          pageInfo { hasNextPage endCursor }
          nodes { ${PR_FIELDS} }
        }
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
  login: string
): Promise<{ issues: GithubRecord[], pullRequests: GithubRecord[] }> {
  const issues: GithubRecord[] = []
  const pullRequests: GithubRecord[] = []
  let withParent = true
  let pending: CursorRepo[] = repos.map(repo => ({ ...repo, issueCursor: null, pullCursor: null }))
  for (let page = 0; page < 4 && pending.length > 0; page += 1) {
    const nextPending: CursorRepo[] = []
    for (let offset = 0; offset < pending.length; offset += 8) {
      const slice = pending.slice(offset, offset + 8)
      const variables: Record<string, string | null> = {}
      slice.forEach((repo, index) => {
        variables[`o${index}`] = repo.owner
        variables[`n${index}`] = repo.name
        variables[`ia${index}`] = repo.issueCursor
        variables[`pa${index}`] = repo.pullCursor
      })
      let payload: unknown
      try {
        payload = await graphql(token, contentQuery(slice.length, withParent), variables, fetchImpl)
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (withParent && /parent/i.test(message)) {
          withParent = false
          payload = await graphql(token, contentQuery(slice.length, false), variables, fetchImpl)
        } else {
          throw error
        }
      }
      const data = dataOf(payload)
      slice.forEach((repo, index) => {
        const parsed: RepoBatchItem | null = parseRepoNode(data[`r${index}`], login)
        if (!parsed) return
        issues.push(...parsed.issues)
        pullRequests.push(...parsed.pullRequests)
        if (parsed.issueCursor || parsed.pullCursor) {
          nextPending.push({
            ...repo,
            issueCursor: parsed.issueCursor,
            pullCursor: parsed.pullCursor
          })
        }
      })
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
  flags: { fromAssignee?: boolean, fromReview?: boolean, fromMention?: boolean },
  state: { withParent: boolean }
): Promise<GithubRecord[]> {
  const records: GithubRecord[] = []
  let after: string | null = null
  for (let page = 0; page < 4; page += 1) {
    let payload: unknown
    try {
      payload = await graphql(token, searchQuery(state.withParent), { q: queryText, after }, fetchImpl)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (state.withParent && /parent/i.test(message)) {
        state.withParent = false
        payload = await graphql(token, searchQuery(false), { q: queryText, after }, fetchImpl)
      } else {
        throw error
      }
    }
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

export async function loadGithubRecords(options: {
  token: string
  config: WaitingConfig
  watchedRepos: readonly string[]
  fetchImpl?: typeof fetch
  now: Date
}): Promise<GithubLoadResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const bucket = {
    errors: [] as SourceError[],
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
  const searchState = { withParent: true }
  let login = ''
  try {
    login = await viewerLogin(options.token, fetchImpl)
  } catch (error) {
    const failure = sourceFailure('GitHub', error)
    return {
      bySource,
      fresh,
      errors: [failure.error],
      rateLimitResetAt: failure.resetAt,
      auth: failure.auth ? 'invalid' : 'ok'
    }
  }

  let scope: ScopeRepo[] = []
  try {
    const discovered = options.watchedRepos.length > 0
      ? await loadExplicit(options.token, fetchImpl, options.watchedRepos)
      : [
        ...await discoverOwned(options.token, fetchImpl, options.now),
        ...await discoverWatching(options.token, fetchImpl)
      ]
    const seen = new Set<string>()
    scope = []
    for (const repo of discovered) {
      if (seen.has(repo.full)) continue
      seen.add(repo.full)
      if (!repoIsOnWaitingPage({ isEmpty: repo.isEmpty, pushedAt: repo.pushedAt }, options.now)) continue
      scope.push(repo)
    }
  } catch (error) {
    const failure = sourceFailure('仓库范围', error)
    bucket.errors.push(failure.error)
    bucket.resetAt = earlierReset(bucket.resetAt, failure.resetAt)
    if (failure.auth) bucket.authInvalid = true
  }

  const scopeNames = new Set(scope.map(repo => repo.full.toLowerCase()))
  const wantContents = options.config.sources.openPrs || options.config.sources.humanIssues
  const contentsEnabled = wantContents && scope.length > 0 && !bucket.authInvalid
  const contents = await runSource(
    '仓库内容',
    contentsEnabled,
    () => loadRepoContents(options.token, fetchImpl, scope, login),
    undefined,
    bucket
  )
  if (contents) {
    bySource.openPrs = contents.pullRequests.map(record => ({ ...record, inScopeRepo: true, fromOpenPr: true }))
    bySource.humanIssues = contents.issues.map(record => ({ ...record, inScopeRepo: true }))
    fresh.openPrs = true
    fresh.humanIssues = true
  }

  const markScope = (records: GithubRecord[]): GithubRecord[] => records.map(record => ({
    ...record,
    inScopeRepo: record.inScopeRepo || scopeNames.has(record.repo.toLowerCase())
  }))

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

  const humanQueries = humanSearchQueries(options.config, scope.map(repo => repo.full))
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

  return {
    bySource,
    fresh,
    errors: bucket.errors,
    rateLimitResetAt: bucket.resetAt,
    auth: bucket.authInvalid ? 'invalid' : 'ok'
  }
}
