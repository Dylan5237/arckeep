import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureDraftPath } from '../src/main/paths.js'
import { flushCaptureOnShutdown } from '../src/main/capture-shutdown.js'
import { loadCaptureDraft, saveCaptureDraft } from '../src/main/todos/draft.js'

describe('flushCaptureOnShutdown', () => {
  let directory: string
  let file: string

  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-capture-shutdown-'))
    file = captureDraftPath(directory)
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  it.each([
    ['idea', { kind: 'idea', text: 'later idea', repo: 'owner/repo', waiting: true }, { kind: 'idea', text: 'later idea', repo: 'owner/repo', waiting: false }],
    ['todo', { kind: 'todo', text: 'unfinished todo', repo: 'owner/repo', waiting: true }, { text: 'unfinished todo', repo: 'owner/repo', waiting: true }]
  ])('saves a renderer %s draft to a real temporary file', async (_kind, snapshot, expected) => {
    await expect(flushCaptureOnShutdown({
      file,
      readDraft: async () => snapshot,
      isCommitted: () => false
    })).resolves.toBe('saved')
    expect(loadCaptureDraft(file)).toEqual(expected)
  })

  it('clears a previously committed draft without rereading or saving it again', async () => {
    saveCaptureDraft(file, { text: 'already committed once', repo: '', waiting: false })
    const readDraft = vi.fn(async () => ({ text: 'duplicate', repo: '', waiting: false }))

    await expect(flushCaptureOnShutdown({ file, readDraft, isCommitted: () => true })).resolves.toBe('cleared')
    expect(readDraft).not.toHaveBeenCalled()
    expect(existsSync(file)).toBe(false)
  })

  it('clears stored data when the capture is committed while the renderer read is pending', async () => {
    saveCaptureDraft(file, { text: 'older local draft', repo: '', waiting: false })
    let committed = false
    let resolveDraft!: (snapshot: unknown) => void
    const readDraft = () => new Promise<unknown>(resolve => { resolveDraft = resolve })
    const pending = flushCaptureOnShutdown({ file, readDraft, isCommitted: () => committed, timeoutMs: 500 })
    await Promise.resolve()
    committed = true
    resolveDraft({ kind: 'idea', text: 'late copy of saved idea', repo: '', waiting: false })

    await expect(pending).resolves.toBe('cleared')
    expect(existsSync(file)).toBe(false)
  })

  it('preserves the existing draft when renderer reading hangs or throws', async () => {
    const original = { kind: 'idea', text: 'keep this idea', repo: 'owner/repo', waiting: false }
    saveCaptureDraft(file, original)
    const before = readFileSync(file, 'utf8')

    await expect(flushCaptureOnShutdown({
      file,
      readDraft: () => new Promise<unknown>(() => {}),
      isCommitted: () => false,
      timeoutMs: 10
    })).resolves.toBe('preserved')
    expect(readFileSync(file, 'utf8')).toBe(before)

    await expect(flushCaptureOnShutdown({
      file,
      readDraft: async () => { throw new Error('renderer closed') },
      isCommitted: () => false
    })).resolves.toBe('preserved')
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('ignores a renderer response that arrives after the shutdown read deadline', async () => {
    const original = { text: 'existing todo', repo: '', waiting: true }
    saveCaptureDraft(file, original)
    const before = readFileSync(file, 'utf8')
    let resolveDraft!: (snapshot: unknown) => void
    const pending = flushCaptureOnShutdown({
      file,
      readDraft: () => new Promise<unknown>(resolve => { resolveDraft = resolve }),
      isCommitted: () => false,
      timeoutMs: 10
    })

    await expect(pending).resolves.toBe('preserved')
    resolveDraft({ text: 'late stale snapshot', repo: 'late/repo', waiting: true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('reports persistence and removal failures instead of claiming the draft was preserved', async () => {
    mkdirSync(file)
    const options = { file, readDraft: async () => ({ text: 'unsaved', repo: '', waiting: false }) }
    await expect(flushCaptureOnShutdown({ ...options, isCommitted: () => false })).rejects.toBeInstanceOf(Error)
    await expect(flushCaptureOnShutdown({ ...options, isCommitted: () => true })).rejects.toBeInstanceOf(Error)
  })
})
