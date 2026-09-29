/** Shared by the main window and the quick-capture window. */
export const HARDENED_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true
} as const

export function hardenedWebPreferences(preload: string): {
  preload: string
  contextIsolation: true
  nodeIntegration: false
  sandbox: true
  webSecurity: true
} {
  return { preload, ...HARDENED_WEB_PREFERENCES }
}
