import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClaudeSession } from '../src/shared/claude-sessions.js'
import { claudeProjectDirectoryName, claudeTranscriptPath, readClaudeTranscript } from '../src/main/claude/transcript.js'

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000'
let directory = ''

function makeSession(cwd = 'C:\\work\\repo'): ClaudeSession {
  return {
    id: SESSION_ID,
    repo: 'octocat/hello',
    name: 'Hello',
    cwd,
    startedAt: '2026-10-13T01:00:00.000Z'
  }
}

function record(type: 'user' | 'assistant', content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type,
    uuid: type + '-uuid',
    timestamp: '2026-10-13T01:02:03.000Z',
    message: { content },
    ...extra
  })
}

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('Claude transcript reader', () => {
  it('matches Claude project folder sanitization for common worktree paths', () => {
    const first = makeSession('C:\\work\\repo')
    const second = makeSession('C:\\work\\repo-feature')
    const repositoryPath = makeSession('D:\\_projects\\skills\\daily-report-fixer')
    const worktreePath = makeSession('D:\\_projects\\platform\\arckeep\\.worktrees\\7-codex-claude-project-sessions')

    expect(claudeProjectDirectoryName(first.cwd)).toBe('C--work-repo')
    expect(claudeProjectDirectoryName(repositoryPath.cwd)).toBe('D---projects-skills-daily-report-fixer')
    expect(claudeProjectDirectoryName(worktreePath.cwd))
      .toBe('D---projects-platform-arckeep--worktrees-7-codex-claude-project-sessions')
    expect(claudeTranscriptPath('C:\\Users\\test\\.claude', first))
      .not.toBe(claudeTranscriptPath('C:\\Users\\test\\.claude', second))
    expect(claudeTranscriptPath('C:\\Users\\test\\.claude', first)).toContain(SESSION_ID + '.jsonl')
  })

  it('matches Claude truncation and hash rules for long project paths', () => {
    const session = makeSession('C:\\' + 'a'.repeat(203))
    expect(claudeProjectDirectoryName(session.cwd)).toBe('C--' + 'a'.repeat(197) + '-yvgthg')
  })

  it('extracts only user and assistant text, reports tool names, and ignores sidechains', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-transcript-'))
    const session = makeSession()
    const file = claudeTranscriptPath(directory, session)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, [
      record('user', 'What changed?'),
      record('assistant', [
        { type: 'text', text: 'The fix is ready.' },
        { type: 'tool_use', name: 'Read' },
        { type: 'tool_result', content: 'do not show tool payload' }
      ]),
      record('assistant', 'sidechain content', { isSidechain: true }),
      '{invalid json'
    ].join('\n') + '\n', 'utf8')

    const transcript = await readClaudeTranscript(session, directory)
    expect(transcript.session).toEqual(session)
    expect(transcript.messages).toEqual([
      { id: 'user-uuid', role: 'user', text: 'What changed?', at: '2026-10-13T01:02:03.000Z' },
      { id: 'assistant-uuid', role: 'assistant', text: 'The fix is ready.\n调用工具：Read', at: '2026-10-13T01:02:03.000Z' }
    ])
    expect(transcript.messages.some(item => item.text.includes('tool payload') || item.text.includes('sidechain'))).toBe(false)
    expect(transcript.updatedAt).not.toBeNull()
    expect(transcript.truncated).toBe(false)
  })

  it('bounds file reads and message output to the most recent transcript tail', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-transcript-limit-'))
    const session = makeSession()
    const file = claudeTranscriptPath(directory, session)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, 'x'.repeat(1024 * 1024) + '\n' + record('user', 'latest message') + '\n', 'utf8')

    const transcript = await readClaudeTranscript(session, directory)
    expect(transcript.truncated).toBe(true)
    expect(transcript.messages.map(item => item.text)).toEqual(['latest message'])
  })

  it('marks message-count and per-message text limits as truncated', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-transcript-message-limits-'))
    const session = makeSession()
    const file = claudeTranscriptPath(directory, session)
    mkdirSync(path.dirname(file), { recursive: true })
    const records = Array.from({ length: 121 }, (_, index) => record('user', 'message-' + index))
    records.push(record('assistant', 'x'.repeat(6001)))
    writeFileSync(file, records.join('\n') + '\n', 'utf8')

    const result = await readClaudeTranscript(session, directory)
    expect(result.messages).toHaveLength(120)
    expect(result.messages.at(-1)?.text).toHaveLength(6000)
    expect(result.truncated).toBe(true)
  })

  it('returns an empty transcript when Claude has not written the session file yet', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-transcript-empty-'))

    await expect(readClaudeTranscript(makeSession(), directory)).resolves.toMatchObject({
      messages: [], updatedAt: null, truncated: false
    })
  })
})
