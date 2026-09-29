import { githubData, githubErrorMessages, githubGraphql } from '../github/client.js'
import { classifyOverview, inAutoScope, mapCiState, selectOverviewRows } from '../shared/overview/classify.js'
import type { OverviewConfig, OverviewPullRequest, OverviewRepoFacts, OverviewRow, OverviewSourceError } from '../shared/overview/types.js'
import { GithubAuthError, GithubRateLimitError, earlierReset } from '../shared/waiting/rate-limit.js'

const BATCH = 8
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
  isEmpty: boolean
  pushedAt: string | null
  archived: boolean
}

function splitRepo(full: string): { owner: string, name: string } | null {
  const parts = full.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { owner: parts[0], name: parts[1] }
}

function repoUrl(name: string): string {
  return `https://github.com/${name}`
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

function readListed(node: unknown): ListedRepo | null {
  if (!node || typeof node !== 'object') return null
  const name = 'nameWithOwner' in node && typeof node.nameWithOwner === 'string' ? node.nameWithOwner : ''
  if (!splitRepo(name)) return null
  return {
    name,
    isEmpty: 'isEmpty' in node && node.isEmpty === true,
    pushedAt: 'pushedAt' in node && typeof node.pushedAt === 'string' ? node.pushedAt : null,
    archived: 'isArchived' in node && node.isArchived === true
  }
}

async function discoverRepos(
  token: string,
  fetchImpl: typeof fetch,
  connection: 'repositories' | 'watching',
  limit: number
): Promise<{ repos: ListedRepo[], truncated: boolean }> {
  const repos: ListedRepo[] = []
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
            nodes { nameWithOwner isEmpty pushedAt isArchived }
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
      const repo = readListed(node)
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

const REPO_FIELDS = `
  nameWithOwner
  url
  isEmpty
  isArchived
  diskUsage
  pushedAt
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
`

function detailQuery(count: number): string {
  const vars: string[] = []
  const fields: string[] = []
  for (let index = 0; index < count; index += 1) {
    vars.push(`$o${index}: String!`, `$n${index}: String!`)
    fields.push(`r${index}: repository(owner: $o${index}, name: $n${index}) { ${REPO_FIELDS} }`)
  }
  return `query(${vars.join(', ')}) { ${fields.join('\n')} }`
}

function rowErrorMessage(message: string): string {
  if (/disabled|blocked|locked/i.test(message)) return '仓库已停用或无权访问'
  return '仓库不存在或无权访问'
}

function errorFacts(name: string, message: string): OverviewRepoFacts {
  return {
    name,
    url: repoUrl(name),
    isEmpty: false,
    sizeKb: null,
    hasDefaultBranchCommit: false,
    pushedAt: null,
    lastCommitAt: null,
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
    lastCommitAt: committedDate,
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
  names: readonly string[]
): Promise<OverviewRepoFacts[]> {
  const variables: Record<string, string> = {}
  names.forEach((full, index) => {
    const parts = splitRepo(full)
    variables[`o${index}`] = parts?.owner ?? ''
    variables[`n${index}`] = parts?.name ?? ''
  })
  const payload = await githubGraphql(token, detailQuery(names.length), variables, fetchImpl)
  const data = githubData(payload)
  const errors = githubErrorMessages(payload)
  return names.map((name, index) => {
    const node = data[`r${index}`]
    if (node && typeof node === 'object') return parseRepositoryNode(node, name)
    const message = errors.find(error => error.path === `r${index}`)?.message ?? ''
    return errorFacts(name, rowErrorMessage(message))
  })
}

async function loadDetails(
  token: string,
  fetchImpl: typeof fetch,
  names: readonly string[]
): Promise<{ facts: OverviewRepoFacts[], rateLimitResetAt: string | null, authInvalid: boolean, aborted: boolean }> {
  const facts: OverviewRepoFacts[] = []
  for (let offset = 0; offset < names.length; offset += BATCH) {
    const slice = names.slice(offset, offset + BATCH)
    try {
      facts.push(...await queryBatch(token, fetchImpl, slice))
    } catch (error) {
      if (error instanceof GithubAuthError) return { facts, rateLimitResetAt: null, authInvalid: true, aborted: true }
      if (error instanceof GithubRateLimitError) {
        return { facts, rateLimitResetAt: error.resetAt, authInvalid: false, aborted: true }
      }
      if (slice.length === 1) {
        const message = error instanceof Error ? error.message : '仓库查询失败'
        facts.push(errorFacts(slice[0] ?? '', rowErrorMessage(message)))
        continue
      }
      for (const name of slice) {
        try {
          facts.push(...await queryBatch(token, fetchImpl, [name]))
        } catch (single) {
          if (single instanceof GithubAuthError) return { facts, rateLimitResetAt: null, authInvalid: true, aborted: true }
          if (single instanceof GithubRateLimitError) {
            return { facts, rateLimitResetAt: single.resetAt, authInvalid: false, aborted: true }
          }
          const message = single instanceof Error ? single.message : '仓库查询失败'
          facts.push(errorFacts(name, rowErrorMessage(message)))
        }
      }
    }
  }
  return { facts, rateLimitResetAt: null, authInvalid: false, aborted: false }
}

export async function loadOverview(options: {
  token: string
  config: OverviewConfig
  watchedRepos: readonly string[]
  now: Date
  fetchImpl?: typeof fetch
  /** Defaults to the settings toggle. The CLI passes this explicitly. */
  includeArchived?: boolean
}): Promise<OverviewLoadResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const includeArchived = options.includeArchived ?? options.config.showArchived
  const notices: string[] = []
  const errors: OverviewSourceError[] = []
  let rateLimitResetAt: string | null = null
  const limit = options.config.maxScopeRepos
  let names: string[] = []

  try {
    if (options.watchedRepos.length > 0) {
      if (options.watchedRepos.length > limit) {
        notices.push(`仓库数量达到上限 ${limit}，其余仓库没有继续查询。到设置里调高「仓库数量上限」。`)
      }
      names = options.watchedRepos.slice(0, limit)
    } else {
      const owned = await discoverRepos(options.token, fetchImpl, 'repositories', limit)
      const room = Math.max(0, limit - owned.repos.length)
      let watchingRepos: ListedRepo[] = []
      let watchingTruncated = false
      if (room > 0) {
        const watching = await discoverRepos(options.token, fetchImpl, 'watching', room)
        watchingRepos = watching.repos
        watchingTruncated = watching.truncated
      } else if (!owned.truncated) {
        const peek = await discoverRepos(options.token, fetchImpl, 'watching', 1)
        watchingTruncated = peek.repos.length > 0
      }
      if (owned.truncated || watchingTruncated) {
        notices.push(`仓库数量达到上限 ${limit}，其余仓库没有继续查询。到设置里调高「仓库数量上限」。`)
      }
      const seen = new Set<string>()
      for (const repo of [...owned.repos, ...watchingRepos]) {
        const key = repo.name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        if (!inAutoScope(repo, options.config, options.now, includeArchived)) continue
        names.push(repo.name)
      }
    }
  } catch (error) {
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

  const loaded = await loadDetails(options.token, fetchImpl, names)
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
    classifyOverview(loaded.facts, options.config, options.now),
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
}
