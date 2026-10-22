import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { readHttpResponse } from '../src/github/http-request.js'
import { runManagedCommand } from '../src/main/managed-command.js'
import { SettingsService } from '../src/main/settings-service.js'
import type { HotkeyRegistrar } from '../src/main/hotkey.js'
import type { SecretBox } from '../src/main/token-store.js'
import { TaskScope } from '../src/shared/task-scope.js'
import { loadUnpushedBranches } from '../src/waiting/local-git.js'
import { resolveGithubAuth } from '../src/main/github-auth.js'
import { loadStatusDocs } from '../src/waiting/status-docs.js'

class NoopHotkeys implements HotkeyRegistrar {
  register(): boolean { return true }
  isRegistered(): boolean { return true }
  unregister(): void {}
}

const secretBox: SecretBox = {
  encrypt: value => value,
  decrypt: value => value
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      readFileSync(file, 'utf8')
      return
    } catch {
      await delay(10)
    }
  }
  throw new Error('测试子进程未写入启动标记')
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

describe('managed lifecycle I/O', () => {
  it('terminates and waits for a real isolated child process tree when its task scope closes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'arckeep-lifecycle-'))
    const pidFile = path.join(dir, 'grandchild.pid')
    const script = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
      'setInterval(() => {}, 1000)'
    ].join(';')
    const scope = new TaskScope()
    try {
      const task = scope.run(signal => runManagedCommand(process.execPath, ['-e', script], {
        signal,
        tasks: scope,
        timeoutMs: 10_000,
        label: '测试子进程树'
      }), '真实子进程测试')
      await waitForFile(pidFile)
      const grandchildPid = Number(readFileSync(pidFile, 'utf8'))
      expect(Number.isInteger(grandchildPid)).toBe(true)
      expect(processExists(grandchildPid)).toBe(true)

      scope.close()
      await expect(task).rejects.toMatchObject({ name: 'AbortError' })
      await expect(scope.drain()).resolves.toBeUndefined()
      expect(scope.pendingCount).toBe(0)
      expect(scope.resourceCount).toBe(0)

      const deadline = Date.now() + 3000
      while (processExists(grandchildPid) && Date.now() < deadline) await delay(20)
      expect(processExists(grandchildPid)).toBe(false)
    } finally {
      scope.close()
      await scope.drain().catch(() => {})
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('bounds a fetch adapter that ignores cancellation and aborts its underlying signal on timeout', async () => {
    let requestSignal: AbortSignal | null = null
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestSignal = init?.signal ?? null
      return await new Promise<Response>(() => {})
    }

    await expect(readHttpResponse('https://unused.invalid', {}, fetchImpl, { timeoutMs: 20 }))
      .rejects.toMatchObject({ name: 'TimeoutError' })
    expect(requestSignal?.aborted).toBe(true)
  })

  it('uses one deadline for response body reading and passes external AbortError through unchanged', async () => {
    let bodySignal: AbortSignal | null = null
    const response = new Response('body')
    Object.defineProperty(response, 'text', { value: () => new Promise<string>(() => {}) })
    const fetchWithHungBody: typeof fetch = async (_input, init) => {
      bodySignal = init?.signal ?? null
      return response
    }

    await expect(readHttpResponse('https://unused.invalid', {}, fetchWithHungBody, { timeoutMs: 20 }))
      .rejects.toMatchObject({ name: 'TimeoutError' })
    expect(bodySignal?.aborted).toBe(true)

    const controller = new AbortController()
    const reason = new Error('test cancellation')
    reason.name = 'AbortError'
    const hungFetch: typeof fetch = async () => await new Promise<Response>(() => {})
    const pending = readHttpResponse('https://unused.invalid', {}, hungFetch, {
      signal: controller.signal,
      timeoutMs: 5000
    })
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
  })

  it('does not schedule another Git command after cancellation between commands', async () => {
    const controller = new AbortController()
    const reason = new Error('stop between git commands')
    reason.name = 'AbortError'
    const calls: string[][] = []
    const git = async (args: readonly string[]) => {
      calls.push([...args])
      controller.abort(reason)
      return { code: 0, stdout: 'true\n', stderr: '' }
    }

    await expect(loadUnpushedBranches(['D:\\repo'], git, { signal: controller.signal })).rejects.toBe(reason)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['-C', 'D:\\repo', 'rev-parse', '--is-inside-work-tree'])
  })

  it('propagates cancellation from optional status-document commit lookups without reading the next rule', async () => {
    const reason = new Error('cancel optional commit lookup')
    reason.name = 'AbortError'
    const urls: string[] = []
    const fetchImpl: typeof fetch = async input => {
      const url = String(input)
      urls.push(url)
      if (urls.length === 1) return new Response('status text', { status: 200 })
      throw reason
    }

    await expect(loadStatusDocs({
      token: 'test-only-token',
      rules: [
        { repo: 'owner/repo', target: 'README.md', pattern: 'status' },
        { repo: 'owner/repo', target: 'NEXT.md', pattern: 'next' }
      ],
      fetchImpl
    })).rejects.toBe(reason)
    expect(urls).toHaveLength(2)
    expect(urls[0]).toContain('/contents/README.md')
    expect(urls[1]).toContain('/commits?path=README.md')
  })

  it('does not fall back to a saved PAT after GitHub CLI lookup is cancelled', async () => {
    const controller = new AbortController()
    const reason = new Error('cancel auth')
    reason.name = 'AbortError'
    let patRead = false

    await expect(resolveGithubAuth({
      readGh: async () => {
        controller.abort(reason)
        return { ok: false, reason: 'not-logged-in' }
      },
      readPat: () => { patRead = true; return 'saved' },
      patSaved: true,
      signal: controller.signal
    })).rejects.toBe(reason)
    expect(patRead).toBe(false)
  })

  it('does not start SettingsService async reads or writes after its task scope closes', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'arckeep-settings-lifecycle-'))
    const scope = new TaskScope()
    const readGh = vi.fn(async () => ({ ok: false as const, reason: 'not-installed' as const }))
    const service = new SettingsService({
      file: path.join(dir, 'settings.json'),
      secretBox,
      registrar: new NoopHotkeys(),
      onHotkey: () => {},
      readGh,
      tasks: scope
    })
    scope.close()
    try {
      await expect(service.getState()).rejects.toMatchObject({ name: 'AbortError' })
      await expect(service.testConnection()).rejects.toMatchObject({ name: 'AbortError' })
      expect(() => service.setRepos(['Dylan5237/arckeep'])).toThrowError(/取消/)
      expect(readGh).not.toHaveBeenCalled()
      expect(scope.pendingCount).toBe(0)
    } finally {
      await scope.drain()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
