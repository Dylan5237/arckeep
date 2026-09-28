import { BrowserWindow } from 'electron'
import { hardenedWebPreferences } from './window-prefs.js'

export interface CaptureWindowOptions {
  preload: string
  icon: string
  trusted: (url: string) => boolean
  load: (window: BrowserWindow) => void
}

/** Shows the capture window and moves keyboard focus to it. No timer. */
export function focusCaptureWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  if (!window.isVisible()) window.show()
  window.moveTop()
  window.focus()
  window.webContents.focus()
}

export function createCaptureWindow(options: CaptureWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 460,
    height: 312,
    show: false,
    title: '快速捕获',
    backgroundColor: '#F5F2EA',
    autoHideMenuBar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    resizable: false,
    useContentSize: true,
    icon: options.icon,
    webPreferences: hardenedWebPreferences(options.preload)
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!options.trusted(url)) event.preventDefault()
  })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      event.preventDefault()
      if (!window.isDestroyed()) window.close()
    }
  })
  window.once('ready-to-show', () => {
    focusCaptureWindow(window)
  })
  options.load(window)
  return window
}
