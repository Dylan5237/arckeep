import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SettingsService } from '../src/main/settings-service.js'
import { WaitingService } from '../src/main/waiting-service.js'
import { settingsFilePath, waitingCachePath, waitingDismissalPath } from '../src/main/paths.js'
import type { SecretBox } from '../src/main/token-store.js'
import { assembleWaiting } from '../src/shared/waiting/assemble.js'
import { classifyRecord } from '../src/shared/waiting/classify.js'
import { createWaitingClock } from '../src/shared/waiting/clock.js'
import { waitingDays } from '../src/shared/waiting/days.js'
import { localClock, relativeLabel } from '../src/shared/waiting/local-time.js'
import { dedupeDrafts } from '../src/shared/waiting/dedupe.js'
import { parseAheadRefLines } from '../src/shared/waiting/local-branch.js'
import { blankRecord, findMentionTime, parseGithubNode, parseSearchPayload } from '../src/shared/waiting/parse-github.js'
import { rateLimitFromResponse } from '../src/shared/waiting/rate-limit.js'
import { defaultWaitingConfig, keywordToSearchTerms, parseWaitingConfig } from '../src/shared/waiting/rules.js'
import { ignoreDraft, partitionDismissals, snoozeDraft } from '../src/shared/waiting/snooze.js'
import { matchStatusDocText } from '../src/shared/waiting/status-doc.js'
import { pendingTodoProvider } from '../src/shared/waiting/todo-source.js'
import type { GithubRecord, WaitingConfig, WaitingDraft } from '../src/shared/waiting/types.js'
import { loadGithubRecords } from '../src/waiting/github-load.js'
import { runCli } from '../src/waiting/cli.js'
import { resolveWaitingToken } from '../src/waiting/token.js'

const NOW = new Date('2026-09-28T00:00:00.000Z')

function config(patch: Partial<WaitingConfig> = {}): WaitingConfig {
  return { ...defaultWaitingConfig(), ...patch, sources: { ...defaultWaitingConfig().sources, ...patch.sources } }
}

function record(patch: Partial<GithubRecord> & Pick<GithubRecord, 'kind' | 'number' | 'title'>): GithubRecord {
  return blankRecord({
    repo: 'example/demo',
    url: `https://github.com/example/demo/${patch.kind === 'pr' ? 'pull' : 'issues'}/${patch.number}`,
    repoIsEmpty: false,
    repoPushedAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    inScopeRepo: true,
    ...patch
  })
}

function headers(values: Record<string, string>): { get(name: string): string | null } {
  return { get: name => values[name.toLowerCase()] ?? null }
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

describe('waiting days', () => {
  it('counts whole days and falls back only when the event time is missing', () => {
    expect(waitingDays('2026-09-01T00:00:00.000Z', NOW)).toBe(27)
    expect(waitingDays('2026-09-27T12:00:00.000Z', NOW)).toBe(0)
    expect(waitingDays('not-a-date', NOW)).toBe(0)
    const draft = classifyRecord(record({
      kind: 'issue',
      number: 3,
      title: 'Assigned without a timeline event',
      fromAssignee: true,
      assignedAt: null,
      updatedAt: '2026-09-18T00:00:00.000Z'
    }), config(), NOW)
    expect(draft?.waitingDays).toBe(10)
    expect(draft?.daysEstimated).toBe(true)
  })

  it('counts quiet time from the latest push, comment, or review, not updatedAt', () => {
    const draft = classifyRecord(record({
      kind: 'pr',
      number: 9,
      title: 'Open pull',
      fromOpenPr: true,
      isDraft: false,
      lastPushedAt: '2026-09-10T00:00:00.000Z',
      updatedAt: '2026-09-27T00:00:00.000Z'
    }), config(), NOW)
    expect(draft?.reasons).toContain('待你审/合')
    expect(draft?.signal.rule).toBe('3 天无动静')
    expect(draft?.waitingDays).toBe(18)
    expect(draft?.daysEstimated).toBe(false)
  })
})

describe('source classification', () => {
  it('keeps assignee, review request, and mention reasons', () => {
    const rules = config()
    const assigned = classifyRecord(record({
      kind: 'issue',
      number: 1,
      title: 'Assigned',
      fromAssignee: true,
      assignedAt: '2026-09-01T00:00:00.000Z'
    }), rules, NOW)
    expect(assigned?.reasons).toEqual(['指派'])
    expect(assigned?.waitingDays).toBe(27)

    const review = classifyRecord(record({
      kind: 'pr',
      number: 2,
      title: 'Review me',
      fromReview: true,
      reviewRequestedAt: '2026-09-21T00:00:00.000Z',
      inScopeRepo: false
    }), rules, NOW)
    expect(review?.reasons).toEqual(['请求 review'])

    const mention = classifyRecord(record({
      kind: 'issue',
      number: 3,
      title: 'Mention',
      fromMention: true,
      mentionedAt: '2026-09-20T00:00:00.000Z',
      inScopeRepo: false
    }), rules, NOW)
    expect(mention?.reasons).toEqual(['提及'])
    expect(mention?.daysEstimated).toBe(false)
  })

  it('drops draft pull requests from the open-PR source and keeps non-drafts', () => {
    const draft = classifyRecord(record({
      kind: 'pr',
      number: 5,
      title: 'Draft',
      isDraft: true,
      fromOpenPr: true
    }), config(), NOW)
    expect(draft).toBeNull()
    const open = classifyRecord(record({
      kind: 'pr',
      number: 6,
      title: 'Ready',
      isDraft: false,
      fromOpenPr: true,
      lastPushedAt: '2026-09-20T00:00:00.000Z'
    }), config(), NOW)
    expect(open?.reasons).toEqual(['待你审/合'])
    expect(open?.signal.rule).toBe('3 天无动静')
  })

  it('keeps every source in a repo last pushed 60 days ago, including an empty repo signal', () => {
    const rules = config()
    const quiet = '2026-07-30T00:00:00.000Z'
    const assigned = classifyRecord(record({
      kind: 'issue',
      number: 2,
      title: 'Assigned in a quiet repo',
      fromAssignee: true,
      assignedAt: '2026-08-01T00:00:00.000Z',
      repoPushedAt: quiet
    }), rules, NOW)
    expect(assigned?.reasons).toEqual(['指派'])

    const open = classifyRecord(record({
      kind: 'pr',
      number: 8,
      title: 'Open pull with nobody asking',
      fromOpenPr: true,
      inScopeRepo: true,
      isDraft: false,
      repoPushedAt: quiet
    }), rules, NOW)
    expect(open?.reasons).toEqual(['待你审/合'])

    const human = classifyRecord(record({
      kind: 'issue',
      number: 9,
      title: 'Need a person',
      body: '请确认',
      inScopeRepo: true,
      repoPushedAt: quiet
    }), rules, NOW)
    expect(human?.reasons).toEqual(['要人动手'])

    const empty = classifyRecord(record({
      kind: 'issue',
      number: 3,
      title: 'Signal in an empty repo',
      body: '请确认',
      inScopeRepo: true,
      repoIsEmpty: true,
      repoPushedAt: null
    }), rules, NOW)
    expect(empty?.reasons).toEqual(['要人动手'])

    const both = classifyRecord(record({
      kind: 'pr',
      number: 10,
      title: 'Assigned pull in a quiet repo',
      fromAssignee: true,
      fromOpenPr: true,
      inScopeRepo: true,
      isDraft: false,
      assignedAt: '2026-08-15T00:00:00.000Z',
      repoPushedAt: quiet
    }), rules, NOW)
    expect(both?.reasons).toEqual(['指派', '待你审/合'])
  })
})

describe('human action signals', () => {
  const rules = config()

  it('matches the current body or latest comment and the default signals', () => {
    const hit = classifyRecord(record({
      kind: 'issue',
      number: 8,
      title: 'Screenshots',
      body: '请确认截图',
      createdAt: '2026-09-01T00:00:00.000Z'
    }), rules, NOW)
    expect(hit?.reasons).toEqual(['要人动手'])
    expect(hit?.waitingDays).toBe(27)
    expect(hit?.daysEstimated).toBe(false)
  })

  it('drops an issue once the latest comment resolves it or no longer carries the signal', () => {
    const resolved = classifyRecord(record({
      kind: 'issue',
      number: 8,
      title: 'Done',
      body: 'USER_ACTION_REQUIRED',
      labels: ['needs-human'],
      comments: [{ body: '已验收 PASS', createdAt: '2026-09-20T00:00:00.000Z' }]
    }), rules, NOW)
    expect(resolved).toBeNull()

    const staleSignal = classifyRecord(record({
      kind: 'issue',
      number: 9,
      title: 'Old signal',
      body: '等Dylan',
      comments: [{ body: '继续看实现', createdAt: '2026-09-20T00:00:00.000Z' }]
    }), rules, NOW)
    expect(staleSignal).toBeNull()

    const labelStillOn = classifyRecord(record({
      kind: 'issue',
      number: 10,
      title: 'Label remains',
      body: '等Dylan',
      labels: ['needs-human'],
      labelEvents: [{ name: 'needs-human', at: '2026-09-05T00:00:00.000Z' }],
      comments: [{ body: '继续看实现', createdAt: '2026-09-20T00:00:00.000Z' }]
    }), rules, NOW)
    expect(labelStillOn?.reasons).toEqual(['要人动手'])

    const reopened = classifyRecord(record({
      kind: 'issue',
      number: 11,
      title: 'Reopened',
      body: '已完成',
      comments: [
        { body: 'PASS', createdAt: '2026-09-02T00:00:00.000Z' },
        { body: '还是需要你看截图', createdAt: '2026-09-20T00:00:00.000Z' }
      ]
    }), rules, NOW)
    expect(reopened?.reasons).toEqual(['要人动手'])
    expect(reopened?.waitingDays).toBe(8)
  })

  it('keeps a sub-issue as its own row and merges duplicate hits of the same issue', () => {
    const rulesOn = config()
    const parent = classifyRecord(record({
      kind: 'issue',
      number: 20,
      title: 'Parent',
      body: '请确认',
      createdAt: '2026-09-01T00:00:00.000Z'
    }), rulesOn, NOW)
    const child = classifyRecord(record({
      kind: 'issue',
      number: 21,
      title: 'Child',
      body: '请确认截图',
      parentNumber: 20,
      createdAt: '2026-09-10T00:00:00.000Z'
    }), rulesOn, NOW)
    const childAgain = classifyRecord(record({
      kind: 'issue',
      number: 21,
      title: 'Child',
      fromAssignee: true,
      assignedAt: '2026-09-12T00:00:00.000Z',
      inScopeRepo: true,
      body: '请确认截图',
      parentNumber: 20,
      createdAt: '2026-09-10T00:00:00.000Z'
    }), rulesOn, NOW)
    const rows = dedupeDrafts([parent, child, childAgain].filter((item): item is WaitingDraft => item !== null), NOW)
    expect(rows.map(item => item.number).sort()).toEqual([20, 21])
    const childRow = rows.find(item => item.number === 21)
    expect(childRow?.reasons).toEqual(expect.arrayContaining(['要人动手', '指派']))
    expect(rows.filter(item => item.number === 21)).toHaveLength(1)
  })
})

describe('status documents and local branches', () => {
  it('returns matching lines and rejects a broken regular expression', () => {
    const hits = matchStatusDocText([
      '进度正常',
      '等 Dylan 验收 #15',
      'AWAITING ACCEPT the export'
    ].join('\n'), {
      repo: 'example/demo',
      target: 'docs/STATUS.md',
      pattern: '等 ?Dylan|AWAITING ACCEPT|HUMAN_REQUIRED|needs-dylan'
    }, '2026-09-01T00:00:00.000Z')
    expect(hits.map(hit => hit.line)).toEqual([2, 3])
    expect(hits[0]?.issueNumber).toBe(15)
    const rows = assembleWaiting({
      records: [],
      statusDocs: hits,
      branches: [],
      todos: [],
      config: config(),
      now: NOW
    })
    expect(rows.find(row => row.number === 15)?.reasons).toEqual(['状态文档'])
    expect(rows.find(row => row.type === 'status-doc')?.title).toContain('AWAITING ACCEPT')
    expect(() => parseWaitingConfig({
      statusDocRules: [{ repo: 'example/demo', target: 'docs/STATUS.md', pattern: '(' }]
    }, { validatePatterns: true })).toThrow(/状态文档正则无效/)
  })

  it('lists branches that are ahead of upstream', () => {
    const nul = '\u0000'
    const hits = parseAheadRefLines([
      ['main', 'origin/main', '[ahead 2]', '2026-09-20T00:00:00.000Z', 'abc', 'export fix'].join(nul),
      ['wip', '', '', '2026-09-20T00:00:00.000Z', 'def', 'no upstream'].join(nul),
      ['synced', 'origin/synced', '', '2026-09-20T00:00:00.000Z', 'aaa', 'even'].join(nul)
    ].join('\n'), '/repos/demo', 'git@github.com:example/demo.git')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.branch).toBe('main')
    expect(hits[0]?.url).toBe('https://github.com/example/demo/tree/main')
    const rows = assembleWaiting({
      records: [],
      statusDocs: [],
      branches: hits,
      todos: [],
      config: config({ sources: { ...defaultWaitingConfig().sources, localBranches: true } }),
      now: NOW
    })
    expect(rows[0]?.type).toBe('local-branch')
    expect(rows[0]?.reasons).toEqual(['没推送'])
    expect(rows[0]?.waitingDays).toBe(8)
  })

  it('keeps an empty fallback when no todo log is wired', async () => {
    expect(pendingTodoProvider.available).toBe(false)
    await expect(pendingTodoProvider.listWaitingOnMe()).resolves.toEqual([])
  })
})

describe('repo activity scope', () => {
  const quietPush = '2026-07-30T00:00:00.000Z'

  function issueNode(repo: string, number: number, title: string, body: string): Record<string, unknown> {
    return {
      number,
      title,
      url: `https://github.com/${repo}/issues/${number}`,
      body,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      labels: { nodes: [] },
      comments: { nodes: [] },
      timelineItems: { nodes: [] }
    }
  }

  it('pages past quiet repos and still loads their pulls and an empty repo issue', async () => {
    const rules = config({
      sources: {
        ...defaultWaitingConfig().sources,
        reviewRequested: false,
        mentions: false,
        statusDocs: false,
        localBranches: false
      }
    })
    const bodies: string[] = []
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = String(init?.body ?? '')
      bodies.push(body)
      if (body.includes('viewer { login }')) {
        return new Response(JSON.stringify({ data: { viewer: { login: 'ada' } } }), { status: 200 })
      }
      if (body.includes('ownerAffiliations') && body.includes('NEXT')) {
        return new Response(JSON.stringify({
          data: {
            viewer: {
              repositories: {
                pageInfo: { hasNextPage: false },
                nodes: [{ nameWithOwner: 'example/empty', isEmpty: true, pushedAt: null }]
              }
            }
          }
        }), { status: 200 })
      }
      if (body.includes('ownerAffiliations')) {
        return new Response(JSON.stringify({
          data: {
            viewer: {
              repositories: {
                pageInfo: { hasNextPage: true, endCursor: 'NEXT' },
                nodes: [
                  { nameWithOwner: 'example/active', isEmpty: false, pushedAt: '2026-09-20T00:00:00.000Z' },
                  { nameWithOwner: 'example/quiet', isEmpty: false, pushedAt: quietPush }
                ]
              }
            }
          }
        }), { status: 200 })
      }
      if (body.includes('watching(')) {
        return new Response(JSON.stringify({
          data: { viewer: { watching: { pageInfo: { hasNextPage: false }, nodes: [] } } }
        }), { status: 200 })
      }
      if (body.includes('pullRequests')) {
        if (body.includes('empty')) throw new Error('empty repo must not be in a pull request query')
        return new Response(JSON.stringify({
          data: {
            r0: {
              nameWithOwner: 'example/quiet',
              isEmpty: false,
              pushedAt: quietPush,
              issues: {
                pageInfo: { hasNextPage: false },
                nodes: [issueNode('example/quiet', 61, 'Need a person', '请确认')]
              },
              pullRequests: {
                pageInfo: { hasNextPage: false },
                nodes: [{
                  number: 8,
                  title: 'Quiet pull',
                  url: 'https://github.com/example/quiet/pull/8',
                  body: '',
                  isDraft: false,
                  createdAt: '2026-08-01T00:00:00.000Z',
                  updatedAt: '2026-08-10T00:00:00.000Z',
                  labels: { nodes: [] },
                  comments: { nodes: [] },
                  commits: { nodes: [{ commit: { committedDate: '2026-08-10T00:00:00.000Z' } }] },
                  timelineItems: { nodes: [] }
                }]
              }
            },
            r1: {
              nameWithOwner: 'example/active',
              isEmpty: false,
              pushedAt: '2026-09-20T00:00:00.000Z',
              issues: { pageInfo: { hasNextPage: false }, nodes: [] },
              pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] }
            }
          }
        }), { status: 200 })
      }
      if (body.includes('"n0":"empty"') || body.includes('example/empty')) {
        return new Response(JSON.stringify({
          data: {
            r0: {
              nameWithOwner: 'example/empty',
              isEmpty: true,
              pushedAt: null,
              issues: {
                pageInfo: { hasNextPage: false },
                nodes: [issueNode('example/empty', 3, 'Signal in an empty repo', '请确认')]
              }
            }
          }
        }), { status: 200 })
      }
      if (body.includes('assignee:@me')) {
        return new Response(JSON.stringify({
          data: {
            search: {
              pageInfo: { hasNextPage: false },
              nodes: [{
                __typename: 'Issue',
                ...issueNode('example/quiet', 60, 'Still waiting in a quiet repo', ''),
                repository: { nameWithOwner: 'example/quiet', isEmpty: false, pushedAt: quietPush },
                timelineItems: { nodes: [{ __typename: 'AssignedEvent', createdAt: '2026-08-01T00:00:00.000Z', assignee: { login: 'ada' } }] }
              }]
            }
          }
        }), { status: 200 })
      }
      if (body.includes('is:issue is:open')) {
        return new Response(JSON.stringify({
          data: { search: { pageInfo: { hasNextPage: false }, nodes: [] } }
        }), { status: 200 })
      }
      return new Response(`unexpected ${body.slice(0, 180)}`, { status: 500 })
    }
    const loaded = await loadGithubRecords({
      token: 'test-token',
      config: rules,
      watchedRepos: [],
      fetchImpl
    })
    expect(bodies.some(body => body.includes('ownerAffiliations') && body.includes('NEXT'))).toBe(true)
    expect(bodies.some(body => body.includes('pullRequests') && body.includes('quiet'))).toBe(true)
    expect(bodies.some(body => body.includes('pullRequests') && body.includes('empty'))).toBe(false)
    expect(loaded.notices).toEqual([])
    expect(loaded.errors).toEqual([])
    const rows = assembleWaiting({
      records: [
        ...loaded.bySource.assignee,
        ...loaded.bySource.openPrs,
        ...loaded.bySource.humanIssues
      ],
      statusDocs: [],
      branches: [],
      todos: [],
      config: rules,
      now: NOW
    })
    expect(rows.map(row => `${row.repo}#${row.number}:${row.reasons.join('+')}`).sort()).toEqual([
      'example/empty#3:要人动手',
      'example/quiet#60:指派',
      'example/quiet#61:要人动手',
      'example/quiet#8:待你审/合'
    ])
  })

  it('notices when the repo cap drops the rest instead of stopping on a quiet repo', async () => {
    const rules = config({
      maxScopeRepos: 1,
      sources: {
        ...defaultWaitingConfig().sources,
        reviewRequested: false,
        mentions: false,
        humanIssues: false,
        statusDocs: false,
        localBranches: false
      }
    })
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = String(init?.body ?? '')
      if (body.includes('NEXT')) throw new Error('cap should stop before another owned-repo page')
      if (body.includes('quiet') && body.includes('pullRequests')) throw new Error('capped repo must not be queried')
      if (body.includes('viewer { login }')) {
        return new Response(JSON.stringify({ data: { viewer: { login: 'ada' } } }), { status: 200 })
      }
      if (body.includes('ownerAffiliations')) {
        return new Response(JSON.stringify({
          data: {
            viewer: {
              repositories: {
                pageInfo: { hasNextPage: true, endCursor: 'NEXT' },
                nodes: [
                  { nameWithOwner: 'example/active', isEmpty: false, pushedAt: '2026-09-20T00:00:00.000Z' },
                  { nameWithOwner: 'example/quiet', isEmpty: false, pushedAt: quietPush }
                ]
              }
            }
          }
        }), { status: 200 })
      }
      if (body.includes('watching(')) {
        return new Response(JSON.stringify({
          data: { viewer: { watching: { pageInfo: { hasNextPage: false }, nodes: [] } } }
        }), { status: 200 })
      }
      if (body.includes('pullRequests')) {
        return new Response(JSON.stringify({
          data: {
            r0: {
              nameWithOwner: 'example/active',
              isEmpty: false,
              pushedAt: '2026-09-20T00:00:00.000Z',
              issues: { pageInfo: { hasNextPage: false }, nodes: [] },
              pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] }
            }
          }
        }), { status: 200 })
      }
      if (body.includes('assignee:@me')) {
        return new Response(JSON.stringify({
          data: { search: { pageInfo: { hasNextPage: false }, nodes: [] } }
        }), { status: 200 })
      }
      return new Response('unexpected', { status: 500 })
    }
    const loaded = await loadGithubRecords({
      token: 'test-token',
      config: rules,
      watchedRepos: [],
      fetchImpl
    })
    expect(loaded.errors).toEqual([])
    expect(loaded.notices).toEqual(['仓库数量达到上限 1，其余仓库没有继续查询。到设置里调高「仓库数量上限」。'])
    expect(loaded.bySource.openPrs).toEqual([])
  })
})

describe('rate limit', () => {
  it('reads 403 and 429 reset headers and ignores unrelated 403s', () => {
    const reset = String(Math.floor(Date.parse('2026-09-28T18:30:00.000Z') / 1000))
    expect(rateLimitFromResponse(429, headers({ 'x-ratelimit-reset': reset }), 'slow down')).toBe('2026-09-28T18:30:00.000Z')
    expect(rateLimitFromResponse(403, headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }), 'api rate limit exceeded')).toBe('2026-09-28T18:30:00.000Z')
    expect(rateLimitFromResponse(403, headers({}), 'Resource not accessible by integration')).toBeNull()
  })

  it('keeps successful sources when another source is rate limited', async () => {
    const rules = config({
      sources: {
        ...defaultWaitingConfig().sources,
        openPrs: false,
        humanIssues: false,
        mentions: false,
        statusDocs: false,
        localBranches: false
      }
    })
    let reviewCalls = 0
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = String(init?.body ?? '')
      if (body.includes('viewer { login }') || body.includes('viewer {login}')) {
        return new Response(JSON.stringify({ data: { viewer: { login: 'ada' } } }), { status: 200 })
      }
      if (body.includes('repository(owner')) {
        return new Response(JSON.stringify({
          data: { r0: { nameWithOwner: 'example/demo', isEmpty: false, pushedAt: '2026-09-27T00:00:00.000Z' } }
        }), { status: 200 })
      }
      if (body.includes('assignee:@me')) {
        return new Response(JSON.stringify({
          data: {
            search: {
              pageInfo: { hasNextPage: false },
              nodes: [{
                __typename: 'Issue',
                number: 7,
                title: 'Need a decision',
                url: 'https://github.com/example/demo/issues/7',
                body: '',
                createdAt: '2026-09-01T00:00:00.000Z',
                updatedAt: '2026-09-20T00:00:00.000Z',
                repository: { nameWithOwner: 'example/demo', isEmpty: false, pushedAt: '2026-09-27T00:00:00.000Z' },
                labels: { nodes: [] },
                comments: { nodes: [] },
                timelineItems: { nodes: [{ __typename: 'AssignedEvent', createdAt: '2026-09-10T00:00:00.000Z', assignee: { login: 'ada' } }] }
              }]
            }
          }
        }), { status: 200 })
      }
      if (body.includes('review-requested:')) {
        reviewCalls += 1
        return new Response('rate limit exceeded', {
          status: reviewCalls === 1 ? 429 : 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.parse('2026-09-28T18:30:00.000Z') / 1000))
          }
        })
      }
      return new Response('unexpected', { status: 500 })
    }
    const first = await loadGithubRecords({
      token: 'test-token',
      config: rules,
      watchedRepos: ['example/demo'],
      fetchImpl
    })
    expect(first.rateLimitResetAt).toBe('2026-09-28T18:30:00.000Z')
    expect(first.fresh.assignee).toBe(true)
    expect(first.fresh.reviewRequested).toBe(false)
    expect(first.bySource.assignee[0]?.title).toBe('Need a decision')
    expect(first.errors.some(error => error.source === '请求 review')).toBe(true)

    const secondFetch: typeof fetch = async (input, init) => {
      const body = String(init?.body ?? '')
      if (body.includes('assignee:@me')) {
        return new Response('api rate limit exceeded', {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.parse('2026-09-28T19:00:00.000Z') / 1000))
          }
        })
      }
      return fetchImpl(input, init)
    }
    const second = await loadGithubRecords({
      token: 'test-token',
      config: rules,
      watchedRepos: ['example/demo'],
      fetchImpl: secondFetch
    })
    expect(second.fresh.assignee).toBe(false)
    expect(second.bySource.assignee).toEqual([])
    const kept = first.bySource.assignee
    expect(kept).toHaveLength(1)
  })
})

describe('snooze and ignore', () => {
  it('hides snoozed rows until the clock passes, and restores ignored rows on new activity', () => {
    const draft = classifyRecord(record({
      kind: 'issue',
      number: 4,
      title: 'Later',
      fromAssignee: true,
      assignedAt: '2026-09-01T00:00:00.000Z'
    }), config(), NOW)
    if (!draft) throw new Error('missing draft')
    const snoozed = snoozeDraft({}, draft.id, 1, NOW)
    expect(partitionDismissals([draft], snoozed, NOW, false).rows).toHaveLength(0)
    expect(partitionDismissals([draft], snoozed, new Date(NOW.getTime() + 86_400_000), false).rows).toHaveLength(1)
    const ignored = ignoreDraft({}, draft)
    expect(partitionDismissals([draft], ignored, new Date('2026-10-01T00:00:00.000Z'), false).rows).toHaveLength(0)
    expect(partitionDismissals([draft], ignored, NOW, true).rows[0]?.ignored).toBe(true)
    const moved = { ...draft, updatedAt: '2026-09-27T00:00:00.000Z' }
    expect(partitionDismissals([moved], ignored, NOW, false).rows).toHaveLength(1)
  })

  it('persists ignore across a restart and only advances time when test hooks are on', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'arckeep-waiting-'))
    const makeSettings = () => new SettingsService({
      file: settingsFilePath(dir),
      secretBox: xorBox(),
      registrar: { register: () => true, isRegistered: () => true, unregister: () => {} },
      onHotkey: () => {},
      readGh: async () => ({ ok: false, reason: 'not-installed' })
    })
    const files = { cache: waitingCachePath(dir), dismissals: waitingDismissalPath(dir) }
    const saved = makeSettings().setWaiting(config({
      sources: {
        ...defaultWaitingConfig().sources,
        reviewRequested: false,
        mentions: false,
        openPrs: false,
        humanIssues: false,
        statusDocs: false,
        localBranches: false
      }
    }))
    expect(saved.ok).toBe(true)
    makeSettings().setRepos(['example/demo'])
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = String(init?.body ?? '')
      if (body.includes('viewer { login }')) {
        return new Response(JSON.stringify({ data: { viewer: { login: 'ada' } } }), { status: 200 })
      }
      if (body.includes('nameWithOwner') && !body.includes('assignee:@me')) {
        return new Response(JSON.stringify({
          data: { r0: { nameWithOwner: 'example/demo', isEmpty: false, pushedAt: '2026-09-27T00:00:00.000Z' } }
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        data: {
          search: {
            pageInfo: { hasNextPage: false },
            nodes: [{
              __typename: 'Issue',
              number: 4,
              title: 'Later',
              url: 'https://github.com/example/demo/issues/4',
              body: '',
              createdAt: '2026-09-01T00:00:00.000Z',
              updatedAt: '2026-09-20T00:00:00.000Z',
              repository: { nameWithOwner: 'example/demo', isEmpty: false, pushedAt: '2026-09-27T00:00:00.000Z' },
              labels: { nodes: [] },
              comments: { nodes: [] },
              timelineItems: { nodes: [{ __typename: 'AssignedEvent', createdAt: '2026-09-01T00:00:00.000Z', assignee: { login: 'ada' } }] }
            }]
          }
        }
      }), { status: 200 })
    }
    const clock = createWaitingClock(() => new Date('2026-09-28T00:00:00.000Z'))
    const first = new WaitingService(makeSettings(), files, {
      env: { ARCKEEP_TEST_HOOKS: '1', GITHUB_TOKEN: 'test-token' },
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      fetchImpl,
      clock
    })
    const opened = await first.refresh()
    expect(opened.auth).toBe('ok')
    expect(opened.rows.map(row => row.title)).toEqual(['Later'])
    const id = opened.rows[0]?.id
    if (!id) throw new Error('missing id')
    expect(first.snooze(id, 1).ok).toBe(true)
    expect(first.current().rows).toHaveLength(0)
    const blockedClock = new WaitingService(makeSettings(), files, {
      env: { GITHUB_TOKEN: 'test-token' },
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      fetchImpl,
      clock
    })
    expect(blockedClock.advanceDays(1).ok).toBe(false)
    const hooked = new WaitingService(makeSettings(), files, {
      env: { ARCKEEP_TEST_HOOKS: '1', GITHUB_TOKEN: 'test-token' },
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      fetchImpl,
      clock
    })
    const stillSnoozed = await hooked.refresh()
    expect(stillSnoozed.rows).toHaveLength(0)
    expect(hooked.advanceDays(1).ok).toBe(true)
    expect(hooked.current().rows.map(row => row.title)).toEqual(['Later'])
    expect(hooked.ignore(id).ok).toBe(true)
    expect(hooked.current().rows).toHaveLength(0)
    const restarted = new WaitingService(makeSettings(), files, {
      env: { GITHUB_TOKEN: 'test-token' },
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      fetchImpl,
      clock
    })
    const again = await restarted.refresh()
    expect(again.rows).toHaveLength(0)
    expect(restarted.setShowIgnored(true).ok).toBe(true)
    expect(restarted.current().rows.map(row => row.title)).toEqual(['Later'])
    const blocked = new WaitingService(makeSettings(), files, {
      env: {},
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      fetchImpl: async () => { throw new Error('should not fetch without a token') }
    })
    const missing = await blocked.refresh()
    expect(missing.auth).toBe('missing')
    expect(missing.rows).toEqual([])
  })
})

describe('cli json', () => {
  it('prints the required fields from a fixture and does not call GitHub', async () => {
    let output = ''
    const code = await runCli(['--json', '--fixture', path.join('test', 'fixtures', 'waiting-cli.json')], {
      stdout: text => { output += text },
      stderr: () => {},
      env: {},
      fetchImpl: async () => { throw new Error('network') }
    })
    expect(code).toBe(0)
    const rows = JSON.parse(output) as Record<string, unknown>[]
    expect(rows.map(row => row.number)).toEqual([12, 4])
    for (const row of rows) {
      expect(row).toEqual(expect.objectContaining({
        repo: 'example/demo',
        title: expect.any(String),
        url: expect.stringContaining('https://github.com/example/demo/'),
        waitingDays: expect.any(Number),
        daysEstimated: expect.any(Boolean)
      }))
      expect(['issue', 'pr', 'todo', 'local-branch', 'status-doc']).toContain(row.type)
      expect(Array.isArray(row.reasons)).toBe(true)
    }
    const pull = rows.find(row => row.number === 4)
    expect(pull?.reasons).toEqual(expect.arrayContaining(['指派', '请求 review', '待你审/合']))
    expect(pull?.daysEstimated).toBe(false)
  })
})

describe('local time', () => {
  it('says how long ago in minutes and formats the clock in local time', () => {
    const now = new Date('2026-09-28T12:00:00.000Z')
    expect(relativeLabel('2026-09-28T11:57:00.000Z', now)).toBe('3 分钟前')
    expect(relativeLabel('2026-09-28T12:00:20.000Z', now)).toBe('刚刚')
    const iso = '2026-09-28T18:30:00.000Z'
    const date = new Date(iso)
    const pad = (value: number) => String(value).padStart(2, '0')
    expect(localClock(iso)).toBe(`${pad(date.getHours())}:${pad(date.getMinutes())}`)
    expect(localClock(iso)).not.toMatch(/UTC/)
  })
})

describe('tokens and search terms', () => {
  it('prefers gh, then GITHUB_TOKEN, then a saved token', async () => {
    const gh = await resolveWaitingToken({
      readGh: async () => ({ ok: true, token: 'from-gh' }),
      envToken: 'from-env',
      readSaved: () => 'from-saved'
    })
    expect(gh).toEqual({ token: 'from-gh', via: 'gh' })
    const env = await resolveWaitingToken({
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      envToken: 'from-env',
      readSaved: () => 'from-saved'
    })
    expect(env).toEqual({ token: 'from-env', via: 'env' })
    const saved = await resolveWaitingToken({
      readGh: async () => ({ ok: false, reason: 'not-logged-in' }),
      envToken: '   ',
      readSaved: () => 'from-saved'
    })
    expect(saved).toEqual({ token: 'from-saved', via: 'saved' })
  })

  it('turns the default keyword patterns into search literals without pinning a repository', () => {
    expect(keywordToSearchTerms('等 ?Dylan')).toEqual(expect.arrayContaining(['等Dylan', '等 Dylan']))
    const defaults = defaultWaitingConfig()
    expect(defaults.humanKeywords).toEqual(expect.arrayContaining([
      'USER_ACTION_REQUIRED',
      'HUMAN_REQUIRED',
      'needs-human',
      'needs-dylan',
      '需要你',
      '等你',
      '待验收',
      '请确认',
      '截图'
    ]))
    expect(defaults.humanLabels).toEqual(expect.arrayContaining(['pending', 'waiting', 'needs-*', 'blocked', '等待']))
    expect(defaults.humanKeywords).not.toContain('\\bACK\\b')
    expect(defaults.parkedMarkers).toEqual(expect.arrayContaining(['parked', '搁置']))
    expect(defaults.resolvedSignals).toEqual(expect.arrayContaining(['已验收', '已完成', '\\bPASS\\b']))
    expect(defaults.maxScopeRepos).toBe(400)
    expect(() => parseWaitingConfig({ maxScopeRepos: 0 })).toThrow('仓库数量上限')
    const queryBlob = JSON.stringify(defaults)
    expect(queryBlob).not.toContain('Dylan5237/')
  })

  it('parses a mention time from the comment that names the login', () => {
    const at = findMentionTime('hello', '2026-09-01T00:00:00.000Z', [
      { body: 'cc @Ada please', createdAt: '2026-09-03T00:00:00.000Z' },
      { body: 'thanks', createdAt: '2026-09-04T00:00:00.000Z' }
    ], 'ada')
    expect(at).toBe('2026-09-03T00:00:00.000Z')
    const nodes = parseSearchPayload({
      search: {
        nodes: [{
          __typename: 'PullRequest',
          number: 3,
          title: 'Mentioned pull',
          url: 'https://github.com/example/demo/pull/3',
          body: '@ada',
          createdAt: '2026-09-02T00:00:00.000Z',
          updatedAt: '2026-09-04T00:00:00.000Z',
          isDraft: false,
          repository: { nameWithOwner: 'example/demo', isEmpty: false, pushedAt: '2026-09-27T00:00:00.000Z' }
        }]
      }
    }, { login: 'ada', fromMention: true })
    expect(nodes[0]?.mentionedAt).toBe('2026-09-02T00:00:00.000Z')
    expect(nodes[0]?.kind).toBe('pr')
  })

  it('reads a pull request push time and the latest submitted review', () => {
    const parsed = parseGithubNode({
      __typename: 'PullRequest',
      number: 4,
      title: 'Quiet',
      url: 'https://github.com/example/demo/pull/4',
      repository: {
        nameWithOwner: 'example/demo',
        isFork: false,
        viewerPermission: 'WRITE',
        owner: { login: 'ada' }
      },
      commits: {
        nodes: [{ commit: { committedDate: '2026-09-01T00:00:00.000Z', pushedDate: '2026-09-20T00:00:00.000Z' } }]
      },
      reviews: {
        nodes: [
          { submittedAt: '2026-09-10T00:00:00.000Z' },
          { submittedAt: '2026-09-22T00:00:00.000Z' }
        ]
      }
    }, { login: 'ada', fromOpenPr: true })
    expect(parsed?.lastPushedAt).toBe('2026-09-20T00:00:00.000Z')
    expect(parsed?.lastReviewAt).toBe('2026-09-22T00:00:00.000Z')
  })
})
