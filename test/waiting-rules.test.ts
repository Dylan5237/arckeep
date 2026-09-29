import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { userDataDir, waitingDismissalPath } from '../src/main/paths.js'
import { assembleWaiting } from '../src/shared/waiting/assemble.js'
import { classifyRecord } from '../src/shared/waiting/classify.js'
import { repoIsParked } from '../src/shared/waiting/text-scan.js'
import { effectiveHiddenRepos } from '../src/shared/waiting/snooze.js'
import { blankRecord, parseIssueTree } from '../src/shared/waiting/parse-github.js'
import { tasklistIssueRefs } from '../src/shared/waiting/sub-issues.js'
import { defaultWaitingConfig, parseWaitingConfig } from '../src/shared/waiting/rules.js'
import { evaluateSignals } from '../src/shared/waiting/signals.js'
import { ignoreDraft, partitionDismissals, readDismissalState, snoozeDraft, writeDismissalState } from '../src/shared/waiting/snooze.js'
import type { GithubRecord, WaitingConfig } from '../src/shared/waiting/types.js'
import { loadGithubRecords } from '../src/waiting/github-load.js'
import { runCli } from '../src/waiting/cli.js'

const NOW = new Date('2026-09-28T00:00:00.000Z')

function config(patch: Partial<WaitingConfig> = {}): WaitingConfig {
  return { ...defaultWaitingConfig(), ...patch, sources: { ...defaultWaitingConfig().sources, ...patch.sources } }
}

function record(patch: Partial<GithubRecord> & Pick<GithubRecord, 'kind' | 'number' | 'title'>): GithubRecord {
  return blankRecord({
    repo: 'example/demo',
    url: 'https://github.com/example/demo/issues/1',
    updatedAt: '2026-09-20T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    inScopeRepo: true,
    repoAccess: 'maintain',
    ...patch
  })
}

function patterns(list: readonly string[]): RegExp[] {
  return list.map(pattern => new RegExp(pattern, 'i'))
}

describe('mixed resolution and action signals', () => {
  const action = patterns(['USER_ACTION_REQUIRED', 'HUMAN_REQUIRED', 'needs-human', '需要你', '等你', '待验收', '请确认', '截图', 'accepted'])
  const resolved = patterns(['已验收', '已完成', '\\bPASS\\b', '通过', 'accepted'])

  const cases: { text: string, verdict: 'action' | 'resolved' | 'none' }[] = [
    { text: 'Functional Verification PASS, only Visual Acceptance remaining', verdict: 'none' },
    { text: 'USER_ACTION_REQUIRED (no Phase PASS)', verdict: 'action' },
    { text: 'no PASS', verdict: 'none' },
    { text: 'not accepted', verdict: 'none' },
    { text: '未通过', verdict: 'none' },
    { text: '不是已完成', verdict: 'none' },
    { text: '没有 PASS', verdict: 'none' },
    { text: '已验收', verdict: 'resolved' },
    { text: '已验收 PASS', verdict: 'resolved' },
    { text: '功能验证 PASS，视觉验收还等你', verdict: 'action' },
    { text: '请确认截图。已验收', verdict: 'resolved' },
    { text: '已验收，但还需要你看截图', verdict: 'action' },
    { text: 'PASS. 请确认截图', verdict: 'action' },
    { text: '这一步 PASS，下一步待验收', verdict: 'action' },
    { text: '整项已完成。', verdict: 'resolved' }
  ]

  it.each(cases)('$verdict for $text', ({ text, verdict }) => {
    expect(evaluateSignals(text, action, resolved)).toBe(verdict)
  })

  it('keeps an issue when a later step still waits, and drops a real closing comment', () => {
    const rules = config()
    const mixed = classifyRecord(record({
      kind: 'issue',
      number: 1,
      title: 'Mixed',
      body: 'USER_ACTION_REQUIRED (no Phase PASS)'
    }), rules, NOW)
    expect(mixed?.reasons).toEqual(['要人动手'])
    const step = classifyRecord(record({
      kind: 'issue',
      number: 2,
      title: 'Step passed',
      body: 'Functional Verification PASS, only Visual Acceptance remaining',
      labels: ['needs-human']
    }), rules, NOW)
    expect(step?.reasons).toEqual(['要人动手'])
    const closed = classifyRecord(record({
      kind: 'issue',
      number: 3,
      title: 'Closed',
      body: 'USER_ACTION_REQUIRED',
      comments: [{ body: '已验收', createdAt: '2026-09-20T00:00:00.000Z' }]
    }), rules, NOW)
    expect(closed).toBeNull()
  })
})

describe('watched repositories do not flood', () => {
  it('lists a blanket open pull only when the user can push, and not on a foreign fork', () => {
    const rules = config()
    const watched = classifyRecord(record({
      kind: 'pr',
      number: 4,
      title: 'Stranger pull',
      fromOpenPr: true,
      inScopeRepo: true,
      repoAccess: 'watch',
      isDraft: false
    }), rules, NOW)
    expect(watched).toBeNull()

    const optedIn = classifyRecord(record({
      kind: 'pr',
      number: 5,
      title: 'Watched on purpose',
      fromOpenPr: true,
      inScopeRepo: true,
      repoAccess: 'watch',
      isDraft: false
    }), config({ openPrScope: 'watching' }), NOW)
    expect(optedIn?.reasons).toEqual(['待你审/合'])

    const maintained = classifyRecord(record({
      kind: 'pr',
      number: 6,
      title: 'Mine',
      fromOpenPr: true,
      repoAccess: 'maintain',
      isDraft: false
    }), rules, NOW)
    expect(maintained?.reasons).toEqual(['待你审/合'])

    const foreignFork = classifyRecord(record({
      kind: 'pr',
      number: 7,
      title: 'Fork',
      fromOpenPr: true,
      repoAccess: 'maintain',
      isFork: true,
      viewerOwnsRepo: false,
      isDraft: false
    }), rules, NOW)
    expect(foreignFork).toBeNull()

    const ownFork = classifyRecord(record({
      kind: 'pr',
      number: 8,
      title: 'My fork',
      fromOpenPr: true,
      repoAccess: 'maintain',
      isFork: true,
      viewerOwnsRepo: true,
      isDraft: false
    }), rules, NOW)
    expect(ownFork?.reasons).toEqual(['待你审/合'])
  })

  it('keeps direct ties in a watched repo and an authored item that still needs action', () => {
    const rules = config()
    const assigned = classifyRecord(record({
      kind: 'issue',
      number: 9,
      title: 'Assigned there',
      repoAccess: 'watch',
      fromAssignee: true,
      assignedAt: '2026-09-20T00:00:00.000Z',
      inScopeRepo: true
    }), rules, NOW)
    expect(assigned?.reasons).toEqual(['指派'])
    expect(assigned?.action).toBe('要你动手')

    const review = classifyRecord(record({
      kind: 'pr',
      number: 10,
      title: 'Review there',
      repoAccess: 'watch',
      fromReview: true,
      reviewRequestedAt: '2026-09-21T00:00:00.000Z'
    }), rules, NOW)
    expect(review?.reasons).toEqual(['请求 review'])
    expect(review?.action).toBe('待你审合')

    const noise = classifyRecord(record({
      kind: 'issue',
      number: 11,
      title: 'Someone else',
      repoAccess: 'watch',
      inScopeRepo: true,
      body: '待验收'
    }), rules, NOW)
    expect(noise).toBeNull()

    const authored = classifyRecord(record({
      kind: 'pr',
      number: 12,
      title: 'I opened it',
      repoAccess: 'watch',
      fromAuthor: true,
      authorLogin: 'ada',
      body: '请确认'
    }), rules, NOW)
    expect(authored?.reasons).toEqual(['要人动手'])
    expect(authored?.action).toBe('要你动手')
  })

  it('does not query open pulls for a repo the user only watches', async () => {
    const bodies: string[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = String(init?.body ?? '')
      bodies.push(body)
      if (body.includes('viewer { login }')) {
        return new Response(JSON.stringify({ data: { viewer: { login: 'ada' } } }), { status: 200 })
      }
      if (body.includes('ownerAffiliations')) {
        return new Response(JSON.stringify({
          data: {
            viewer: {
              repositories: {
                pageInfo: { hasNextPage: false },
                nodes: [{
                  nameWithOwner: 'ada/notes',
                  isEmpty: false,
                  pushedAt: '2026-09-20T00:00:00.000Z',
                  isFork: false,
                  viewerPermission: 'ADMIN',
                  owner: { login: 'ada' }
                }]
              }
            }
          }
        }), { status: 200 })
      }
      if (body.includes('watching(')) {
        return new Response(JSON.stringify({
          data: {
            viewer: {
              watching: {
                pageInfo: { hasNextPage: false },
                nodes: [{
                  nameWithOwner: 'stranger/public',
                  isEmpty: false,
                  pushedAt: '2026-09-27T00:00:00.000Z',
                  isFork: false,
                  viewerPermission: 'READ',
                  owner: { login: 'stranger' }
                }]
              }
            }
          }
        }), { status: 200 })
      }
      if (body.includes('pullRequests')) {
        if (body.includes('stranger')) throw new Error('watched repo must not be in a pull request query')
        return new Response(JSON.stringify({
          data: {
            r0: {
              nameWithOwner: 'ada/notes',
              isEmpty: false,
              pushedAt: '2026-09-20T00:00:00.000Z',
              issues: { pageInfo: { hasNextPage: false }, nodes: [] },
              pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] }
            }
          }
        }), { status: 200 })
      }
      if (body.includes('author:@me')) {
        return new Response(JSON.stringify({
          data: { search: { pageInfo: { hasNextPage: false }, nodes: [] } }
        }), { status: 200 })
      }
      if (body.includes('is:issue is:open') || body.includes('assignee:@me') || body.includes('review-requested:') || body.includes('mentions:@me')) {
        return new Response(JSON.stringify({
          data: { search: { pageInfo: { hasNextPage: false }, nodes: [] } }
        }), { status: 200 })
      }
      return new Response(`unexpected ${body.slice(0, 240)}`, { status: 500 })
    }
    const loaded = await loadGithubRecords({
      token: 'test-token',
      config: config(),
      watchedRepos: [],
      fetchImpl
    })
    expect(loaded.errors).toEqual([])
    expect(bodies.some(body => body.includes('pullRequests') && body.includes('stranger'))).toBe(false)
    expect(bodies.some(body => body.includes('author:@me') && body.includes('stranger/public'))).toBe(true)
  })
})

describe('mention policy', () => {
  it('drops a bare old mention and keeps a recent comment, a nearby action, or an explicit opt-in', () => {
    const rules = config()
    const bare = classifyRecord(record({
      kind: 'issue',
      number: 30,
      title: 'Tracker',
      fromMention: true,
      viewerLogin: 'ada',
      mentionedAt: '2026-01-01T00:00:00.000Z',
      body: 'dashboard @ada',
      inScopeRepo: false,
      repoAccess: 'unknown'
    }), rules, NOW)
    expect(bare).toBeNull()

    const recent = classifyRecord(record({
      kind: 'issue',
      number: 31,
      title: 'Recent',
      fromMention: true,
      viewerLogin: 'ada',
      mentionedAt: '2026-09-20T00:00:00.000Z',
      body: 'dashboard @ada',
      comments: [{ body: '@ada', createdAt: '2026-09-20T00:00:00.000Z' }],
      inScopeRepo: false,
      repoAccess: 'unknown'
    }), rules, NOW)
    expect(recent?.reasons).toEqual(['提及'])

    const near = classifyRecord(record({
      kind: 'issue',
      number: 32,
      title: 'Near',
      fromMention: true,
      viewerLogin: 'ada',
      mentionedAt: '2026-01-01T00:00:00.000Z',
      body: '@ada 请确认',
      inScopeRepo: false,
      repoAccess: 'unknown'
    }), rules, NOW)
    expect(near?.reasons).toEqual(['提及'])

    const latest = classifyRecord(record({
      kind: 'issue',
      number: 33,
      title: 'Latest comment still asks',
      fromMention: true,
      viewerLogin: 'ada',
      mentionedAt: '2026-01-01T00:00:00.000Z',
      body: '@ada',
      comments: [{ body: '请确认', createdAt: '2026-06-01T00:00:00.000Z' }],
      inScopeRepo: false,
      repoAccess: 'unknown'
    }), rules, NOW)
    expect(latest?.reasons).toEqual(['提及'])

    const any = classifyRecord(record({
      kind: 'issue',
      number: 30,
      title: 'Tracker',
      fromMention: true,
      viewerLogin: 'ada',
      mentionedAt: '2026-01-01T00:00:00.000Z',
      body: 'dashboard @ada',
      inScopeRepo: false,
      repoAccess: 'unknown'
    }), config({ mentionPolicy: 'any' }), NOW)
    expect(any?.reasons).toEqual(['提及'])
  })
})

describe('quiet open pulls in writable repos', () => {
  const day = 86_400_000

  function pull(patch: Partial<GithubRecord> = {}): GithubRecord {
    return record({
      kind: 'pr',
      number: 40,
      title: 'Keep going',
      fromOpenPr: true,
      inScopeRepo: true,
      repoAccess: 'maintain',
      isDraft: false,
      createdAt: new Date(NOW.getTime() - 10 * day).toISOString(),
      updatedAt: new Date(NOW.getTime() - day).toISOString(),
      lastPushedAt: new Date(NOW.getTime() - 10 * day).toISOString(),
      ...patch
    })
  }

  it('counts a pull when the body or a comment asks for action, not the title alone', () => {
    const titled = classifyRecord(pull({
      title: '请确认导出列',
      lastPushedAt: new Date(NOW.getTime() - day).toISOString()
    }), config(), NOW)
    expect(titled).toBeNull()

    const body = classifyRecord(pull({
      body: '需要你看一下失败重试',
      lastPushedAt: new Date(NOW.getTime() - 2 * day).toISOString()
    }), config(), NOW)
    expect(body?.reasons).toEqual(['待你审/合'])
    expect(body?.signal.excerpt).toContain('需要你看一下失败重试')

    const commented = classifyRecord(pull({
      comments: [{ body: '等你验收截图', createdAt: new Date(NOW.getTime() - day).toISOString() }]
    }), config(), NOW)
    expect(commented?.reasons).toEqual(['待你审/合'])
    expect(commented?.signal.rule).toBe('明确请求')
    expect(commented?.signal.excerpt).toContain('等你验收截图')

    const negated = classifyRecord(pull({
      title: '不是请确认',
      body: '没有待验收',
      lastPushedAt: new Date(NOW.getTime() - 2 * day).toISOString()
    }), config(), NOW)
    expect(negated).toBeNull()
  })

  it('keeps a signal even after a new push, and ignores a resolved closing comment', () => {
    const stillAsking = classifyRecord(pull({
      body: '请确认',
      lastPushedAt: new Date(NOW.getTime() - day).toISOString()
    }), config(), NOW)
    expect(stillAsking?.signal.excerpt).toContain('请确认')

    const closed = classifyRecord(pull({
      body: '请确认',
      lastPushedAt: new Date(NOW.getTime() - 10 * day).toISOString(),
      comments: [{ body: '已验收', createdAt: new Date(NOW.getTime() - day).toISOString() }]
    }), config(), NOW)
    expect(closed).toBeNull()
  })

  it('uses the 2, 3, and 4 day edges for a pull with no signal', () => {
    const age = (days: number) => new Date(NOW.getTime() - days * day).toISOString()
    expect(classifyRecord(pull({ lastPushedAt: age(2), createdAt: age(2) }), config(), NOW)).toBeNull()
    const exact = classifyRecord(pull({ lastPushedAt: age(3), createdAt: age(3) }), config(), NOW)
    expect(exact?.reasons).toEqual(['待你审/合'])
    expect(exact?.signal.rule).toBe('3 天无动静')
    expect(exact?.signal.excerpt).toContain('2026-09-25')
    expect(exact?.signal.excerpt).not.toBe(exact?.signal.rule)
    expect(exact?.waitingDays).toBe(3)
    const older = classifyRecord(pull({ lastPushedAt: age(4), createdAt: age(4) }), config(), NOW)
    expect(older?.signal.rule).toBe('3 天无动静')
    expect(older?.waitingDays).toBe(4)
    const almost = classifyRecord(pull({
      lastPushedAt: new Date(NOW.getTime() - 3 * day + 1).toISOString(),
      createdAt: new Date(NOW.getTime() - 3 * day + 1).toISOString()
    }), config(), NOW)
    expect(almost).toBeNull()
  })

  it('restarts the quiet clock on a new comment or a new push', () => {
    const old = new Date(NOW.getTime() - 10 * day).toISOString()
    const fresh = new Date(NOW.getTime() - 2 * day).toISOString()
    const commentReset = classifyRecord(pull({
      lastPushedAt: old,
      createdAt: old,
      comments: [{ body: '还在改文案', createdAt: fresh }]
    }), config(), NOW)
    expect(commentReset).toBeNull()

    const pushReset = classifyRecord(pull({
      createdAt: old,
      lastPushedAt: fresh,
      comments: [{ body: '先这样', createdAt: old }]
    }), config(), NOW)
    expect(pushReset).toBeNull()

    const reviewReset = classifyRecord(pull({
      createdAt: old,
      lastPushedAt: old,
      lastReviewAt: fresh
    }), config(), NOW)
    expect(reviewReset).toBeNull()

    const staleReview = classifyRecord(pull({
      createdAt: old,
      lastPushedAt: old,
      lastReviewAt: new Date(NOW.getTime() - 4 * day).toISOString()
    }), config(), NOW)
    expect(staleReview?.signal.rule).toBe('3 天无动静')
  })

  it('still lists a review request or an assignment without waiting for the quiet period', () => {
    const fresh = new Date(NOW.getTime() - day).toISOString()
    const review = classifyRecord(pull({
      fromReview: true,
      reviewRequestedAt: fresh,
      lastPushedAt: fresh,
      createdAt: fresh,
      title: 'Please look'
    }), config(), NOW)
    expect(review?.reasons).toEqual(['请求 review'])
    expect(review?.signal.rule).toBe('请求 review')
    expect(review?.signal.excerpt).toContain('请求')
    expect(review?.signal.excerpt).toContain('2026-09-27')
    expect(review?.signal.excerpt).not.toBe('请求 review')

    const assigned = classifyRecord(pull({
      fromAssignee: true,
      assignedAt: fresh,
      lastPushedAt: fresh,
      createdAt: fresh
    }), config(), NOW)
    expect(assigned?.reasons).toEqual(['指派'])
    expect(assigned?.signal.rule).toBe('指派')
    expect(assigned?.signal.excerpt).toContain('指派')
    expect(assigned?.signal.excerpt).toContain('2026-09-27')
    expect(assigned?.tier).toBe('weak')
  })

  it('honors a different quiet window', () => {
    const age = (days: number) => new Date(NOW.getTime() - days * day).toISOString()
    const rules = config({ openPrQuietDays: 5 })
    expect(classifyRecord(pull({ lastPushedAt: age(4), createdAt: age(4) }), rules, NOW)).toBeNull()
    const hit = classifyRecord(pull({ lastPushedAt: age(5), createdAt: age(5) }), rules, NOW)
    expect(hit?.reasons).toEqual(['待你审/合'])
    expect(hit?.signal.rule).toBe('5 天无动静')
    expect(hit?.signal.excerpt).toContain('5 天')
    expect(hit?.signal.excerpt).not.toBe('5 天无动静')
    expect(parseWaitingConfig({}).openPrQuietDays).toBe(3)
    expect(parseWaitingConfig({ openPrQuietDays: 5 }).openPrQuietDays).toBe(5)
    expect(() => parseWaitingConfig({ openPrQuietDays: 0 })).toThrow('待你审/合的无动静天数')
  })
})

describe('role names, status headers, specs, and step owners', () => {
  const rules = config()

  it('counts a role plus an explicit ask, and ignores a role with no ask', () => {
    const asked = classifyRecord(record({
      kind: 'issue',
      number: 90,
      title: 'Ship',
      body: '先记在这里',
      comments: [{ body: '请负责人确认能否合入', createdAt: '2026-09-21T00:00:00.000Z' }]
    }), rules, NOW)
    expect(asked?.reasons).toEqual(['要人动手'])
    expect(asked?.signal.rule).toBe('明确请求')
    expect(asked?.signal.excerpt).toContain('请负责人确认')

    const named = classifyRecord(record({
      kind: 'issue',
      number: 91,
      title: 'Decide',
      comments: [{ body: '主人，请明示接受或拒收这一版', createdAt: '2026-09-21T00:00:00.000Z' }]
    }), rules, NOW)
    expect(named?.reasons).toEqual(['要人动手'])
    expect(named?.signal.excerpt).toContain('明示接受或拒收')

    const chatter = classifyRecord(record({
      kind: 'issue',
      number: 92,
      title: 'Note',
      comments: [{ body: '主人今天看了风景', createdAt: '2026-09-21T00:00:00.000Z' }]
    }), rules, NOW)
    expect(chatter).toBeNull()

    const renamed = classifyRecord(record({
      kind: 'issue',
      number: 93,
      title: 'Other name',
      comments: [{ body: '请负责人看一下进度', createdAt: '2026-09-21T00:00:00.000Z' }]
    }), config({ roleNames: ['值班人'] }), NOW)
    expect(renamed).toBeNull()
  })

  it('does not let an inequality clarification cancel an explicit request', () => {
    const clarified = classifyRecord(record({
      kind: 'issue',
      number: 94,
      title: 'Not the same',
      comments: [{
        body: '合入 ≠ 接受，请主人明示接受或拒收',
        createdAt: '2026-09-21T00:00:00.000Z'
      }]
    }), rules, NOW)
    expect(clarified?.reasons).toEqual(['要人动手'])
    expect(clarified?.signal.excerpt).toContain('明示接受或拒收')

    const notPass = classifyRecord(record({
      kind: 'issue',
      number: 95,
      title: 'Still open',
      comments: [{ body: '不等于通过，请确认', createdAt: '2026-09-21T00:00:00.000Z' }]
    }), rules, NOW)
    expect(notPass?.reasons).toEqual(['要人动手'])
    expect(notPass?.signal.excerpt).toContain('请确认')

    const dismissed = classifyRecord(record({
      kind: 'issue',
      number: 96,
      title: 'Done enough',
      comments: [{ body: '请确认，无需操作', createdAt: '2026-09-21T00:00:00.000Z' }]
    }), rules, NOW)
    expect(dismissed).toBeNull()

    const notNeeded = classifyRecord(record({
      kind: 'issue',
      number: 97,
      title: 'Skip',
      body: '不需要用户再看'
    }), rules, NOW)
    expect(notNeeded).toBeNull()
  })

  it('reads configured status headers, and only some BLOCKED or WAITING ON lines', () => {
    const needs = classifyRecord(record({
      kind: 'issue',
      number: 98,
      title: 'Header',
      comments: [{ body: '**NEEDS USER ACTION**', createdAt: '2026-09-22T00:00:00.000Z' }]
    }), rules, NOW)
    expect(needs?.signal.rule).toBe('状态头')
    expect(needs?.signal.excerpt.toUpperCase()).toContain('NEEDS USER ACTION')

    const blocked = classifyRecord(record({
      kind: 'issue',
      number: 99,
      title: 'Blocked',
      body: 'BLOCKED'
    }), rules, NOW)
    expect(blocked?.signal.rule).toBe('状态头')

    const blockedOnOwner = classifyRecord(record({
      kind: 'issue',
      number: 100,
      title: 'Blocked on you',
      comments: [{ body: 'BLOCKED on owner', createdAt: '2026-09-22T00:00:00.000Z' }]
    }), rules, NOW)
    expect(blockedOnOwner?.reasons).toEqual(['要人动手'])

    const blockedOnCi = classifyRecord(record({
      kind: 'issue',
      number: 101,
      title: 'Blocked on CI',
      comments: [{ body: 'BLOCKED: CI', createdAt: '2026-09-22T00:00:00.000Z' }]
    }), rules, NOW)
    expect(blockedOnCi).toBeNull()

    const waitingOwner = classifyRecord(record({
      kind: 'issue',
      number: 102,
      title: 'Wait',
      body: 'WAITING ON 维护者'
    }), rules, NOW)
    expect(waitingOwner?.signal.excerpt.toUpperCase()).toContain('WAITING ON')

    const waitingAgent = classifyRecord(record({
      kind: 'issue',
      number: 103,
      title: 'Wait agent',
      body: '状态：WAITING ON agent'
    }), rules, NOW)
    expect(waitingAgent).toBeNull()

    const custom = classifyRecord(record({
      kind: 'issue',
      number: 104,
      title: 'Custom header',
      comments: [{ body: 'NEEDS USER ACTION', createdAt: '2026-09-22T00:00:00.000Z' }]
    }), config({ statusHeaders: ['ACTION REQUIRED'] }), NOW)
    expect(custom).toBeNull()
  })

  it('ignores feature behavior in a spec issue unless a comment or status line asks', () => {
    const described = classifyRecord(record({
      kind: 'issue',
      number: 105,
      title: '功能：导出',
      body: '导出流程会等待用户完成选择后再继续。'
    }), rules, NOW)
    expect(described).toBeNull()

    const labeled = classifyRecord(record({
      kind: 'issue',
      number: 106,
      title: '夜间模式',
      labels: ['spec'],
      body: '当开关打开后，等待用户完成授权。'
    }), rules, NOW)
    expect(labeled).toBeNull()

    const commented = classifyRecord(record({
      kind: 'issue',
      number: 107,
      title: '功能：导出',
      body: '导出流程会等待用户完成选择后再继续。',
      comments: [{ body: '请确认是否按这个做', createdAt: '2026-09-22T00:00:00.000Z' }]
    }), rules, NOW)
    expect(commented?.reasons).toEqual(['要人动手'])
    expect(commented?.signal.excerpt).toContain('请确认是否按这个做')

    const status = classifyRecord(record({
      kind: 'issue',
      number: 108,
      title: 'PRD：搜索',
      body: '搜索会等待用户完成输入。\n\n状态：请负责人确认范围'
    }), rules, NOW)
    expect(status?.reasons).toEqual(['要人动手'])
    expect(status?.signal.excerpt).toContain('确认')
  })

  it('counts an unfinished step only when it is the user\'s or it asks the user', () => {
    const mine = classifyRecord(record({
      kind: 'issue',
      number: 109,
      title: 'Steps',
      body: [
        '| 步骤 | 负责人 | 状态 |',
        '| --- | --- | --- |',
        '| 验收 | 主人 | 未完成 |',
        '| 补测试 | agent | 未完成 |'
      ].join('\n')
    }), rules, NOW)
    expect(mine).toBeNull()

    const asked = classifyRecord(record({
      kind: 'issue',
      number: 110,
      title: 'Checklist',
      body: '- [ ] 请用户确认文案\n- [ ] agent：补测试\n- [ ] 我还没写完文档'
    }), rules, NOW)
    expect(asked?.signal.excerpt).toContain('请用户确认文案')
    expect(asked?.signal.excerpt).not.toContain('补测试')
    expect(asked?.signal.excerpt).not.toContain('我还没写完')

    const theirs = classifyRecord(record({
      kind: 'issue',
      number: 111,
      title: 'Someone else',
      body: [
        '| 步骤 | 负责人 | 状态 |',
        '| --- | --- | --- |',
        '| 写文档 | 张三 | 未完成 |'
      ].join('\n')
    }), rules, NOW)
    expect(theirs).toBeNull()
  })

  it('puts the matched text on review, assignment, and quiet rows', () => {
    const ack = classifyRecord(record({
      kind: 'pr',
      number: 112,
      title: 'Merge',
      fromOpenPr: true,
      isDraft: false,
      body: '需 @ada ACK 后合入',
      viewerLogin: 'ada',
      lastPushedAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
      createdAt: new Date(NOW.getTime() - 86_400_000).toISOString()
    }), rules, NOW)
    expect(ack?.reasons).toEqual(['待你审/合'])
    expect(ack?.signal.excerpt).toContain('ACK')
    expect(ack?.signal.excerpt).toContain('合入')

    const review = classifyRecord(record({
      kind: 'pr',
      number: 113,
      title: 'Review',
      fromReview: true,
      fromOpenPr: true,
      isDraft: false,
      reviewRequestedAt: '2026-09-27T00:00:00.000Z',
      body: '需 @ada ACK 后合入',
      viewerLogin: 'ada',
      lastPushedAt: '2026-09-27T00:00:00.000Z',
      createdAt: '2026-09-27T00:00:00.000Z'
    }), rules, NOW)
    expect(review?.reasons).toContain('请求 review')
    expect(review?.signal.excerpt.startsWith('有人 在 2026-09-27 请求')).toBe(true)
    expect(review?.signal.excerpt).toContain('ACK')

    const assigned = classifyRecord(record({
      kind: 'issue',
      number: 114,
      title: 'Assigned quietly',
      fromAssignee: true,
      assignedAt: '2026-09-20T00:00:00.000Z'
    }), rules, NOW)
    expect(assigned?.signal.excerpt).toContain('2026-09-20')
    expect(assigned?.signal.excerpt).not.toBe('指派')
    expect(assigned?.tier).toBe('weak')
  })
})

describe('hidden repositories', () => {
  it('reads an old flat dismissal file and hides a whole repo until include-hidden', async () => {
    const draft = classifyRecord(record({
      kind: 'issue',
      number: 1,
      title: 'Keep',
      fromAssignee: true,
      assignedAt: '2026-09-20T00:00:00.000Z'
    }), config(), NOW)
    const other = classifyRecord(record({
      kind: 'issue',
      number: 2,
      title: 'Other',
      repo: 'other/repo',
      fromAssignee: true,
      assignedAt: '2026-09-20T00:00:00.000Z'
    }), config(), NOW)
    if (!draft || !other) throw new Error('missing draft')
    expect(readDismissalState({ [draft.id]: { snoozeUntil: null, ignored: true, ignoredUpdatedAt: draft.updatedAt } }).hiddenRepos).toEqual([])
    const hidden = writeDismissalState({ items: {}, hiddenRepos: ['example/demo'] })
    const parted = partitionDismissals([draft, other], hidden.items, NOW, false, hidden.hiddenRepos)
    expect(parted.rows.map(row => row.repo)).toEqual(['other/repo'])
    expect(parted.hiddenCount).toBe(1)
    expect(parseWaitingConfig({}).openPrScope).toBe('maintain')
    expect(parseWaitingConfig({}).mentionPolicy).toBe('action-or-recent')

    const dir = mkdtempSync(path.join(tmpdir(), 'arckeep-hidden-'))
    const configHome = path.join(dir, 'config')
    mkdirSync(userDataDir(configHome), { recursive: true })
    writeFileSync(waitingDismissalPath(userDataDir(configHome)), JSON.stringify(hidden))
    const fixture = path.join(dir, 'fixture.json')
    writeFileSync(fixture, JSON.stringify({
      now: NOW.toISOString(),
      records: [draft && {
        ...record({
          kind: 'issue',
          number: 12,
          title: 'Hidden issue',
          body: 'USER_ACTION_REQUIRED',
          inScopeRepo: true,
          repoAccess: 'maintain'
        })
      }]
    }))
    const env = process.platform === 'win32'
      ? { APPDATA: configHome }
      : { XDG_CONFIG_HOME: configHome }
    let hiddenOut = ''
    await runCli(['--json', '--fixture', fixture], {
      stdout: text => { hiddenOut += text },
      stderr: () => {},
      env
    })
    expect(JSON.parse(hiddenOut)).toEqual([])
    let shown = ''
    await runCli(['--json', '--fixture', fixture, '--include-hidden'], {
      stdout: text => { shown += text },
      stderr: () => {},
      env
    })
    const rows = JSON.parse(shown) as { repo: string, action: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.repo).toBe('example/demo')
    expect(rows[0]?.action).toBe('要你动手')
  })
})

describe('sub-issues stay on their own rows', () => {
  const repo = 'owner/repo'
  const issueUrl = (number: number) => `https://github.com/owner/repo/issues/${number}`

  function issue(number: number, body: string, patch: Partial<GithubRecord> = {}): GithubRecord {
    return blankRecord({
      kind: 'issue',
      repo,
      number,
      title: `item ${number}`,
      url: issueUrl(number),
      body,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
      inScopeRepo: true,
      repoAccess: 'maintain',
      ...patch
    })
  }

  function rowsOf(records: GithubRecord[]) {
    return assembleWaiting({
      records,
      statusDocs: [],
      branches: [],
      todos: [],
      config: config(),
      now: NOW
    })
  }

  it('emits one row for a qualifying parent and each qualifying child', () => {
    const rows = rowsOf([
      issue(1, '请确认\n- [ ] #2\n- [ ] #3'),
      issue(2, '待验收', { parentNumber: 1 }),
      issue(3, '需要你', { parentNumber: 1 })
    ])
    expect(rows).toHaveLength(3)
    expect(rows.map(row => row.url).sort()).toEqual([issueUrl(1), issueUrl(2), issueUrl(3)].sort())
    expect(rows.find(row => row.number === 1)?.childCount).toBe(2)
    expect(rows.find(row => row.number === 1)?.parent).toBeNull()
    expect(rows.find(row => row.number === 2)?.parent).toBe(issueUrl(1))
    expect(rows.find(row => row.number === 2)?.childCount).toBe(0)
    expect(rows.find(row => row.number === 3)?.parent).toBe(issueUrl(1))
  })

  it('dedupes a child found from a sub-issue link and from search by url', () => {
    const rows = rowsOf([
      issue(2, '请确认', { parentNumber: 1, url: 'https://github.com/Owner/Repo/issues/2' }),
      issue(2, '请确认', {
        fromAssignee: true,
        assignedAt: '2026-09-12T00:00:00.000Z',
        url: 'https://github.com/owner/repo/issues/2/'
      })
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.url.toLowerCase().replace(/\/$/, '')).toBe(issueUrl(2))
    expect(rows[0]?.reasons).toEqual(expect.arrayContaining(['要人动手', '指派']))
  })

  it('emits no row for a linked child that does not qualify', () => {
    const rows = rowsOf([
      issue(1, '请确认\n- [ ] #2'),
      issue(2, '进度记录', { parentNumber: 1 })
    ])
    expect(rows.map(row => row.url)).toEqual([issueUrl(1)])
  })

  it('parses sub-issues as separate records and ignores a closed child', () => {
    const records = parseIssueTree({
      __typename: 'Issue',
      number: 1,
      title: 'item 1',
      url: issueUrl(1),
      body: '请确认',
      repository: { nameWithOwner: repo },
      subIssues: {
        nodes: [
          { number: 2, title: 'item 2', url: issueUrl(2), body: '待验收', state: 'OPEN' },
          { number: 3, title: 'item 3', url: issueUrl(3), body: '待验收', state: 'CLOSED' }
        ]
      }
    }, { login: 'me', inScopeRepo: true })
    expect(records.map(record => record.number).sort()).toEqual([1, 2])
    expect(records.find(record => record.number === 2)?.parentNumber).toBe(1)
    expect(records.find(record => record.number === 2)?.url).toBe(issueUrl(2))
    expect(tasklistIssueRefs('see #4\n- [ ] #4\n- [x] https://github.com/owner/repo/issues/5', repo).map(ref => ref.number)).toEqual([4, 5])
  })
})

describe('recall of requests that are still open', () => {
  const rules = config()

  it('keeps a request in the same paragraph as a negated PASS', () => {
    const cases = [
      '请主人确认或拒收，这一版不 PASS',
      '还需要用户动手。未 PASS',
      '请确认这一步\nno Phase 2 PASS',
      '请确认，no one has written PASS yet'
    ]
    for (const body of cases) {
      const row = classifyRecord(record({ kind: 'issue', number: 70, title: 'Still open', body }), rules, NOW)
      expect(row?.reasons, body).toEqual(['要人动手'])
      expect(row?.signal.rule, body).toBe('明确请求')
      expect(row?.signal.excerpt.length).toBeGreaterThan(0)
    }
  })

  it('treats an explicit ask to confirm or reject as an action by itself', () => {
    const row = classifyRecord(record({
      kind: 'issue',
      number: 71,
      title: 'Owner',
      body: '请主人确认或拒收这一版。'
    }), rules, NOW)
    expect(row?.reasons).toEqual(['要人动手'])
    expect(row?.signal.rule).toBe('明确请求')
    expect(row?.signal.excerpt).toContain('请主人确认或拒收')
  })

  it('reads an unfinished status table, checklist, and status line from the issue body', () => {
    const table = classifyRecord(record({
      kind: 'issue',
      number: 72,
      title: 'Table',
      body: '| 项 | 状态 |\n| --- | --- |\n| 发布 | 待用户确认后 push |\n| 文档 | 已完成 |',
      comments: [{ body: '我先记下进度', createdAt: '2026-09-21T00:00:00.000Z' }]
    }), rules, NOW)
    expect(table?.reasons).toEqual(['要人动手'])
    expect(table?.tier).toBe('weak')
    expect(table?.signal.rule).toBe('动作关键词')
    expect(table?.signal.excerpt).toContain('待用户确认后 push')

    const checked = classifyRecord(record({
      kind: 'issue',
      number: 73,
      title: 'Checked',
      body: '- [x] 待用户确认后 push\n- [ ] 等用户看完再合并'
    }), rules, NOW)
    expect(checked?.signal.excerpt).toContain('等用户看完再合并')
    expect(checked?.signal.excerpt).not.toContain('待用户确认后 push')

    const line = classifyRecord(record({
      kind: 'issue',
      number: 74,
      title: 'Line',
      body: '状态：等用户确认截图'
    }), rules, NOW)
    expect(line?.reasons).toEqual(['要人动手'])
    expect(line?.signal.rule).toBe('明确请求')
    expect(line?.tier).toBe('strong')
  })

  it('does not drop a stale mention when the body still asks for a person', () => {
    const row = classifyRecord(record({
      kind: 'issue',
      number: 75,
      title: 'Old mention',
      fromMention: true,
      viewerLogin: 'ada',
      mentionedAt: '2026-01-01T00:00:00.000Z',
      body: '抄送 @ada\n\n| 项 | 状态 |\n| --- | --- |\n| 上线 | 待用户确认后 push |',
      inScopeRepo: false,
      repoAccess: 'unknown'
    }), rules, NOW)
    expect(row?.reasons).toEqual(['提及'])
    expect(row?.tier).toBe('weak')
    expect(row?.signal.rule).toBe('只是提及')
    expect(row?.signal.excerpt).toBe('抄送 @ada')
    expect(row?.signal.excerpt.includes('没有明确请求')).toBe(false)
  })
})

describe('keywords that only describe the product are not waiting', () => {
  const rules = config()

  it('ignores code, quotes, spec sections, and a report that never asks the user', () => {
    const spec = classifyRecord(record({
      kind: 'issue',
      number: 80,
      title: 'Spec',
      body: [
        '## 需求',
        '用户可以点请确认。',
        '## 验收标准',
        '- [ ] 待用户确认后 push',
        '## 背景',
        '需要你在设计里写待验收。',
        '## 设计',
        '按钮文案是请拒收。',
        '## 规格',
        'USER_ACTION_REQUIRED'
      ].join('\n')
    }), rules, NOW)
    expect(spec).toBeNull()

    const code = classifyRecord(record({
      kind: 'issue',
      number: 81,
      title: 'Code',
      body: '实现见下。\n\n```\nUSER_ACTION_REQUIRED\n请确认\n```\n\n调用 `请确认` 即可。\n\n> 请确认截图'
    }), rules, NOW)
    expect(code).toBeNull()

    const report = classifyRecord(record({
      kind: 'issue',
      number: 82,
      title: 'Report',
      body: [
        '# 分析报告',
        '这篇只复盘规则，没有要谁动手。',
        '关键词「请确认」「待验收」「USER_ACTION_REQUIRED」出现在描述里。',
        '功能会显示待验收，并不代表当前在等用户。'
      ].join('\n')
    }), rules, NOW)
    expect(report).toBeNull()
  })

  it('still keeps a current-status sentence that asks the user to act', () => {
    const row = classifyRecord(record({
      kind: 'issue',
      number: 83,
      title: 'Now',
      body: '## 需求\n按钮写请确认。\n\n## 现状\n请确认是否拒收这一版。'
    }), rules, NOW)
    expect(row?.reasons).toEqual(['要人动手'])
    expect(row?.signal.excerpt).toContain('请确认是否拒收')
  })
})

describe('show ignored rows', () => {
  it('lists snoozed and ignored rows when asked, and the count matches those rows', () => {
    const make = (number: number, title: string) => classifyRecord(record({
      kind: 'issue',
      number,
      title,
      fromAssignee: true,
      assignedAt: '2026-09-01T00:00:00.000Z'
    }), config(), NOW)
    const first = make(1, 'One')
    const second = make(2, 'Two')
    const third = make(3, 'Three')
    if (!first || !second || !third) throw new Error('missing draft')
    const map = ignoreDraft(snoozeDraft({}, first.id, 7, NOW), second)
    const hidden = partitionDismissals([first, second, third], map, NOW, false)
    expect(hidden.rows.map(row => row.title)).toEqual(['Three'])
    expect(hidden.hiddenCount).toBe(2)
    const shown = partitionDismissals([first, second, third], map, NOW, true)
    const faded = shown.rows.filter(row => row.ignored)
    expect(faded).toHaveLength(shown.hiddenCount)
    expect(faded.map(row => row.title).sort()).toEqual(['One', 'Two'])
    expect(shown.rows).toHaveLength(3)
  })
})

describe('synthetic fixtures for each waiting rule', () => {
  const rules = config()
  const main = (patch: Partial<GithubRecord> & Pick<GithubRecord, 'kind' | 'number' | 'title'>) => {
    const row = classifyRecord(record(patch), rules, NOW)
    expect(row?.tier).toBe('strong')
    return row
  }

  it('keeps a review request and ignores a pull nobody asked to review', () => {
    const kept = main({
      kind: 'pr',
      number: 1,
      title: 'Review',
      fromReview: true,
      reviewRequestedAt: '2026-09-20T00:00:00.000Z',
      reviewRequestedBy: 'mina',
      viewerLogin: 'ada'
    })
    expect(kept?.signal.excerpt).toContain('mina')
    expect(kept?.signal.excerpt).toContain('2026-09-20')
    expect(kept?.signal.excerpt).not.toBe('请求 review')
    const quiet = classifyRecord(record({
      kind: 'pr',
      number: 2,
      title: 'Fresh',
      fromOpenPr: true,
      isDraft: false,
      repoAccess: 'maintain',
      createdAt: '2026-09-27T00:00:00.000Z',
      lastPushedAt: '2026-09-27T00:00:00.000Z'
    }), rules, NOW)
    expect(quiet).toBeNull()
  })

  it('requires an explicit request before an assignment joins the main list', () => {
    const kept = main({
      kind: 'issue',
      number: 3,
      title: 'Assigned',
      fromAssignee: true,
      assignedAt: '2026-09-18T00:00:00.000Z',
      assignedBy: 'mina',
      comments: [{ body: '请确认能否合入', authorLogin: 'mina', createdAt: '2026-09-21T00:00:00.000Z' }]
    })
    expect(kept?.reasons).toContain('指派')
    expect(kept?.signal.excerpt).toContain('请确认')
    const bare = classifyRecord(record({
      kind: 'issue',
      number: 4,
      title: 'Only assigned',
      fromAssignee: true,
      assignedAt: '2026-09-18T00:00:00.000Z',
      assignedBy: 'mina'
    }), rules, NOW)
    expect(bare?.tier).toBe('weak')
    expect(bare?.signal.excerpt).toContain('mina')
    expect(bare?.signal.excerpt).not.toBe('指派')
  })

  it('reads an explicit request or a status header from the latest comment by someone else', () => {
    const request = main({
      kind: 'issue',
      number: 5,
      title: 'Ask',
      viewerLogin: 'ada',
      comments: [
        { body: '请确认', authorLogin: 'ada', createdAt: '2026-09-22T00:00:00.000Z' },
        { body: 'please review the diff', authorLogin: 'mina', createdAt: '2026-09-21T00:00:00.000Z' }
      ]
    })
    expect(request?.signal.excerpt).toContain('please review')
    const header = main({
      kind: 'issue',
      number: 6,
      title: 'Header',
      comments: [{ body: 'NEEDS USER ACTION\nPASS: not claimed', authorLogin: 'mina', createdAt: '2026-09-22T00:00:00.000Z' }]
    })
    expect(header?.signal.excerpt).toContain('NEEDS USER ACTION')
    const negated = classifyRecord(record({
      kind: 'issue',
      number: 7,
      title: 'Negated header',
      comments: [{ body: 'NEEDS USER ACTION: not needed', authorLogin: 'mina', createdAt: '2026-09-22T00:00:00.000Z' }]
    }), rules, NOW)
    expect(negated).toBeNull()
    const lower = classifyRecord(record({
      kind: 'issue',
      number: 8,
      title: 'Lower',
      comments: [{ body: 'the build remains blocked.', authorLogin: 'mina', createdAt: '2026-09-22T00:00:00.000Z' }]
    }), rules, NOW)
    expect(lower).toBeNull()
    const other = classifyRecord(record({
      kind: 'issue',
      number: 9,
      title: 'Someone else',
      viewerLogin: 'ada',
      comments: [{ body: '请 @bob 确认', authorLogin: 'mina', createdAt: '2026-09-22T00:00:00.000Z' }]
    }), rules, NOW)
    expect(other).toBeNull()
  })

  it('counts ACK only with a request verb and the user in the same sentence', () => {
    const kept = main({
      kind: 'issue',
      number: 10,
      title: 'Ack',
      viewerLogin: 'ada',
      comments: [{ body: '需 @ada ACK 后再合', authorLogin: 'mina', createdAt: '2026-09-22T00:00:00.000Z' }]
    })
    expect(kept?.signal.rule).toBe('需 ACK')
    expect(kept?.signal.excerpt).toContain('ACK')
    const alone = classifyRecord(record({
      kind: 'issue',
      number: 11,
      title: 'Bare ack',
      viewerLogin: 'ada',
      comments: [{ body: 'ACK', authorLogin: 'mina', createdAt: '2026-09-22T00:00:00.000Z' }]
    }), rules, NOW)
    expect(alone).toBeNull()
    const unnamed = classifyRecord(record({
      kind: 'issue',
      number: 12,
      title: 'Please ack',
      viewerLogin: 'ada',
      comments: [{ body: '请 ACK', authorLogin: 'mina', createdAt: '2026-09-22T00:00:00.000Z' }]
    }), rules, NOW)
    expect(unnamed).toBeNull()
  })

  it('reads inline code in a comment and ignores a fenced block', () => {
    const inline = main({
      kind: 'issue',
      number: 13,
      title: 'Inline',
      comments: [{ body: '看一下 `请确认` 这一处', authorLogin: 'mina', createdAt: '2026-09-22T00:00:00.000Z' }]
    })
    expect(inline?.signal.excerpt).toContain('请确认')
    const fenced = classifyRecord(record({
      kind: 'issue',
      number: 14,
      title: 'Fence',
      comments: [{ body: '```\n请确认\n```', authorLogin: 'mina', createdAt: '2026-09-22T00:00:00.000Z' }]
    }), rules, NOW)
    expect(fenced).toBeNull()
  })

  it('lists a matching label without a comment and ignores an unrelated label', () => {
    const kept = main({
      kind: 'issue',
      number: 15,
      title: 'Labeled',
      labels: ['needs-review'],
      labelEvents: [{ name: 'needs-review', at: '2026-09-11T00:00:00.000Z' }]
    })
    expect(kept?.signal.excerpt).toContain('needs-review')
    expect(kept?.signal.excerpt).toContain('2026-09-11')
    const missed = classifyRecord(record({
      kind: 'issue',
      number: 16,
      title: 'Other label',
      labels: ['bug']
    }), rules, NOW)
    expect(missed).toBeNull()
  })

  it('hides a parked repository the same way as an ignored repository', () => {
    expect(repoIsParked('temporarily parked', [], ['parked', '搁置'])).toBe(true)
    expect(repoIsParked('active toolkit', ['搁置'], ['parked', '搁置'])).toBe(true)
    expect(repoIsParked('unparked notes', ['active'], ['parked', '搁置'])).toBe(false)
    const row = classifyRecord(record({
      kind: 'issue',
      number: 17,
      title: 'Parked ask',
      body: '请确认',
      repoDescription: '这个仓库已搁置'
    }), rules, NOW)
    expect(row?.tier).toBe('strong')
    expect(row?.parked).toBe(true)
    const hidden = effectiveHiddenRepos([], ['example/demo'], [])
    const parted = partitionDismissals([row].filter((item): item is NonNullable<typeof row> => item !== null), {}, NOW, false, hidden)
    expect(parted.rows).toEqual([])
    const revealed = effectiveHiddenRepos([], ['example/demo'], ['example/demo'])
    const shown = partitionDismissals([row].filter((item): item is NonNullable<typeof row> => item !== null), {}, NOW, false, revealed)
    expect(shown.rows).toHaveLength(1)
  })

  it('drops a closed sub-issue and keeps an open one', () => {
    const records = parseIssueTree({
      __typename: 'Issue',
      number: 18,
      title: 'Parent',
      url: 'https://github.com/example/demo/issues/18',
      body: '请确认',
      state: 'OPEN',
      repository: { nameWithOwner: 'example/demo' },
      subIssues: {
        nodes: [
          { number: 19, title: 'Open child', url: 'https://github.com/example/demo/issues/19', body: '请确认', state: 'OPEN' },
          { number: 20, title: 'Closed child', url: 'https://github.com/example/demo/issues/20', body: '请确认', state: 'CLOSED' }
        ]
      }
    }, { login: 'ada', inScopeRepo: true })
    expect(records.map(item => item.number).sort()).toEqual([18, 19])
  })
})
