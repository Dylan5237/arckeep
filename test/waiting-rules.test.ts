import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { userDataDir, waitingDismissalPath } from '../src/main/paths.js'
import { assembleWaiting } from '../src/shared/waiting/assemble.js'
import { classifyRecord } from '../src/shared/waiting/classify.js'
import { blankRecord, parseIssueTree } from '../src/shared/waiting/parse-github.js'
import { tasklistIssueRefs } from '../src/shared/waiting/sub-issues.js'
import { defaultWaitingConfig, parseWaitingConfig } from '../src/shared/waiting/rules.js'
import { evaluateSignals } from '../src/shared/waiting/signals.js'
import { partitionDismissals, readDismissalState, writeDismissalState } from '../src/shared/waiting/snooze.js'
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
