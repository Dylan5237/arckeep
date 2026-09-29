import { assembleWaiting, mergeRecords } from '../shared/waiting/assemble.js'
import { GithubAuthError, GithubRateLimitError, earlierReset } from '../shared/waiting/rate-limit.js'
import { pendingTodoProvider } from '../shared/waiting/todo-source.js'
import type {
  GithubRecord,
  LocalBranchHit,
  SourceError,
  StatusDocHit,
  TodoWaitingItem,
  TodoWaitingProvider,
  WaitingConfig,
  WaitingDraft
} from '../shared/waiting/types.js'
import { loadGithubRecords, type GithubSourceBundle } from './github-load.js'
import { loadUnpushedBranches, type GitRunner } from './local-git.js'
import { loadStatusDocs } from './status-docs.js'

export interface WaitingMemory {
  assignee: GithubRecord[]
  reviewRequested: GithubRecord[]
  mentions: GithubRecord[]
  openPrs: GithubRecord[]
  humanIssues: GithubRecord[]
  statusDocs: StatusDocHit[]
  branches: LocalBranchHit[]
  todos: TodoWaitingItem[]
}

export function emptyWaitingMemory(): WaitingMemory {
  return {
    assignee: [],
    reviewRequested: [],
    mentions: [],
    openPrs: [],
    humanIssues: [],
    statusDocs: [],
    branches: [],
    todos: []
  }
}

export interface CollectResult {
  drafts: WaitingDraft[]
  memory: WaitingMemory
  errors: SourceError[]
  notices: string[]
  rateLimitResetAt: string | null
  auth: 'ok' | 'missing' | 'invalid'
  todosAvailable: boolean
  parkedRepos: string[]
}

function keepOrReplace<T>(fresh: boolean, next: T[], previous: T[]): T[] {
  return fresh ? next : previous
}

export async function collectWaiting(options: {
  token: string | null
  config: WaitingConfig
  watchedRepos: readonly string[]
  now: Date
  memory?: WaitingMemory
  fetchImpl?: typeof fetch
  git?: GitRunner
  todos?: TodoWaitingProvider
}): Promise<CollectResult> {
  const memory = options.memory ?? emptyWaitingMemory()
  const next: WaitingMemory = { ...memory }
  const errors: SourceError[] = []
  const notices: string[] = []
  let rateLimitResetAt: string | null = null
  let auth: CollectResult['auth'] = options.token ? 'ok' : 'missing'
  let parkedRepos: string[] = []
  const todos = options.todos ?? pendingTodoProvider

  if (options.token) {
    try {
      const github = await loadGithubRecords({
        token: options.token,
        config: options.config,
        watchedRepos: options.watchedRepos,
        fetchImpl: options.fetchImpl
      })
      auth = github.auth
      rateLimitResetAt = github.rateLimitResetAt
      errors.push(...github.errors)
      notices.push(...github.notices)
      parkedRepos = github.parkedRepos
      const keys: (keyof GithubSourceBundle)[] = ['assignee', 'reviewRequested', 'mentions', 'openPrs', 'humanIssues']
      if (github.auth !== 'invalid') {
        for (const key of keys) {
          next[key] = keepOrReplace(github.fresh[key], github.bySource[key], memory[key])
        }
      }
    } catch (error) {
      if (error instanceof GithubAuthError) auth = 'invalid'
      if (error instanceof GithubRateLimitError) rateLimitResetAt = earlierReset(rateLimitResetAt, error.resetAt)
      errors.push({ source: 'GitHub', message: error instanceof Error ? error.message : 'GitHub 查询失败' })
    }

    if (auth !== 'invalid' && options.config.sources.statusDocs) {
      try {
        const docs = await loadStatusDocs({
          token: options.token,
          rules: options.config.statusDocRules,
          fetchImpl: options.fetchImpl
        })
        next.statusDocs = docs.hits
        errors.push(...docs.errors)
      } catch (error) {
        if (error instanceof GithubAuthError) auth = 'invalid'
        if (error instanceof GithubRateLimitError) rateLimitResetAt = earlierReset(rateLimitResetAt, error.resetAt)
        errors.push({
          source: '状态文档',
          message: error instanceof Error ? error.message : '状态文档读取失败'
        })
      }
    }
  }

  if (options.config.sources.localBranches) {
    try {
      const local = await loadUnpushedBranches(options.config.localRepoDirs, options.git)
      next.branches = local.hits
      errors.push(...local.errors)
    } catch (error) {
      errors.push({ source: '本地没推送', message: error instanceof Error ? error.message : '本地仓库读取失败' })
    }
  } else {
    next.branches = []
  }

  if (options.config.sources.todos && todos.available) {
    try {
      next.todos = await todos.listWaitingOnMe()
    } catch (error) {
      errors.push({ source: '待办', message: error instanceof Error ? error.message : '待办读取失败' })
    }
  } else {
    next.todos = []
  }

  const showGithub = auth !== 'missing'
  const records = showGithub
    ? mergeRecords([
      ...next.assignee,
      ...next.reviewRequested,
      ...next.mentions,
      ...next.openPrs,
      ...next.humanIssues
    ])
    : []
  const drafts = assembleWaiting({
    records,
    statusDocs: auth === 'missing' ? [] : next.statusDocs,
    branches: next.branches,
    todos: next.todos,
    config: options.config,
    now: options.now
  })
  return {
    drafts,
    memory: next,
    errors,
    notices,
    rateLimitResetAt,
    auth,
    todosAvailable: todos.available,
    parkedRepos
  }
}
