import type { CaptureDraft } from './types.js'

/**
 * Esc with an empty input drops the whole draft, including a repo tag and
 * 等我 that were filled in beside the blank line. Whitespace-only counts as
 * empty. Any other text keeps the draft as typed.
 */
export function captureDraftOnEscape(draft: CaptureDraft): CaptureDraft {
  if (draft.text.trim() === '') return { text: '', repo: '', waiting: false }
  return draft
}
