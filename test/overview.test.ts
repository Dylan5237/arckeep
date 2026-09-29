import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { OverviewService } from '../src/main/overview-service.js'
import { overviewCachePath, settingsFilePath } from '../src/main/paths.js'
import { SettingsService } from '../src/main/settings-service.js'
import type { SecretBox } from '../src/main/token-store.js'
import { classifyOverview, countsAsAttention, hasOverviewPushAccess, inAutoScope, isEmptyRepo, isReviewStuck, overviewCounts, selectOverviewRows } from '../src/shared/overview/classify.js'
import { canRemoveFromWatchList, overviewMetaText, visibleWarningChips } from '../src/shared/overview/present.js'
import { defaultOverviewConfig, parseOverviewConfig } from '../src/shared/overview/rules.js'
import type { OverviewConfig, OverviewPullRequest, OverviewRepoFacts, OverviewRow } from '../src/shared/overview/types.js'
import { runOverviewCli, toOverviewJson } from '../src/overview/cli.js'
import { loadOverview, parseRepositoryNode, readIssueActivity } from '../src/overview/load.js'

const NOW = new Date('2026-09-28T00:00:00.000Z')
const DAY = 86_400_000

function ago(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString()
}

function config(patch: Partial<OverviewConfig> = {}): OverviewConfig {
  return { ...defaultOverviewConfig(), ...patch }
}

function facts(patch: Partial<OverviewRepoFacts> = {}): OverviewRepoFacts {
  return {
    name: 'example/demo',
    url: 'https://github.com/example/demo',
    isEmpty: false,
    sizeKb: 24,
    hasDefaultBranchCommit: true,
    pushedAt: ago(1),
    createdAt: null,
    lastCommitAt: ago(1),
    lastIssueActivityAt: null,
    openPrCount: 0,
    ciState: 'success',
    ciFailureUrl: null,
    pullRequests: [],
    archived: false,
    error: null,
    ...patch
  }
}

function pull(patch: Partial<OverviewPullRequest> = {}): OverviewPullRequest {
  return {
    number: 4,
    title: 'Review me',
    url: 'https://github.com/example/demo/pull/4',
    isDraft: false,
    createdAt: ago(5),
    reviewDecision: 'REVIEW_REQUIRED',
    approvedReviewCount: 0,
    ...patch
  }
}

function kinds(row: OverviewRow): string[] {
  return row.warnings.map(warning => warning.kind)
}

function xorBox(): SecretBox {
  return {
    encrypt(plain: string) {
      const xored = Uint8Array.from(Buffer.from(plain, 'utf8'), byte => byte ^ 0x5a)
      return Buffer.from(xored).toString('base64')
    },
    decrypt(payload: string) {
      const xored = Uint8Array.from(Buffer.from(payload, 'base64'), byte => byte ^ 0x5a)
      return Buffer.from(xored).toString('utf8')
    }
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

describe('overview warnings', () => {
  it('marks 停滞, 卡住, 空仓, and 陈旧 from configurable day counts', () => {
    const rules = config({ staleDays: 14, reviewWaitDays: 3, staleRepoDays: 90 })
    const stalled = classifyOverview([facts({
      name: 'example/quiet',
      url: 'https://github.com/example/quiet',
      pushedAt: ago(14),
      lastCommitAt: ago(14)
    })], rules, NOW)[0]
    expect(stalled?.warnings[0]).toMatchObject({
      kind: '停滞',
      label: '停滞 14 天',
      days: 14,
      hint: '默认分支提交和 Issue/PR 活动都超过 14 天',
      targets: [{ url: 'https://github.com/example/quiet' }]
    })

    const recent = classifyOverview([facts({ pushedAt: ago(13), lastCommitAt: ago(13) })], rules, NOW)[0]
    expect(kinds(recent!)).toEqual([])

    const stuck = classifyOverview([facts({
      openPrCount: 1,
      pullRequests: [pull({ createdAt: ago(3) })]
    })], rules, NOW)[0]
    expect(stuck?.warnings[0]).toMatchObject({
      kind: '卡住',
      label: '卡住：PR 等 review 3 天',
      days: 3,
      hint: '超过 3 天没有 review',
      targets: [{ url: 'https://github.com/example/demo/pull/4' }]
    })
    const several = classifyOverview([facts({
      openPrCount: 3,
      pullRequests: [
        pull({ number: 2, url: 'https://github.com/example/demo/pull/2', createdAt: ago(4) }),
        pull({ number: 9, url: 'https://github.com/example/demo/pull/9', createdAt: ago(10) }),
        pull({ number: 3, url: 'https://github.com/example/demo/pull/3', createdAt: ago(6) })
      ]
    })], rules, NOW)[0]
    expect(several?.warnings.filter(item => item.label.startsWith('卡住：PR'))).toEqual([
      expect.objectContaining({
        label: '卡住：PR 等 review 10 天，等 2 个',
        days: 10,
        targets: [{ url: 'https://github.com/example/demo/pull/9' }]
      })
    ])
    const failedCi = classifyOverview([facts({
      ciState: 'failure',
      ciFailureUrl: 'https://github.com/example/demo/actions/runs/42',
      lastCommitAt: ago(1),
      pushedAt: ago(1)
    })], rules, NOW)[0]
    expect(failedCi?.warnings).toEqual([
      expect.objectContaining({
        kind: '卡住',
        label: '卡住：CI 失败',
        days: null,
        hint: '默认分支最近一次检查失败',
        targets: [{ url: 'https://github.com/example/demo/actions/runs/42' }]
      })
    ])
    expect(classifyOverview([facts({ ciState: 'success' })], rules, NOW)[0]?.warnings).toEqual([])
    expect(isReviewStuck(pull({ createdAt: ago(2) }), rules, NOW)).toBe(false)
    expect(isReviewStuck(pull({ isDraft: true, createdAt: ago(30) }), rules, NOW)).toBe(false)
    expect(isReviewStuck(pull({ reviewDecision: 'APPROVED', approvedReviewCount: 1 }), rules, NOW)).toBe(false)
    expect(isReviewStuck(pull({ reviewDecision: 'CHANGES_REQUESTED' }), rules, NOW)).toBe(false)

    expect(isEmptyRepo(facts({ isEmpty: true }))).toBe(true)
    expect(isEmptyRepo(facts({ sizeKb: 0, isEmpty: false, hasDefaultBranchCommit: true }))).toBe(true)
    expect(isEmptyRepo(facts({ hasDefaultBranchCommit: false, isEmpty: false, sizeKb: 8 }))).toBe(true)
    expect(isEmptyRepo(facts({ sizeKb: null }))).toBe(false)

    const empty = classifyOverview([facts({
      name: 'example/empty',
      url: 'https://github.com/example/empty',
      isEmpty: true,
      sizeKb: 0,
      hasDefaultBranchCommit: false,
      pushedAt: null,
      lastCommitAt: null,
      ciState: 'none'
    })], rules, NOW)[0]
    expect(kinds(empty!)).toEqual(['空仓'])
    expect(kinds(classifyOverview([facts({ sizeKb: 0 })], rules, NOW)[0]!)).toContain('空仓')
    expect(kinds(classifyOverview([facts({ hasDefaultBranchCommit: false, lastCommitAt: null })], rules, NOW)[0]!)).toContain('空仓')

    const pushedRecently = classifyOverview([facts({
      pushedAt: ago(1),
      createdAt: ago(200),
      lastCommitAt: ago(91),
      lastIssueActivityAt: ago(91)
    })], rules, NOW)[0]
    expect(pushedRecently?.group).toBe('active')
    expect(kinds(pushedRecently!)).toEqual(['停滞'])
    const ancient = classifyOverview([facts({
      pushedAt: ago(91),
      createdAt: ago(200),
      lastCommitAt: ago(91),
      lastIssueActivityAt: ago(91)
    })], rules, NOW)[0]
    expect(kinds(ancient!)).toEqual(['陈旧'])
    expect(kinds(classifyOverview([facts({ pushedAt: ago(89), lastCommitAt: ago(89) })], rules, NOW)[0]!)).toEqual(['停滞'])

    const named = classifyOverview([
      facts({ name: 'alpha/one', url: 'https://github.com/alpha/one', pushedAt: ago(20), lastCommitAt: ago(20) }),
      facts({ name: 'beta/two', url: 'https://github.com/beta/two', pushedAt: ago(20), lastCommitAt: ago(20) })
    ], rules, NOW)
    expect(named.map(row => kinds(row))).toEqual([['停滞'], ['停滞']])
  })

  it('never warns an archived repository and omits it unless inclusion is requested', () => {
    const archived = facts({
      name: 'example/old',
      url: 'https://github.com/example/old',
      archived: true,
      isEmpty: true,
      sizeKb: 0,
      hasDefaultBranchCommit: false,
      pushedAt: ago(400),
      lastCommitAt: ago(400),
      ciState: 'failure',
      ciFailureUrl: 'https://github.com/example/old/actions/runs/1',
      openPrCount: 1,
      pullRequests: [pull({ url: 'https://github.com/example/old/pull/2', createdAt: ago(30) })]
    })
    const live = facts({
      name: 'example/live',
      url: 'https://github.com/example/live',
      pushedAt: ago(100),
      lastCommitAt: ago(100)
    })
    const rows = classifyOverview([archived, live], config(), NOW)
    expect(rows.map(row => row.name)).toEqual(['example/live', 'example/old'])
    expect(rows[1]).toMatchObject({ archived: true, warnings: [] })
    expect(selectOverviewRows(rows, false).map(row => row.name)).toEqual(['example/live'])
    expect(overviewCounts(rows)).toEqual({ repos: 1, attention: 0 })
    expect(overviewCounts(selectOverviewRows(rows, true)).repos).toBe(1)
  })

  it('sorts active warnings ahead of quiet repos and keeps 陈旧 after them, oldest first', () => {
    const rows = classifyOverview([
      facts({ name: 'example/clean', lastCommitAt: ago(1), pushedAt: ago(1) }),
      facts({ name: 'example/older-stale', lastCommitAt: ago(200), pushedAt: ago(200) }),
      facts({ name: 'example/stale', lastCommitAt: ago(100), pushedAt: ago(100) }),
      facts({
        name: 'example/stuck',
        lastCommitAt: ago(2),
        pushedAt: ago(2),
        openPrCount: 1,
        pullRequests: [pull({ url: 'https://github.com/example/stuck/pull/8', createdAt: ago(9) })]
      }),
      facts({ name: 'example/quiet', lastCommitAt: ago(20), pushedAt: ago(20) }),
      facts({
        name: 'example/failed',
        url: 'https://github.com/example/failed',
        lastCommitAt: ago(2),
        pushedAt: ago(2),
        ciState: 'failure'
      }),
      facts({ name: 'example/missing', error: '仓库不存在或无权访问', lastCommitAt: null, pushedAt: null, ciState: 'unknown' })
    ], config(), NOW)
    expect(rows.map(row => row.name)).toEqual([
      'example/failed',
      'example/stuck',
      'example/quiet',
      'example/clean',
      'example/missing',
      'example/older-stale',
      'example/stale'
    ])
    expect(rows[0]?.warnings[0]?.label).toBe('卡住：CI 失败')
    expect(rows[0]?.warnings[0]?.targets).toEqual([{ url: 'https://github.com/example/failed/actions' }])
    expect(rows.at(-1)?.warnings.map(warning => warning.kind)).toEqual(['陈旧'])
  })

  it('uses the auto-mode push window without naming a repository', () => {
    const rules = config({ staleRepoDays: 30 })
    expect(inAutoScope({ isEmpty: false, pushedAt: ago(14) }, rules, NOW)).toBe(true)
    expect(inAutoScope({ isEmpty: false, pushedAt: ago(20) }, rules, NOW)).toBe(true)
    expect(inAutoScope({ isEmpty: false, pushedAt: ago(31) }, rules, NOW)).toBe(true)
    expect(inAutoScope({ isEmpty: true, pushedAt: null }, rules, NOW)).toBe(true)
    expect(inAutoScope({ isEmpty: false, pushedAt: null }, rules, NOW)).toBe(true)
    expect(inAutoScope({ isEmpty: false, pushedAt: ago(1), archived: true }, rules, NOW)).toBe(false)
    expect(inAutoScope({ isEmpty: true, pushedAt: null, archived: true }, rules, NOW, true)).toBe(true)
    expect(defaultOverviewConfig().showArchived).toBe(false)
    expect(defaultOverviewConfig()).toMatchObject({ staleDays: 7, staleRepoDays: 30 })
    expect(defaultOverviewConfig()).not.toHaveProperty('autoPushWindowDays')
    expect(parseOverviewConfig({ showArchived: true }).showArchived).toBe(true)
    expect(parseOverviewConfig({ staleDays: 9, staleRepoDays: 45 })).toMatchObject({
      staleDays: 9,
      staleRepoDays: 45
    })
    expect(parseOverviewConfig({ autoPushWindowDays: 3 })).not.toHaveProperty('autoPushWindowDays')
    const defaults = defaultOverviewConfig()
    expect(JSON.stringify(defaults)).not.toContain('Dylan5237/')
    const source = [
      readFileSync(path.join('src', 'shared', 'overview', 'classify.ts'), 'utf8'),
      readFileSync(path.join('src', 'overview', 'load.ts'), 'utf8')
    ].join('\n')
    expect(source).not.toContain('Dylan5237/')
    expect(source).not.toMatch(/watching\s*\(/)
    expect(source).toContain('OWNER, COLLABORATOR, ORGANIZATION_MEMBER')
    expect(hasOverviewPushAccess('ADMIN')).toBe(true)
    expect(hasOverviewPushAccess('MAINTAIN')).toBe(true)
    expect(hasOverviewPushAccess('WRITE')).toBe(true)
    expect(hasOverviewPushAccess('TRIAGE')).toBe(false)
    expect(hasOverviewPushAccess('READ')).toBe(false)
    expect(hasOverviewPushAccess(null)).toBe(false)
    expect(hasOverviewPushAccess(undefined)).toBe(false)
    expect(parseOverviewConfig(undefined)).toEqual(defaults)
    expect(() => parseOverviewConfig({ staleDays: 0 })).toThrow('停滞天数')
  })

  it('counts only 卡住, 停滞, 空仓, and errors, and keeps quiet CI off the chips', () => {
    const failed = classifyOverview([facts({
      name: 'example/failed',
      url: 'https://github.com/example/failed',
      ciState: 'failure',
      ciFailureUrl: 'https://github.com/example/failed/actions/runs/9',
      openPrCount: 2,
      lastCommitAt: ago(1),
      pushedAt: ago(1)
    })], config(), NOW)[0]!
    const quiet = classifyOverview([facts({ ciState: 'success', openPrCount: 0 })], config(), NOW)[0]!
    const pending = classifyOverview([facts({ name: 'example/pending', ciState: 'pending' })], config(), NOW)[0]!
    const none = classifyOverview([facts({ name: 'example/none', ciState: 'none' })], config(), NOW)[0]!
    const stale = classifyOverview([facts({
      name: 'example/old',
      pushedAt: ago(120),
      lastCommitAt: ago(120),
      ciState: 'none'
    })], config(), NOW)[0]!
    const missing = classifyOverview([facts({
      name: 'example/gone',
      error: '仓库不存在或无权访问',
      lastCommitAt: null,
      pushedAt: null,
      ciState: 'unknown'
    })], config(), NOW)[0]!
    const archived = classifyOverview([facts({
      name: 'example/archived',
      archived: true,
      ciState: 'failure',
      pushedAt: ago(400),
      lastCommitAt: ago(400)
    })], config(), NOW)[0]!

    expect(visibleWarningChips(failed).map(item => item.label)).toEqual(['卡住：CI 失败'])
    expect(visibleWarningChips(failed)[0]?.targets).toEqual([
      { url: 'https://github.com/example/failed/actions/runs/9' }
    ])
    expect(overviewMetaText(failed, NOW)).toBe('1 天前 · 2 个 PR 待合并')
    expect(overviewMetaText(failed, NOW)).not.toContain('open PR')
    expect(visibleWarningChips(quiet)).toEqual([])
    expect(overviewMetaText(quiet, NOW)).toBe('1 天前 · CI 通过')
    expect(overviewMetaText(pending, NOW)).toContain('CI 进行中')
    expect(overviewMetaText(none, NOW)).toContain('无 CI')
    expect(stale.warnings.map(item => item.kind)).toContain('陈旧')
    expect(visibleWarningChips(stale).map(item => item.kind)).not.toContain('陈旧')
    expect(visibleWarningChips(archived)).toEqual([])
    expect(canRemoveFromWatchList(missing)).toBe(false)
    expect(canRemoveFromWatchList({ ...missing, fromWatchList: true })).toBe(true)
    expect(canRemoveFromWatchList({ ...quiet, fromWatchList: true })).toBe(false)
    expect(overviewCounts([failed, quiet, pending, none, stale, missing, archived])).toEqual({
      repos: 6,
      attention: 2
    })
  })

  it('places 29/30/31 day activity and stalls only active repos at 6/7/8 days', () => {
    const rules = config()
    const aged = (days: number, patch: Partial<OverviewRepoFacts> = {}) => classifyOverview([facts({
      pushedAt: ago(days),
      lastCommitAt: ago(days),
      lastIssueActivityAt: ago(days),
      ...patch
    })], rules, NOW)[0]!

    expect(aged(29).group).toBe('active')
    expect(aged(30).group).toBe('active')
    expect(aged(30).warnings.find(item => item.kind === '停滞')?.days).toBe(30)
    expect(aged(31).group).toBe('stale')
    expect(kinds(aged(31))).toEqual(['陈旧'])
    expect(kinds(aged(31))).not.toContain('停滞')

    expect(kinds(aged(6))).not.toContain('停滞')
    expect(aged(6).group).toBe('active')
    expect(aged(7).warnings.find(item => item.kind === '停滞')).toMatchObject({ label: '停滞 7 天', days: 7 })
    expect(aged(8).warnings.find(item => item.kind === '停滞')?.days).toBe(8)
    expect(aged(8).group).toBe('active')

    const recentIssue = aged(40, { lastIssueActivityAt: ago(3), name: 'example/talking', url: 'https://github.com/example/talking' })
    expect(recentIssue.group).toBe('active')
    expect(kinds(recentIssue)).not.toContain('停滞')
    expect(recentIssue.stallBasis).toMatchObject({ source: 'issue', at: ago(3) })

    const recentCommit = aged(40, { lastCommitAt: ago(6), lastIssueActivityAt: ago(8) })
    expect(recentCommit.group).toBe('active')
    expect(kinds(recentCommit)).not.toContain('停滞')
    expect(recentCommit.stallBasis.source).toBe('commit')

    const newerIssue = aged(20, { lastIssueActivityAt: ago(12), name: 'example/both', url: 'https://github.com/example/both' })
    expect(newerIssue.group).toBe('active')
    expect(newerIssue.warnings.find(item => item.kind === '停滞')).toMatchObject({ label: '停滞 12 天', days: 12 })
    expect(newerIssue.stallBasis.source).toBe('issue')

    const tie = aged(10, { lastCommitAt: ago(10), lastIssueActivityAt: ago(10) })
    expect(tie.stallBasis.source).toBe('tie')
    expect(tie.warnings.find(item => item.kind === '停滞')?.days).toBe(10)

    const staleFailure = aged(31, {
      name: 'example/stale-ci',
      url: 'https://github.com/example/stale-ci',
      ciState: 'failure',
      ciFailureUrl: 'https://github.com/example/stale-ci/actions/runs/7'
    })
    expect(staleFailure.group).toBe('stale')
    expect(visibleWarningChips(staleFailure).map(item => item.label)).toEqual(['卡住：CI 失败'])
    expect(countsAsAttention(staleFailure)).toBe(false)

    const staleEmpty = classifyOverview([facts({
      name: 'example/stale-empty',
      url: 'https://github.com/example/stale-empty',
      isEmpty: true,
      sizeKb: 0,
      hasDefaultBranchCommit: false,
      pushedAt: ago(40),
      lastCommitAt: null,
      lastIssueActivityAt: ago(40),
      ciState: 'none'
    })], rules, NOW)[0]!
    expect(staleEmpty.group).toBe('stale')
    expect(visibleWarningChips(staleEmpty).map(item => item.kind)).toEqual(['空仓'])
    expect(countsAsAttention(staleEmpty)).toBe(false)

    const activeEmpty = classifyOverview([facts({
      name: 'example/active-empty',
      url: 'https://github.com/example/active-empty',
      isEmpty: true,
      sizeKb: 0,
      hasDefaultBranchCommit: false,
      pushedAt: null,
      lastCommitAt: null,
      lastIssueActivityAt: null,
      ciState: 'none'
    })], rules, NOW)[0]!
    expect(activeEmpty.group).toBe('active')
    expect(visibleWarningChips(activeEmpty).map(item => item.label)).toEqual(['空仓'])
    expect(countsAsAttention(activeEmpty)).toBe(true)
    expect(overviewCounts([staleFailure, staleEmpty, activeEmpty, aged(29)])).toEqual({ repos: 4, attention: 2 })
  })

  it('groups an empty repo by the newest of commit, issue activity, push, and creation', () => {
    const rules = config()
    const untouched = (createdDays: number, patch: Partial<OverviewRepoFacts> = {}) => classifyOverview([facts({
      name: 'example/untouched',
      url: 'https://github.com/example/untouched',
      isEmpty: true,
      sizeKb: 0,
      hasDefaultBranchCommit: false,
      pushedAt: null,
      lastCommitAt: null,
      lastIssueActivityAt: null,
      createdAt: ago(createdDays),
      ciState: 'none',
      ...patch
    })], rules, NOW)[0]!

    const yearsOld = untouched(800)
    expect(yearsOld.group).toBe('stale')
    expect(kinds(yearsOld)).toEqual(['空仓', '陈旧'])
    expect(kinds(yearsOld)).not.toContain('停滞')
    expect(visibleWarningChips(yearsOld).map(item => item.kind)).toEqual(['空仓'])
    expect(countsAsAttention(yearsOld)).toBe(false)
    expect(overviewCounts([yearsOld])).toEqual({ repos: 1, attention: 0 })

    const born29 = untouched(29)
    const born30 = untouched(30)
    const born31 = untouched(31)
    expect(born29.group).toBe('active')
    expect(born30.group).toBe('active')
    expect(born31.group).toBe('stale')
    expect(kinds(born29)).toEqual(['空仓'])
    expect(kinds(born29)).not.toContain('停滞')
    expect(kinds(untouched(6))).not.toContain('停滞')
    expect(countsAsAttention(born29)).toBe(true)
    expect(countsAsAttention(born31)).toBe(false)
    expect(visibleWarningChips(born31).map(item => item.kind)).toEqual(['空仓'])
    expect(overviewCounts([born29, born31])).toEqual({ repos: 2, attention: 1 })

    const discussed = untouched(400, { lastIssueActivityAt: ago(10) })
    expect(discussed.group).toBe('active')
    expect(kinds(discussed)).toEqual(['空仓'])
    expect(countsAsAttention(discussed)).toBe(true)
    expect(overviewCounts([discussed])).toEqual({ repos: 1, attention: 1 })

    const pushed = (days: number) => untouched(400, {
      name: 'example/side-push',
      url: 'https://github.com/example/side-push',
      isEmpty: false,
      sizeKb: 4,
      pushedAt: ago(days)
    })
    const recentPush = pushed(5)
    expect(recentPush.group).toBe('active')
    expect(kinds(recentPush)).toEqual(['空仓'])
    expect(kinds(recentPush)).not.toContain('停滞')
    expect(countsAsAttention(recentPush)).toBe(true)
    const oldPush = pushed(40)
    expect(oldPush.group).toBe('stale')
    expect(visibleWarningChips(oldPush).map(item => item.kind)).toEqual(['空仓'])
    expect(countsAsAttention(oldPush)).toBe(false)
    expect(overviewCounts([recentPush, oldPush])).toEqual({ repos: 2, attention: 1 })
  })
})

describe('overview loading', () => {
  it('skips an archived watch-list repository until inclusion is requested', async () => {
    const node = (archived: boolean) => ({
      nameWithOwner: archived ? 'example/old' : 'example/live',
      url: `https://github.com/example/${archived ? 'old' : 'live'}`,
      isEmpty: false,
      isArchived: archived,
      diskUsage: 8,
      pushedAt: ago(archived ? 400 : 2),
      defaultBranchRef: {
        target: {
          oid: 'abc',
          committedDate: ago(archived ? 400 : 2),
          statusCheckRollup: { state: archived ? 'FAILURE' : 'SUCCESS' }
        }
      },
      pullRequests: archived
        ? { totalCount: 1, nodes: [{ number: 2, title: 'old', url: 'https://github.com/example/old/pull/2', isDraft: false, createdAt: ago(40), reviewDecision: 'REVIEW_REQUIRED', reviews: { totalCount: 0 } }] }
        : { totalCount: 0, nodes: [] }
    })
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables: Record<string, string> }
      const names = Object.entries(body.variables).filter(([key]) => key.startsWith('n')).map(([, value]) => value)
      const data: Record<string, unknown> = {}
      names.forEach((name, index) => { data[`r${index}`] = node(name === 'old') })
      return jsonResponse({ data })
    }
    const hidden = await loadOverview({
      token: 'test-token',
      config: config({ showArchived: false }),
      watchedRepos: ['example/live', 'example/old'],
      now: NOW,
      fetchImpl
    })
    expect(hidden.rows.map(row => row.name)).toEqual(['example/live'])
    const shown = await loadOverview({
      token: 'test-token',
      config: config({ showArchived: true }),
      watchedRepos: ['example/live', 'example/old'],
      now: NOW,
      includeArchived: true,
      fetchImpl
    })
    expect(shown.rows.map(row => [row.name, row.archived, row.warnings.length])).toEqual([
      ['example/live', false, 0],
      ['example/old', true, 0]
    ])
    expect(overviewCounts(shown.rows)).toEqual({ repos: 1, attention: 0 })
  })

  it('keeps a missing repository on its own row', async () => {
    const payload = {
      data: {
        r0: {
          nameWithOwner: 'example/live',
          url: 'https://github.com/example/live',
          isEmpty: false,
          diskUsage: 12,
          pushedAt: ago(2),
          defaultBranchRef: {
            target: {
              oid: 'abc',
              committedDate: ago(2),
              statusCheckRollup: { state: 'SUCCESS' }
            }
          },
          pullRequests: { totalCount: 0, nodes: [] }
        },
        r1: null
      },
      errors: [{ message: "Could not resolve to a Repository with the name 'example/gone'.", path: ['r1'] }]
    }
    const result = await loadOverview({
      token: 'test-token',
      config: config(),
      watchedRepos: ['example/live', 'example/gone'],
      now: NOW,
      fetchImpl: async () => jsonResponse(payload)
    })
    expect(result.fresh).toBe(true)
    expect(result.rows.map(row => row.name)).toEqual(['example/live', 'example/gone'])
    expect(result.rows[1]).toMatchObject({
      error: '仓库不存在或无权访问',
      ciState: 'unknown',
      warnings: [],
      openPrCount: 0,
      fromWatchList: true
    })
    expect(result.rows.every(row => row.fromWatchList)).toBe(true)
    expect(canRemoveFromWatchList(result.rows[1]!)).toBe(true)
    expect(canRemoveFromWatchList(result.rows[0]!)).toBe(false)
    expect(result.rows[0]?.ciState).toBe('success')
  })

  it('falls back per repository when a batch fails', async () => {
    let calls = 0
    const result = await loadOverview({
      token: 'test-token',
      config: config(),
      watchedRepos: ['example/ok', 'example/denied'],
      now: NOW,
      fetchImpl: async (_url, init) => {
        calls += 1
        const body = JSON.parse(String(init?.body)) as { query: string, variables: Record<string, string> }
        if (body.query.includes('$o1')) throw new Error('batch failed')
        if (body.variables.n0 === 'denied') {
          return jsonResponse({
            data: { r0: null },
            errors: [{ message: 'Could not resolve to a Repository', path: ['r0'] }]
          })
        }
        return jsonResponse({
          data: {
            r0: {
              nameWithOwner: 'example/ok',
              url: 'https://github.com/example/ok',
              isEmpty: false,
              diskUsage: 4,
              pushedAt: ago(1),
              defaultBranchRef: { target: { oid: 'abc', committedDate: ago(1), statusCheckRollup: { state: 'FAILURE' } } },
              pullRequests: { totalCount: 0, nodes: [] }
            }
          }
        })
      }
    })
    expect(calls).toBeGreaterThan(1)
    expect(result.rows.map(row => [row.name, row.error, row.ciState])).toEqual([
      ['example/ok', null, 'failure'],
      ['example/denied', '仓库不存在或无权访问', 'unknown']
    ])
  })

  it('keeps every pushable age band and drops watch-only or read-only repos', async () => {
    const seen: string[] = []
    const queries: string[] = []
    const ages: Record<string, number> = { owned: 2, collab: 20, member: 40, blank: 0 }
    const node = (name: string, days: number, empty = false) => ({
      nameWithOwner: name,
      url: `https://github.com/${name}`,
      isEmpty: empty,
      diskUsage: empty ? 0 : 8,
      pushedAt: empty ? null : ago(days),
      createdAt: empty ? ago(500) : ago(days),
      defaultBranchRef: empty ? null : { target: { oid: 'abc', committedDate: ago(days), statusCheckRollup: null } },
      pullRequests: { totalCount: 0, nodes: [] },
      issues: { nodes: [] },
      recentPulls: { nodes: [] }
    })
    const result = await loadOverview({
      token: 'test-token',
      config: config({ staleRepoDays: 30, staleDays: 7, maxScopeRepos: 20 }),
      watchedRepos: [],
      now: NOW,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { query: string, variables: Record<string, string> }
        queries.push(body.query)
        if (body.query.includes('repositories(')) {
          return jsonResponse({
            data: {
              viewer: {
                repositories: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    { nameWithOwner: 'example/owned', isEmpty: false, pushedAt: ago(2), isArchived: false, viewerPermission: 'ADMIN' },
                    { nameWithOwner: 'example/collab', isEmpty: false, pushedAt: ago(20), isArchived: false, viewerPermission: 'WRITE' },
                    { nameWithOwner: 'example/member', isEmpty: false, pushedAt: ago(40), isArchived: false, viewerPermission: 'MAINTAIN' },
                    { nameWithOwner: 'example/reader', isEmpty: false, pushedAt: ago(1), isArchived: false, viewerPermission: 'READ' },
                    { nameWithOwner: 'example/triage', isEmpty: false, pushedAt: ago(1), isArchived: false, viewerPermission: 'TRIAGE' },
                    { nameWithOwner: 'example/blank', isEmpty: true, pushedAt: null, isArchived: false, viewerPermission: 'ADMIN' },
                    { nameWithOwner: 'example/vault', isEmpty: false, pushedAt: ago(1), isArchived: true, viewerPermission: 'ADMIN' }
                  ]
                }
              }
            }
          })
        }
        if (body.query.includes('watching(')) {
          return jsonResponse({
            data: {
              viewer: {
                watching: {
                  pageInfo: { hasNextPage: false },
                  nodes: [{ nameWithOwner: 'other/only-watch', isEmpty: false, pushedAt: ago(1), isArchived: false, viewerPermission: 'READ' }]
                }
              }
            }
          })
        }
        const names = Object.entries(body.variables).filter(([key]) => key.startsWith('n')).map(([, value]) => value)
        for (const name of names) seen.push(name)
        const data: Record<string, unknown> = {}
        names.forEach((name, index) => {
          data[`r${index}`] = node(`example/${name}`, ages[name] ?? 1, name === 'blank')
        })
        return jsonResponse({ data })
      }
    })
    expect(queries.some(query => /watching\s*\(/.test(query))).toBe(false)
    expect(queries.some(query => query.includes('OWNER, COLLABORATOR, ORGANIZATION_MEMBER'))).toBe(true)
    expect(seen.sort()).toEqual(['blank', 'collab', 'member', 'owned'])
    expect(queries.some(query => query.includes('\n  createdAt\n'))).toBe(true)
    expect(result.rows.map(row => [row.name, row.group])).toEqual([
      ['example/collab', 'active'],
      ['example/owned', 'active'],
      ['example/member', 'stale'],
      ['example/blank', 'stale']
    ])
    expect(result.rows.some(row => row.name.includes('only-watch') || row.name.includes('reader') || row.name.includes('triage'))).toBe(false)
    expect(visibleWarningChips(result.rows.find(row => row.name === 'example/blank')!).map(item => item.kind)).toEqual(['空仓'])
    expect(overviewCounts(result.rows)).toEqual({ repos: 4, attention: 1 })
    expect(result.rows.find(row => row.name === 'example/collab')?.warnings.map(item => item.kind)).toEqual(['停滞'])
    expect(result.rows.find(row => row.name === 'example/member')?.warnings.map(item => item.kind)).toEqual(['陈旧'])
  })

  it('keeps archived repositories out of auto mode unless inclusion is requested', async () => {
    const seen: string[] = []
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string, variables: Record<string, string> }
      if (body.query.includes('repositories(')) {
        return jsonResponse({
          data: {
            viewer: {
              repositories: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { nameWithOwner: 'example/recent', isEmpty: false, pushedAt: ago(2), isArchived: false, viewerPermission: 'ADMIN' },
                  { nameWithOwner: 'example/vault', isEmpty: false, pushedAt: ago(1), isArchived: true, viewerPermission: 'WRITE' },
                  { nameWithOwner: 'example/moth', isEmpty: true, pushedAt: ago(200), isArchived: true, viewerPermission: 'MAINTAIN' }
                ]
              }
            }
          }
        })
      }
      const names = Object.entries(body.variables).filter(([key]) => key.startsWith('n')).map(([, value]) => value)
      for (const name of names) seen.push(name)
      const data: Record<string, unknown> = {}
      names.forEach((name, index) => {
        data[`r${index}`] = {
          nameWithOwner: `example/${name}`,
          url: `https://github.com/example/${name}`,
          isEmpty: name === 'moth',
          isArchived: name !== 'recent',
          diskUsage: name === 'moth' ? 0 : 8,
          pushedAt: ago(name === 'moth' ? 200 : 1),
          defaultBranchRef: name === 'moth'
            ? null
            : { target: { oid: 'abc', committedDate: ago(1), statusCheckRollup: { state: 'FAILURE' } } },
          pullRequests: { totalCount: 0, nodes: [] }
        }
      })
      return jsonResponse({ data })
    }
    const hidden = await loadOverview({
      token: 'test-token',
      config: config({ staleRepoDays: 90 }),
      watchedRepos: [],
      now: NOW,
      fetchImpl
    })
    expect(hidden.rows.map(row => row.name)).toEqual(['example/recent'])
    expect(hidden.rows.every(row => row.fromWatchList === false)).toBe(true)
    expect(seen).toEqual(['recent'])
    seen.length = 0
    const shown = await loadOverview({
      token: 'test-token',
      config: config({ showArchived: true, staleRepoDays: 90 }),
      watchedRepos: [],
      now: NOW,
      includeArchived: true,
      fetchImpl
    })
    expect(shown.rows.map(row => [row.name, row.archived, row.warnings.length])).toEqual([
      ['example/recent', false, 1],
      ['example/moth', true, 0],
      ['example/vault', true, 0]
    ])
    expect(overviewCounts(shown.rows)).toEqual({ repos: 1, attention: 1 })
  })

  it('keeps the previous list when GitHub rate limits, and does not call GitHub without a token', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'arckeep-overview-cache-'))
    const file = settingsFilePath(dir)
    const service = new SettingsService({
      file,
      secretBox: xorBox(),
      registrar: { register: () => true, isRegistered: () => false, unregister: () => {} },
      onHotkey: () => {},
      readGh: async () => ({ ok: false, reason: 'not-installed' })
    })
    service.init()
    expect(service.setRepos(['example/live']).ok).toBe(true)
    let fetches = 0
    const live = jsonResponse({
      data: {
        r0: {
          nameWithOwner: 'example/live',
          url: 'https://github.com/example/live',
          isEmpty: false,
          diskUsage: 3,
          pushedAt: ago(1),
          defaultBranchRef: { target: { oid: 'abc', committedDate: ago(1), statusCheckRollup: { state: 'SUCCESS' } } },
          pullRequests: { totalCount: 0, nodes: [] }
        }
      }
    })
    const overview = new OverviewService(service, overviewCachePath(dir), {
      env: { GITHUB_TOKEN: 'test-token' },
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      now: () => NOW,
      fetchImpl: async () => {
        fetches += 1
        if (fetches === 1) return live
        return jsonResponse('rate limit exceeded', 429, { 'x-ratelimit-reset': '1790600000' })
      }
    })
    const first = await overview.refresh()
    expect(first.rows.map(row => row.name)).toEqual(['example/live'])
    const limited = await overview.refresh()
    expect(limited.rows.map(row => row.name)).toEqual(['example/live'])
    expect(limited.rateLimitResetAt).toBeTruthy()
    const blocked = new OverviewService(service, overviewCachePath(`${dir}-empty`), {
      env: {},
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      fetchImpl: async () => { throw new Error('should not fetch') }
    })
    const missing = await blocked.refresh()
    expect(missing.auth).toBe('missing')
    expect(missing.rows).toEqual([])
  })
})

describe('overview cli', () => {
  it('prints name, url, last commit, pull count, CI, and warning urls', async () => {
    let output = ''
    const code = await runOverviewCli(['--json', '--fixture', path.join('test', 'fixtures', 'overview-cli.json')], {
      stdout: text => { output += text },
      stderr: () => {},
      env: {},
      fetchImpl: async () => { throw new Error('network') }
    })
    expect(code).toBe(0)
    const rows = JSON.parse(output) as OverviewRow[]
    expect(rows.map(row => row.name)).toEqual(['example/stalled', 'example/stuck'])
    for (const row of rows) {
      expect(row).toEqual(expect.objectContaining({
        name: expect.any(String),
        url: expect.stringContaining('https://github.com/example/'),
        openPrCount: expect.any(Number),
        ciState: expect.any(String)
      }))
      expect(row.archived).toBe(false)
      expect(Array.isArray(row.warnings)).toBe(true)
      for (const warning of row.warnings) {
        expect(warning.targets.every(target => target.url.startsWith('https://github.com/'))).toBe(true)
      }
    }
    const stalled = rows.find(row => row.name === 'example/stalled')
    const stuck = rows.find(row => row.name === 'example/stuck')
    expect(stalled?.warnings.map(warning => warning.label)).toEqual(['卡住：CI 失败', '停滞 27 天'])
    expect(stalled?.warnings[1]).toMatchObject({ days: 27, targets: [{ url: 'https://github.com/example/stalled' }] })
    expect(stalled?.ciState).toBe('failure')
    expect(stuck?.warnings[0]).toMatchObject({
      kind: '卡住',
      label: '卡住：PR 等 review 8 天',
      days: 8,
      hint: '超过 3 天没有 review',
      targets: [{ url: 'https://github.com/example/stuck/pull/8' }]
    })
    expect(stuck?.lastCommitAt).toBe('2026-09-27T00:00:00.000Z')
    const withFlag = toOverviewJson([{ ...stuck!, fromWatchList: true }])
    expect(withFlag[0]).not.toHaveProperty('fromWatchList')
    expect(Object.keys(withFlag[0]!).sort()).toEqual([
      'archived', 'ciState', 'error', 'group', 'lastCommitAt', 'name', 'openPrCount', 'stallBasis', 'url', 'warnings'
    ])
    expect(stalled?.group).toBe('active')
    expect(stalled?.stallBasis).toMatchObject({
      source: 'commit',
      at: '2026-09-01T00:00:00.000Z',
      lastIssueActivityAt: null
    })
    expect(rows.every(row => !('fromWatchList' in row))).toBe(true)
  })

  it('leaves archived repositories out unless --include-archived', async () => {
    const run = async (argv: string[]) => {
      let output = ''
      const code = await runOverviewCli(argv, {
        stdout: text => { output += text },
        stderr: () => {},
        env: {},
        fetchImpl: async () => { throw new Error('network') }
      })
      expect(code).toBe(0)
      return JSON.parse(output) as OverviewRow[]
    }
    const hidden = await run(['--json', '--fixture', path.join('test', 'fixtures', 'overview-cli.json')])
    expect(hidden.map(row => row.name)).toEqual(['example/stalled', 'example/stuck'])
    const shown = await run(['--json', '--include-archived', '--fixture', path.join('test', 'fixtures', 'overview-cli.json')])
    const archived = shown.find(row => row.name === 'example/archived')
    expect(archived).toMatchObject({
      archived: true,
      warnings: [],
      ciState: 'failure'
    })
    expect(shown.filter(row => !row.archived).map(row => row.name)).toEqual(['example/stalled', 'example/stuck'])
  })
})

describe('repository node', () => {
  it('treats a missing default-branch commit as an empty repo signal', () => {
    const parsed = parseRepositoryNode({
      nameWithOwner: 'example/new',
      url: 'https://github.com/example/new',
      isEmpty: false,
      diskUsage: 0,
      pushedAt: null,
      createdAt: ago(3),
      defaultBranchRef: null,
      pullRequests: { totalCount: 0, nodes: [] }
    }, 'example/new')
    expect(parsed.hasDefaultBranchCommit).toBe(false)
    expect(parsed.createdAt).toBe(ago(3))
    expect(parsed.sizeKb).toBe(0)
    const fresh = classifyOverview([parsed], config(), NOW)[0]!
    expect(fresh.group).toBe('active')
    expect(kinds(fresh)).toEqual(['空仓'])
    expect(kinds(fresh)).not.toContain('停滞')
    const dormant = classifyOverview([{ ...parsed, createdAt: ago(400) }], config(), NOW)[0]!
    expect(dormant.group).toBe('stale')
    expect(countsAsAttention(dormant)).toBe(false)
    expect(visibleWarningChips(dormant).map(item => item.kind)).toEqual(['空仓'])
  })

  it('reads issue and pull comment times as activity, not only the commit', () => {
    const parsed = parseRepositoryNode({
      nameWithOwner: 'example/talking',
      url: 'https://github.com/example/talking',
      isEmpty: false,
      diskUsage: 12,
      pushedAt: ago(20),
      defaultBranchRef: { target: { oid: 'abc', committedDate: ago(20) } },
      pullRequests: { totalCount: 0, nodes: [] },
      issues: {
        nodes: [{
          createdAt: ago(40),
          updatedAt: ago(18),
          comments: { nodes: [{ createdAt: ago(4) }] }
        }]
      },
      recentPulls: {
        nodes: [{
          createdAt: ago(12),
          updatedAt: ago(9),
          comments: { nodes: [{ createdAt: ago(9) }] },
          reviews: { nodes: [{ submittedAt: ago(8) }] }
        }]
      }
    }, 'example/talking')
    expect(parsed.lastIssueActivityAt).toBe(ago(4))
    expect(readIssueActivity({
      issues: { nodes: [{ createdAt: ago(3), updatedAt: ago(3), comments: { nodes: [] } }] },
      recentPulls: { nodes: [] }
    })).toBe(ago(3))
    const row = classifyOverview([parsed], config({ staleDays: 7, staleRepoDays: 30 }), NOW)[0]!
    expect(kinds(row)).not.toContain('停滞')
    expect(row.group).toBe('active')
    expect(row.stallBasis).toMatchObject({ source: 'issue', at: ago(4) })
  })

  it('points a failing rollup at the Actions run, not a pull request number', () => {
    const parsed = parseRepositoryNode({
      nameWithOwner: 'example/demo',
      url: 'https://github.com/example/demo',
      isEmpty: false,
      diskUsage: 12,
      pushedAt: '2026-09-27T00:00:00.000Z',
      defaultBranchRef: {
        target: {
          oid: 'abc',
          committedDate: '2026-09-27T00:00:00.000Z',
          statusCheckRollup: {
            state: 'FAILURE',
            contexts: {
              nodes: [
                { conclusion: 'SUCCESS', detailsUrl: 'https://github.com/example/demo/actions/runs/1' },
                { conclusion: 'FAILURE', detailsUrl: 'https://github.com/example/demo/actions/runs/99' }
              ]
            }
          }
        }
      },
      pullRequests: { totalCount: 0, nodes: [] }
    }, 'example/demo')
    const row = classifyOverview([parsed], config(), NOW)[0]
    expect(row?.warnings[0]).toMatchObject({
      label: '卡住：CI 失败',
      days: null,
      targets: [{ url: 'https://github.com/example/demo/actions/runs/99' }]
    })
  })
})
