import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CaptureDraft } from '../../shared/todos/types.js'
import { MAX_IDEA_LENGTH } from '../../shared/ideas/types.js'

export type { CaptureDraft }

export function emptyCaptureDraft(): CaptureDraft {
  return { text: '', repo: '', waiting: false }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeCaptureDraft(input: unknown): CaptureDraft {
  if (!isRecord(input)) return emptyCaptureDraft()
  const idea = input.kind === 'idea'
  return {
    ...(idea ? { kind: 'idea' as const } : {}),
    text: typeof input.text === 'string' ? input.text.slice(0, idea ? MAX_IDEA_LENGTH : 500) : '',
    repo: typeof input.repo === 'string' ? input.repo.slice(0, 200) : '',
    waiting: !idea && input.waiting === true
  }
}

export function loadCaptureDraft(file: string): CaptureDraft {
  try {
    return normalizeCaptureDraft(JSON.parse(readFileSync(file, 'utf8')) as unknown)
  } catch {
    return emptyCaptureDraft()
  }
}

export function saveCaptureDraft(file: string, input: unknown): CaptureDraft {
  const draft = normalizeCaptureDraft(input)
  if (!draft.text && !draft.repo && !draft.waiting) {
    clearCaptureDraft(file)
    return draft
  }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(draft), { encoding: 'utf8', mode: 0o600 })
  return draft
}

export function clearCaptureDraft(file: string): void {
  rmSync(file, { force: true })
}
