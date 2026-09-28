import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, safeStorage } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { IpcChannel } from '../shared/ipc.js'
import { mergeRepoOptions } from '../shared/todos/repos.js'
import { createCaptureWindow, focusCaptureWindow } from './capture-window.js'
import { createGracefulShutdownHandler } from './graceful-shutdown.js'
import {
  normalizeTodoCompletion,
  normalizeTodoId,
  normalizeTodoInput,
  normalizeTodoUpdate,
  requireTrustedSender
} from './ipc-validators.js'
import { settingsFilePath, testHookTodosPath, todosFilePath, userDataDir } from './paths.js'
import {
  createScreenshotSettings,
  parseScreenshotScene,
  screenshotOpensSettings,
  screenshotOpensTodos,
  screenshotShowsMainWindow,
  screenshotWindowSize
} from './screenshot-scene.js'
import { presentScreenshot } from './screenshot-run.js'
import {
  screenshotCaptureFixture,
  screenshotSeedsTodos,
  screenshotTodoLog
} from './screenshot-todos.js'
import { SettingsService } from './settings-service.js'
import {
  dispatchTestHook,
  installTrayTestHooks,
  parseTestHookAction,
  type TestHookExtras,
  type TrayActions
} from './test-hooks.js'
import { TodoStore } from './todos/store.js'
import { createSafeStorageBox } from './token-store.js'
import { createUrlGuard } from './url-trust.js'
import { hardenedWebPreferences } from './window-prefs.js'

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
let captureWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let service: SettingsService | null = null
let todos: TodoStore | null = null

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
  if (!mainWindow || mainWindow.isDestroyed()) return
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

function testHookExtras(): TestHookExtras {
  return {
    openCapture: () => openCaptureWindow(),
    readTodos: () => todos?.listTodos() ?? [],
    onTodos: snapshot => {
      const file = testHookTodosPath(app.getPath('userData'))
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const payload = JSON.stringify(snapshot)
      fs.writeFileSync(file, payload)
      console.log(`ARCKEEP_TODOS ${payload}`)
    }
  }
}

function preloadPath(): string {
  return path.join(__dirname, '../preload/index.cjs')
}

function loadRenderer(window: BrowserWindow, page: string, query: Record<string, string> = {}): void {
  if (devServerOrigin) {
    const url = new URL(page, devServerOrigin)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    void window.loadURL(url.href)
    return
  }
  void window.loadFile(path.join(rendererDir, page), { query })
}

function openCaptureWindow(): BrowserWindow {
  if (captureWindow && !captureWindow.isDestroyed()) {
    focusCaptureWindow(captureWindow)
    return captureWindow
  }
  const fixture = screenshotPath ? screenshotCaptureFixture(screenshotScene) : null
  const window = createCaptureWindow({
    preload: preloadPath(),
    icon: trayIconPath(),
    trusted: isTrustedNavigation,
    load: target => {
      loadRenderer(target, 'capture.html', fixture ? { fixture } : {})
    }
  })
  window.on('closed', () => {
    if (captureWindow === window) captureWindow = null
  })
  captureWindow = window
  return window
}

function createTray(): void {
  const icon = nativeImage.createFromPath(trayIconPath())
  if (icon.isEmpty()) throw new Error('tray icon is empty')
  tray = new Tray(icon)
  tray.setToolTip('Arckeep')
  const menu = Menu.buildFromTemplate([
    { label: '打开', click: () => showMainWindow() },
    { label: '快速捕获', click: () => openCaptureWindow() },
    { label: '退出', click: () => quitFromTray() }
  ])
  tray.setContextMenu(menu)
  tray.on('double-click', () => showMainWindow())
}

function installTestHooks(): void {
  installTrayTestHooks(process.env, {
    argv: process.argv,
    actions: trayActions(),
    extras: testHookExtras(),
    expose(handlers) {
      Object.defineProperty(globalThis, '__ARCKEEP_TEST_HOOKS__', {
        configurable: true,
        enumerable: false,
        value: handlers
      })
    },
    registerIpc(handler) {
      ipcMain.handle(IpcChannel.testHook, (event, action: unknown) => {
        requireTrustedSender(event, [mainWindow?.webContents, captureWindow?.webContents])
        return handler(action)
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
    webPreferences: hardenedWebPreferences(preloadPath())
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
    if (!screenshotPath || screenshotShowsMainWindow(screenshotScene)) window.show()
  })

  if (screenshotPath) {
    window.webContents.once('did-finish-load', () => {
      void presentScreenshot({
        scene: screenshotScene,
        main: window,
        openCapture: openCaptureWindow,
        file: screenshotPath,
        prepareMain: async contents => {
          await contents.executeJavaScript(`
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
      }).then(() => {
        isQuitting = true
        app.exit(0)
      }).catch(error => {
        console.error(error)
        app.exit(1)
      })
    })
  }

  const query: Record<string, string> = {}
  if (screenshotPath && screenshotOpensSettings(screenshotScene)) query.page = 'settings'
  if (screenshotPath && screenshotOpensTodos(screenshotScene)) query.page = 'todos'
  loadRenderer(window, 'index.html', query)
  return window
}

function notifyTodosChanged(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(IpcChannel.todosChanged)
}

function ipcError(error: unknown, fallback: string): { ok: false, error: string } {
  return { ok: false, error: error instanceof Error ? error.message : fallback }
}

function registerIpc(settings: SettingsService, store: TodoStore): void {
  const guard = (event: Electron.IpcMainInvokeEvent) => {
    requireTrustedSender(event, [mainWindow?.webContents, captureWindow?.webContents])
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
  ipcMain.handle(IpcChannel.listTodos, event => {
    guard(event)
    return store.listTodos()
  })
  ipcMain.handle(IpcChannel.todoRepoOptions, event => {
    guard(event)
    return mergeRepoOptions(settings.getSettings().watchedRepos, store.listTodos())
  })
  ipcMain.handle(IpcChannel.createTodo, (event, input: unknown) => {
    guard(event)
    try {
      const created = store.create(normalizeTodoInput(input))
      notifyTodosChanged()
      return { ok: true, data: created }
    } catch (error) {
      return ipcError(error, '待办无效')
    }
  })
  ipcMain.handle(IpcChannel.updateTodo, (event, input: unknown) => {
    guard(event)
    try {
      const updated = store.update(normalizeTodoUpdate(input))
      notifyTodosChanged()
      return { ok: true, data: updated }
    } catch (error) {
      return ipcError(error, '待办无效')
    }
  })
  ipcMain.handle(IpcChannel.setTodoCompleted, (event, input: unknown) => {
    guard(event)
    try {
      const updated = store.setCompleted(normalizeTodoCompletion(input))
      notifyTodosChanged()
      return { ok: true, data: updated }
    } catch (error) {
      return ipcError(error, '待办无效')
    }
  })
  ipcMain.handle(IpcChannel.deleteTodo, (event, id: unknown) => {
    guard(event)
    try {
      const removed = store.delete(normalizeTodoId(id))
      notifyTodosChanged()
      return { ok: true, data: removed }
    } catch (error) {
      return ipcError(error, '待办无效')
    }
  })
  ipcMain.handle(IpcChannel.closeCapture, event => {
    guard(event)
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close()
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (dispatchTestHook(process.env, parseTestHookAction(argv), trayActions(), testHookExtras())) return
    showMainWindow()
  })
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null)
    if (screenshotPath && screenshotSeedsTodos(screenshotScene)) {
      const file = todosFilePath(app.getPath('userData'))
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, screenshotTodoLog())
    }
    todos = new TodoStore({ file: todosFilePath(app.getPath('userData')) })
    if (screenshotPath) {
      service = createScreenshotSettings(screenshotScene, settingsFilePath(app.getPath('userData')))
    } else {
      service = new SettingsService({
        file: settingsFilePath(app.getPath('userData')),
        secretBox: createSafeStorageBox(safeStorage),
        registrar: globalShortcut,
        onHotkey: () => openCaptureWindow(),
        log: message => console.error(message)
      })
      service.init()
    }
    registerIpc(service, todos)
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
