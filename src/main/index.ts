import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, safeStorage } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { IpcChannel } from '../shared/ipc.js'
import { createGracefulShutdownHandler } from './graceful-shutdown.js'
import { requireSender } from './ipc-validators.js'
import { settingsFilePath, userDataDir } from './paths.js'
import {
  MOCK_GITHUB_LOGIN,
  createScreenshotSettings,
  parseScreenshotScene,
  screenshotOpensSettings,
  screenshotWindowSize
} from './screenshot-scene.js'
import { SettingsService } from './settings-service.js'
import { dispatchTestHook, installTrayTestHooks, parseTestHookAction, type TrayActions } from './test-hooks.js'
import { createSafeStorageBox } from './token-store.js'
import { createUrlGuard } from './url-trust.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const screenshotPath = process.env.ARCKEEP_SCREENSHOT
const screenshotScene = parseScreenshotScene(process.env.ARCKEEP_SCREENSHOT_SCENE)

if (screenshotPath) {
  app.commandLine.appendSwitch('no-sandbox')
  app.disableHardwareAcceleration()
}

app.setName('Arckeep')
app.setPath('userData', screenshotPath
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'arckeep-screenshot-'))
  : userDataDir(app.getPath('appData')))

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

function quitFromTray(): void {
  isQuitting = true
  app.quit()
}

function closeMainWindow(): void {
  mainWindow?.close()
}

function trayActions(): TrayActions {
  return {
    closeWindow: closeMainWindow,
    showWindow: showMainWindow,
    quit: quitFromTray
  }
}

function createTray(): void {
  const icon = nativeImage.createFromPath(trayIconPath())
  if (icon.isEmpty()) throw new Error('tray icon is empty')
  tray = new Tray(icon)
  tray.setToolTip('Arckeep')
  const menu = Menu.buildFromTemplate([
    { label: '打开', click: () => showMainWindow() },
    { label: '退出', click: () => quitFromTray() }
  ])
  tray.setContextMenu(menu)
  tray.on('double-click', () => showMainWindow())
}

function installTestHooks(): void {
  installTrayTestHooks(process.env, {
    argv: process.argv,
    actions: trayActions(),
    expose(handlers) {
      Object.defineProperty(globalThis, '__ARCKEEP_TEST_HOOKS__', {
        configurable: true,
        enumerable: false,
        value: handlers
      })
    },
    registerIpc(handler) {
      ipcMain.handle(IpcChannel.testHook, (event, action: unknown) => {
        requireSender(event, mainWindow?.webContents ?? null)
        handler(action)
      })
    }
  })
}

function createWindow(): BrowserWindow {
  const size = screenshotWindowSize(screenshotScene)
  const window = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: 720,
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

  if (screenshotPath) {
    window.webContents.once('did-finish-load', () => {
      void captureScreenshot(window, screenshotPath, screenshotScene).catch(error => {
        console.error(error)
        app.exit(1)
      })
    })
  }

  const openSettings = screenshotPath ? screenshotOpensSettings(screenshotScene) : false
  if (devServerOrigin) {
    const page = openSettings ? `${devServerOrigin}?page=settings` : devServerOrigin
    void window.loadURL(page)
  } else {
    void window.loadFile(path.join(rendererDir, 'index.html'), {
      query: openSettings ? { page: 'settings' } : {}
    })
  }
  return window
}

async function captureScreenshot(window: BrowserWindow, file: string, scene: string): Promise<void> {
  if (scene === 'invalid-token' || scene === 'connected') {
    await window.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const start = Date.now()
        const timer = setInterval(() => {
          const button = [...document.querySelectorAll('button')].find(item => item.textContent === '测试连接')
          if (button) {
            clearInterval(timer)
            button.click()
            resolve(true)
            return
          }
          if (Date.now() - start > 5000) {
            clearInterval(timer)
            reject(new Error('测试连接 button was not rendered'))
          }
        }, 50)
      })
    `)
  }
  const expected = scene === 'connected'
    ? MOCK_GITHUB_LOGIN
    : scene === 'invalid-token'
      ? 'HTTP 401'
      : scene === 'signed-out'
        ? '未配置'
        : scene === 'hotkey-conflict'
          ? '已被其他程序占用'
          : '等我处理'
  const start = Date.now()
  let seen = false
  while (Date.now() - start < 5000) {
    seen = await window.webContents.executeJavaScript(
      `document.body.innerText.includes(${JSON.stringify(expected)})`
    )
    if (seen) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (!seen) throw new Error(`screenshot scene ${scene} did not show ${expected}`)
  await new Promise(resolve => setTimeout(resolve, 150))
  const image = await window.webContents.capturePage()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, image.toPNG())
  isQuitting = true
  app.exit(0)
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
  ipcMain.handle(IpcChannel.testGithub, (event, pasted: unknown) => {
    guard(event)
    return settings.testConnection(pasted)
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (dispatchTestHook(process.env, parseTestHookAction(argv), trayActions())) return
    showMainWindow()
  })
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    if (screenshotPath) {
      service = createScreenshotSettings(screenshotScene, settingsFilePath(app.getPath('userData')))
    } else {
      service = new SettingsService({
        file: settingsFilePath(app.getPath('userData')),
        secretBox: createSafeStorageBox(safeStorage),
        registrar: globalShortcut,
        onHotkey: () => showMainWindow(),
        log: message => console.error(message)
      })
      service.init()
    }
    registerIpc(service)
    mainWindow = createWindow()
    try {
      createTray()
    } catch (error) {
      console.error(error instanceof Error ? error.message : '托盘不可用')
    }
    installTestHooks()
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
