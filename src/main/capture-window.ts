import { BrowserWindow, screen } from 'electron'
import { hardenedWebPreferences } from './window-prefs.js'

export interface CaptureWindowOptions {
  preload: string
  icon: string
  trusted: (url: string) => boolean
  load: (window: BrowserWindow) => void
  /** Screenshot runs keep the window up when the desktop focus flickers. */
  ignoreBlur?: boolean
}

/** Puts the caret in the capture field, at the end of any restored draft. */
export const focusCaptureInputScript = `(() => {
  const input = document.querySelector('#text');
  if (!(input instanceof HTMLInputElement)) return false;
  input.focus();
  const end = input.value.length;
  input.setSelectionRange(end, end);
  document.dispatchEvent(new Event('selectionchange'));
  return document.activeElement === input;
})()`

/** Shows the capture window and moves keyboard focus to it. No timer. */
export function focusCaptureWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  if (!window.isVisible()) window.show()
  window.moveTop()
  window.focus()
  window.webContents.focus()
}

export function focusCaptureInput(window: BrowserWindow): void {
  focusCaptureWindow(window)
  if (window.webContents.isLoading()) return
  void window.webContents.executeJavaScript(focusCaptureInputScript).catch(() => {})
}

export function createCaptureWindow(options: CaptureWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 460,
    height: 348,
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
  window.webContents.on('did-finish-load', () => {
    focusCaptureInput(window)
  })
  window.once('ready-to-show', () => {
    focusCaptureWindow(window)
  })
  if (!options.ignoreBlur) {
    let blurTimer: NodeJS.Timeout | null = null
    window.on('blur', () => {
      if (blurTimer) clearTimeout(blurTimer)
      blurTimer = setTimeout(() => {
        if (window.isDestroyed() || window.isFocused()) return
        window.close()
      }, 200)
    })
    window.on('focus', () => {
      if (blurTimer) clearTimeout(blurTimer)
    })
  }
  options.load(window)
  return window
}

const SAVED_TOAST_MS = 1000

/** A small overlay that does not take keyboard focus away from the previous app. */
export function showSavedToast(options: {
  preload: string
  trusted: (url: string) => boolean
  load: (window: BrowserWindow) => void
  holdMs?: number
}): BrowserWindow {
  const window = new BrowserWindow({
    width: 168,
    height: 48,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: hardenedWebPreferences(options.preload)
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!options.trusted(url)) event.preventDefault()
  })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  window.once('ready-to-show', () => {
    if (window.isDestroyed()) return
    const area = screen.getPrimaryDisplay().workArea
    window.setPosition(
      area.x + Math.round((area.width - 168) / 2),
      area.y + area.height - 96
    )
    window.showInactive()
  })
  options.load(window)
  const holdMs = options.holdMs ?? SAVED_TOAST_MS
  setTimeout(() => {
    if (!window.isDestroyed()) window.close()
  }, holdMs)
  return window
}
