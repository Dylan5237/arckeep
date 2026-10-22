import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { userDataDir, waitingDismissalPath } from '../src/main/paths.js'
import { assembleWaiting } from '../src/shared/waiting/assemble.js'
import { ownRequestLabel } from '../src/renderer/waiting-page.js'
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
      title: 'Diff there',
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
              login: 'ada',
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
              },
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

  it('counts a pull when the title, body, or a comment asks for action', () => {
    const titled = classifyRecord(pull({
      title: '请确认导出列',
      lastPushedAt: new Date(NOW.getTime() - day).toISOString()
    }), config(), NOW)
    expect(titled?.tier).toBe('strong')
    expect(titled?.signal.rule).toBe('明确请求')
    expect(titled?.signal.excerpt).toBe('请确认导出列')

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

    const plain = classifyRecord(pull({
      title: '导出列',
      body: '没有待验收',
      lastPushedAt: new Date(NOW.getTime() - 2 * day).toISOString()
    }), config(), NOW)
    expect(plain).toBeNull()
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
      title: 'Look here'
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
    expect(assigned?.tier).toBe('strong')
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
      title: 'Diff',
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
    expect(assigned?.tier).toBe('strong')
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
      issue(2, '请确认', { parentNumber: 1 }),
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
    expect(table?.tier).toBe('strong')
    expect(table?.signal.rule).toBe('明确请求')
    expect(table?.signal.excerpt).toContain('待用户确认后 push')

    const checked = classifyRecord(record({
      kind: 'issue',
      number: 73,
      title: 'Checked',
      body: '- [x] 待用户确认后 push\n- [ ] 等用户看完再合并'
    }), rules, NOW)
    expect(checked?.tier).toBe('strong')
    expect(checked?.signal.rule).toBe('明确请求')
    expect(checked?.signal.excerpt).toContain('等用户看完再合并')
    expect(checked?.signal.excerpt.includes('待用户确认后 push')).toBe(false)

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
      title: 'Diff',
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

  it('puts an open assignment on the main list without a separate request', () => {
    const kept = main({
      kind: 'issue',
      number: 3,
      title: 'Assigned',
      fromAssignee: true,
      assignedAt: '2026-09-18T00:00:00.000Z',
      assignedBy: 'mina',
      body: '## 状态\n进行中'
    })
    expect(kept?.reasons).toEqual(['指派'])
    expect(kept?.signal.rule).toBe('指派')
    expect(kept?.signal.excerpt).toContain('mina')
    expect(kept?.signal.excerpt).toContain('2026-09-18')
    const finished = classifyRecord(record({
      kind: 'issue',
      number: 4,
      title: 'Assigned and done',
      fromAssignee: true,
      assignedAt: '2026-09-18T00:00:00.000Z',
      assignedBy: 'mina',
      body: '## 状态\n已完成'
    }), rules, NOW)
    expect(finished).toBeNull()
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
      title: 'Ack note',
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

  it('reads a status subsection anywhere in the body, not only the opening', () => {
    const glance = main({
      kind: 'issue',
      number: 21,
      title: 'Later status',
      body: '先记一段没有请求的引言。\n\n## 讨论\n还在对方案。\n\n## 一眼状态\n请确认是否接受这一版。'
    })
    expect(glance?.signal.rule).toBe('明确请求')
    expect(glance?.signal.excerpt).toContain('请确认是否接受')
    const current = main({
      kind: 'issue',
      number: 22,
      title: 'Current status heading',
      body: '背景先放这里。\n\n## 备注\n材料还在整理。\n\n## Current Status\n请确认这一版。'
    })
    expect(current?.signal.excerpt).toContain('请确认这一版')
    const outside = classifyRecord(record({
      kind: 'issue',
      number: 23,
      title: 'Ask outside status',
      body: '## 备注\n请确认这一版。\n\n## 状态\n还在整理材料。'
    }), rules, NOW)
    expect(outside).toBeNull()
  })

  it('keeps the signed-in user\'s latest comment when it still asks, and drops it after a newer close', () => {
    const own = main({
      kind: 'issue',
      number: 24,
      title: 'Own ask',
      viewerLogin: 'ada',
      comments: [
        { body: 'looks fine', authorLogin: 'mina', createdAt: '2026-09-21T00:00:00.000Z' },
        { body: '请确认能否合入', authorLogin: 'ada', createdAt: '2026-09-22T00:00:00.000Z' }
      ]
    })
    expect(own?.signal.rule).toBe('明确请求')
    expect(own?.signal.excerpt).toContain('请确认能否合入')
    const closed = classifyRecord(record({
      kind: 'issue',
      number: 25,
      title: 'Own ask then closed',
      viewerLogin: 'ada',
      comments: [
        { body: '请确认能否合入', authorLogin: 'ada', createdAt: '2026-09-21T00:00:00.000Z' },
        { body: '已完成', authorLogin: 'mina', createdAt: '2026-09-22T00:00:00.000Z' }
      ]
    }), rules, NOW)
    expect(closed).toBeNull()
  })

  it('matches waiting labels by containment', () => {
    const blocked = main({
      kind: 'issue',
      number: 26,
      title: 'Blocked label',
      labels: ['status:blocked'],
      labelEvents: [{ name: 'status:blocked', at: '2026-09-12T00:00:00.000Z' }]
    })
    expect(blocked?.signal.rule).toBe('标签')
    expect(blocked?.signal.excerpt).toContain('status:blocked')
    const pending = main({
      kind: 'issue',
      number: 27,
      title: 'Pending label',
      labels: ['freeze:pending'],
      labelEvents: [{ name: 'freeze:pending', at: '2026-09-13T00:00:00.000Z' }]
    })
    expect(pending?.signal.excerpt).toContain('freeze:pending')
    const missed = classifyRecord(record({
      kind: 'issue',
      number: 28,
      title: 'Unrelated label',
      labels: ['bug']
    }), rules, NOW)
    expect(missed).toBeNull()
  })

  it('labels the signed-in user\'s own latest request and leaves someone else\'s unmarked', () => {
    const sentence = '请确认能否合入'
    const own = main({
      kind: 'issue',
      number: 32,
      title: 'Own ask',
      viewerLogin: 'ada',
      comments: [{ body: sentence, authorLogin: 'ada', createdAt: '2026-09-22T00:00:00.000Z' }]
    })
    expect(ownRequestLabel(own ?? {})).toBe('你写的')
    expect(own?.signal.excerpt).toBe(sentence)
    expect(own?.signal.excerpt.includes('你写的')).toBe(false)
    const other = main({
      kind: 'issue',
      number: 33,
      title: 'Their ask',
      viewerLogin: 'ada',
      comments: [{ body: sentence, authorLogin: 'mina', createdAt: '2026-09-22T00:00:00.000Z' }]
    })
    expect(ownRequestLabel(other ?? {})).toBeNull()
    expect(other?.signal.excerpt).toBe(sentence)
    expect(other?.signal.own).toBeUndefined()
  })

  it('admits a title that contains a request verb, and ignores a title that does not', () => {
    const titled = main({
      kind: 'issue',
      number: 34,
      title: '定夺是否接受这一版',
      body: '材料还在整理。'
    })
    expect(titled?.signal.rule).toBe('明确请求')
    expect(titled?.signal.excerpt).toBe('定夺是否接受这一版')
    const plain = classifyRecord(record({
      kind: 'issue',
      number: 35,
      title: '材料还在整理',
      body: '先放着。'
    }), rules, NOW)
    expect(plain).toBeNull()
  })

  it('keeps an earlier explicit request when a newer comment does not close it', () => {
    const kept = main({
      kind: 'issue',
      number: 36,
      title: '导出列名',
      body: '材料还在整理。',
      comments: [
        { body: '请确认能否合入', authorLogin: 'mina', createdAt: '2026-09-21T00:00:00.000Z' },
        { body: '收到，先记下。', authorLogin: 'ada', createdAt: '2026-09-22T00:00:00.000Z' }
      ]
    })
    expect(kept?.signal.rule).toBe('明确请求')
    expect(kept?.signal.excerpt).toBe('请确认能否合入')
    expect(kept?.signal.own).toBeUndefined()
    const closed = classifyRecord(record({
      kind: 'issue',
      number: 37,
      title: '导出列名',
      body: '材料还在整理。',
      comments: [
        { body: '请确认能否合入', authorLogin: 'mina', createdAt: '2026-09-21T00:00:00.000Z' },
        { body: '已完成', authorLogin: 'ada', createdAt: '2026-09-22T00:00:00.000Z' }
      ]
    }), rules, NOW)
    expect(closed).toBeNull()
  })

  it('uses the configured request verbs, including 定夺', () => {
    const asked = main({
      kind: 'issue',
      number: 29,
      title: 'Decide',
      comments: [{ body: '定夺是否接受这一版', authorLogin: 'mina', createdAt: '2026-09-22T00:00:00.000Z' }]
    })
    expect(asked?.signal.rule).toBe('明确请求')
    expect(asked?.signal.excerpt).toBe('定夺是否接受这一版')
    const narrowed = classifyRecord(record({
      kind: 'issue',
      number: 30,
      title: 'Verb not configured',
      comments: [{ body: '定夺是否接受这一版', authorLogin: 'mina', createdAt: '2026-09-22T00:00:00.000Z' }]
    }), config({ requestVerbs: ['请'] }), NOW)
    expect(narrowed).toBeNull()
    const quiet = classifyRecord(record({
      kind: 'issue',
      number: 31,
      title: 'No verb',
      comments: [{ body: '材料还在整理。', authorLogin: 'mina', createdAt: '2026-09-22T00:00:00.000Z' }]
    }), rules, NOW)
    expect(quiet).toBeNull()
  })
})

describe('classifier narrowings for pass, quiet pulls, tables, checklists, titles, and excerpts', () => {
  const rules = config()
  const day = 86_400_000
  const age = (days: number) => new Date(NOW.getTime() - days * day).toISOString()

  function pull(patch: Partial<GithubRecord> = {}): GithubRecord {
    return record({
      kind: 'pr',
      number: 240,
      title: 'Export columns',
      fromOpenPr: true,
      inScopeRepo: true,
      repoAccess: 'maintain',
      isDraft: false,
      createdAt: age(10),
      updatedAt: age(1),
      lastPushedAt: age(10),
      ...patch
    })
  }

  it('keeps a later or beside ask after PASS, and a USER_ACTION_REQUIRED title', () => {
    const beside = classifyRecord(record({
      kind: 'issue',
      number: 201,
      title: 'Phase notes',
      comments: [{
        body: 'Alpha PASS，只剩请你接受这一版。',
        authorLogin: 'mina',
        createdAt: '2026-09-22T00:00:00.000Z'
      }]
    }), rules, NOW)
    expect(beside?.tier).toBe('strong')
    expect(beside?.signal.rule).toBe('明确请求')
    expect(beside?.signal.excerpt).toContain('只剩')
    expect(beside?.signal.excerpt).toContain('接受')

    const screenshot = classifyRecord(record({
      kind: 'issue',
      number: 202,
      title: 'Shot',
      body: '## 状态\nWidget PASS。\n下一步请提供截图。'
    }), rules, NOW)
    expect(screenshot?.tier).toBe('strong')
    expect(screenshot?.signal.excerpt).toContain('提供截图')
    expect(screenshot?.signal.excerpt.includes('Widget PASS')).toBe(false)

    const look = classifyRecord(record({
      kind: 'issue',
      number: 203,
      title: 'Look',
      body: '## 现状\nGamma PASS.\nNext, run it and look at the empty state.'
    }), rules, NOW)
    expect(look?.tier).toBe('strong')
    expect(look?.signal.excerpt.toLowerCase()).toContain('run it and look')

    const titled = classifyRecord(record({
      kind: 'issue',
      number: 204,
      title: 'USER_ACTION_REQUIRED (no Phase PASS)',
      body: '材料还在整理。'
    }), rules, NOW)
    expect(titled?.tier).toBe('strong')
    expect(titled?.signal.rule).toBe('明确请求')
    expect(titled?.signal.excerpt).toContain('USER_ACTION_REQUIRED')
    expect(titled?.signal.excerpt).toContain('no Phase PASS')

    const named = classifyRecord(record({
      kind: 'issue',
      number: 205,
      title: 'Named pass',
      body: '## 状态\n只剩截图 PASS'
    }), rules, NOW)
    expect(named).toBeNull()

    const bare = classifyRecord(record({
      kind: 'issue',
      number: 206,
      title: 'Bare pass',
      comments: [{ body: 'Alpha PASS', authorLogin: 'mina', createdAt: '2026-09-22T00:00:00.000Z' }]
    }), rules, NOW)
    expect(bare).toBeNull()

    const deniedTitle = classifyRecord(record({
      kind: 'issue',
      number: 207,
      title: 'no USER_ACTION_REQUIRED',
      body: '材料还在整理。'
    }), rules, NOW)
    expect(deniedTitle).toBeNull()

    const note = classifyRecord(record({
      kind: 'issue',
      number: 208,
      title: 'Note',
      body: '## 状态\nAlpha PASS。\n下一步把材料归档。'
    }), rules, NOW)
    expect(note).toBeNull()
  })

  it('keeps a non-draft pull after three quiet days even when a comment says PASS', () => {
    const stayed = classifyRecord(pull({
      number: 241,
      lastPushedAt: age(4),
      createdAt: age(10),
      comments: [{ body: 'Phase 2 PASS', authorLogin: 'mina', createdAt: age(4) }]
    }), rules, NOW)
    expect(stayed?.tier).toBe('strong')
    expect(stayed?.reasons).toEqual(['待你审/合'])
    expect(stayed?.signal.rule).toBe('3 天无动静')

    const exact = classifyRecord(pull({
      number: 242,
      lastPushedAt: age(3),
      createdAt: age(3),
      comments: [{ body: 'PASS', authorLogin: 'mina', createdAt: age(3) }]
    }), rules, NOW)
    expect(exact?.tier).toBe('strong')
    expect(exact?.signal.excerpt).toContain('3 天')

    const draft = classifyRecord(pull({
      number: 243,
      isDraft: true,
      lastPushedAt: age(6),
      createdAt: age(10),
      comments: [{ body: 'PASS', authorLogin: 'mina', createdAt: age(6) }]
    }), rules, NOW)
    expect(draft).toBeNull()

    const recentComment = classifyRecord(pull({
      number: 244,
      lastPushedAt: age(8),
      createdAt: age(10),
      comments: [{ body: 'PASS', authorLogin: 'mina', createdAt: age(1) }]
    }), rules, NOW)
    expect(recentComment).toBeNull()

    const recentPush = classifyRecord(pull({
      number: 245,
      lastPushedAt: age(1),
      createdAt: age(10),
      comments: [{ body: 'PASS', authorLogin: 'mina', createdAt: age(6) }]
    }), rules, NOW)
    expect(recentPush).toBeNull()

    const accepted = classifyRecord(pull({
      number: 246,
      lastPushedAt: age(6),
      createdAt: age(10),
      comments: [{ body: '已验收', authorLogin: 'mina', createdAt: age(6) }]
    }), rules, NOW)
    expect(accepted).toBeNull()

    const issue = classifyRecord(record({
      kind: 'issue',
      number: 247,
      title: 'Not a pull',
      comments: [{ body: 'PASS', authorLogin: 'mina', createdAt: age(6) }]
    }), rules, NOW)
    expect(issue).toBeNull()
  })

  it('reads a next-action cell inside a status subsection', () => {
    const decide = classifyRecord(record({
      kind: 'issue',
      number: 251,
      title: 'Columns',
      body: [
        '先记一段没有请求的引言。',
        '',
        '## 状态',
        '| 项 | 下一步 |',
        '| --- | --- |',
        '| 导出 | 请裁决默认列宽 |',
        '| 文档 | 材料还在整理 |'
      ].join('\n')
    }), rules, NOW)
    expect(decide?.tier).toBe('strong')
    expect(decide?.signal.rule).toBe('明确请求')
    expect(decide?.signal.excerpt).toContain('请裁决默认列宽')

    const confirm = classifyRecord(record({
      kind: 'issue',
      number: 252,
      title: 'Cutoff',
      body: [
        '## 讨论',
        '还在对方案。',
        '',
        '## 现状',
        '| 项 | Next Action |',
        '| --- | --- |',
        '| 截止 | 请确认能否合入 |'
      ].join('\n')
    }), rules, NOW)
    expect(confirm?.tier).toBe('strong')
    expect(confirm?.signal.excerpt).toContain('请确认能否合入')

    const outside = classifyRecord(record({
      kind: 'issue',
      number: 253,
      title: 'Outside status',
      body: [
        '## 讨论',
        '| 项 | 下一步 |',
        '| --- | --- |',
        '| 导出 | 请裁决默认列宽 |'
      ].join('\n')
    }), rules, NOW)
    expect(outside).toBeNull()

    const plain = classifyRecord(record({
      kind: 'issue',
      number: 254,
      title: 'Plain next',
      body: [
        '## 状态',
        '| 项 | 下一步 |',
        '| --- | --- |',
        '| 导出 | 材料还在整理 |'
      ].join('\n')
    }), rules, NOW)
    expect(plain).toBeNull()
  })

  it('treats an unchecked user checklist item as a request and ignores the checked twin', () => {
    const items = [
      'provide a screenshot of the empty state',
      'visual acceptance of the print preview',
      'run it on their machine before signing off'
    ]
    items.forEach((item, index) => {
      const open = classifyRecord(record({
        kind: 'issue',
        number: 260 + index,
        title: `Open item ${index}`,
        comments: [{
          body: `- [ ] ${item}`,
          authorLogin: 'mina',
          createdAt: '2026-09-22T00:00:00.000Z'
        }]
      }), rules, NOW)
      expect(open?.tier, item).toBe('strong')
      expect(open?.signal.rule, item).toBe('明确请求')
      expect(open?.signal.excerpt, item).toContain(item)

      const done = classifyRecord(record({
        kind: 'issue',
        number: 270 + index,
        title: `Checked item ${index}`,
        comments: [{
          body: `- [x] ${item}`,
          authorLogin: 'mina',
          createdAt: '2026-09-22T00:00:00.000Z'
        }]
      }), rules, NOW)
      expect(done, item).toBeNull()
    })
  })

  it('counts review in a title only together with 请, 待, needs, or please', () => {
    const admitted = [
      '请 review 导出列',
      '待 review 导出列',
      'needs review on the export',
      'please review the export',
      '待拍板是否合入',
      '待确认列名',
      '待裁决默认值'
    ]
    admitted.forEach((title, index) => {
      const row = classifyRecord(record({
        kind: 'issue',
        number: 280 + index,
        title,
        body: '材料还在整理。'
      }), rules, NOW)
      expect(row?.tier, title).toBe('strong')
      expect(row?.signal.rule, title).toBe('明确请求')
      expect(row?.signal.excerpt, title).toBe(title)
    })

    const rejected = ['Review', 'Accuracy Review', 'Design Review notes']
    rejected.forEach((title, index) => {
      const row = classifyRecord(record({
        kind: 'issue',
        number: 290 + index,
        title,
        body: '材料还在整理。'
      }), rules, NOW)
      expect(row, title).toBeNull()
    })
  })

  it('does not use a bare citation or a negative sentence as the excerpt', () => {
    const cited = classifyRecord(record({
      kind: 'issue',
      number: 301,
      title: 'Follow-up',
      comments: [{
        body: '支持 #12\n请确认能否合入',
        authorLogin: 'mina',
        createdAt: '2026-09-22T00:00:00.000Z'
      }]
    }), rules, NOW)
    expect(cited?.tier).toBe('strong')
    expect(cited?.signal.excerpt).toBe('请确认能否合入')
    expect(cited?.signal.excerpt.includes('支持 #12')).toBe(false)

    const seeOnly = classifyRecord(record({
      kind: 'issue',
      number: 302,
      title: 'Pointer',
      comments: [{ body: '见 #8', authorLogin: 'mina', createdAt: '2026-09-22T00:00:00.000Z' }]
    }), rules, NOW)
    expect(seeOnly).toBeNull()

    const supportOnly = classifyRecord(record({
      kind: 'issue',
      number: 303,
      title: 'Pointer two',
      body: '支持 #4'
    }), rules, NOW)
    expect(supportOnly).toBeNull()

    const mixed = classifyRecord(record({
      kind: 'issue',
      number: 304,
      title: 'Pointer with an ask',
      comments: [{
        body: '见 #7 之后请确认能否合入',
        authorLogin: 'mina',
        createdAt: '2026-09-22T00:00:00.000Z'
      }]
    }), rules, NOW)
    expect(mixed?.tier).toBe('strong')
    expect(mixed?.signal.excerpt).toContain('请确认能否合入')

    const labeled = classifyRecord(record({
      kind: 'issue',
      number: 305,
      title: 'Labeled pointer',
      labels: ['waiting-on-answer'],
      labelEvents: [{ name: 'waiting-on-answer', at: '2026-09-11T00:00:00.000Z' }],
      body: '支持 #3'
    }), rules, NOW)
    expect(labeled?.tier).toBe('strong')
    expect(labeled?.signal.rule).toBe('标签')
    expect(labeled?.signal.excerpt).toContain('waiting-on-answer')
    expect(labeled?.signal.excerpt.includes('支持 #3')).toBe(false)

    const denied = classifyRecord(record({
      kind: 'issue',
      number: 306,
      title: 'Denial then ask',
      body: '这句并不构成批准。请确认能否合入。'
    }), rules, NOW)
    expect(denied?.tier).toBe('strong')
    expect(denied?.signal.excerpt).toBe('请确认能否合入。')
    expect(denied?.signal.excerpt.includes('并不构成')).toBe(false)

    const labelDenial = classifyRecord(record({
      kind: 'issue',
      number: 307,
      title: 'Label only',
      labels: ['needs-human'],
      labelEvents: [{ name: 'needs-human', at: '2026-09-12T00:00:00.000Z' }],
      body: 'The label does not constitute approval.'
    }), rules, NOW)
    expect(labelDenial?.tier).toBe('strong')
    expect(labelDenial?.signal.rule).toBe('标签')
    expect(labelDenial?.signal.excerpt).toContain('needs-human')
    expect(labelDenial?.signal.excerpt.toLowerCase().includes('does not constitute')).toBe(false)

    const denialOnly = classifyRecord(record({
      kind: 'issue',
      number: 308,
      title: 'Denial only',
      body: '「请确认」并不构成批准，也不算需要你动手。'
    }), rules, NOW)
    expect(denialOnly).toBeNull()

    const countOnly = classifyRecord(record({
      kind: 'issue',
      number: 309,
      title: 'Does not count',
      comments: [{
        body: 'That sentence does not count as a request.',
        authorLogin: 'mina',
        createdAt: '2026-09-22T00:00:00.000Z'
      }]
    }), rules, NOW)
    expect(countOnly).toBeNull()
  })

  it('parks a repository only from its description or topics', () => {
    const described = classifyRecord(record({
      kind: 'issue',
      number: 321,
      title: 'Ask',
      body: '请确认',
      repoDescription: 'temporarily parked',
      repoTopics: []
    }), rules, NOW)
    expect(described?.parked).toBe(true)
    expect(described?.tier).toBe('strong')

    const topic = classifyRecord(record({
      kind: 'issue',
      number: 322,
      title: 'Ask',
      body: '请确认',
      repo: 'example/toolkit',
      repoDescription: 'active notes',
      repoTopics: ['搁置']
    }), rules, NOW)
    expect(topic?.parked).toBe(true)

    const nickname = classifyRecord(record({
      kind: 'issue',
      number: 323,
      title: 'parked in the title',
      repo: 'example/parked-nickname',
      body: '请确认',
      comments: [{ body: '这个先搁置', authorLogin: 'mina', createdAt: '2026-09-22T00:00:00.000Z' }],
      repoDescription: '',
      repoTopics: []
    }), rules, NOW)
    expect(nickname?.parked).toBe(false)
    expect(nickname?.tier).toBe('strong')

    const silent = classifyRecord(record({
      kind: 'issue',
      number: 324,
      title: 'Quiet assignment',
      fromAssignee: true,
      assignedAt: '2026-09-18T00:00:00.000Z',
      assignedBy: 'mina',
      repoDescription: '',
      repoTopics: [],
      comments: []
    }), rules, NOW)
    expect(silent?.parked).toBe(false)
    expect(silent?.tier).toBe('strong')
    expect(silent?.reasons).toEqual(['指派'])
  })
})

describe('classifier clarifications for pass scope, checklists, cells, tokens, headings, citations, and excerpts', () => {
  const rules = config()

  function sample(patch: Partial<GithubRecord> & Pick<GithubRecord, 'kind' | 'number' | 'title'>): GithubRecord {
    return record({
      repo: 'example-org/sample',
      url: 'https://github.com/example-org/sample/issues/1',
      ...patch
    })
  }

  it('keeps 只剩 or 仍须 with 验收 or 截图 after a comma or semicolon when PASS names another item', () => {
    const positive = classifyRecord(sample({
      kind: 'issue',
      number: 401,
      title: 'Export phase',
      comments: [{
        body: '功能 PASS；仍须截图',
        authorLogin: 'mina',
        createdAt: '2026-09-22T00:00:00.000Z'
      }]
    }), rules, NOW)
    expect(positive?.tier).toBe('strong')
    expect(positive?.signal.rule).toBe('明确请求')
    expect(positive?.signal.excerpt).toContain('仍须')
    expect(positive?.signal.excerpt).toContain('截图')
    expect(positive?.signal.excerpt.includes('功能 PASS')).toBe(false)

    const negative = classifyRecord(sample({
      kind: 'issue',
      number: 402,
      title: 'Export phase',
      comments: [{
        body: '功能 PASS，仍须整理目录',
        authorLogin: 'mina',
        createdAt: '2026-09-22T00:00:00.000Z'
      }]
    }), rules, NOW)
    expect(negative).toBeNull()
  })

  it('reads an unchecked machine, screenshot, or visual-acceptance item anywhere in the body', () => {
    const positive = classifyRecord(sample({
      kind: 'issue',
      number: 411,
      title: 'Check later',
      body: [
        '## 说明',
        '这里没有状态小节。',
        '',
        '- [ ] run it on their own machine'
      ].join('\n')
    }), rules, NOW)
    expect(positive?.tier).toBe('strong')
    expect(positive?.signal.rule).toBe('明确请求')
    expect(positive?.signal.excerpt).toContain('run it on their own machine')

    const negative = classifyRecord(sample({
      kind: 'issue',
      number: 412,
      title: 'Check later',
      body: [
        '## 说明',
        '这里没有状态小节。',
        '',
        '- [x] run it on their own machine',
        '- [x] provide a screenshot',
        '- [x] visual acceptance'
      ].join('\n')
    }), rules, NOW)
    expect(negative).toBeNull()
  })

  it('keeps a 请…裁决 or 请…确认 cell when a later clause says PASS 暂不改变 and a newer comment does not close it', () => {
    const body = [
      '## 状态',
      '| 项 | 下一步 |',
      '| --- | --- |',
      '| 导出 | 请你裁决这一项，PASS 暂不改变 |'
    ].join('\n')
    const positive = classifyRecord(sample({
      kind: 'issue',
      number: 421,
      title: 'Column width',
      body,
      comments: [{
        body: 'PASS\n下一步：compare on a machine, sync',
        authorLogin: 'mina',
        createdAt: '2026-09-27T00:00:00.000Z'
      }]
    }), rules, NOW)
    expect(positive?.tier).toBe('strong')
    expect(positive?.signal.rule).toBe('明确请求')
    expect(positive?.signal.excerpt).toContain('请你裁决')
    expect(positive?.signal.excerpt.includes('暂不')).toBe(false)
    expect(positive?.signal.excerpt.toLowerCase().includes('compare on a machine')).toBe(false)
    expect(positive?.signal.excerpt.toLowerCase().includes('sync')).toBe(false)

    const negative = classifyRecord(sample({
      kind: 'issue',
      number: 422,
      title: 'Column width',
      body,
      comments: [{
        body: '已完成',
        authorLogin: 'mina',
        createdAt: '2026-09-27T00:00:00.000Z'
      }]
    }), rules, NOW)
    expect(negative).toBeNull()
  })

  it('admits USER_ACTION_REQUIRED, WAITING_USER, or USER_NEEDED_NEXT, and a following Next section', () => {
    const positive = classifyRecord(sample({
      kind: 'issue',
      number: 431,
      title: 'USER_NEEDED_NEXT (not claimed)',
      body: [
        'WAITING_USER (no Phase PASS)',
        '',
        '## Next',
        'The user must finish a step.'
      ].join('\n')
    }), rules, NOW)
    expect(positive?.tier).toBe('strong')
    expect(positive?.signal.rule).toBe('明确请求')
    expect(positive?.signal.excerpt.toLowerCase()).toContain('user must finish')
    expect(positive?.signal.excerpt.toLowerCase().includes('not claimed')).toBe(false)
    expect(positive?.signal.excerpt.toLowerCase().includes('no phase pass')).toBe(false)

    const negative = classifyRecord(sample({
      kind: 'issue',
      number: 432,
      title: 'Notes (no Phase PASS)',
      body: [
        'not claimed',
        '',
        '## Next',
        'Archive the notes.'
      ].join('\n')
    }), rules, NOW)
    expect(negative).toBeNull()
  })

  it('treats a standalone 待拍板, 待确认, or 待裁决 heading as the request', () => {
    const positive = classifyRecord(sample({
      kind: 'issue',
      number: 441,
      title: 'Export columns',
      body: [
        '## 说明',
        '材料还在整理。',
        '',
        '### 待裁决默认值',
        '下面这段只是补充说明，单独出现也不构成请求。'
      ].join('\n')
    }), rules, NOW)
    expect(positive?.tier).toBe('strong')
    expect(positive?.signal.rule).toBe('明确请求')
    expect(positive?.signal.excerpt).toContain('待裁决')
    expect(positive?.signal.excerpt.includes('补充说明')).toBe(false)

    const negative = classifyRecord(sample({
      kind: 'issue',
      number: 442,
      title: 'Export columns',
      body: [
        '## 说明',
        '正文里出现待拍板。',
        '另一句出现待确认。',
        '再一句出现待裁决。'
      ].join('\n')
    }), rules, NOW)
    expect(negative).toBeNull()
  })

  it('drops a sentence whose main clause is 支持 #N, 见 #N, or 同 #N, including quoted text', () => {
    const positive = classifyRecord(sample({
      kind: 'issue',
      number: 451,
      title: 'Follow-up',
      comments: [{
        body: '同 #4：「请确认能否合入」\n请确认列名是否保留',
        authorLogin: 'mina',
        createdAt: '2026-09-22T00:00:00.000Z'
      }]
    }), rules, NOW)
    expect(positive?.tier).toBe('strong')
    expect(positive?.signal.rule).toBe('明确请求')
    expect(positive?.signal.excerpt).toBe('请确认列名是否保留')
    expect(positive?.signal.excerpt.includes('同 #4')).toBe(false)
    expect(positive?.signal.excerpt.includes('请确认能否合入')).toBe(false)

    const negative = classifyRecord(sample({
      kind: 'issue',
      number: 452,
      title: 'Pointer',
      comments: [{
        body: '支持 #15：「请确认能否合入」',
        authorLogin: 'mina',
        createdAt: '2026-09-22T00:00:00.000Z'
      }]
    }), rules, NOW)
    expect(negative).toBeNull()
  })

  it('skips excerpt sentences that contain 不能, 不构成, 不是, or 暂不', () => {
    const positive = classifyRecord(sample({
      kind: 'issue',
      number: 461,
      title: 'Wording',
      body: '这不能当作结论。这不是待办。暂不收进列表。这句并不构成批准。请确认能否合入。'
    }), rules, NOW)
    expect(positive?.tier).toBe('strong')
    expect(positive?.signal.rule).toBe('明确请求')
    expect(positive?.signal.excerpt).toBe('请确认能否合入。')
    expect(positive?.signal.excerpt.includes('不能')).toBe(false)
    expect(positive?.signal.excerpt.includes('不是')).toBe(false)
    expect(positive?.signal.excerpt.includes('暂不')).toBe(false)
    expect(positive?.signal.excerpt.includes('不构成')).toBe(false)

    const negative = classifyRecord(sample({
      kind: 'issue',
      number: 462,
      title: 'Wording',
      labels: ['needs-human'],
      labelEvents: [{ name: 'needs-human', at: '2026-09-12T00:00:00.000Z' }],
      body: '请确认这不是最终版，暂不合并。'
    }), rules, NOW)
    expect(negative?.tier).toBe('strong')
    expect(negative?.signal.rule).toBe('标签')
    expect(negative?.signal.excerpt).toContain('needs-human')
    expect(negative?.signal.excerpt.includes('不是')).toBe(false)
    expect(negative?.signal.excerpt.includes('暂不')).toBe(false)
    expect(negative?.signal.excerpt.includes('不能')).toBe(false)
    expect(negative?.signal.excerpt.includes('请确认')).toBe(false)
  })
})
