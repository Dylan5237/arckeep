import { describe, expect, it } from 'vitest'
import { createGhAuthCache, type GhAuthReader } from '../src/main/gh-auth-cache.js'
import type { GhLookup } from '../src/main/github-auth.js'

function countingReader(result: GhLookup): { read: GhAuthReader, calls: () => number } {
  let calls = 0
  return {
    read: async () => {
      calls += 1
      return result
    },
    calls: () => calls
  }
}

describe('gh auth cache', () => {
  it('reuses one lookup across concurrent and later reads', async () => {
    let now = 0
    const reader = countingReader({ ok: true, token: 'ghp_cached' })
    const cache = createGhAuthCache({ read: reader.read, now: () => now, successTtlMs: 100 })
    const [first, second] = await Promise.all([cache.read(), cache.read()])
    expect(first).toEqual({ ok: true, token: 'ghp_cached' })
    expect(second).toEqual(first)
    now = 99
    expect(await cache.read()).toEqual({ ok: true, token: 'ghp_cached' })
    expect(reader.calls()).toBe(1)
  })

  it('runs gh again after the success TTL lapses', async () => {
    let now = 0
    const reader = countingReader({ ok: true, token: 'ghp_cached' })
    const cache = createGhAuthCache({ read: reader.read, now: () => now, successTtlMs: 100 })
    await cache.read()
    now = 100
    await cache.read()
    expect(reader.calls()).toBe(2)
  })

  it('retries a failed lookup after the shorter failure TTL', async () => {
    let now = 0
    const reader = countingReader({ ok: false, reason: 'not-logged-in' })
    const cache = createGhAuthCache({
      read: reader.read,
      now: () => now,
      successTtlMs: 100,
      failureTtlMs: 20
    })
    await cache.read()
    now = 19
    await cache.read()
    expect(reader.calls()).toBe(1)
    now = 20
    await cache.read()
    expect(reader.calls()).toBe(2)
  })

  it('does not cache a rejection', async () => {
    let calls = 0
    const cache = createGhAuthCache({
      read: async () => {
        calls += 1
        throw new Error('spawn failed')
      }
    })
    await expect(cache.read()).rejects.toThrow('spawn failed')
    await expect(cache.read()).rejects.toThrow('spawn failed')
    expect(calls).toBe(2)
  })

  it('invalidate forces the next read to spawn gh again', async () => {
    const reader = countingReader({ ok: true, token: 'ghp_cached' })
    const cache = createGhAuthCache({ read: reader.read })
    await cache.read()
    cache.invalidate()
    await cache.read()
    expect(reader.calls()).toBe(2)
  })

  it('passes the task context and log through to the reader', async () => {
    const seen: unknown[] = []
    const controller = new AbortController()
    const cache = createGhAuthCache({
      read: async (context, log) => {
        seen.push(context?.signal, typeof log)
        log?.('from reader')
        return { ok: true, token: 'ghp_cached' }
      }
    })
    const logs: string[] = []
    await cache.read({ signal: controller.signal }, message => logs.push(message))
    expect(seen).toEqual([controller.signal, 'function'])
    expect(logs).toEqual(['from reader'])
  })
})
