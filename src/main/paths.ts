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

export function captureDraftPath(userData: string, join: (...parts: string[]) => string = path.join): string {
  return join(userData, 'capture-draft.json')
}

export function waitingCachePath(userData: string, join: (...parts: string[]) => string = path.join): string {
  return join(userData, 'waiting-cache.json')
}

export function waitingDismissalPath(userData: string, join: (...parts: string[]) => string = path.join): string {
  return join(userData, 'waiting-dismissals.json')
}

/** Same folder the Electron app uses for `%APPDATA%\\Arckeep`. */
export function defaultAppDataDir(
  env: NodeJS.ProcessEnv,
  platform = process.platform,
  home = ''
): string {
  if (platform === 'win32') return env.APPDATA || path.win32.join(home, 'AppData', 'Roaming')
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support')
  return env.XDG_CONFIG_HOME || path.join(home, '.config')
}
