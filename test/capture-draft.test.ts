import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { captureDraftPath, userDataDir } from '../src/main/paths.js'
import { captureDraftOnEscape } from '../src/shared/todos/capture-draft.js'
import {
  clearCaptureDraft,
  loadCaptureDraft,
  saveCaptureDraft
} from '../src/main/todos/draft.js'

function tempFile(): string {
  return captureDraftPath(mkdtempSync(path.join(tmpdir(), 'arckeep-draft-')))
}

describe('capture draft', () => {
  it('round-trips text, repo tag, and 等我 across a fresh read', () => {
    const file = tempFile()
    saveCaptureDraft(file, { text: '把没写完的这半句留在', repo: 'example/demo', waiting: true })
    expect(loadCaptureDraft(file)).toEqual({
      text: '把没写完的这半句留在',
      repo: 'example/demo',
      waiting: true
    })
    expect(loadCaptureDraft(file).text.endsWith('留在')).toBe(true)
  })

  it('clears the file after a successful save and ignores a corrupt file', () => {
    const file = tempFile()
    saveCaptureDraft(file, { text: '暂时的', repo: '', waiting: false })
    expect(existsSync(file)).toBe(true)
    clearCaptureDraft(file)
    expect(existsSync(file)).toBe(false)
    expect(loadCaptureDraft(file)).toEqual({ text: '', repo: '', waiting: false })

    writeFileSync(file, '{not json', 'utf8')
    expect(loadCaptureDraft(file)).toEqual({ text: '', repo: '', waiting: false })
    expect(readFileSync(file, 'utf8')).toBe('{not json')
    saveCaptureDraft(file, { text: '', repo: '', waiting: false })
    expect(existsSync(file)).toBe(false)
  })

  it('discards the repo tag and 等我 when Esc is pressed with an empty input', () => {
    const file = tempFile()
    saveCaptureDraft(file, { text: '半句', repo: 'example/demo', waiting: true })
    const kept = captureDraftOnEscape({ text: '半句', repo: 'example/demo', waiting: true })
    saveCaptureDraft(file, kept)
    expect(loadCaptureDraft(file)).toEqual({
      text: '半句',
      repo: 'example/demo',
      waiting: true
    })

    const cleared = captureDraftOnEscape({ text: '', repo: 'example/demo', waiting: true })
    expect(cleared).toEqual({ text: '', repo: '', waiting: false })
    saveCaptureDraft(file, cleared)
    expect(existsSync(file)).toBe(false)
    expect(loadCaptureDraft(file)).toEqual({ text: '', repo: '', waiting: false })

    expect(captureDraftOnEscape({ text: '   ', repo: 'Dylan5237/arckeep', waiting: true }))
      .toEqual({ text: '', repo: '', waiting: false })
  })

  it('lives under the Arckeep userData directory', () => {
    const appData = 'C:\\Users\\Dylan\\AppData\\Roaming'
    expect(captureDraftPath(userDataDir(appData, path.win32.join), path.win32.join))
      .toBe('C:\\Users\\Dylan\\AppData\\Roaming\\Arckeep\\capture-draft.json')
  })

  it('restores the idea mode and multiline body beyond the todo limit', () => {
    const file = tempFile()
    const text = `第一行 #literal !等我\n${'想法'.repeat(400)}`
    saveCaptureDraft(file, { kind: 'idea', text, repo: 'example/demo', waiting: true })
    expect(loadCaptureDraft(file)).toEqual({ kind: 'idea', text, repo: 'example/demo', waiting: false })
    expect(captureDraftOnEscape(loadCaptureDraft(file))).toEqual(loadCaptureDraft(file))
  })

  it('applies separate limits and treats unknown modes as legacy todo drafts', () => {
    const file = tempFile()
    const text = '字'.repeat(10_100)
    saveCaptureDraft(file, { kind: 'idea', text, repo: '', waiting: true })
    expect(loadCaptureDraft(file).text).toHaveLength(10_000)
    saveCaptureDraft(file, { kind: 'unknown', text, repo: '', waiting: true })
    expect(loadCaptureDraft(file)).toEqual({ text: text.slice(0, 500), repo: '', waiting: true })
  })
})
