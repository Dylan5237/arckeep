import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeSessionStore } from '../src/main/claude/session-store.js'
import { ClaudeSessionService } from '../src/main/claude/service.js'

const FIRST = '123e4567-e89b-42d3-a456-426614174001'
const SECOND = '123e4567-e89b-42d3-a456-426614174002'
const REPO = 'octocat/hello'
const otherRepo = 'octocat/other'
let directory = ''

function makeService(options: {
  chooseDirectory?: (repo: string, name: string) => Promise<string | null>
  activate?: (input: { repo: string, cwd: string, sessionId: string }) => Promise<boolean>
  launch?: (input: { repo: string, cwd: string, sessionId: string, resume: boolean }) => Promise<void>
  linkedDirectories?: (repo: string) => readonly string[]
  verifyDirectory?: (path: string, repo: string) => Promise<string>
  ids?: string[]
  now?: () => number
} = {}) {
  let nextId = 0
  const ids = options.ids ?? [FIRST, SECOND]
  const store = new ClaudeSessionStore({
    file: path.join(directory, 'claude-sessions.json'),
    id: () => ids[nextId++] ?? '123e4567-e89b-42d3-a456-426614174099'
  })
  const service = new ClaudeSessionService({
    store,
    chooseDirectory: options.chooseDirectory ?? (async () => 'C:\\work\\hello'),
    linkedDirectories: options.linkedDirectories ?? (() => []),
    activate: options.activate,
    launch: options.launch ?? (async () => {}),
    verifyDirectory: options.verifyDirectory ?? (async value => path.win32.resolve(value)),
    configDirectory: path.join(directory, '.claude'),
    now: options.now
  })
  return { store, service }
}

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
  vi.restoreAllMocks()
})

describe('Claude session service', () => {
  it('reuses and activates an open terminal for the same repository directory', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-service-'))
    let now = 1000
    const launch = vi.fn(async () => {})
    const activate = vi.fn(async () => true)
    const { service, store } = makeService({ launch, activate, now: () => now })

    const first = await service.start(REPO, 'Hello')
    now += 10_001
    const second = await service.start(REPO, 'Hello')

    expect(second).toEqual(first)
    expect(activate).toHaveBeenCalledWith({ repo: REPO, cwd: 'C:\\work\\hello', sessionId: FIRST })
    expect(launch).toHaveBeenCalledTimes(1)
    expect(store.list(REPO)).toEqual([first])
  })

  it('coalesces project clicks during the terminal startup window even before Windows exposes its title', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-window-grace-'))
    let now = 1000
    const activate = vi.fn(async () => false)
    const launch = vi.fn(async () => {})
    const { service, store } = makeService({ activate, launch, now: () => now })
    const first = await service.start(REPO, 'Hello')
    const second = await service.start(REPO, 'Hello')

    expect(second).toEqual(first)
    expect(store.list(REPO)).toHaveLength(1)
    expect(launch).toHaveBeenCalledOnce()

    // A closed terminal can start a new session after the short startup grace expires.
    now += 10_001
    await service.start(REPO, 'Hello')
    expect(store.list(REPO)).toHaveLength(2)
    expect(launch).toHaveBeenCalledTimes(2)
  })

  it('keeps sessions from different worktree paths separate and only reuses the selected path', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-worktrees-'))
    const paths = ['C:\\work\\hello-main', 'C:\\work\\hello-feature']
    const chooseDirectory = vi.fn(async () => paths.shift() ?? null)
    const activate = vi.fn(async () => false)
    const launch = vi.fn(async () => {})
    const { service, store } = makeService({ chooseDirectory, activate, launch })

    const main = await service.start(REPO, 'Hello')
    await service.chooseWorkspace(REPO, 'Hello')
    const feature = await service.start(REPO, 'Hello')

    expect(main.id).toBe(FIRST)
    expect(feature.id).toBe(SECOND)
    expect(store.list(REPO).map(item => item.cwd)).toEqual([
      'C:\\work\\hello-feature', 'C:\\work\\hello-main'
    ])
    expect(launch).toHaveBeenCalledTimes(2)
    expect(activate).not.toHaveBeenCalled()
  })

  it('coalesces simultaneous clicks so they cannot create duplicate terminal sessions', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-double-click-'))
    let release!: (value: string | null) => void
    const selection = new Promise<string | null>(resolve => { release = resolve })
    const chooseDirectory = vi.fn(() => selection)
    const launch = vi.fn(async () => {})
    const { service, store } = makeService({ chooseDirectory, launch })

    const first = service.start(REPO, 'Hello')
    const second = service.start(REPO, 'Hello')
    release('C:\\work\\hello')
    const [one, two] = await Promise.all([first, second])

    expect(two).toEqual(one)
    expect(chooseDirectory).toHaveBeenCalledOnce()
    expect(launch).toHaveBeenCalledOnce()
    expect(store.list(REPO)).toHaveLength(1)
  })

  it('serializes project start and explicit resume requests without substituting a different session id', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-cross-entry-race-'))
    let releaseActivation!: (value: boolean) => void
    const activation = new Promise<boolean>(resolve => { releaseActivation = resolve })
    const activate = vi.fn(() => activation)
    const launch = vi.fn(async () => {})
    const { service, store } = makeService({ activate, launch })
    const oldSession = store.createSession({ repo: REPO, name: 'Hello', cwd: 'C:\\work\\hello' })

    const projectStart = service.start(REPO, 'Hello')
    await vi.waitFor(() => expect(activate).toHaveBeenCalledOnce())
    const explicitResume = service.start(REPO, 'Hello', oldSession.id)
    releaseActivation(false)

    const [started, resumed] = await Promise.allSettled([projectStart, explicitResume])
    expect(started.status).toBe('fulfilled')
    if (started.status !== 'fulfilled') throw started.reason
    expect(resumed.status).toBe('rejected')
    if (resumed.status !== 'rejected') throw new Error('expected an explicit resume conflict')
    expect(resumed.reason).toBeInstanceOf(Error)
    expect((resumed.reason as Error).message).toContain('已有另一个 Claude 会话窗口')
    expect(launch).toHaveBeenCalledOnce()
    expect(launch).toHaveBeenCalledWith({ repo: REPO, cwd: 'C:\\work\\hello', sessionId: SECOND, resume: false })
    expect(store.list(REPO)).toHaveLength(2)
  })

  it('rejects an explicit resume when another session is active in the same worktree', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-resume-conflict-'))
    const activate = vi.fn(async ({ sessionId }: { sessionId: string }) => sessionId === SECOND)
    const launch = vi.fn(async () => {})
    const { service, store } = makeService({ activate, launch })
    const requested = store.createSession({ repo: REPO, name: 'Hello', cwd: 'C:\\work\\hello' })
    store.createSession({ repo: REPO, name: 'Hello', cwd: 'C:\\work\\hello' })

    await expect(service.start(REPO, 'Hello', requested.id)).rejects.toThrow('已有另一个 Claude 会话窗口')
    expect(activate).toHaveBeenCalledTimes(2)
    expect(launch).not.toHaveBeenCalled()
  })

  it('resumes only a session belonging to the requested repo and focuses it when its terminal is open', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-resume-'))
    const launch = vi.fn(async () => {})
    const activate = vi.fn(async () => true)
    const { service, store } = makeService({ launch, activate })
    const session = store.createSession({ repo: REPO, name: 'Hello', cwd: 'C:\\work\\hello' })

    await expect(service.start(otherRepo, 'Other', session.id)).rejects.toThrow('找不到该项目的 Claude 会话')
    await expect(service.start(REPO, 'Hello', session.id)).resolves.toEqual(session)
    expect(activate).toHaveBeenCalledOnce()
    expect(launch).not.toHaveBeenCalled()
  })

  it('does not launch a resumed session twice while its terminal title is appearing', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-resume-grace-'))
    let now = 1000
    const launch = vi.fn(async () => {})
    const activate = vi.fn(async () => false)
    const { service, store } = makeService({ launch, activate, now: () => now })
    const session = store.createSession({ repo: REPO, name: 'Hello', cwd: 'C:\\work\\hello' })

    await service.start(REPO, 'Hello', session.id)
    await service.start(REPO, 'Hello', session.id)
    expect(launch).toHaveBeenCalledOnce()

    now += 10_001
    await service.start(REPO, 'Hello', session.id)
    expect(launch).toHaveBeenCalledTimes(2)
  })

  it('removes a newly indexed session if launching its external terminal fails', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-launch-failure-'))
    const { service, store } = makeService({ launch: async () => { throw new Error('spawn failed') } })

    await expect(service.start(REPO, 'Hello')).rejects.toThrow('spawn failed')
    expect(store.list(REPO)).toEqual([])
  })
})
