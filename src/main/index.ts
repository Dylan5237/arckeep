import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { IpcChannel } from '../shared/ipc.js'
import { createGracefulShutdownHandler } from './graceful-shutdown.js'
import { requireSender } from './ipc-validators.js'
import { settingsFilePath, userDataDir } from './paths.js'
import { SettingsService } from './settings-service.js'
import { createSafeStorageBox } from './token-store.js'
import { createUrlGuard } from './url-trust.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

if (process.env.ARCKEEP_SCREENSHOT) {
  app.commandLine.appendSwitch('no-sandbox')
  app.disableHardwareAcceleration()
}

app.setName('Arckeep')
app.setPath('userData', userDataDir(app.getPath('appData')))

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let service: SettingsService | null = null

const devServerOrigin = process.env.ARCKEEP_DEV === '1' ? process.env.VITE_DEV_SERVER_URL ?? null : null
const rendererDir = path.join(__dirname, '../renderer')
const rendererRootFileUrl = pathToFileURL(rendererDir.endsWith(path.sep) ? rendererDir : `${rendererDir}${path.sep}`).href
const isTrustedNavigation = createUrlGuard(() => ({
  devServerOrigin,
  rendererRootFileUrl: devServerOrigin ? null : rendererRootFileUrl
}))

function trayIconPath(): string {
  if (app.isPackaged) {
    const packaged = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
    return path.join(process.resourcesPath, packaged)
  }
  const devIcon = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  return path.join(app.getAppPath(), 'build', devIcon)
}

function showMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  const icon = nativeImage.createFromPath(trayIconPath())
  if (icon.isEmpty()) throw new Error('tray icon is empty')
  tray = new Tray(icon)
  tray.setToolTip('Arckeep')
  const menu = Menu.buildFromTemplate([
    { label: '打开', click: () => showMainWindow() },
    { label: '退出', click: () => { isQuitting = true; app.quit() } }
  ])
  tray.setContextMenu(menu)
  tray.on('double-click', () => showMainWindow())
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 880,
    minHeight: 600,
    show: false,
    title: 'Arckeep',
    backgroundColor: '#F5F2EA',
    autoHideMenuBar: true,
    icon: trayIconPath(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedNavigation(url)) event.preventDefault()
  })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  window.on('close', event => {
    if (isQuitting || !tray) return
    event.preventDefault()
    window.hide()
  })
  window.once('ready-to-show', () => {
    window.show()
  })

  const screenshot = process.env.ARCKEEP_SCREENSHOT
  if (screenshot) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        window.webContents.capturePage().then(image => {
          fs.mkdirSync(path.dirname(screenshot), { recursive: true })
          fs.writeFileSync(screenshot, image.toPNG())
          isQuitting = true
          app.exit(0)
        }).catch(error => {
          console.error(error)
          app.exit(1)
        })
      }, 400)
    })
  }

  if (devServerOrigin) {
    const page = process.env.ARCKEEP_SCREENSHOT ? `${devServerOrigin}?page=settings` : devServerOrigin
    void window.loadURL(page)
  } else {
    void window.loadFile(path.join(rendererDir, 'index.html'), {
      query: process.env.ARCKEEP_SCREENSHOT ? { page: 'settings' } : {}
    })
  }
  return window
}

function registerIpc(settings: SettingsService): void {
  const guard = (event: Electron.IpcMainInvokeEvent) => {
    requireSender(event, mainWindow?.webContents ?? null)
  }
  ipcMain.handle(IpcChannel.getState, event => {
    guard(event)
    return settings.getState()
  })
  ipcMain.handle(IpcChannel.setRepos, (event, repos: unknown) => {
    guard(event)
    return settings.setRepos(repos)
  })
  ipcMain.handle(IpcChannel.setHotkey, (event, hotkey: unknown) => {
    guard(event)
    return settings.setHotkey(hotkey)
  })
  ipcMain.handle(IpcChannel.setPat, (event, token: unknown) => {
    guard(event)
    return settings.setPat(token)
  })
  ipcMain.handle(IpcChannel.clearPat, event => {
    guard(event)
    return settings.clearPat()
  })
  ipcMain.handle(IpcChannel.testGithub, event => {
    guard(event)
    return settings.testConnection()
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    service = new SettingsService({
      file: settingsFilePath(app.getPath('userData')),
      secretBox: createSafeStorageBox(safeStorage),
      registrar: globalShortcut,
      onHotkey: () => showMainWindow(),
      log: message => console.error(message)
    })
    service.init()
    registerIpc(service)
    mainWindow = createWindow()
    try {
      createTray()
    } catch (error) {
      console.error(error instanceof Error ? error.message : '托盘不可用')
    }
  }).catch(error => {
    console.error(error)
    app.exit(1)
  })
}

const handleBeforeQuit = createGracefulShutdownHandler({
  quit: () => app.quit(),
  shutdown: () => {
    globalShortcut.unregisterAll()
    tray?.destroy()
    tray = null
  }
})

app.on('before-quit', event => {
  isQuitting = true
  handleBeforeQuit(event)
})

app.on('window-all-closed', () => {
  if (isQuitting) app.quit()
})
