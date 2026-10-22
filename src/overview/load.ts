import { githubData, githubErrorMessages, githubGraphql } from '../github/client.js'
import { classifyOverview, hasOverviewPushAccess, inAutoScope, mapCiState, selectOverviewRows } from '../shared/overview/classify.js'
import type { OverviewConfig, OverviewPullRequest, OverviewRepoFacts, OverviewRow, OverviewSourceError } from '../shared/overview/types.js'
import { laterIso } from '../shared/waiting/days.js'
import { GithubAuthError, GithubRateLimitError, earlierReset } from '../shared/waiting/rate-limit.js'
import { MAX_GITHUB_REQUESTS, createGithubRequestScheduler, mapConcurrentOrdered, type GithubRequestScheduler } from '../github/concurrency.js'
import { isCancellation, throwIfCancelled } from '../shared/task-scope.js'
import { COMMAND_CENTER_LABEL_LIMIT, COMMAND_CENTER_TITLE_LIMIT, readCommandCenter } from '../shared/overview/command-center.js'
import { recentRepoPage, repoPushedInWindow, repoPushCutoff, type RepoFetchWindow } from '../shared/repo-fetch-window.js'
import { repositoryScopeData, repositoryScopePage } from '../github/repository-scope.js'

const BATCH = 3
const REPO_PAGE_SIZE = 40

export interface OverviewLoadResult {
  rows: OverviewRow[]
  fresh: boolean
  rateLimitResetAt: string | null
  auth: 'ok' | 'invalid'
  errors: OverviewSourceError[]
  notices: string[]
}

interface ListedRepo {
  name: string
  archived: boolean
  permission: string | null
}

function splitRepo(full: string): { owner: string, name: string } | null {
  const parts = full.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { owner: parts[0], name: parts[1] }
}

function repoUrl(name: string): string {
  return `https://github.com/${name}`
}

function readListed(node: unknown): ListedRepo | null {
  if (!node || typeof node !== 'object') return null
  const name = 'nameWithOwner' in node && typeof node.nameWithOwner === 'string' ? node.nameWithOwner : ''
  if (!splitRepo(name)) return null
  const permission = 'viewerPermission' in node && typeof node.viewerPermission === 'string'
    ? node.viewerPermission
    : null
  if (!hasOverviewPushAccess(permission)) return null
  return {
    name,
    archived: 'isArchived' in node && node.isArchived === true,
    permission
  }
}

async function discoverRepos(
  token: string,
  fetchImpl: typeof fetch,
  limit: number,
  scheduler: GithubRequestScheduler,
  cutoff: number | null
): Promise<{ repos: ListedRepo[], truncated: boolean }> {
  const repos: ListedRepo[] = []
  let cursor: string | null = null
  let truncated = false
  const pageCap = Math.max(1, Math.ceil(Math.max(limit, 1) / REPO_PAGE_SIZE) + 1)
  for (let page = 0; page < pageCap && repos.length < limit; page += 1) {
    const payload = await githubGraphql(token, `
      query($cursor: String) {
        viewer {
          repositories(first: ${REPO_PAGE_SIZE}, after: $cursor, ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: {field: PUSHED_AT, direction: DESC}) {
            pageInfo { hasNextPage endCursor }
            nodes { nameWithOwner isArchived viewerPermission pushedAt }
          }
        }
      }
    `, { cursor }, fetchImpl, scheduler)
    const viewer = repositoryScopeData(payload).viewer
    const listed = viewer && typeof viewer === 'object' && 'repositories' in viewer
      ? (viewer as { repositories?: unknown }).repositories
      : null
    const batch = repositoryScopePage(listed)
    const recent = recentRepoPage(batch.nodes, cutoff)
    for (const node of recent.nodes) {
      const repo = readListed(node)
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

/** Explicit lists need only push metadata before the expensive CI/PR/CC query. */
async function recentExplicitRepos(
  token: string, fetchImpl: typeof fetch, names: readonly string[],
  scheduler: GithubRequestScheduler, cutoff: number, checkedAt: string
): Promise<{ names: string[], errors: OverviewRepoFacts[] }> {
  const slices: string[][] = []
  for (let offset = 0; offset < names.length; offset += 20) slices.push(names.slice(offset, offset + 20))
  const results = await mapConcurrentOrdered(slices, 2, async slice => {
    const variables: Record<string, string> = {}
    const fields = slice.map((full, index) => {
      const parts = splitRepo(full)
      variables[`o${index}`] = parts?.owner ?? ''
      variables[`n${index}`] = parts?.name ?? ''
      return `r${index}: repository(owner: $o${index}, name: $n${index}) { nameWithOwner pushedAt }`
    })
    const definitions = slice.flatMap((_, index) => [`$o${index}: String!`, `$n${index}: String!`])
    const payload = await githubGraphql(token, `query(${definitions.join(', ')}) { ${fields.join('\n')} }`, variables, fetchImpl, scheduler)
    const data = githubData(payload)
    const apiErrors = githubErrorMessages(payload)
    const selected: string[] = []
    const errors: OverviewRepoFacts[] = []
    for (const [index, full] of slice.entries()) {
      const alias = `r${index}`
      const node = data[alias]
      const failure = apiErrors.filter(error => !error.path || error.path === alias).map(error => error.message).join('；')
      if (failure || !node || typeof node !== 'object') {
        errors.push(errorFacts(full, rowErrorMessage(failure || (Object.hasOwn(data, alias) ? '' : 'GitHub 返回的仓库数据不完整')), checkedAt))
      } else if (repoPushedInWindow(node, cutoff)) {
        const canonical = 'nameWithOwner' in node && typeof node.nameWithOwner === 'string' ? node.nameWithOwner : full
        selected.push(splitRepo(canonical) ? canonical : full)
      }
    }
    return { names: selected, errors }
  })
  return {
    names: [...new Set(results.flatMap(result => result?.names ?? []))],
    errors: results.flatMap(result => result?.errors ?? [])
  }
}

const REPO_FIELDS = `
  nameWithOwner
  url
  isEmpty
  isArchived
  diskUsage
  createdAt
  pushedAt
  commandCenters: issues(states: OPEN, labels: ["type:command-center"], first: ${COMMAND_CENTER_LABEL_LIMIT}, orderBy: {field: UPDATED_AT, direction: DESC}) {
    totalCount
    pageInfo { hasNextPage }
    nodes { number title url body updatedAt state }
  }
  defaultBranchRef {
    target {
      oid
      ... on Commit {
        committedDate
        statusCheckRollup {
          state
          contexts(first: 10) {
            nodes {
              ... on CheckRun { conclusion detailsUrl }
              ... on StatusContext { state targetUrl }
            }
          }
        }
      }
    }
  }
  pullRequests(states: OPEN, first: 40, orderBy: {field: CREATED_AT, direction: ASC}) {
    totalCount
    nodes {
      number
      title
      url
      isDraft
      createdAt
      reviewDecision
      reviews(states: APPROVED, first: 1) { totalCount }
    }
  }
  issues(states: [OPEN, CLOSED], first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) {
    nodes {
      createdAt
      updatedAt
      comments(last: 1) { nodes { createdAt } }
    }
  }
  recentPulls: pullRequests(states: [OPEN, CLOSED, MERGED], first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) {
    nodes {
      createdAt
      updatedAt
      comments(last: 1) { nodes { createdAt } }
      reviews(last: 1) { nodes { submittedAt } }
    }
  }
`

const CENTER_SEARCH_FIELDS = `
  issueCount
  pageInfo { hasNextPage }
  nodes { ... on Issue { number title url body updatedAt state repository { nameWithOwner } } }
`

function detailQuery(count: number): string {
  const vars: string[] = ['$ccEnglishSearch: String!', '$ccChineseSearch: String!']
  const fields: string[] = []
  for (let index = 0; index < count; index += 1) {
    vars.push(`$o${index}: String!`, `$n${index}: String!`)
    fields.push(`r${index}: repository(owner: $o${index}, name: $n${index}) { ${REPO_FIELDS} }`)
  }
  fields.push(`ccEnglish: search(query: $ccEnglishSearch, type: ISSUE, first: ${COMMAND_CENTER_TITLE_LIMIT * count}) { ${CENTER_SEARCH_FIELDS} }`)
  fields.push(`ccChinese: search(query: $ccChineseSearch, type: ISSUE, first: ${COMMAND_CENTER_TITLE_LIMIT * count}) { ${CENTER_SEARCH_FIELDS} }`)
  return `query(${vars.join(', ')}) { ${fields.join('\n')} }`
}

/** A batch-wide title search saves repeated index work; repository identity still bounds every card. */
function repositorySearch(connection: unknown, repo: string, knownNames: Set<string>, requestedRepo: string): unknown {
  if (!connection || typeof connection !== 'object') return undefined
  const record = connection as { nodes?: unknown, issueCount?: unknown, pageInfo?: { hasNextPage?: unknown } }
  if (!Array.isArray(record.nodes) || typeof record.issueCount !== 'number' || !Number.isSafeInteger(record.issueCount) || record.issueCount < 0 || typeof record.pageInfo?.hasNextPage !== 'boolean') return undefined
  const nodes: unknown[] = []
  for (const item of record.nodes) {
    if (!item || typeof item !== 'object') return undefined
    const value = item as { repository?: { nameWithOwner?: unknown }, number?: unknown, title?: unknown, body?: unknown, updatedAt?: unknown, url?: unknown, state?: unknown }
    const name = value.repository?.nameWithOwner
    if (typeof name !== 'string' || !knownNames.has(name.toLowerCase()) || !Number.isSafeInteger(value.number) || Number(value.number) < 1
      || typeof value.title !== 'string' || typeof value.body !== 'string' || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
      || value.state !== 'OPEN' || typeof value.url !== 'string' || value.url.toLowerCase() !== `https://github.com/${name}/issues/${value.number}`.toLowerCase()) return undefined
    // A repository rename must resolve consistently in both observations. An old-name
    // search node is not evidence that the canonical new-name repository has no CC.
    if (requestedRepo.toLowerCase() !== repo.toLowerCase() && name.toLowerCase() === requestedRepo.toLowerCase()) return undefined
    if (name.toLowerCase() === repo.toLowerCase()) nodes.push(item)
  }
  const truncated = record.pageInfo.hasNextPage || record.issueCount > record.nodes.length
  if (record.issueCount < record.nodes.length) return undefined
  return { nodes, issueCount: nodes.length + (truncated ? 1 : 0), pageInfo: { hasNextPage: truncated } }
}

function rowErrorMessage(message: string): string {
  if (/disabled|blocked|locked/i.test(message)) return '仓库已停用或无权访问'
  if (!message || /could not resolve to a repository|not found|does not exist|forbidden|access denied|not accessible|permission/i.test(message)) {
    return '仓库不存在或无权访问'
  }
  return `仓库查询失败：${message}`
}

function errorFacts(name: string, message: string, checkedAt = new Date().toISOString()): OverviewRepoFacts {
  return {
    commandCenter: { kind: 'unavailable', message, checkedAt },
    name,
    url: repoUrl(name),
    isEmpty: false,
    sizeKb: null,
    hasDefaultBranchCommit: false,
    pushedAt: null,
    createdAt: null,
    lastCommitAt: null,
    lastIssueActivityAt: null,
    openPrCount: 0,
    ciState: 'unknown',
    ciFailureUrl: null,
    pullRequests: [],
    archived: false,
    error: message
  }
}

function githubHttps(url: string): string | null {
  if (url.startsWith('https://github.com/') || url.startsWith('https://www.github.com/')) return url
  return null
}

function failingCheckUrl(rollup: unknown, repoUrl: string): string {
  const fallback = `${repoUrl.replace(/\/$/, '')}/actions`
  if (!rollup || typeof rollup !== 'object' || !('contexts' in rollup)) return fallback
  const contexts = rollup.contexts
  const nodes = contexts && typeof contexts === 'object' && 'nodes' in contexts && Array.isArray(contexts.nodes)
    ? contexts.nodes
    : []
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue
    const conclusion = 'conclusion' in node && typeof node.conclusion === 'string' ? node.conclusion : ''
    const state = 'state' in node && typeof node.state === 'string' ? node.state : ''
    const failed = conclusion === 'FAILURE' || conclusion === 'ERROR' || state === 'FAILURE' || state === 'ERROR'
    if (!failed) continue
    const details = 'detailsUrl' in node && typeof node.detailsUrl === 'string' ? githubHttps(node.detailsUrl) : null
    const target = 'targetUrl' in node && typeof node.targetUrl === 'string' ? githubHttps(node.targetUrl) : null
    if (details || target) return details || target || fallback
  }
  return fallback
}

function readIso(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function latestStamp(values: Array<string | null>): string | null {
  let best: string | null = null
  let bestMs = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (!value) continue
    const ms = Date.parse(value)
    if (!Number.isFinite(ms) || ms < bestMs) continue
    best = value
    bestMs = ms
  }
  return best
}

function commentStamps(node: object): string[] {
  const stamps: string[] = []
  const comments = 'comments' in node ? node.comments : null
  const commentNodes = comments && typeof comments === 'object' && 'nodes' in comments && Array.isArray(comments.nodes)
    ? comments.nodes
    : []
  for (const comment of commentNodes) {
    const created = comment && typeof comment === 'object' && 'createdAt' in comment ? readIso(comment.createdAt) : null
    if (created) stamps.push(created)
  }
  const reviews = 'reviews' in node ? node.reviews : null
  const reviewNodes = reviews && typeof reviews === 'object' && 'nodes' in reviews && Array.isArray(reviews.nodes)
    ? reviews.nodes
    : []
  for (const review of reviewNodes) {
    const submitted = review && typeof review === 'object' && 'submittedAt' in review ? readIso(review.submittedAt) : null
    if (submitted) stamps.push(submitted)
  }
  return stamps
}

/** Newest create, update, or comment across the already-sorted issue and pull connections. */
export function readIssueActivity(node: object): string | null {
  const issueConnection = 'issues' in node ? node.issues : null
  const pullConnection = 'recentPulls' in node ? node.recentPulls : null
  return laterIso(connectionActivity(issueConnection), connectionActivity(pullConnection))
}

function connectionActivity(connection: unknown): string | null {
  if (!connection || typeof connection !== 'object' || !('nodes' in connection) || !Array.isArray(connection.nodes)) {
    return null
  }
  const stamps: string[] = []
  for (const item of connection.nodes) {
    if (!item || typeof item !== 'object') continue
    const created = 'createdAt' in item ? readIso(item.createdAt) : null
    const updated = 'updatedAt' in item ? readIso(item.updatedAt) : null
    if (created) stamps.push(created)
    if (updated) stamps.push(updated)
    stamps.push(...commentStamps(item))
  }
  return latestStamp(stamps)
}

function readPull(node: unknown): OverviewPullRequest | null {
  if (!node || typeof node !== 'object') return null
  const number = 'number' in node && typeof node.number === 'number' ? node.number : null
  const url = 'url' in node && typeof node.url === 'string' ? node.url : ''
  const createdAt = 'createdAt' in node && typeof node.createdAt === 'string' ? node.createdAt : ''
  if (number === null || !url || !createdAt) return null
  const decision = 'reviewDecision' in node && typeof node.reviewDecision === 'string' ? node.reviewDecision : null
  const reviewDecision = decision === 'APPROVED' || decision === 'CHANGES_REQUESTED' || decision === 'REVIEW_REQUIRED'
    ? decision
    : null
  const reviews = 'reviews' in node && node.reviews && typeof node.reviews === 'object'
    ? node.reviews as { totalCount?: unknown }
    : null
  const approvedReviewCount = reviews && typeof reviews.totalCount === 'number' ? reviews.totalCount : 0
  return {
    number,
    title: 'title' in node && typeof node.title === 'string' ? node.title : '',
    url,
    isDraft: 'isDraft' in node && node.isDraft === true,
    createdAt,
    reviewDecision,
    approvedReviewCount
  }
}

export function parseRepositoryNode(node: unknown, requestedName: string): OverviewRepoFacts {
  if (!node || typeof node !== 'object') return errorFacts(requestedName, '仓库不存在或无权访问')
  const name = 'nameWithOwner' in node && typeof node.nameWithOwner === 'string' ? node.nameWithOwner : requestedName
  const url = 'url' in node && typeof node.url === 'string' && node.url.startsWith('https://') ? node.url : repoUrl(name)
  const sizeKb = 'diskUsage' in node && typeof node.diskUsage === 'number' ? node.diskUsage : null
  const branch = 'defaultBranchRef' in node ? node.defaultBranchRef : null
  const target = branch && typeof branch === 'object' && 'target' in branch ? branch.target : null
  const oid = target && typeof target === 'object' && 'oid' in target && typeof target.oid === 'string' ? target.oid : ''
  const committedDate = target && typeof target === 'object' && 'committedDate' in target && typeof target.committedDate === 'string'
    ? target.committedDate
    : null
  const rollup = target && typeof target === 'object' && 'statusCheckRollup' in target ? target.statusCheckRollup : null
  const rollupState = rollup && typeof rollup === 'object' && 'state' in rollup && typeof rollup.state === 'string'
    ? rollup.state
    : null
  const ciFailureUrl = mapCiState(rollupState) === 'failure' ? failingCheckUrl(rollup, url) : null
  const pulls = 'pullRequests' in node && node.pullRequests && typeof node.pullRequests === 'object'
    ? node.pullRequests as { totalCount?: unknown, nodes?: unknown }
    : null
  const pullNodes = pulls && Array.isArray(pulls.nodes) ? pulls.nodes : []
  const pullRequests = pullNodes.map(readPull).filter((item): item is OverviewPullRequest => item !== null)
  const openPrCount = pulls && typeof pulls.totalCount === 'number' ? pulls.totalCount : pullRequests.length
  return {
    name,
    url,
    isEmpty: 'isEmpty' in node && node.isEmpty === true,
    sizeKb,
    hasDefaultBranchCommit: Boolean(oid || committedDate),
    pushedAt: 'pushedAt' in node && typeof node.pushedAt === 'string' ? node.pushedAt : null,
    createdAt: 'createdAt' in node ? readIso(node.createdAt) : null,
    lastCommitAt: committedDate,
    lastIssueActivityAt: readIssueActivity(node),
    openPrCount,
    ciState: mapCiState(rollupState),
    ciFailureUrl,
    pullRequests,
    archived: 'isArchived' in node && node.isArchived === true,
    error: null
  }
}

async function queryBatch(
  token: string,
  fetchImpl: typeof fetch,
  names: readonly string[],
  scheduler: GithubRequestScheduler,
  checkedAt: string
): Promise<OverviewRepoFacts[]> {
  const variables: Record<string, string> = {}
  names.forEach((full, index) => {
    const parts = splitRepo(full)
    variables[`o${index}`] = parts?.owner ?? ''
    variables[`n${index}`] = parts?.name ?? ''
  })
  const repoTerms = names.map(full => `repo:${full}`).join(' ')
  variables.ccEnglishSearch = `${repoTerms} is:issue is:open in:title "Command Center"`
  variables.ccChineseSearch = `${repoTerms} is:issue is:open in:title "项目总控台"`
  const payload = await githubGraphql(token, detailQuery(names.length), variables, fetchImpl, scheduler)
  const data = githubData(payload)
  const errors = githubErrorMessages(payload)
  const aliases = new Set([...names.map((_, index) => `r${index}`), 'ccEnglish', 'ccChinese'])
  const knownNames = new Set(names.map(name => name.toLowerCase()))
  for (const name of names.map((_, index) => data[`r${index}`])) {
    if (name && typeof name === 'object' && 'nameWithOwner' in name && typeof name.nameWithOwner === 'string') knownNames.add(name.nameWithOwner.toLowerCase())
  }
  const globalMessage = errors
    .filter(error => !aliases.has(error.path))
    .map(error => error.message)
    .join('；')
  return names.map((name, index) => {
    const alias = `r${index}`
    const node = data[alias]
    const message = errors
      .filter(error => !aliases.has(error.path) || error.path === alias)
      .map(error => error.message)
      .join('；')
    if (node && typeof node === 'object') {
      const facts = parseRepositoryNode(node, name)
      const rawErrors = payload && typeof payload === 'object' && 'errors' in payload && Array.isArray(payload.errors) ? payload.errors : []
      const centerErrors = rawErrors.filter(error => {
        if (!error || typeof error !== 'object' || !('path' in error) || !Array.isArray(error.path)) return false
        return error.path[0] === 'ccEnglish' || error.path[0] === 'ccChinese'
          || (error.path[0] === alias && error.path[1] === 'commandCenters')
      }).map(error => error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '总控台查询失败')
      const commandCenter = readCommandCenter({
        repo: facts.name, labeled: 'commandCenters' in node ? node.commandCenters : undefined,
        english: repositorySearch(data.ccEnglish, facts.name, knownNames, name), chinese: repositorySearch(data.ccChinese, facts.name, knownNames, name), checkedAt,
        error: [...centerErrors, globalMessage].filter(Boolean).join('；') || undefined
      })
      // Optional fields can fail (for example, Issues disabled) while the repo
      // and its CI/PR data remain usable. Preserve that existing partial-node behavior.
      return { ...facts, commandCenter, ...(globalMessage ? { error: rowErrorMessage(globalMessage) } : {}) }
    }
    const missing = Object.hasOwn(data, alias) ? '' : 'GitHub 返回的仓库数据不完整'
    return errorFacts(name, rowErrorMessage(message || missing), checkedAt)
  })
}

async function loadDetails(
  token: string,
  fetchImpl: typeof fetch,
  names: readonly string[],
  scheduler: GithubRequestScheduler,
  checkedAt: string
): Promise<{ facts: OverviewRepoFacts[], rateLimitResetAt: string | null, authInvalid: boolean, aborted: boolean }> {
  interface SliceResult {
    facts: OverviewRepoFacts[]
    rateLimitResetAt: string | null
    authInvalid: boolean
    aborted: boolean
  }

  const slices: string[][] = []
  for (let offset = 0; offset < names.length; offset += BATCH) slices.push(names.slice(offset, offset + BATCH))
  const loaded = await mapConcurrentOrdered(
    slices,
    MAX_GITHUB_REQUESTS,
    async (slice): Promise<SliceResult> => {
      const facts: OverviewRepoFacts[] = []
      try {
        facts.push(...await queryBatch(token, fetchImpl, slice, scheduler, checkedAt))
        return { facts, rateLimitResetAt: null, authInvalid: false, aborted: false }
      } catch (error) {
        if (isCancellation(error)) throw error
        if (error instanceof GithubAuthError) return { facts, rateLimitResetAt: null, authInvalid: true, aborted: true }
        if (error instanceof GithubRateLimitError) return { facts, rateLimitResetAt: error.resetAt, authInvalid: false, aborted: true }
        // Transport/query failures do not identify an individual repository.
        // Retrying every repo would multiply requests during an outage.
        const message = error instanceof Error ? error.message : '仓库查询失败'
        facts.push(...slice.map(name => errorFacts(name, rowErrorMessage(message), checkedAt)))
        return { facts, rateLimitResetAt: null, authInvalid: false, aborted: false }
      }
    },
    result => result.aborted
  )
  const facts: OverviewRepoFacts[] = []
  let rateLimitResetAt: string | null = null
  let authInvalid = false
  let aborted = false
  for (const result of loaded) {
    if (!result) continue
    facts.push(...result.facts)
    rateLimitResetAt = earlierReset(rateLimitResetAt, result.rateLimitResetAt)
    authInvalid ||= result.authInvalid
    aborted ||= result.aborted
  }
  return { facts, rateLimitResetAt, authInvalid, aborted }
}

export async function loadOverview(options: {
  token: string
  config: OverviewConfig
  watchedRepos: readonly string[]
  now: Date
  /** Application/CLI callers pass the shared setting; omitted preserves the loader's full-range API. */
  repoFetchWindow?: RepoFetchWindow
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  /** Defaults to the settings toggle. The CLI passes this explicitly. */
  includeArchived?: boolean
}): Promise<OverviewLoadResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const scheduler = createGithubRequestScheduler({ signal: options.signal })
  try {
  const includeArchived = options.includeArchived ?? options.config.showArchived
  const notices: string[] = []
  const errors: OverviewSourceError[] = []
  let rateLimitResetAt: string | null = null
  const limit = options.config.maxScopeRepos
  const cutoff = repoPushCutoff(options.repoFetchWindow ?? 'all', options.now)
  let names: string[] = []
  let metadataErrors: OverviewRepoFacts[] = []

  try {
    if (options.watchedRepos.length > 0) {
      const recent = cutoff === null ? { names: [...options.watchedRepos], errors: [] } : await recentExplicitRepos(
        options.token, fetchImpl, options.watchedRepos, scheduler, cutoff, options.now.toISOString()
      )
      metadataErrors = recent.errors
      if (recent.names.length > limit) {
        notices.push(`仓库数量达到上限 ${limit}，其余仓库没有继续查询。到设置里调高「仓库数量上限」。`)
      }
      names = recent.names.slice(0, limit)
    } else {
      const owned = await discoverRepos(options.token, fetchImpl, limit, scheduler, cutoff)
      throwIfCancelled(options.signal)
      if (owned.truncated) {
        notices.push(`仓库数量达到上限 ${limit}，其余仓库没有继续查询。到设置里调高「仓库数量上限」。`)
      }
      const seen = new Set<string>()
      for (const repo of owned.repos) {
        const key = repo.name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        if (!inAutoScope(repo, options.config, options.now, includeArchived)) continue
        names.push(repo.name)
      }
    }
  } catch (error) {
    if (isCancellation(error)) throw error
    if (error instanceof GithubAuthError) {
      return { rows: [], fresh: false, rateLimitResetAt: null, auth: 'invalid', errors: [{ source: 'GitHub', message: error.message }], notices }
    }
    if (error instanceof GithubRateLimitError) {
      return {
        rows: [],
        fresh: false,
        rateLimitResetAt: error.resetAt,
        auth: 'ok',
        errors: [{ source: '仓库范围', message: 'GitHub 速率限制，本页保留上次结果' }],
        notices
      }
    }
    return {
      rows: [],
      fresh: false,
      rateLimitResetAt: null,
      auth: 'ok',
      errors: [{ source: '仓库范围', message: error instanceof Error ? error.message : '仓库范围查询失败' }],
      notices
    }
  }

  const loaded = await loadDetails(options.token, fetchImpl, names, scheduler, options.now.toISOString())
  throwIfCancelled(options.signal)
  rateLimitResetAt = earlierReset(rateLimitResetAt, loaded.rateLimitResetAt)
  if (loaded.authInvalid) {
    return {
      rows: [],
      fresh: false,
      rateLimitResetAt,
      auth: 'invalid',
      errors: [{ source: 'GitHub', message: 'GitHub 认证无效或已过期' }],
      notices
    }
  }
  if (loaded.aborted) {
    errors.push({ source: '仓库', message: 'GitHub 速率限制，本页保留上次结果' })
  }
  const fromWatchList = options.watchedRepos.length > 0
  const rows = selectOverviewRows(
    classifyOverview([...loaded.facts, ...metadataErrors], options.config, options.now),
    includeArchived
  ).map(row => ({ ...row, fromWatchList }))
  return {
    rows,
    fresh: !loaded.aborted,
    rateLimitResetAt,
    auth: 'ok',
    errors,
    notices
  }
  } finally {
    scheduler.dispose()
  }
}
