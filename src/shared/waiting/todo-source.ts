import type { WaitingTodo } from '../todos/types.js'
import type { TodoWaitingItem, TodoWaitingProvider } from './types.js'

export function todoWaitingUrl(id: string): string {
  return `arckeep://todos?id=${encodeURIComponent(id)}`
}

/**
 * Maps incomplete「等我」todos into the waiting assembler.
 * `createdAt` is the moment the flag was checked; that is the reason clock.
 */
export function toTodoWaitingItems(items: readonly WaitingTodo[]): TodoWaitingItem[] {
  return items.map(item => ({
    id: item.id,
    title: item.text,
    createdAt: item.waitingSince,
    updatedAt: item.waitingSince,
    url: todoWaitingUrl(item.id)
  }))
}

export function createTodoWaitingProvider(
  read: () => Promise<readonly WaitingTodo[]> | readonly WaitingTodo[]
): TodoWaitingProvider {
  return {
    available: true,
    async listWaitingOnMe() {
      return toTodoWaitingItems(await read())
    }
  }
}

/** Fallback when nothing has wired the local todo log. */
export const pendingTodoProvider: TodoWaitingProvider = {
  available: false,
  listWaitingOnMe() {
    return Promise.resolve([])
  }
}
