import type { TodoItem } from './types.js'

/** How long the「已删除 · 撤销」bar stays up. */
export const TODO_DELETE_UNDO_MS = 5000

export interface DeleteUndo {
  item: TodoItem
  until: number
}

export function beginDeleteUndo(item: TodoItem, now: number): DeleteUndo {
  return { item: { ...item }, until: now + TODO_DELETE_UNDO_MS }
}

/** The pending operation, or null once its absolute deadline has passed. */
export function activeDeleteUndo(pending: DeleteUndo | null, now: number): DeleteUndo | null {
  if (!pending || now >= pending.until) return null
  return pending
}

/** The snapshot to restore, or null once the window has closed. */
export function deleteUndoItem(pending: DeleteUndo | null, now: number): TodoItem | null {
  return activeDeleteUndo(pending, now)?.item ?? null
}
