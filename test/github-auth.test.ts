import { describe, expect, it } from 'vitest'
import {
  classifyGithubFailure,
  isGithubNetworkError,
  readGhAuthToken,
  resolveGithubAuth,
  testGithubConnection,
  toPublicGithubAuth,
  type CommandRunner
} from '../src/main/github-auth.js'
import { githubSourceLabel } from '../src/shared/types.js'

const TOKEN = 'ghp_fromGhCliToken999'

function runner(result: { code: number, stdout: string, stderr?: string } | { error: NodeJS.ErrnoException }): CommandRunner {
  return async () => {
    if ('error' in result) throw result.error
    return { code: result.code, stdout: result.stdout, stderr: result.stderr ?? '' }
  }
}

describe('readGhAuthToken', () => {
  it('returns a trimmed token without logging it', async () => {
    const logs: string[] = []
    const result = await readGhAuthToken(runner({ code: 0, stdout: `${TOKEN}\n` }), message => logs.push(message))
    expect(result).toEqual({ ok: true, token: TOKEN })
    expect(logs.join('\n').includes(TOKEN.slice(0, 8))).toBe(false)
  })

  it('falls back when gh is missing or not logged in, and does not echo stdout', async () => {
    const logs: string[] = []
    const missing = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
    await expect(readGhAuthToken(runner({ error: missing }), message => logs.push(message)))
      .resolves.toEqual({ ok: false, reason: 'not-installed' })
    await expect(readGhAuthToken(
      runner({ code: 1, stdout: TOKEN, stderr: TOKEN }),
      message => logs.push(message)
    )).resolves.toEqual({ ok: false, reason: 'not-logged-in' })
    expect(logs.join('\n').includes(TOKEN.slice(0, 8))).toBe(false)
    expect(logs.every(line => line.startsWith('gh auth token unavailable:'))).toBe(true)
  })
})

describe('resolveGithubAuth', () => {
  it('prefers gh CLI and otherwise uses a saved PAT', async () => {
    const fromGh = await resolveGithubAuth({
      readGh: async () => ({ ok: true, token: TOKEN }),
      readPat: () => 'ghp_savedPatToken00000',
      patSaved: true
    })
    expect(fromGh.source).toBe('gh-cli')
    expect(fromGh.token).toBe(TOKEN)
    expect(toPublicGithubAuth(fromGh)).toEqual({
      source: 'gh-cli',
      sourceLabel: githubSourceLabel('gh-cli'),
      patSaved: true
    })
    expect(githubSourceLabel('gh-cli')).toBe('来源：gh CLI')
    expect(JSON.stringify(toPublicGithubAuth(fromGh)).includes(TOKEN.slice(0, 8))).toBe(false)

    const fromPat = await resolveGithubAuth({
      readGh: async () => ({ ok: false, reason: 'not-installed' }),
      readPat: () => 'ghp_savedPatToken00000',
      patSaved: true
    })
    expect(fromPat).toMatchObject({ source: 'pat', token: 'ghp_savedPatToken00000' })

    const none = await resolveGithubAuth({
      readGh: async () => ({ ok: false, reason: 'not-logged-in' }),
      readPat: () => null,
      patSaved: false
    })
    expect(none).toEqual({ source: 'none', token: null, patSaved: false })
  })
})

describe('classifyGithubFailure', () => {
  it('separates invalid tokens, missing scopes, and unreachable networks', () => {
    const invalid = classifyGithubFailure({ status: 401 })
    const forbidden = classifyGithubFailure({ status: 403 })
    const missing = classifyGithubFailure({ status: 200, grantedScopes: 'read:user', acceptedScopes: 'repo, read:user' })
    const dns = classifyGithubFailure({ network: true })
    expect(invalid.kind).toBe('invalid-token')
    expect(forbidden.kind).toBe('insufficient-scope')
    expect(missing.kind).toBe('insufficient-scope')
    expect(dns.kind).toBe('network')
    for (const failure of [invalid, forbidden, missing, dns]) {
      expect(failure.message).toMatch(/。/)
      expect(failure.message).toMatch(/请/)
    }
    expect(isGithubNetworkError(Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' }))).toBe(true)
    expect(isGithubNetworkError(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))).toBe(true)
    expect(isGithubNetworkError(new Error('offline'))).toBe(true)
    expect(isGithubNetworkError(new Error('nope'))).toBe(false)
  })
})

describe('testGithubConnection', () => {
  it('returns the login and a clear error for a rejected token', async () => {
    const ok = await testGithubConnection({
      token: TOKEN,
      fetchImpl: async () => new Response(JSON.stringify({ login: 'Dylan5237' }), { status: 200 })
    })
    expect(ok).toEqual({ ok: true, login: 'Dylan5237' })

    const denied = await testGithubConnection({
      token: TOKEN,
      fetchImpl: async () => new Response('bad credentials ' + TOKEN, { status: 401 })
    })
    expect(denied.ok).toBe(false)
    if (!denied.ok) {
      expect(denied.error).toBe(classifyGithubFailure({ status: 401 }).message)
      expect(denied.error.includes(TOKEN.slice(0, 8))).toBe(false)
    }

    const offline = await testGithubConnection({
      token: TOKEN,
      fetchImpl: async () => { throw Object.assign(new Error(`network down ${TOKEN}`), { code: 'ENOTFOUND' }) }
    })
    expect(offline.ok).toBe(false)
    if (!offline.ok) {
      expect(offline.error).toBe(classifyGithubFailure({ network: true }).message)
      expect(offline.error.includes(TOKEN.slice(0, 8))).toBe(false)
    }
    expect(await testGithubConnection({ token: null })).toEqual({
      ok: false,
      error: '尚未配置 GitHub token'
    })
  })
})
