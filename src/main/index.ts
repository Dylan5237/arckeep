import { app, BrowserWindow, Menu, Notification, Tray, dialog, globalShortcut, ipcMain, nativeImage, net, safeStorage, shell } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WINDOW_BACKGROUND } from '../shared/chrome.js'
import { IpcChannel } from '../shared/ipc.js'
import { hotkeyUnavailableMessage, shouldNotifyStartupHotkeyFailure, trayMenuEntries, trayToolTip } from '../shared/hotkey-status.js'
import { shouldShowMainWindowOnReady } from './launch-window.js'
import { mergeRepoOptions } from '../shared/todos/repos.js'
import { createTodoWaitingProvider } from '../shared/waiting/todo-source.js'
import { createCaptureWindow, focusCaptureInput, showSavedToast } from './capture-window.js'
import { createGracefulShutdownHandler } from './graceful-shutdown.js'
import { TaskScope, TaskCancelledError } from '../shared/task-scope.js'
import { flushCaptureOnShutdown } from './capture-shutdown.js'
import {
  normalizeTodoCompletion,
  normalizeTodoId,
  normalizeTodoInput,
  normalizeTodoUpdate,
  requireSender,
  requireTrustedSender
} from './ipc-validators.js'
import { OverviewService } from './overview-service.js'
import {
  captureDraftPath,
  claudeSessionsFilePath,
  overviewCachePath,
  settingsFilePath,
  testHookTodosPath,
  todosFilePath,
  userDataDir,
  waitingCachePath,
  waitingDismissalPath
} from './paths.js'
import {
  createScreenshotSettings,
  parseScreenshotScene,
  screenshotShowsMainWindow,
  screenshotStartPage,
  screenshotWindowSize
} from './screenshot-scene.js'
import { createScreenshotOverview } from './screenshot-overview.js'
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
import { clearCaptureDraft, emptyCaptureDraft, loadCaptureDraft, saveCaptureDraft } from './todos/draft.js'
import { TodoStore } from './todos/store.js'
import { IdeaStore } from './ideas/store.js'
import { registerIdeaIpc } from './ideas/ipc.js'
import { ideasFilePath } from './paths.js'
import { PromptStore } from './prompts/store.js'
import { registerPromptIpc } from './prompts/ipc.js'
import { promptsFilePath } from './paths.js'
import { ClaudeSessionStore } from './claude/session-store.js'
import { ClaudeSessionService } from './claude/service.js'
import { activateClaudeTerminal, createClaudeLaunchPlan, createClaudeTerminalTitle, launchClaudeInTerminal } from './claude/launcher.js'
import { registerClaudeIpc } from './claude/ipc.js'
import { seedScreenshotPrompts } from './screenshot-prompts.js'
import { createSafeStorageBox } from './token-store.js'
import type { HotkeyRegistrar } from './hotkey.js'
import { registerToolIpc } from './tool-ipc.js'
import { ToolRunner } from './tool-runner.js'
import { createToolRehearsals } from './tool-rehearse.js'
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
let shutdownFinished = false
const closingFailures: string[] = []
const backgroundTasks = new TaskScope()
let captureRecordCommitted = false
let captureDraftConsumed = false
let service: SettingsService | null = null
let todos: TodoStore | null = null
let waiting: WaitingService | ReturnType<typeof createScreenshotWaiting> | null = null
let overview: OverviewService | ReturnType<typeof createScreenshotOverview> | null = null
let hotkeyNoticeSent = false
const toolRunner = new ToolRunner(event => {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  win.webContents.send(IpcChannel.toolEvent, event)
})
const toolRehearsals = createToolRehearsals()
let toolIpcLifecycle: ReturnType<typeof registerToolIpc> | null = null

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
  if (isQuitting) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function openHotkeySettings(): void {
  if (isQuitting) return
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
  beginClosing()
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
    openCapture: () => { if (!isQuitting) openCaptureWindow() },
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

function consumeCaptureDraft(event: Electron.IpcMainInvokeEvent): void {
  if (!captureWindow || event.sender !== captureWindow.webContents) return
  captureRecordCommitted = true
  captureDraftConsumed = true
  try { clearCaptureDraft(draftFile()) } catch {
    // The record is durable. Suppress the consumed draft in this session and retry cleanup.
    console.error('捕获记录已保存，但对应草稿未能清理')
  }
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
  if (isQuitting) throw new TaskCancelledError()
  if (captureWindow && !captureWindow.isDestroyed()) {
    focusCaptureInput(captureWindow)
    return captureWindow
  }
  if (captureDraftConsumed) {
    try { clearCaptureDraft(draftFile()) } catch { /* The consumed draft remains suppressed. */ }
  }
  captureRecordCommitted = false
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
  window.on('close', event => {
    if (isQuitting && !shutdownFinished) event.preventDefault()
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
        ? () => { if (!isQuitting) openCaptureWindow() }
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
    backgroundColor: WINDOW_BACKGROUND,
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
    if (isQuitting) return
    const showWindow = shouldShowMainWindowOnReady({
      screenshot: Boolean(screenshotPath),
      screenshotShowsMainWindow: screenshotShowsMainWindow(screenshotScene),
      hideMainWindowOnLaunch: service?.getSettings().hideMainWindowOnLaunch === true
    })
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

  const startPage = screenshotPath ? screenshotStartPage(screenshotScene) : 'inbox'
  const query: Record<string, string> = startPage === 'inbox' ? {} : { page: startPage }
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
    backgroundTasks.assertOpen()
    if (isQuitting) throw new TaskCancelledError()
    requireTrustedSender(event, [mainWindow?.webContents, captureWindow?.webContents])
  }
  registerIdeaIpc({
    store: new IdeaStore({ file: ideasFilePath(app.getPath('userData')) }),
    guard,
    onCreated: consumeCaptureDraft,
    onChanged: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send(IpcChannel.ideasChanged)
    }
  })
  const prompts = new PromptStore({ file: promptsFilePath(app.getPath('userData')) })
  if (screenshotPath) seedScreenshotPrompts(screenshotScene, prompts)
  registerPromptIpc({
    store: prompts,
    guard: event => {
      backgroundTasks.assertOpen()
      if (isQuitting) throw new TaskCancelledError()
      requireSender(event, mainWindow?.webContents ?? null)
    },
    onChanged: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send(IpcChannel.promptsChanged)
    }
  })
  ipcMain.handle(IpcChannel.getState, event => {
    guard(event)
    return settings.getState()
  })
  ipcMain.handle(IpcChannel.setRepos, (event, repos: unknown) => {
    guard(event)
    return settings.setRepos(repos)
  })
  ipcMain.handle(IpcChannel.setRepoFetchWindow, (event, window: unknown) => {
    guard(event)
    return settings.setRepoFetchWindow(window)
  })
  ipcMain.handle(IpcChannel.setHotkey, (event, hotkey: unknown) => {
    guard(event)
    const result = settings.setHotkey(hotkey)
    publishHotkeyStatus()
    return result
  })
  ipcMain.handle(IpcChannel.setHideMainWindowOnLaunch, (event, hide: unknown) => {
    guard(event)
    return settings.setHideMainWindowOnLaunch(hide)
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
      consumeCaptureDraft(event)
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
  ipcMain.handle(IpcChannel.restoreTodo, (event, input: unknown) => {
    guard(event)
    try {
      const restored = store.restore(input)
      notifyTodosChanged()
      return { ok: true, data: restored }
    } catch (error) {
      return ipcError(error, '待办无效')
    }
  })
  ipcMain.handle(IpcChannel.getCaptureDraft, event => {
    guard(event)
    return captureDraftConsumed ? emptyCaptureDraft() : loadCaptureDraft(draftFile())
  })
  ipcMain.handle(IpcChannel.setCaptureDraft, (event, input: unknown) => {
    guard(event)
    const draft = saveCaptureDraft(draftFile(), input)
    captureDraftConsumed = false
    return draft
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
  ipcMain.handle(IpcChannel.refreshWaiting, (event, force: unknown) => {
    guard(event)
    if (force !== undefined && typeof force !== 'boolean') throw new Error('刷新参数无效')
    return waiting?.refresh(force) ?? Promise.reject(new Error('等我处理尚未就绪'))
  })
  for (const channel of [IpcChannel.commentWaitingApo, IpcChannel.checkWaitingApo]) ipcMain.handle(channel, (event, rowId: unknown, actionId: unknown) => {
    backgroundTasks.assertOpen()
    if (isQuitting) throw new TaskCancelledError()
    requireSender(event, mainWindow?.webContents ?? null)
    if (event.senderFrame !== mainWindow?.webContents.mainFrame) throw new Error('Blocked IPC from a child frame')
    if (!(waiting instanceof WaitingService)) return { ok: false, error: '当前模式不能发送 GitHub 评论' }
    return waiting.commentApo(rowId, actionId, channel === IpcChannel.checkWaitingApo)
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
  ipcMain.handle(IpcChannel.setMaybeSectionOpen, (event, open: unknown) => {
    guard(event)
    return waiting?.setMaybeSectionOpen(open) ?? { ok: false, error: '等我处理尚未就绪' }
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
  ipcMain.handle(IpcChannel.getOverview, event => {
    guard(event)
    return overview?.current()
  })
  ipcMain.handle(IpcChannel.refreshOverview, (event, force: unknown) => {
    guard(event)
    if (force !== undefined && typeof force !== 'boolean') throw new Error('刷新参数无效')
    return overview?.refresh(force) ?? Promise.reject(new Error('项目总览尚未就绪'))
  })
  ipcMain.handle(IpcChannel.setOverview, (event, config: unknown) => {
    guard(event)
    const saved = settings.setOverview(config)
    if (!saved.ok) return saved
    return settings.getState().then(state => ({ ok: true as const, data: state }))
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    if (isQuitting) return
    if (dispatchTestHook(process.env, parseTestHookAction(argv), trayActions(), testHookExtras())) return
    showMainWindow()
  })
  app.whenReady().then(() => {
    if (isQuitting) return
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
      overview = createScreenshotOverview(screenshotScene)
    } else {
      service = new SettingsService({
        tasks: backgroundTasks,
        file: settingsFilePath(userData),
        secretBox: createSafeStorageBox(safeStorage),
        registrar: captureRegistrar(),
        onHotkey: () => { if (!isQuitting) openCaptureWindow() },
        log: message => console.error(message)
      })
      service.init()
      waiting = new WaitingService(service, {
        cache: waitingCachePath(userData),
        dismissals: waitingDismissalPath(userData)
      }, {
        tasks: backgroundTasks,
        todos: todoProvider,
        fetchImpl: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
        log: message => console.error(message)
      })
      overview = new OverviewService(service, overviewCachePath(userData), {
        tasks: backgroundTasks,
        fetchImpl: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
        log: message => console.error(message)
      })
    }
    registerIpc(service, todos)
    const claudeStore = new ClaudeSessionStore({ file: claudeSessionsFilePath(userData) })
    const claudeService = new ClaudeSessionService({
      store: claudeStore,
      chooseDirectory: async (repo, name) => {
        const options: Electron.OpenDialogOptions = {
          title: '选择 ' + name + '（' + repo + '）的本地工作目录',
          properties: ['openDirectory']
        }
        const selected = mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showOpenDialog(mainWindow, options)
          : await dialog.showOpenDialog(options)
        return selected.canceled ? null : selected.filePaths[0] ?? null
      },
      linkedDirectories: repo => (waiting?.observedLocalLinks() ?? [])
        .filter(link => link.github.toLowerCase() === repo.toLowerCase())
        .map(link => link.path),
      activate: input => activateClaudeTerminal(createClaudeTerminalTitle(input.repo, input.sessionId)),
      launch: async input => {
        const plan = createClaudeLaunchPlan(input)
        await launchClaudeInTerminal(plan)
      }
    })
    registerClaudeIpc({
      service: claudeService,
      guard: event => {
        backgroundTasks.assertOpen()
        if (isQuitting) throw new TaskCancelledError()
        requireSender(event, mainWindow?.webContents ?? null)
        if (event.senderFrame !== mainWindow?.webContents.mainFrame) throw new Error('Blocked IPC from a child frame')
      }
    })
    toolIpcLifecycle = registerToolIpc({
      tasks: backgroundTasks,
      guard: event => {
        backgroundTasks.assertOpen()
        if (isQuitting) throw new TaskCancelledError()
        requireSender(event, mainWindow?.webContents ?? null)
      },
      getWindow: () => mainWindow,
      settings: service,
      runner: toolRunner,
      rehearsals: toolRehearsals,
      repos: waiting,
      todoRepos: () => (todos?.listTodos() ?? []).flatMap(item => item.repo ? [item.repo] : []),
      screenshotScene
    })
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

function beginClosing(): void {
  if (isQuitting) return
  isQuitting = true
  const gates = [
    { label: '后台任务', close: () => backgroundTasks.close() },
    { label: '工具命令', close: () => toolRunner.close() },
    { label: '工具预演', close: () => toolRehearsals.close() },
    { label: '工具请求', close: () => toolIpcLifecycle?.close() },
    { label: '全局热键', close: () => { if (app.isReady()) globalShortcut.unregisterAll() } }
  ]
  for (const gate of gates) {
    try { gate.close() } catch { closingFailures.push(`${gate.label}停止失败`) }
  }
}

async function flushCaptureBeforeQuit(): Promise<void> {
  if (captureRecordCommitted) {
    clearCaptureDraft(draftFile())
    return
  }
  const window = captureWindow
  if (!window || window.isDestroyed()) return
  if (window.webContents.isLoading()) return
  const result = await flushCaptureOnShutdown({
    file: draftFile(),
    isCommitted: () => captureRecordCommitted,
    readDraft: () => window.webContents.executeJavaScript(`(() => {
    if (!document.querySelector('#capture-form')) throw new Error('Capture form is not ready');
    const idea = document.querySelector('#capture-kind')?.value === 'idea';
    const text = document.querySelector(idea ? '#idea-text' : '#text')?.value ?? '';
    return { ...(idea ? { kind: 'idea' } : {}), text,
      repo: document.querySelector('#repo')?.value ?? '',
      waiting: !idea && document.querySelector('#waiting')?.checked === true };
    })()`)
  })
  if (result === 'preserved') throw new Error('快速捕获草稿读取失败，保留已有草稿')
}

function reportShutdownFailure(error: unknown): void {
  const record = {
    at: new Date().toISOString(),
    event: 'shutdown_incomplete',
    message: error instanceof Error ? error.message : '应用关闭清理失败',
    pendingTasks: backgroundTasks.pendingCount,
    ownedResources: backgroundTasks.resourceCount
  }
  console.error(JSON.stringify(record))
  let recorded = false
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'lifecycle-errors.jsonl'), `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    recorded = true
  } catch { /* A read-only data directory must not prevent exit. */ }
  if (!screenshotPath && Notification.isSupported()) {
    const body = recorded ? '退出清理未完整完成，诊断信息已记录。' : '退出清理未完整完成，诊断文件无法写入，请检查数据目录权限。'
    try { new Notification({ title: 'Arckeep', body }).show() } catch { /* OS notification unavailable. */ }
  }
}

const handleBeforeQuit = createGracefulShutdownHandler({
  quit: () => { shutdownFinished = true; app.quit() },
  onError: reportShutdownFailure,
  timeoutMs: 15_000,
  shutdown: async () => {
    const stages = [
      { label: '后台任务', run: () => backgroundTasks.drain() },
      { label: '工具预演', run: () => toolIpcLifecycle?.shutdown() ?? toolRehearsals.cancelAll() },
      { label: '工具命令', run: () => toolRunner.abortAll() },
      { label: '快速捕获草稿', run: () => flushCaptureBeforeQuit() }
    ]
    const results = await Promise.allSettled(stages.map(stage => Promise.resolve().then(stage.run)))
    try { tray?.destroy() } catch { closingFailures.push('托盘释放失败') }
    tray = null
    const failures = [...closingFailures.map(message => new Error(message)), ...results.flatMap((result, index) => result.status === 'rejected'
      ? [new Error(`${stages[index].label}关闭失败`)] : [])
    ]
    if (failures.length > 0) throw new AggregateError(failures, failures.map(error => error.message).join('；'))
  }
})

app.on('before-quit', event => {
  beginClosing()
  handleBeforeQuit(event)
})

app.on('window-all-closed', () => {
  if (isQuitting) app.quit()
})
