import { app, BrowserWindow, Menu, Notification, Tray, globalShortcut, ipcMain, nativeImage, safeStorage, shell } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { IpcChannel } from '../shared/ipc.js'
import { hotkeyUnavailableMessage, shouldNotifyStartupHotkeyFailure, trayMenuEntries, trayToolTip } from '../shared/hotkey-status.js'
import { mergeRepoOptions } from '../shared/todos/repos.js'
import { createTodoWaitingProvider } from '../shared/waiting/todo-source.js'
import { createCaptureWindow, focusCaptureInput, showSavedToast } from './capture-window.js'
import { createGracefulShutdownHandler } from './graceful-shutdown.js'
import {
  normalizeTodoCompletion,
  normalizeTodoId,
  normalizeTodoInput,
  normalizeTodoUpdate,
  requireTrustedSender
} from './ipc-validators.js'
import { captureDraftPath, settingsFilePath, testHookTodosPath, todosFilePath, userDataDir, waitingCachePath, waitingDismissalPath } from './paths.js'
import {
  createScreenshotSettings,
  parseScreenshotScene,
  screenshotOpensSettings,
  screenshotOpensTodos,
  screenshotShowsMainWindow,
  screenshotWindowSize
} from './screenshot-scene.js'
import { presentScreenshot } from './screenshot-run.js'
import { createScreenshotWaiting } from './screenshot-waiting.js'
import {
  screenshotCaptureFixture,
  screenshotSeedsTodos,
  screenshotTodoLog
} from './screenshot-todos.js'
import { SettingsService } from './settings-service.js'
import { WaitingService } from './waiting-service.js'
import {
  dispatchTestHook,
  hotkeyFailureRequested,
  installTrayTestHooks,
  parseTestHookAction,
  testHooksEnabled,
  type TestHookExtras,
  type TrayActions
} from './test-hooks.js'
import { clearCaptureDraft, loadCaptureDraft, saveCaptureDraft } from './todos/draft.js'
import { TodoStore } from './todos/store.js'
import { createSafeStorageBox } from './token-store.js'
import type { HotkeyRegistrar } from './hotkey.js'
import { createUrlGuard, isTrustedBrowserUrl } from './url-trust.js'
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
let savedToast: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let service: SettingsService | null = null
let todos: TodoStore | null = null
let waiting: WaitingService | ReturnType<typeof createScreenshotWaiting> | null = null
let hotkeyNoticeSent = false

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

function openHotkeySettings(): void {
  showMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(IpcChannel.focusHotkey)
}

function maybeNotifyStartupHotkeyFailure(windowVisible: boolean): void {
  const banner = service?.hotkeyUnavailableCombo() ?? null
  if (!shouldNotifyStartupHotkeyFailure({ banner, windowVisible, alreadySent: hotkeyNoticeSent })) return
  hotkeyNoticeSent = true
  if (screenshotPath || !banner) return
  const notice = new Notification({
    title: 'Arckeep',
    body: hotkeyUnavailableMessage(banner)
  })
  notice.on('click', () => openHotkeySettings())
  notice.show()
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

function draftFile(): string {
  return captureDraftPath(app.getPath('userData'))
}

function showSavedConfirmation(): void {
  if (savedToast && !savedToast.isDestroyed()) savedToast.close()
  const toast = showSavedToast({
    preload: preloadPath(),
    trusted: isTrustedNavigation,
    holdMs: screenshotPath ? 4000 : undefined,
    load: target => loadRenderer(target, 'toast.html')
  })
  savedToast = toast
  toast.on('closed', () => {
    if (savedToast === toast) savedToast = null
  })
}

function openCaptureWindow(): BrowserWindow {
  if (captureWindow && !captureWindow.isDestroyed()) {
    focusCaptureInput(captureWindow)
    return captureWindow
  }
  const fixture = screenshotPath ? screenshotCaptureFixture(screenshotScene) : null
  const query: Record<string, string> = {}
  if (fixture) query.fixture = fixture
  if (screenshotPath) query.stay = '1'
  const window = createCaptureWindow({
    preload: preloadPath(),
    icon: trayIconPath(),
    trusted: isTrustedNavigation,
    ignoreBlur: Boolean(screenshotPath),
    load: target => {
      loadRenderer(target, 'capture.html', query)
    }
  })
  window.on('closed', () => {
    if (captureWindow === window) captureWindow = null
  })
  captureWindow = window
  return window
}

function publishHotkeyStatus(): void {
  applyTrayState()
  if (!mainWindow || mainWindow.isDestroyed() || !service) return
  mainWindow.webContents.send(IpcChannel.hotkeyStatus, service.hotkeyUnavailableCombo())
}

function applyTrayState(): void {
  if (!tray) return
  const unavailable = service?.hotkeyUnavailableCombo() ?? null
  tray.setToolTip(trayToolTip(unavailable))
  const menu = Menu.buildFromTemplate(trayMenuEntries(unavailable).map(entry => ({
    label: entry.label,
    enabled: entry.enabled,
    click: entry.role === 'open'
      ? () => showMainWindow()
      : entry.role === 'capture'
        ? () => openCaptureWindow()
        : entry.role === 'quit'
          ? () => quitFromTray()
          : undefined
  })))
  tray.setContextMenu(menu)
}

function createTray(): void {
  const icon = nativeImage.createFromPath(trayIconPath())
  if (icon.isEmpty()) throw new Error('tray icon is empty')
  tray = new Tray(icon)
  applyTrayState()
  tray.on('double-click', () => showMainWindow())
}

function captureRegistrar(): HotkeyRegistrar {
  if (!hotkeyFailureRequested(process.env, process.argv)) return globalShortcut
  return {
    register: () => false,
    isRegistered: () => false,
    unregister: accelerator => {
      globalShortcut.unregister(accelerator)
    }
  }
}

function installTestHooks(): void {
  installTrayTestHooks(process.env, {
    argv: process.argv,
    actions: trayActions(),
    extras: {
      ...testHookExtras(),
      failHotkey: () => {
        if (!testHooksEnabled(process.env) || !service) return
        service.simulateRegistrationFailure()
        publishHotkeyStatus()
      }
    },
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
    const showWindow = !screenshotPath || screenshotShowsMainWindow(screenshotScene)
    if (showWindow) window.show()
    maybeNotifyStartupHotkeyFailure(showWindow)
  })

  if (screenshotPath) {
    window.webContents.once('did-finish-load', () => {
      void presentScreenshot({
        scene: screenshotScene,
        main: window,
        openCapture: openCaptureWindow,
        savedToast: () => savedToast,
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
    const result = settings.setHotkey(hotkey)
    publishHotkeyStatus()
    return result
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
  ipcMain.handle(IpcChannel.getCaptureDraft, event => {
    guard(event)
    return loadCaptureDraft(draftFile())
  })
  ipcMain.handle(IpcChannel.setCaptureDraft, (event, input: unknown) => {
    guard(event)
    return saveCaptureDraft(draftFile(), input)
  })
  ipcMain.handle(IpcChannel.closeCapture, (event, mode: unknown) => {
    guard(event)
    const saved = mode === 'saved'
    if (saved) clearCaptureDraft(draftFile())
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close()
    if (saved) showSavedConfirmation()
  })
  ipcMain.handle(IpcChannel.getWaiting, event => {
    guard(event)
    return waiting?.current()
  })
  ipcMain.handle(IpcChannel.refreshWaiting, event => {
    guard(event)
    return waiting?.refresh() ?? Promise.reject(new Error('等我处理尚未就绪'))
  })
  ipcMain.handle(IpcChannel.snoozeWaiting, (event, id: unknown, days: unknown) => {
    guard(event)
    return waiting?.snooze(id, days) ?? { ok: false, error: '等我处理尚未就绪' }
  })
  ipcMain.handle(IpcChannel.ignoreWaiting, (event, id: unknown) => {
    guard(event)
    return waiting?.ignore(id) ?? { ok: false, error: '等我处理尚未就绪' }
  })
  ipcMain.handle(IpcChannel.restoreWaiting, (event, id: unknown) => {
    guard(event)
    return waiting?.restore(id) ?? { ok: false, error: '等我处理尚未就绪' }
  })
  ipcMain.handle(IpcChannel.hideWaitingRepo, (event, repo: unknown) => {
    guard(event)
    return waiting?.hideRepo(repo) ?? { ok: false, error: '等我处理尚未就绪' }
  })
  ipcMain.handle(IpcChannel.unhideWaitingRepo, (event, repo: unknown) => {
    guard(event)
    return waiting?.unhideRepo(repo) ?? { ok: false, error: '等我处理尚未就绪' }
  })
  ipcMain.handle(IpcChannel.setShowIgnored, (event, show: unknown) => {
    guard(event)
    return waiting?.setShowIgnored(show) ?? { ok: false, error: '等我处理尚未就绪' }
  })
  ipcMain.handle(IpcChannel.setWaiting, (event, config: unknown) => {
    guard(event)
    const saved = settings.setWaiting(config)
    if (!saved.ok) return saved
    return settings.getState().then(state => ({ ok: true as const, data: state }))
  })
  ipcMain.handle(IpcChannel.openExternal, (event, url: unknown) => {
    guard(event)
    if (typeof url !== 'string' || !isTrustedBrowserUrl(url)) {
      return { ok: false, error: '只能用浏览器打开 GitHub 链接' }
    }
    return shell.openExternal(url).then(
      () => ({ ok: true as const, data: true as const }),
      () => ({ ok: false as const, error: '无法打开浏览器' })
    )
  })
  ipcMain.handle(IpcChannel.advanceWaitingDays, (event, days: unknown) => {
    guard(event)
    return waiting?.advanceDays(days) ?? { ok: false, error: '等我处理尚未就绪' }
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
    if (screenshotPath && screenshotScene === 'capture-draft') {
      saveCaptureDraft(captureDraftPath(app.getPath('userData')), {
        text: '把没写完的这半句留在',
        repo: 'example/demo',
        waiting: true
      })
    }
    if (screenshotPath && screenshotSeedsTodos(screenshotScene)) {
      const file = todosFilePath(app.getPath('userData'))
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, screenshotTodoLog())
    }
    const userData = app.getPath('userData')
    todos = new TodoStore({ file: todosFilePath(userData) })
    const todoProvider = createTodoWaitingProvider(() => todos?.listWaitingTodos() ?? [])
    if (screenshotPath) {
      service = createScreenshotSettings(screenshotScene, settingsFilePath(userData))
      waiting = createScreenshotWaiting(screenshotScene)
    } else {
      service = new SettingsService({
        file: settingsFilePath(userData),
        secretBox: createSafeStorageBox(safeStorage),
        registrar: captureRegistrar(),
        onHotkey: () => openCaptureWindow(),
        log: message => console.error(message)
      })
      service.init()
      waiting = new WaitingService(service, {
        cache: waitingCachePath(userData),
        dismissals: waitingDismissalPath(userData)
      }, {
        todos: todoProvider,
        log: message => console.error(message)
      })
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
