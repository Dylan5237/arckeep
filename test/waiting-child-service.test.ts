import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WaitingService } from '../src/main/waiting-service.js'
import { settingsFilePath, waitingCachePath, waitingDismissalPath } from '../src/main/paths.js'
import { SettingsService } from '../src/main/settings-service.js'
import type { SecretBox } from '../src/main/token-store.js'
import { defaultWaitingConfig } from '../src/shared/waiting/rules.js'
import { createWaitingClock } from '../src/shared/waiting/clock.js'
import type { WaitingConfig } from '../src/shared/waiting/types.js'

const BASE_TIME = Date.parse('2026-10-08T00:00:00.000Z')

interface GraphqlRequest {
  query: string
  variables?: Record<string, unknown>
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function config(): WaitingConfig {
  const defaults = defaultWaitingConfig()
  return {
    ...defaults,
    sources: {
      ...defaults.sources,
      assignee: false,
      reviewRequested: false,
      mentions: false,
      openPrs: false,
      humanIssues: true,
      statusDocs: false,
      localBranches: false,
      todos: false
    }
  }
}

function testSecretBox(): SecretBox {
  return {
    encrypt: value => `encrypted:${Buffer.from(value, 'utf8').toString('base64')}`,
    decrypt: value => value.startsWith('encrypted:')
      ? Buffer.from(value.slice('encrypted:'.length), 'base64').toString('utf8')
      : ''
  }
}

function makeSettings(dir: string): SettingsService {
  const settings = new SettingsService({
    file: settingsFilePath(dir),
    secretBox: testSecretBox(),
    registrar: { register: () => true, isRegistered: () => true, unregister: () => {} },
    onHotkey: () => {},
    readGh: async () => ({ ok: false, reason: 'not-installed' })
  })
  settings.init()
  settings.setRepos(['ada/demo'])
  settings.setWaiting(config())
  return settings
}

function issue(number: number, title: string, subIssues: unknown[] = []): Record<string, unknown> {
  return {
    __typename: 'Issue',
    number,
    title,
    url: `https://github.com/ada/demo/issues/${number}`,
    body: '请确认这个 issue',
    state: 'OPEN',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-08T00:00:00.000Z',
    author: { login: 'ada' },
    labels: { nodes: [] },
    comments: { nodes: [] },
    timelineItems: { nodes: [] },
    parent: null,
    subIssues: { nodes: subIssues }
  }
}

function variableIndexes(variables: Record<string, unknown> | undefined): number[] {
  return Object.keys(variables ?? {})
    .filter(key => /^n\d+$/.test(key))
    .map(key => Number(key.slice(1)))
    .sort((left, right) => left - right)
}

describe('WaitingService child hydration failures', () => {
  it.each(['malformed', 'missing'] as const)('keeps the last successful rows and timestamp on a %s child connection, then retries refresh(false)', async shape => {
    const dir = mkdtempSync(path.join(tmpdir(), 'arckeep-waiting-child-service-'))
    const settings = makeSettings(dir)
    let now = BASE_TIME
    let contentCalls = 0
    const requests: GraphqlRequest[] = []
    const service = new WaitingService(settings, {
      cache: waitingCachePath(dir),
      dismissals: waitingDismissalPath(dir)
    }, {
      env: { GITHUB_TOKEN: 'test-token' },
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      clock: createWaitingClock(() => new Date(now)),
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as GraphqlRequest
        requests.push(request)
        if (request.query.includes('viewer { login }')) {
          return jsonResponse({ data: { viewer: { login: 'ada' } } })
        }
        if (request.query.includes('issue(number:')) {
          return jsonResponse({
            data: { r0: { issue: shape === 'malformed'
              ? { number: 2, subIssues: { nodes: [{ number: 3 }] } }
              : { number: 2 } } }
          })
        }
        if (request.query.includes('issues(states: OPEN, first: 40')) {
          contentCalls += 1
          const current = contentCalls === 1
            ? issue(1, 'Before')
            : contentCalls === 2
              ? issue(2, 'After', [{ number: 3 }])
              : issue(2, 'After')
          const data: Record<string, unknown> = {}
          for (const index of variableIndexes(request.variables)) {
            const owner = String(request.variables?.[`o${index}`] ?? 'ada')
            const name = String(request.variables?.[`n${index}`] ?? 'demo')
            data[`r${index}`] = {
              nameWithOwner: `${owner}/${name}`,
              description: 'Demo repository',
              isEmpty: false,
              pushedAt: '2026-10-08T00:00:00.000Z',
              isFork: false,
              viewerPermission: 'ADMIN',
              owner: { login: owner },
              repositoryTopics: { nodes: [] },
              issues: { nodes: [current], pageInfo: { hasNextPage: false } }
            }
          }
          return jsonResponse({ data })
        }
        if (request.query.includes('search(query:')) {
          return jsonResponse({ data: { search: { nodes: [], pageInfo: { hasNextPage: false } } } })
        }
        if (request.query.includes('r0: repository(owner:')) {
          return jsonResponse({
            data: {
              r0: {
                nameWithOwner: 'ada/demo',
                description: 'Demo repository',
                isEmpty: false,
                pushedAt: '2026-10-08T00:00:00.000Z',
                isFork: false,
                viewerPermission: 'ADMIN',
                owner: { login: 'ada' },
                repositoryTopics: { nodes: [] }
              }
            }
          })
        }
        return jsonResponse({ data: {} })
      }
    })

    const first = await service.refresh(false)
    expect(first.rows.map(row => row.title)).toContain('Before')
    expect(first.sourceErrors).toEqual([])
    const firstRefreshedAt = first.refreshedAt
    const callsAfterFirst = requests.length

    now += 1
    const incomplete = await service.refresh(true)
    expect(requests.length).toBeGreaterThan(callsAfterFirst)
    expect(incomplete.rows.map(row => row.title)).toContain('Before')
    expect(incomplete.rows.map(row => row.title)).not.toContain('After')
    expect(incomplete.refreshedAt).toBe(firstRefreshedAt)
    const contentError = incomplete.sourceErrors.find(error => error.source === '仓库内容')
    expect(contentError?.message).toContain('子 issue 数据不完整')

    const callsAfterIncomplete = requests.length
    now += 1
    const recovered = await service.refresh(false)
    expect(requests.length).toBeGreaterThan(callsAfterIncomplete)
    expect(recovered.rows.map(row => row.title)).toContain('After')
    expect(recovered.rows.map(row => row.title)).not.toContain('Before')
    expect(recovered.refreshedAt).not.toBe(firstRefreshedAt)
    expect(recovered.sourceErrors).toEqual([])
  })
})
