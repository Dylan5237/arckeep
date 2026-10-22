// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeSession, ClaudeSessionTranscript } from '../src/shared/claude-sessions.js'
import type { ArckeepApi, IpcResult } from '../src/shared/types.js'

const FIRST = '123e4567-e89b-42d3-a456-426614174001'
const SECOND = '123e4567-e89b-42d3-a456-426614174002'
const REPO = 'octocat/hello'
let page: typeof import('../src/renderer/claude-sessions-page.js')
let disposePage: (() => void) | null = null

function makeSession(id: string, cwd: string, name = 'Hello'): ClaudeSession {
  return { id, repo: REPO, name, cwd, startedAt: id === SECOND ? '2026-10-13T02:00:00.000Z' : '2026-10-13T01:00:00.000Z' }
}

function transcript(session: ClaudeSession): ClaudeSessionTranscript {
  return {
    session,
    messages: [{ id: 'msg', role: 'assistant', text: 'Response for ' + session.cwd, at: '2026-10-13T02:01:00.000Z' }],
    updatedAt: '2026-10-13T02:01:00.000Z',
    truncated: false
  }
}

function ok<T>(data: T): IpcResult<T> { return { ok: true, data } }

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => { resolve = complete })
  return { promise, resolve }
}

afterEach(() => {
  disposePage?.()
  disposePage = null
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  Reflect.deleteProperty(document, 'hidden')
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('Claude sessions viewer', () => {
  it('shows multiple worktree paths under one project and loads only the selected transcript', async () => {
    vi.resetModules()
    page = await import('../src/renderer/claude-sessions-page.js')
    HTMLElement.prototype.scrollIntoView = vi.fn()
    const sessions = [
      makeSession(SECOND, 'C:\\work\\hello-feature'),
      makeSession(FIRST, 'C:\\work\\hello-main')
    ]
    const readClaudeSession = vi.fn(async (id: string) => ok(transcript(sessions.find(item => item.id === id)!)))
    const api = {
      listClaudeSessions: vi.fn(async () => ok(sessions)),
      readClaudeSession,
      startClaudeSession: vi.fn(async (_repo: string, _name: string, id?: string) => ok(sessions.find(item => item.id === id) ?? sessions[0])),
      chooseClaudeWorkspace: vi.fn(async () => ok({ repo: REPO, name: 'Hello', path: 'C:\\work\\hello-main', updatedAt: '2026-10-13T00:00:00.000Z' }))
    } as unknown as ArckeepApi
    window.arckeep = api
    document.body.replaceChildren()
    const host = document.createElement('main')
    document.body.append(host)

    disposePage = await page.renderClaudeSessions(host, { repo: REPO })
    expect(host.querySelectorAll('.claude-project-group')).toHaveLength(1)
    expect(host.querySelectorAll('.claude-session-card')).toHaveLength(2)
    expect(host.textContent).toContain('C:\\work\\hello-feature')
    expect(host.textContent).toContain('C:\\work\\hello-main')
    expect(readClaudeSession).toHaveBeenCalledWith(SECOND)

    host.querySelectorAll<HTMLButtonElement>('.claude-session-select')[1].click()
    await settle()
    expect(readClaudeSession).toHaveBeenLastCalledWith(FIRST)
    expect(host.querySelector('.claude-transcript')?.textContent).toContain('Response for C:\\work\\hello-main')

    host.querySelectorAll<HTMLButtonElement>('.claude-session-card .tiny')[0].click()
    await settle()
    expect(api.startClaudeSession).toHaveBeenCalledWith(REPO, 'Hello', SECOND)
    disposePage()
    disposePage = null
  })

  it('renders repository and transcript content as text instead of interpreting HTML', async () => {
    vi.resetModules()
    page = await import('../src/renderer/claude-sessions-page.js')
    HTMLElement.prototype.scrollIntoView = vi.fn()
    const session = makeSession(FIRST, 'C:\\work\\hello', '<img src=x onerror=alert(1)>')
    window.arckeep = {
      listClaudeSessions: async () => ok([session]),
      readClaudeSession: async () => ok({ ...transcript(session), messages: [
        { id: 'msg', role: 'assistant', text: '<script>not code</script>', at: null }
      ] }),
      startClaudeSession: async () => ok(session),
      chooseClaudeWorkspace: async () => ok({ repo: REPO, name: session.name, path: session.cwd, updatedAt: session.startedAt })
    } as unknown as ArckeepApi
    document.body.replaceChildren()
    const host = document.createElement('main')
    document.body.append(host)

    disposePage = await page.renderClaudeSessions(host, {})
    expect(host.querySelector('img, script')).toBeNull()
    expect(host.querySelector('.claude-transcript')?.textContent).toContain('<script>not code</script>')
  })

  it('preserves transcript and list nodes when polling returns the same session snapshot', async () => {
    vi.resetModules()
    page = await import('../src/renderer/claude-sessions-page.js')
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    const session = makeSession(FIRST, 'C:\\work\\hello')
    const listClaudeSessions = vi.fn(async () => ok([session]))
    const readClaudeSession = vi.fn(async () => ok(transcript(session)))
    window.arckeep = {
      listClaudeSessions,
      readClaudeSession,
      startClaudeSession: async () => ok(session),
      chooseClaudeWorkspace: async () => ok({ repo: REPO, name: 'Hello', path: session.cwd, updatedAt: session.startedAt })
    } as unknown as ArckeepApi
    document.body.replaceChildren()
    const host = document.createElement('main')
    document.body.append(host)

    disposePage = await page.renderClaudeSessions(host, { repo: REPO })
    const originalMessage = host.querySelector('.claude-message')
    const originalCard = host.querySelector('.claude-session-card')
    const transcriptView = host.querySelector<HTMLElement>('.claude-transcript')!
    const listView = host.querySelector<HTMLElement>('.claude-session-list')!
    transcriptView.scrollTop = 60
    listView.scrollTop = 40
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()

    expect(host.querySelector('.claude-message')).toBe(originalMessage)
    expect(host.querySelector('.claude-session-card')).toBe(originalCard)
    expect(transcriptView.scrollTop).toBe(60)
    expect(listView.scrollTop).toBe(40)
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('keeps the reader position when new transcript messages arrive above the viewport', async () => {
    vi.resetModules()
    page = await import('../src/renderer/claude-sessions-page.js')
    const scrollIntoView = vi.fn()
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    const session = makeSession(FIRST, 'C:\\work\\hello')
    let latest = transcript(session)
    const listClaudeSessions = vi.fn(async () => ok([session]))
    const readClaudeSession = vi.fn(async () => ok(latest))
    window.arckeep = {
      listClaudeSessions,
      readClaudeSession,
      startClaudeSession: async () => ok(session),
      chooseClaudeWorkspace: async () => ok({ repo: REPO, name: 'Hello', path: session.cwd, updatedAt: session.startedAt })
    } as unknown as ArckeepApi
    document.body.replaceChildren()
    const host = document.createElement('main')
    document.body.append(host)

    disposePage = await page.renderClaudeSessions(host, { repo: REPO })
    const transcriptView = host.querySelector<HTMLElement>('.claude-transcript')!
    Object.defineProperty(transcriptView, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(transcriptView, 'clientHeight', { configurable: true, value: 300 })
    transcriptView.scrollTop = 100
    latest = {
      ...latest,
      updatedAt: '2026-10-13T02:02:00.000Z',
      messages: [...latest.messages, { id: 'new', role: 'assistant', text: 'A later message', at: '2026-10-13T02:02:00.000Z' }]
    }
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()

    expect(transcriptView.scrollTop).toBe(100)
    expect(host.textContent).toContain('A later message')
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })

  it('keeps a new session when an older in-flight refresh returns a stale project list', async () => {
    vi.resetModules()
    page = await import('../src/renderer/claude-sessions-page.js')
    HTMLElement.prototype.scrollIntoView = vi.fn()
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    const session = makeSession(FIRST, 'C:\\work\\hello')
    const stale = deferred<IpcResult<ClaudeSession[]>>()
    const listClaudeSessions = vi.fn()
      .mockResolvedValueOnce(ok([]))
      .mockReturnValueOnce(stale.promise)
    window.arckeep = {
      listClaudeSessions,
      readClaudeSession: async () => ok(transcript(session)),
      startClaudeSession: async () => ok(session),
      chooseClaudeWorkspace: async () => ok({ repo: REPO, name: 'Hello', path: session.cwd, updatedAt: session.startedAt })
    } as unknown as ArckeepApi
    document.body.replaceChildren()
    const host = document.createElement('main')
    document.body.append(host)
    disposePage = await page.renderClaudeSessions(host, { repo: REPO })

    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(listClaudeSessions).toHaveBeenCalledTimes(2)
    host.querySelector<HTMLButtonElement>('.claude-toolbar .primary')!.click()
    await settle()
    expect(host.querySelectorAll('.claude-session-card')).toHaveLength(1)

    stale.resolve(ok([]))
    await settle()
    expect(host.querySelectorAll('.claude-session-card')).toHaveLength(1)
    expect(host.querySelector('.claude-transcript')?.textContent).toContain('Response for C:\\work\\hello')
  })
})
