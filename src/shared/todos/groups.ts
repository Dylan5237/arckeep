import type { TodoItem } from './types.js'

export const COMPLETED_GROUP_STORAGE_KEY = 'arckeep.todos.completedOpen'

export function partitionTodos(items: readonly TodoItem[]): { open: TodoItem[], done: TodoItem[] } {
  const open: TodoItem[] = []
  const done: TodoItem[] = []
  for (const item of items) {
    if (item.completed) done.push(item)
    else open.push(item)
  }
  return { open, done }
}

export function completedGroupTitle(count: number): string {
  return `已完成 · ${count}`
}

/** Missing or any value other than "1" keeps the group collapsed. */
export function readCompletedGroupOpen(stored: string | null | undefined): boolean {
  return stored === '1'
}

export function writeCompletedGroupOpen(open: boolean): '1' | '0' {
  return open ? '1' : '0'
}
