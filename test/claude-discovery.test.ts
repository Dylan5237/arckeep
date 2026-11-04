import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeSessionStore } from '../src/main/claude/session-store.js'
import { ClaudeSessionService } from '../src/main/claude/service.js'
import { discoverLocalClaudeSessions } from '../src/main/claude/discovery.js'
import { clearProjectIdentityCache } from '../src/main/claude/project-map.js'

const LOCAL_ID = '123e4567-e89b-42d3-a456-426614174010'
let directory = ''

function writeSession(configDirectory: string, id: string, cwd: string, userText: string, extra: {
  includeCwd?: boolean
  assistantText?: string
} = {}): string {
  const projectDir = path.join(configDirectory, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(projectDir, { recursive: true })
  const file = path.join(projectDir, id + '.jsonl')
  const lines = [
    JSON.stringify({
      type: 'user',
      sessionId: id,
      ...(extra.includeCwd === false ? {} : { cwd }),
      timestamp: '2026-11-01T09:00:00.000Z',
      uuid: 'u-1',
      message: { role: 'user', content: userText }
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId: id,
      timestamp: '2026-11-01T09:01:00.000Z',
      uuid: 'a-1',
      message: { role: 'assistant', content: [{ type: 'text', text: extra.assistantText ?? '收到，开始处理。' }] }
    })
  ]
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}

function makeService(options: {
  configDirectory: string
  storeFile: string
  launch?: (input: { repo: string, cwd: string, sessionId: string, resume: boolean }) => Promise<void>
}) {
  const store = new ClaudeSessionStore({ file: options.storeFile })
  const launch = options.launch ?? vi.fn(async () => {})
  const service = new ClaudeSessionService({
    store,
    chooseDirectory: async () => null,
    linkedDirectories: () => [],
    verifyDirectory: async value => path.resolve(value),
    launch,
    configDirectory: options.configDirectory,
    now: () => Date.parse('2026-11-04T10:00:00.000Z')
  })
  return { service, store, launch }
}

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
  clearProjectIdentityCache()
  vi.restoreAllMocks()
})

describe('local Claude session discovery', () => {
  it('discovers sessions Arckeep did not start, including their first user message', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-discovery-'))
    const config = path.join(directory, '.claude')
    const cwd = path.join(directory, 'work', 'hello')
    mkdirSync(cwd, { recursive: true })
    writeSession(config, LOCAL_ID, cwd, '请帮我修一下登录页')
    writeSession(config, '123e4567-e89b-42d3-a456-426614174012', cwd, '没有 cwd 的坏记录', { includeCwd: false })
    const sessions = await discoverLocalClaudeSessions({ configDirectory: config })
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      id: LOCAL_ID,
      cwd: path.resolve(cwd),
      title: '请帮我修一下登录页',
      startedAt: '2026-11-01T09:00:00.000Z'
    })
  })

  it('merges store sessions with local history and groups local work under a linked project', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-merge-'))
    const config = path.join(directory, '.claude')
    const cwd = path.join(directory, 'work', 'hello')
    mkdirSync(cwd, { recursive: true })
    writeSession(config, LOCAL_ID, cwd, '本地已有的会话')
    const storeFile = path.join(directory, 'claude-sessions.json')
    const { service, store } = makeService({ configDirectory: config, storeFile })
    store.setWorkspace({ repo: 'octocat/hello', name: 'Hello', path: cwd })
    store.createSession({ repo: 'octocat/hello', name: 'Hello', cwd })

    const sessions = await service.list()
    expect(sessions).toHaveLength(2)
    const local = sessions.find(item => item.id === LOCAL_ID)!
    expect(local.source).toBe('local')
    expect(local.repo).toBe('octocat/hello')
    expect(local.name).toBe('Hello')
    expect(local.title).toBe('本地已有的会话')
    const stored = sessions.find(item => item.source === 'arckeep')
    expect(stored?.source).toBe('arckeep')
    expect((await service.list('octocat/hello'))).toHaveLength(2)
    expect((await service.list('local/other'))).toHaveLength(0)
  })

  it('reads a local transcript directly from Claude history', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-read-'))
    const config = path.join(directory, '.claude')
    const cwd = path.join(directory, 'work', 'hello')
    mkdirSync(cwd, { recursive: true })
    writeSession(config, LOCAL_ID, cwd, '读这条历史', { assistantText: '历史里的回答' })
    const { service } = makeService({ configDirectory: config, storeFile: path.join(directory, 'claude-sessions.json') })
    const transcript = await service.read(LOCAL_ID)
    expect(transcript.session.id).toBe(LOCAL_ID)
    expect(transcript.session.source).toBe('local')
    expect(transcript.messages.map(item => item.text)).toEqual(['读这条历史', '历史里的回答'])
    expect(transcript.updatedAt).toBeTruthy()
  })

  it('resumes a local session in its original directory without adding a store record', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-resume-'))
    const config = path.join(directory, '.claude')
    const cwd = path.join(directory, 'work', 'hello')
    mkdirSync(cwd, { recursive: true })
    writeSession(config, LOCAL_ID, cwd, '恢复我')
    const launch = vi.fn(async () => {})
    const { service, store } = makeService({ configDirectory: config, storeFile: path.join(directory, 'claude-sessions.json'), launch })
    const resumed = await service.resume(LOCAL_ID)
    expect(resumed.id).toBe(LOCAL_ID)
    expect(launch).toHaveBeenCalledWith({ repo: 'local/hello', cwd: path.resolve(cwd), sessionId: LOCAL_ID, resume: true })
    expect(store.list()).toEqual([])
  })

  it('maps a local checkout to its GitHub origin when the directory is a real repository', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-origin-'))
    const config = path.join(directory, '.claude')
    const cwd = path.join(directory, 'work', 'hello')
    mkdirSync(cwd, { recursive: true })
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' })
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Octocat/Hello.git'], { cwd, stdio: 'ignore' })
    writeSession(config, LOCAL_ID, cwd, '带 origin 的会话')
    const { service } = makeService({ configDirectory: config, storeFile: path.join(directory, 'claude-sessions.json') })
    const sessions = await service.list()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].repo).toBe('Octocat/Hello')
    expect(sessions[0].name).toBe('Hello')
  })
})
