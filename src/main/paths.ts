import path from 'node:path'

/** Windows userData folder name. package.json `name` is lowercase, so we set the path explicitly. */
export const USER_DATA_DIR_NAME = 'Arckeep'

export function userDataDir(appData: string, join: (...parts: string[]) => string = path.join): string {
  return join(appData, USER_DATA_DIR_NAME)
}

export function settingsFilePath(userData: string, join: (...parts: string[]) => string = path.join): string {
  return join(userData, 'settings.json')
}

export function todosFilePath(userData: string, join: (...parts: string[]) => string = path.join): string {
  return join(userData, 'todos.jsonl')
}

export function testHookTodosPath(userData: string, join: (...parts: string[]) => string = path.join): string {
  return join(userData, 'test-hook-todos.json')
}
