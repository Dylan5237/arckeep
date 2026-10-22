import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ClaudeSessionStore } from '../src/main/claude/session-store.js'

const ONE = '123e4567-e89b-42d3-a456-426614174001'
const TWO = '123e4567-e89b-42d3-a456-426614174002'
let directory = ''

function filePath(): string {
  directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-store-'))
  return path.join(directory, 'claude-sessions.json')
}

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('Claude session store', () => {
  it('persists one workspace per repository and returns sessions newest first', () => {
    const file = filePath()
    let idIndex = 0
    let clock = new Date('2026-10-13T01:00:00.000Z')
    const ids = [ONE, TWO]
    const store = new ClaudeSessionStore({ file, id: () => ids[idIndex++], now: () => clock })
    store.setWorkspace({ repo: 'octocat/hello', name: 'Hello', path: 'C:\\work\\hello' })
    clock = new Date('2026-10-13T02:00:00.000Z')
    store.createSession({ repo: 'octocat/hello', name: 'Hello', cwd: 'C:\\work\\hello' })
    clock = new Date('2026-10-13T03:00:00.000Z')
    store.createSession({ repo: 'octocat/hello', name: 'Hello', cwd: 'C:\\work\\hello-feature' })
    store.setWorkspace({ repo: 'OCTOCAT/HELLO', name: 'Hello', path: 'C:\\work\\hello-feature' })

    expect(store.workspace('octocat/hello')).toMatchObject({ path: 'C:\\work\\hello-feature' })
    expect(store.list('octocat/hello').map(item => item.id)).toEqual([TWO, ONE])
    expect(JSON.parse(readFileSync(file, 'utf8')).sessions).toHaveLength(2)
    expect(new ClaudeSessionStore({ file }).list('OCTOCAT/HELLO')).toHaveLength(2)
  })

  it.each([
    ['truncated JSON', '{"version":1,"workspaces":[],"sessions":['],
    ['unknown version', '{"version":2,"workspaces":[],"sessions":[]}'],
    ['duplicate session IDs', JSON.stringify({ version: 1, workspaces: [], sessions: [
      { id: ONE, repo: 'octocat/hello', name: 'Hello', cwd: 'C:\\work', startedAt: '2026-10-13T00:00:00.000Z' },
      { id: ONE, repo: 'octocat/hello', name: 'Hello', cwd: 'C:\\work', startedAt: '2026-10-13T00:00:00.000Z' }
    ] })]
  ])('preserves a %s file and rejects reads and writes', (_label, contents) => {
    const file = filePath()
    writeFileSync(file, contents, 'utf8')
    const store = new ClaudeSessionStore({ file, id: () => TWO })

    expect(() => store.list()).toThrow('原文件已保留')
    expect(() => store.createSession({ repo: 'octocat/hello', name: 'Hello', cwd: 'C:\\work' }))
      .toThrow('原文件已保留')
    expect(readFileSync(file, 'utf8')).toBe(contents)
  })

  it('refuses to overwrite an index changed by another process', () => {
    const file = filePath()
    const store = new ClaudeSessionStore({ file, id: () => ONE })
    writeFileSync(file, '{"version":1,"workspaces":[],"sessions":[]}\n', 'utf8')

    expect(() => store.setWorkspace({ repo: 'octocat/hello', name: 'Hello', path: 'C:\\work' }))
      .toThrow('外部修改')
    expect(readFileSync(file, 'utf8')).toBe('{"version":1,"workspaces":[],"sessions":[]}\n')
  })
})
