import { describe, expect, it } from 'vitest'
import { HARDENED_WEB_PREFERENCES, hardenedWebPreferences } from '../src/main/window-prefs.js'

describe('hardened webPreferences', () => {
  it('keeps the capture window on the same isolation flags as the main window', () => {
    expect(HARDENED_WEB_PREFERENCES).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    })
    expect(hardenedWebPreferences('/preload.cjs')).toMatchObject(HARDENED_WEB_PREFERENCES)
  })
})
