import { githubData, githubGraphql } from '../github/client.js'
import { parseRepoNode, parseSearchPayload, type RepoBatchItem } from '../shared/waiting/parse-github.js'
import { keywordToSearchTerms, chunkSearchText } from '../shared/waiting/rules.js'
import { GithubAuthError, GithubRateLimitError, earlierReset } from '../shared/waiting/rate-limit.js'
import type { GithubRecord, SourceError, WaitingConfig } from '../shared/waiting/types.js'

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
  notices: string[]
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

async function viewerLogin(token: string, fetchImpl: typeof fetch): Promise<string> {
  const payload = await githubGraphql(token, 'query { viewer { login } }', {}, fetchImpl)
  const data = githubData(payload)
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

function readScopeNode(node: unknown): ScopeRepo | null {
  if (!node || typeof node !== 'object') return null
  const name = 'nameWithOwner' in node && typeof node.nameWithOwner === 'string' ? node.nameWithOwner : ''
  const parts = splitRepo(name)
  if (!parts) return null
  const isEmpty = 'isEmpty' in node && node.isEmpty === true
  const pushedAt = 'pushedAt' in node && typeof node.pushedAt === 'string' ? node.pushedAt : null
  return { ...parts, full: name, isEmpty, pushedAt }
}

async function discoverRepos(
  token: string,
  fetchImpl: typeof fetch,
  connection: 'repositories' | 'watching',
  limit: number
): Promise<{ repos: ScopeRepo[], truncated: boolean }> {
  const repos: ScopeRepo[] = []
  let cursor: string | null = null
  let truncated = false
  const field = connection === 'repositories'
    ? `repositories(first: ${REPO_PAGE_SIZE}, after: $cursor, ownerAffiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC})`
    : `watching(first: ${REPO_PAGE_SIZE}, after: $cursor)`
  const pageCap = Math.max(1, Math.ceil(Math.max(limit, 1) / REPO_PAGE_SIZE) + 1)
  for (let page = 0; page < pageCap && repos.length < limit; page += 1) {
    const payload = await githubGraphql(token, `
      query($cursor: String) {
        viewer {
          ${field} {
            pageInfo { hasNextPage endCursor }
            nodes { nameWithOwner isEmpty pushedAt }
          }
        }
      }
    `, { cursor }, fetchImpl)
    const viewer = githubData(payload).viewer
    const listed = viewer && typeof viewer === 'object' && connection in viewer
      ? (viewer as Record<string, unknown>)[connection]
      : null
    const batch = connectionPage(listed)
    for (const node of batch.nodes) {
      const repo = readScopeNode(node)
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
    const payload = await githubGraphql(token, metadataQuery(slice.length), variables, fetchImpl)
    const data = githubData(payload)
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

function contentQuery(count: number, withParent: boolean, includePulls: boolean): string {
  const vars: string[] = []
  const fields: string[] = []
  const issueFields = withParent ? ISSUE_FIELDS_PARENT : ISSUE_FIELDS
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
  login: string
): Promise<{ issues: GithubRecord[], pullRequests: GithubRecord[] }> {
  const issues: GithubRecord[] = []
  const pullRequests: GithubRecord[] = []
  let withParent = true
  let pending: CursorRepo[] = repos.map(repo => ({ ...repo, issueCursor: null, pullCursor: null }))
  for (let page = 0; page < 4 && pending.length > 0; page += 1) {
    const nextPending: CursorRepo[] = []
    const groups = [
      pending.filter(repo => repo.isEmpty),
      pending.filter(repo => !repo.isEmpty)
    ]
    for (const group of groups) {
      if (group.length === 0) continue
      const includePulls = group.some(repo => !repo.isEmpty)
      for (let offset = 0; offset < group.length; offset += 8) {
        const slice = group.slice(offset, offset + 8)
        const variables: Record<string, string | null> = {}
        slice.forEach((repo, index) => {
          variables[`o${index}`] = repo.owner
          variables[`n${index}`] = repo.name
          variables[`ia${index}`] = repo.issueCursor
          if (includePulls) variables[`pa${index}`] = repo.pullCursor
        })
        let payload: unknown
        try {
          payload = await githubGraphql(token, contentQuery(slice.length, withParent, includePulls), variables, fetchImpl)
        } catch (error) {
          const message = error instanceof Error ? error.message : ''
          if (withParent && /parent/i.test(message)) {
            withParent = false
            payload = await githubGraphql(token, contentQuery(slice.length, false, includePulls), variables, fetchImpl)
          } else {
            throw error
          }
        }
        const data = githubData(payload)
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
  flags: { fromAssignee?: boolean, fromReview?: boolean, fromMention?: boolean },
  state: { withParent: boolean }
): Promise<GithubRecord[]> {
  const records: GithubRecord[] = []
  let after: string | null = null
  for (let page = 0; page < 4; page += 1) {
    let payload: unknown
    try {
      payload = await githubGraphql(token, searchQuery(state.withParent), { q: queryText, after }, fetchImpl)
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (state.withParent && /parent/i.test(message)) {
        state.withParent = false
        payload = await githubGraphql(token, searchQuery(false), { q: queryText, after }, fetchImpl)
      } else {
        throw error
      }
    }
    const search = githubData(payload).search
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
      discovered = await loadExplicit(options.token, fetchImpl, options.watchedRepos.slice(0, limit))
    } else {
      const owned = await discoverRepos(options.token, fetchImpl, 'repositories', limit)
      const room = Math.max(0, limit - owned.repos.length)
      let watchingRepos: ScopeRepo[] = []
      let watchingTruncated = false
      if (room > 0) {
        const watching = await discoverRepos(options.token, fetchImpl, 'watching', room)
        watchingRepos = watching.repos
        watchingTruncated = watching.truncated
      } else if (!owned.truncated) {
        const peek = await discoverRepos(options.token, fetchImpl, 'watching', 1)
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

  const scopeNames = new Set(scope.map(repo => repo.full.toLowerCase()))
  const wantContents = options.config.sources.openPrs || options.config.sources.humanIssues
  const contentScope = scope.filter(repo => !repo.isEmpty || options.config.sources.humanIssues)
  const contentsEnabled = wantContents && contentScope.length > 0 && !bucket.authInvalid
  const contents = await runSource(
    '仓库内容',
    contentsEnabled,
    () => loadRepoContents(options.token, fetchImpl, contentScope, login),
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
    notices: bucket.notices,
    rateLimitResetAt: bucket.resetAt,
    auth: bucket.authInvalid ? 'invalid' : 'ok'
  }
}
