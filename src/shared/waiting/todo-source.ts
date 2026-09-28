import type { TodoWaitingProvider } from './types.js'

/** Placeholder until issue #4 supplies real「等我」todos. */
export const pendingTodoProvider: TodoWaitingProvider = {
  available: false,
  listWaitingOnMe() {
    return Promise.resolve([])
  }
}
