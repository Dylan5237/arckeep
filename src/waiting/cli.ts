import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { assembleWaiting, toWaitingJson } from '../shared/waiting/assemble.js'
import { readDismissalState } from '../shared/waiting/snooze.js'
import { createTodoWaitingProvider } from '../shared/waiting/todo-source.js'
import { defaultWaitingConfig, parseWaitingConfig } from '../shared/waiting/rules.js'
import type { GithubRecord, LocalBranchHit, StatusDocHit, TodoWaitingItem, WaitingConfig, WaitingDraft } from '../shared/waiting/types.js'
import type { GhLookup } from '../main/github-auth.js'
import { defaultAppDataDir, settingsFilePath, todosFilePath, userDataDir, waitingDismissalPath } from '../main/paths.js'
import { loadSettings } from '../main/settings-store.js'
import { TodoStore } from '../main/todos/store.js'
import { collectWaiting } from './collect.js'
import { resolveWaitingToken } from './token.js'

interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
  env: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  readSaved?: () => string | null
  readGh?: () => Promise<GhLookup>
  now?: Date
}

function readFlag(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name)
  if (index < 0) return null
  return argv[index + 1] ?? null
}

function fixtureConfig(raw: unknown): {
  now: Date
  config: WaitingConfig
  records: GithubRecord[]
  statusDocs: StatusDocHit[]
  branches: LocalBranchHit[]
  todos: TodoWaitingItem[]
} {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const now = typeof record.now === 'string' ? new Date(record.now) : new Date()
  const config = record.config === undefined ? defaultWaitingConfig() : parseWaitingConfig(record.config)
  return {
    now,
    config,
    records: Array.isArray(record.records) ? record.records as GithubRecord[] : [],
    statusDocs: Array.isArray(record.statusDocs) ? record.statusDocs as StatusDocHit[] : [],
    branches: Array.isArray(record.branches) ? record.branches as LocalBranchHit[] : [],
    todos: Array.isArray(record.todos) ? record.todos as TodoWaitingItem[] : []
  }
}

function hiddenRepos(env: NodeJS.ProcessEnv): string[] {
  try {
    const file = waitingDismissalPath(userDataDir(defaultAppDataDir(env, process.platform, homedir())))
    return readDismissalState(JSON.parse(readFileSync(file, 'utf8')) as unknown).hiddenRepos
  } catch {
    return []
  }
}

function withoutHidden(drafts: WaitingDraft[], repos: readonly string[], includeHidden: boolean): WaitingDraft[] {
  if (includeHidden) return drafts
  const hidden = new Set(repos.map(repo => repo.toLowerCase()))
  return drafts.filter(draft => !draft.parked && !hidden.has(draft.repo.toLowerCase()))
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  if (argv.includes('--help')) {
    io.stderr('用法：npm run waiting -- --json [--fixture 文件] [--include-hidden]')
    return 0
  }
  const includeHidden = argv.includes('--include-hidden')
  const fixturePath = readFlag(argv, '--fixture')
  if (fixturePath) {
    const absolute = path.resolve(fixturePath)
    const parsed = fixtureConfig(JSON.parse(readFileSync(absolute, 'utf8')) as unknown)
    const drafts = assembleWaiting({
      records: parsed.records,
      statusDocs: parsed.statusDocs,
      branches: parsed.branches,
      todos: parsed.todos,
      config: parsed.config,
      now: parsed.now
    })
    io.stdout(`${JSON.stringify(toWaitingJson(withoutHidden(drafts, hiddenRepos(io.env), includeHidden)), null, 2)}\n`)
    return 0
  }

  const appData = defaultAppDataDir(io.env, process.platform, homedir())
  const settings = loadSettings(settingsFilePath(userDataDir(appData)))
  const access = await resolveWaitingToken({
    envToken: io.env.GITHUB_TOKEN ?? null,
    readSaved: io.readSaved ?? (() => null),
    readGh: io.readGh
  })
  if (!access.token && !settings.waiting.sources.localBranches) {
    io.stderr('未配置 GitHub 认证。请先 gh auth login，或设置环境变量 GITHUB_TOKEN。')
  }
  const userData = userDataDir(appData)
  const todos = createTodoWaitingProvider(() => new TodoStore({ file: todosFilePath(userData) }).listWaitingTodos())
  const result = await collectWaiting({
    token: access.token,
    config: settings.waiting,
    watchedRepos: settings.watchedRepos,
    now: io.now ?? new Date(),
    fetchImpl: io.fetchImpl,
    todos
  })
  if (result.auth === 'invalid') io.stderr('GitHub 认证无效或已过期。')
  for (const error of result.errors) io.stderr(`${error.source}: ${error.message}`)
  if (result.rateLimitResetAt) io.stderr(`GitHub 速率限制，重置时间 ${result.rateLimitResetAt}`)
  io.stdout(`${JSON.stringify(toWaitingJson(withoutHidden(result.drafts, hiddenRepos(io.env), includeHidden)), null, 2)}\n`)
  return 0
}

const invokedDirectly = process.argv[1] && (
  process.argv[1].endsWith('cli.js') || process.argv[1].endsWith('cli.ts')
)
if (invokedDirectly) {
  runCli(process.argv.slice(2), {
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(`${text}\n`),
    env: process.env
  }).then(code => {
    process.exitCode = code
  }).catch(error => {
    console.error(error instanceof Error ? error.message : '等我处理查询失败')
    process.exitCode = 1
  })
}
