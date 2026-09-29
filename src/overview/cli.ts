import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { defaultAppDataDir, settingsFilePath, userDataDir } from '../main/paths.js'
import { loadSettings } from '../main/settings-store.js'
import { classifyOverview, selectOverviewRows } from '../shared/overview/classify.js'
import { defaultOverviewConfig, parseOverviewConfig } from '../shared/overview/rules.js'
import type { OverviewRepoFacts, OverviewRow } from '../shared/overview/types.js'
import { resolveWaitingToken } from '../waiting/token.js'
import { loadOverview } from './load.js'

interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
  env: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  readSaved?: () => string | null
}

function readFlag(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name)
  if (index < 0) return null
  return argv[index + 1] ?? null
}

export function toOverviewJson(rows: readonly OverviewRow[]): OverviewRow[] {
  return rows.map(row => ({
    name: row.name,
    url: row.url,
    lastCommitAt: row.lastCommitAt,
    openPrCount: row.openPrCount,
    ciState: row.ciState,
    archived: row.archived,
    group: row.group,
    stallBasis: {
      at: row.stallBasis.at,
      source: row.stallBasis.source,
      lastCommitAt: row.stallBasis.lastCommitAt,
      lastIssueActivityAt: row.stallBasis.lastIssueActivityAt
    },
    warnings: row.warnings.map(warning => ({
      kind: warning.kind,
      label: warning.label,
      days: warning.days,
      hint: warning.hint,
      targets: warning.targets.map(target => ({ url: target.url }))
    })),
    error: row.error
  }))
}

function fixtureRows(raw: unknown, includeArchived: boolean): OverviewRow[] {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const now = typeof record.now === 'string' ? new Date(record.now) : new Date()
  const config = record.config === undefined ? defaultOverviewConfig() : parseOverviewConfig(record.config)
  const facts = Array.isArray(record.facts) ? record.facts as OverviewRepoFacts[] : []
  return selectOverviewRows(classifyOverview(facts, config, now), includeArchived)
}

export async function runOverviewCli(argv: readonly string[], io: CliIo): Promise<number> {
  if (argv.includes('--help')) {
    io.stderr('用法：npm run overview -- --json [--include-archived] [--fixture 文件]')
    return 0
  }
  const includeArchived = argv.includes('--include-archived')
  const fixturePath = readFlag(argv, '--fixture')
  if (fixturePath) {
    const absolute = path.resolve(fixturePath)
    const rows = fixtureRows(JSON.parse(readFileSync(absolute, 'utf8')) as unknown, includeArchived)
    io.stdout(`${JSON.stringify(toOverviewJson(rows), null, 2)}\n`)
    return 0
  }

  const appData = defaultAppDataDir(io.env, process.platform, homedir())
  const settings = loadSettings(settingsFilePath(userDataDir(appData)))
  const access = await resolveWaitingToken({
    envToken: io.env.GITHUB_TOKEN ?? null,
    readSaved: io.readSaved ?? (() => null)
  })
  if (!access.token) {
    io.stderr('未配置 GitHub 认证。请先 gh auth login，或设置环境变量 GITHUB_TOKEN。')
    io.stdout('[]\n')
    return 0
  }
  const result = await loadOverview({
    token: access.token,
    config: settings.overview,
    watchedRepos: settings.watchedRepos,
    now: new Date(),
    fetchImpl: io.fetchImpl,
    includeArchived
  })
  if (result.auth === 'invalid') io.stderr('GitHub 认证无效或已过期。')
  for (const error of result.errors) io.stderr(`${error.source}: ${error.message}`)
  if (result.rateLimitResetAt) io.stderr(`GitHub 速率限制，重置时间 ${result.rateLimitResetAt}`)
  for (const notice of result.notices) io.stderr(notice)
  io.stdout(`${JSON.stringify(toOverviewJson(result.rows), null, 2)}\n`)
  return 0
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').includes('/overview/cli.')
if (invokedDirectly) {
  runOverviewCli(process.argv.slice(2), {
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(`${text}\n`),
    env: process.env
  }).then(code => {
    process.exitCode = code
  }).catch(error => {
    console.error(error instanceof Error ? error.message : '项目总览查询失败')
    process.exitCode = 1
  })
}
