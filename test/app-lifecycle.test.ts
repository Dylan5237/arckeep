import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel } from '../src/shared/ipc.js'
import type { TaskScope } from '../src/shared/task-scope.js'

type Mock = ReturnType<typeof vi.fn>
type MainHandler = (...args: unknown[]) => unknown
type ToolIpcOptions = Parameters<typeof import('../src/main/tool-ipc.js').registerToolIpc>[0]
type ServiceOptions = { tasks: TaskScope, onHotkey: () => void }
type TaskOptions = { tasks: TaskScope }
type TrayMenuEntry = { label: string, click?: () => void }
type TrayHarness = { contextMenu: TrayMenuEntry[], destroy: Mock }
type NotificationHarness = { options: { title: string, body: string }, show: Mock }
type LifecycleHarness = {
  rootDirectory: string
  appDataDirectory: string
  userDataDirectory: string
  paths: Map<string, string>
  listeners: Map<string, MainHandler[]>
  handlers: Map<string, MainHandler>
  mainWindows: FakeWindow[]
  captureWindows: FakeWindow[]
  trays: TrayHarness[]
  notifications: NotificationHarness[]
  quitEvents: PreventableEvent[]
  settingsOptions: ServiceOptions[]
  waitingOptions: TaskOptions[]
  overviewOptions: TaskOptions[]
  pendingBackgroundTask: Deferred<void>
  pendingToolShutdown: Deferred<void>
  pendingCommandAbort: Deferred<void>
  pendingCaptureRead: Deferred<unknown>
  pendingDialog: Deferred<{ canceled: boolean, filePaths: string[] }>
  focusCaptureInput: Mock
  ideaStore: { list: Mock, create: Mock, update: Mock, delete: Mock }
  secretSentinel: string
  emitAppEvent: (name: string, ...args: unknown[]) => void
  app: { quit: Mock }
  globalShortcut: { unregisterAll: Mock }
  ipcMain: { handle: Mock }
  dialog: { showOpenDialog: Mock }
  toolRunner?: { abortAll: Mock }
  toolIpcOptions?: ToolIpcOptions
  toolIpcLifecycle?: { close(): void, shutdown(): Promise<void> }
  consoleError?: Mock
  taskScopeModule?: typeof import('../src/shared/task-scope.js')
}

type PreventableEvent = {
  defaultPrevented: boolean
  preventDefault: ReturnType<typeof vi.fn>
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function preventableEvent(): PreventableEvent {
  const event = {
    defaultPrevented: false,
    preventDefault: vi.fn(() => { event.defaultPrevented = true })
  }
  return event
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 24; index += 1) await Promise.resolve()
}

let nextWebContentsId = 1

class FakeWebContents extends EventEmitter {
  readonly id = nextWebContentsId++
  readonly mainFrame = {}
  readonly session = { setPermissionRequestHandler: vi.fn() }
  readonly setWindowOpenHandler = vi.fn()
  readonly send = vi.fn()
  readonly isLoading = vi.fn(() => false)
  readonly executeJavaScript: ReturnType<typeof vi.fn>

  constructor(execute: () => Promise<unknown> = async () => undefined) {
    super()
    this.executeJavaScript = vi.fn(() => execute())
  }
}

class FakeWindow extends EventEmitter {
  readonly webContents: FakeWebContents
  readonly loadFile = vi.fn(async () => undefined)
  readonly loadURL = vi.fn(async () => undefined)
  readonly show = vi.fn()
  readonly focus = vi.fn()
  readonly hide = vi.fn()
  readonly restore = vi.fn()
  destroyed = false
  minimized = false

  constructor(execute: () => Promise<unknown> = async () => undefined) {
    super()
    this.webContents = new FakeWebContents(execute)
  }

  isDestroyed(): boolean { return this.destroyed }
  isMinimized(): boolean { return this.minimized }
}

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

async function createHarness(options: { failDraftRemoval?: boolean } = {}) {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubEnv('ARCKEEP_SCREENSHOT', '')
  vi.stubEnv('ARCKEEP_SCREENSHOT_SCENE', '')
  vi.stubEnv('ARCKEEP_DEV', '')
  vi.stubEnv('VITE_DEV_SERVER_URL', '')
  vi.stubEnv('ARCKEEP_TEST_HOOKS', '')

  const rootDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'arckeep-app-lifecycle-'))
  temporaryDirectories.push(rootDirectory)
  const appDataDirectory = path.join(rootDirectory, 'app-data')
  fs.mkdirSync(appDataDirectory, { recursive: true })
  const userDataDirectory = path.join(appDataDirectory, 'Arckeep')
  const paths = new Map<string, string>([['appData', appDataDirectory]])
  const listeners = new Map<string, MainHandler[]>()
  const handlers = new Map<string, MainHandler>()
  const quitEvents: PreventableEvent[] = []
  const pendingBackgroundTask = deferred<void>()
  const pendingToolShutdown = deferred<void>()
  const pendingCommandAbort = deferred<void>()
  const pendingCaptureRead = deferred<unknown>()
  const pendingDialog = deferred<{ canceled: boolean, filePaths: string[] }>()
  const secretSentinel = 'SENSITIVE_GLOBALSHORTCUT_EXCEPTION_BODY_9a17d4'
  const emitAppEvent = (name: string, ...args: unknown[]) => {
    for (const listener of listeners.get(name) ?? []) listener(...args)
  }

  const app = {
    commandLine: { appendSwitch: vi.fn() },
    isPackaged: false,
    setName: vi.fn(),
    setPath: vi.fn((name: string, value: string) => {
      paths.set(name, value)
      if (name === 'userData') fs.mkdirSync(value, { recursive: true })
    }),
    getPath: vi.fn((name: string) => paths.get(name) ?? rootDirectory),
    getAppPath: vi.fn(() => rootDirectory),
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(() => Promise.resolve()),
    isReady: vi.fn(() => true),
    disableHardwareAcceleration: vi.fn(),
    on: vi.fn((name: string, listener: MainHandler) => {
      const handlersForEvent = listeners.get(name) ?? []
      handlersForEvent.push(listener)
      listeners.set(name, handlersForEvent)
      return app
    }),
    quit: vi.fn(() => {
      const event = preventableEvent()
      quitEvents.push(event)
      emitAppEvent('before-quit', event)
    }),
    exit: vi.fn()
  }

  const globalShortcut = {
    register: vi.fn(() => true),
    isRegistered: vi.fn(() => false),
    unregister: vi.fn(),
    unregisterAll: vi.fn(() => { throw new Error(secretSentinel) })
  }

  const ipcMain = {
    handle: vi.fn((channel: string, handler: MainHandler) => {
      handlers.set(channel, handler)
    })
  }

  const dialog = {
    showOpenDialog: vi.fn(() => pendingDialog.promise),
    showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined }))
  }

  const harness: LifecycleHarness = {
    rootDirectory,
    appDataDirectory,
    userDataDirectory,
    paths,
    listeners,
    handlers,
    mainWindows: [],
    captureWindows: [],
    trays: [],
    notifications: [],
    quitEvents,
    settingsOptions: [],
    waitingOptions: [],
    overviewOptions: [],
    pendingBackgroundTask,
    pendingToolShutdown,
    pendingCommandAbort,
    pendingCaptureRead,
    pendingDialog,
    focusCaptureInput: vi.fn(),
    ideaStore: {
      list: vi.fn(() => []),
      create: vi.fn(() => ({ id: 'idea-1' })),
      update: vi.fn(),
      delete: vi.fn()
    },
    secretSentinel,
    emitAppEvent,
    app,
    globalShortcut,
    ipcMain,
    dialog
  }

  const menu = {
    setApplicationMenu: vi.fn(),
    buildFromTemplate: vi.fn((template: unknown) => template)
  }

  class MainWindow extends FakeWindow {
    constructor(_options: unknown) {
      super()
      harness.mainWindows.push(this)
    }
  }

  class FakeTray extends EventEmitter {
    contextMenu: TrayMenuEntry[] = []
    readonly setToolTip = vi.fn()
    readonly setContextMenu = vi.fn((value: unknown) => {
      this.contextMenu = value as TrayMenuEntry[]
    })
    readonly destroy = vi.fn()

    constructor(_icon: unknown) {
      super()
      harness.trays.push(this)
    }
  }

  class FakeNotification {
    static isSupported = vi.fn(() => true)
    readonly on = vi.fn()
    readonly show = vi.fn()
    constructor(readonly options: { title: string, body: string }) {
      harness.notifications.push(this)
    }
  }

  const electron = {
    app,
    BrowserWindow: MainWindow,
    Menu: menu,
    Notification: FakeNotification,
    Tray: FakeTray,
    globalShortcut,
    ipcMain,
    nativeImage: { createFromPath: vi.fn(() => ({ isEmpty: () => false })) },
    safeStorage: {
      isEncryptionAvailable: vi.fn(() => false),
      encryptString: vi.fn(),
      decryptString: vi.fn()
    },
    shell: { openExternal: vi.fn(async () => '') },
    dialog,
    clipboard: { writeText: vi.fn() }
  }

  vi.doMock('electron', () => electron)
  vi.doMock('../src/main/capture-window.js', () => ({
    createCaptureWindow: vi.fn(() => {
      const window = new FakeWindow(() => harness.pendingCaptureRead.promise)
      harness.captureWindows.push(window)
      return window
    }),
    focusCaptureInput: harness.focusCaptureInput,
    showSavedToast: vi.fn(() => new FakeWindow())
  }))
  vi.doMock('../src/main/settings-service.js', () => ({
    SettingsService: class {
      constructor(options: unknown) { harness.settingsOptions.push(options as ServiceOptions) }
      init() {}
      hotkeyUnavailableCombo() { return null }
      getSettings() { return { watchedRepos: [], waiting: { localRepoDirs: [] }, toolShelfJson: '' } }
      getState() { return undefined }
    }
  }))
  vi.doMock('../src/main/waiting-service.js', () => ({
    WaitingService: class {
      constructor(_settings: unknown, _paths: unknown, options: unknown) { harness.waitingOptions.push(options as TaskOptions) }
      current() { return undefined }
      observedGithubRepos() { return [] }
      observedLocalLinks() { return [] }
    }
  }))
  vi.doMock('../src/main/overview-service.js', () => ({
    OverviewService: class {
      constructor(_settings: unknown, _file: unknown, options: unknown) { harness.overviewOptions.push(options as TaskOptions) }
      current() { return undefined }
    }
  }))
  vi.doMock('../src/main/tool-runner.js', () => ({
    ToolRunner: class {
      readonly close = vi.fn()
      readonly abortAll = vi.fn(() => harness.pendingCommandAbort.promise)
      readonly start = vi.fn(() => 'run-1')
      readonly abort = vi.fn(() => true)
      constructor(_emit: unknown) { harness.toolRunner = this }
    }
  }))
  vi.doMock('../src/main/tool-rehearse.js', () => ({
    createToolRehearsals: vi.fn(() => ({
      close: vi.fn(),
      rehearse: vi.fn(async () => ({ status: 'unavailable', summary: '', canConfirm: true })),
      cancel: vi.fn(async () => undefined),
      cancelAll: vi.fn(() => harness.pendingToolShutdown.promise)
    }))
  }))
  vi.doMock('../src/main/todos/store.js', () => ({
    TodoStore: class {
      listTodos() { return [] }
      listWaitingTodos() { return [] }
    }
  }))
  vi.doMock('../src/main/ideas/store.js', () => ({
    IdeaStore: class {
      list = harness.ideaStore.list
      create = harness.ideaStore.create
      update = harness.ideaStore.update
      delete = harness.ideaStore.delete
      constructor(_options: unknown) {}
    }
  }))
  vi.doMock('../src/main/tool-ipc.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/main/tool-ipc.js')>()
    return {
      ...actual,
      registerToolIpc: vi.fn((options: ToolIpcOptions) => {
        harness.toolIpcOptions = options
        const lifecycle = actual.registerToolIpc(options)
        harness.toolIpcLifecycle = lifecycle
        return lifecycle
      })
    }
  })

  harness.consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.doMock('../src/main/todos/draft.js', async importOriginal => {
    const actual = await importOriginal<typeof import('../src/main/todos/draft.js')>()
    return { ...actual, clearCaptureDraft: (file: string) => {
      if (options.failDraftRemoval) throw new Error('fixture removal denied')
      actual.clearCaptureDraft(file)
    } }
  })
  harness.taskScopeModule = await import('../src/shared/task-scope.js')
  await import('../src/main/index.js')
  await flushMicrotasks()
  return harness
}

describe('主进程退出生命周期', () => {
  it('APO 评论、决策回复和只读核对只接收主窗口主 frame，并在退出后拒绝调用', async () => {
    const harness = await createHarness()
    harness.settingsOptions[0].onHotkey()
    const main = harness.mainWindows[0].webContents
    const capture = harness.captureWindows[0].webContents
    for (const channel of [IpcChannel.commentWaitingApo, IpcChannel.checkWaitingApo, IpcChannel.replyWaitingDecision, IpcChannel.checkWaitingDecision]) {
      const handle = harness.handlers.get(channel)!
      expect(() => handle({ sender: capture, senderFrame: capture.mainFrame }, 'row', 'action')).toThrow('unexpected renderer')
      expect(() => handle({ sender: { id: -9 }, senderFrame: main.mainFrame }, 'row', 'action')).toThrow('unexpected renderer')
      expect(() => handle({ sender: main, senderFrame: {} }, 'row', 'action')).toThrow('child frame')
    }
    harness.emitAppEvent('before-quit', preventableEvent())
    for (const channel of [IpcChannel.commentWaitingApo, IpcChannel.checkWaitingApo, IpcChannel.replyWaitingDecision, IpcChannel.checkWaitingDecision]) {
      expect(() => harness.handlers.get(channel)!({ sender: main, senderFrame: main.mainFrame }, 'row', 'action')).toThrow('应用正在关闭')
    }
    harness.pendingToolShutdown.resolve(undefined)
    harness.pendingCommandAbort.resolve(undefined)
    await flushMicrotasks()
  })
  it('提示词接口只允许主窗口，并在退出后拒绝写入，已有提示词保持完整', async () => {
    const harness = await createHarness()
    const mainEvent = { sender: harness.mainWindows[0].webContents }
    const create = harness.handlers.get(IpcChannel.createPrompt)!
    const list = harness.handlers.get(IpcChannel.listPrompts)!
    const draft = { title: '审查提示词', text: '  第一行\r\n第二行\n', tags: ['开发'], pinned: true }
    const saved = await create(mainEvent, draft)
    expect(saved).toMatchObject({ ok: true, data: draft })
    expect(harness.mainWindows[0].webContents.send).toHaveBeenCalledWith(IpcChannel.promptsChanged)
    expect(await list(mainEvent)).toMatchObject({ ok: true, data: [{ text: draft.text }] })
    const file = path.join(harness.userDataDirectory, 'prompts.json')
    const before = fs.readFileSync(file, 'utf8')

    harness.settingsOptions[0].onHotkey()
    const captureEvent = { sender: harness.captureWindows[0].webContents }
    expect(await create(captureEvent, draft)).toEqual({ ok: false, error: '提示词请求未授权' })
    harness.emitAppEvent('before-quit', preventableEvent())
    expect(await create(mainEvent, draft)).toEqual({ ok: false, error: '提示词请求未授权' })
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it.each(['before-quit', 'tray'] as const)('等待全部退出清理并在 %s 路径只完成一次退出', async route => {
    const harness = await createHarness()
    expect(harness.mainWindows).toHaveLength(1)
    expect(harness.trays).toHaveLength(1)
    expect(harness.handlers.has(IpcChannel.getState)).toBe(true)

    const settingsOptions = harness.settingsOptions[0]
    const taskScopeModule = harness.taskScopeModule!
    const toolIpcOptions = harness.toolIpcOptions!
    const waitingOptions = harness.waitingOptions[0]
    const overviewOptions = harness.overviewOptions[0]
    const scope = settingsOptions.tasks
    expect(scope).toBeInstanceOf(taskScopeModule.TaskScope)
    expect(waitingOptions.tasks).toBe(scope)
    expect(overviewOptions.tasks).toBe(scope)
    expect(toolIpcOptions.tasks).toBe(scope)

    let backgroundTaskStarted = false
    const backgroundTask = scope.run(async () => {
      backgroundTaskStarted = true
      await harness.pendingBackgroundTask.promise
    }, '受控退出任务')
    void backgroundTask.catch(() => undefined)
    await flushMicrotasks()
    expect(backgroundTaskStarted).toBe(true)
    const drain = vi.spyOn(scope, 'drain')

    const onHotkey = settingsOptions.onHotkey as () => void
    onHotkey()
    expect(harness.captureWindows).toHaveLength(1)
    const captureWindow = harness.captureWindows[0]

    const sender = harness.mainWindows[0].webContents
    const invokePickFolder = harness.handlers.get(IpcChannel.pickFolder)
    expect(invokePickFolder).toBeTypeOf('function')
    const pendingDialog = Promise.resolve(invokePickFolder!({ sender })).then(
      () => ({ status: 'fulfilled' as const }),
      error => ({ status: 'rejected' as const, error })
    )
    await flushMicrotasks()
    expect(harness.dialog.showOpenDialog).toHaveBeenCalledOnce()
    expect(harness.handlers.has(IpcChannel.pickFolder)).toBe(true)
    expect(harness.ipcMain.handle).toHaveBeenCalled()

    let beforeQuitEvent: PreventableEvent | undefined
    if (route === 'before-quit') {
      beforeQuitEvent = preventableEvent()
      harness.emitAppEvent('before-quit', beforeQuitEvent)
      expect(beforeQuitEvent.preventDefault).toHaveBeenCalledOnce()
    } else {
      const quitEntry = harness.trays[0].contextMenu.find((entry: { label: string }) => entry.label === '退出')
      expect(quitEntry?.click).toBeTypeOf('function')
      quitEntry.click()
      expect(harness.app.quit).toHaveBeenCalledTimes(1)
      expect(harness.quitEvents[0].defaultPrevented).toBe(true)
    }

    const repeatedBeforeQuit = preventableEvent()
    harness.emitAppEvent('before-quit', repeatedBeforeQuit)
    expect(repeatedBeforeQuit.preventDefault).toHaveBeenCalledOnce()

    expect(scope.isClosing).toBe(true)
    expect(scope.signal.aborted).toBe(true)
    const dialogOutcome = await pendingDialog
    expect(dialogOutcome.status).toBe('rejected')
    if (dialogOutcome.status === 'rejected') {
      expect(dialogOutcome.error).toMatchObject({ name: 'AbortError' })
    }
    const captureClose = preventableEvent()
    captureWindow.emit('close', captureClose)
    expect(captureClose.preventDefault).toHaveBeenCalledOnce()

    onHotkey()
    expect(harness.captureWindows).toHaveLength(1)
    expect(harness.focusCaptureInput).not.toHaveBeenCalled()

    const createIdea = harness.handlers.get(IpcChannel.createIdea)
    expect(createIdea).toBeTypeOf('function')
    const ideaResult = await createIdea!({ sender }, { text: '退出后不应创建' }) as { ok: boolean }
    expect(ideaResult.ok).toBe(false)
    expect(harness.ideaStore.create).not.toHaveBeenCalled()

    const latePickFolder = Promise.resolve().then(() => invokePickFolder!({ sender }))
    await expect(latePickFolder).rejects.toMatchObject({ name: 'AbortError' })
    expect(harness.dialog.showOpenDialog).toHaveBeenCalledOnce()
    expect(toolIpcOptions.tasks).toBe(scope)

    await flushMicrotasks()
    expect(drain).toHaveBeenCalledOnce()
    expect(toolIpcOptions.rehearsals.cancelAll).toHaveBeenCalledOnce()
    expect(harness.toolRunner?.abortAll).toHaveBeenCalledOnce()
    expect(captureWindow.webContents.executeJavaScript).toHaveBeenCalledOnce()
    expect(harness.globalShortcut.unregisterAll).toHaveBeenCalledOnce()
    expect(harness.toolIpcLifecycle).toBeDefined()
    expect(harness.app.quit).toHaveBeenCalledTimes(route === 'tray' ? 1 : 0)
    expect(scope.pendingCount).toBe(1)

    const initialQuitCalls = route === 'tray' ? 1 : 0
    harness.pendingBackgroundTask.resolve(undefined)
    await flushMicrotasks()
    expect(harness.app.quit).toHaveBeenCalledTimes(initialQuitCalls)

    harness.pendingToolShutdown.resolve(undefined)
    await flushMicrotasks()
    expect(harness.app.quit).toHaveBeenCalledTimes(initialQuitCalls)

    harness.pendingCommandAbort.resolve(undefined)
    await flushMicrotasks()
    expect(harness.app.quit).toHaveBeenCalledTimes(initialQuitCalls)

    harness.pendingCaptureRead.resolve({ text: '保留退出前草稿', repo: '', waiting: false })
    await flushMicrotasks()
    expect(harness.app.quit).toHaveBeenCalledTimes(initialQuitCalls + 1)

    const quitEvents = harness.quitEvents as PreventableEvent[]
    expect(quitEvents).toHaveLength(route === 'tray' ? 2 : 1)
    expect(quitEvents.at(-1)?.defaultPrevented).toBe(false)
    if (route === 'tray') expect(quitEvents[0].defaultPrevented).toBe(true)
    expect(harness.globalShortcut.unregisterAll).toHaveBeenCalledOnce()
    expect(harness.trays[0].destroy).toHaveBeenCalledOnce()

    const lateClose = preventableEvent()
    captureWindow.emit('close', lateClose)
    expect(lateClose.preventDefault).not.toHaveBeenCalled()

    const diagnostics = fs.readFileSync(
      path.join(harness.userDataDirectory, 'lifecycle-errors.jsonl'),
      'utf8'
    )
    const logOutput = harness.consoleError!.mock.calls.flatMap((args: unknown[]) => args.map(String)).join('\n')
    expect(diagnostics).not.toContain(harness.secretSentinel)
    expect(logOutput).not.toContain(harness.secretSentinel)
    expect(diagnostics).toContain('全局热键停止失败')
    expect(harness.notifications).toHaveLength(1)
    expect(harness.notifications[0].options.body).toContain('诊断信息已记录')

    harness.emitAppEvent('before-quit', preventableEvent())
    expect(harness.app.quit).toHaveBeenCalledTimes(initialQuitCalls + 1)
  })

  it('成功创建后捕获窗口已消失仍清理旧草稿，避免退出时留下副本', async () => {
    const harness = await createHarness()
    harness.settingsOptions[0].onHotkey()
    const captureWindow = harness.captureWindows[0]
    const draftFile = path.join(harness.userDataDirectory, 'capture-draft.json')
    fs.writeFileSync(draftFile, '{"kind":"idea","text":"已成功创建"}', 'utf8')
    const created = await harness.handlers.get(IpcChannel.createIdea)!({ sender: captureWindow.webContents }, { text: '已成功创建' })
    expect(created.ok).toBe(true)
    captureWindow.destroyed = true
    captureWindow.emit('closed')
    harness.emitAppEvent('before-quit', preventableEvent())
    harness.pendingToolShutdown.resolve(undefined)
    harness.pendingCommandAbort.resolve(undefined)
    await flushMicrotasks()
    expect(harness.app.quit).toHaveBeenCalledOnce()
    expect(fs.existsSync(draftFile)).toBe(false)
    expect(captureWindow.webContents.executeJavaScript).not.toHaveBeenCalled()
  })

  it('成功创建后意外关闭再打开，不恢复已经入库的草稿且可记录新的草稿', async () => {
    const harness = await createHarness()
    harness.settingsOptions[0].onHotkey()
    const firstWindow = harness.captureWindows[0]
    const draftFile = path.join(harness.userDataDirectory, 'capture-draft.json')
    fs.writeFileSync(draftFile, '{"kind":"idea","text":"已成功创建"}', 'utf8')
    const created = await harness.handlers.get(IpcChannel.createIdea)!({ sender: firstWindow.webContents }, { text: '已成功创建' })
    expect(created.ok).toBe(true)
    expect(fs.existsSync(draftFile)).toBe(false)
    firstWindow.destroyed = true
    firstWindow.emit('closed')
    harness.settingsOptions[0].onHotkey()
    const event = { sender: harness.captureWindows[1].webContents }
    expect(await harness.handlers.get(IpcChannel.getCaptureDraft)!(event)).toEqual({ text: '', repo: '', waiting: false })
    await harness.handlers.get(IpcChannel.setCaptureDraft)!(event, { kind: 'idea', text: '下一条未保存', repo: '', waiting: false })
    expect(await harness.handlers.get(IpcChannel.getCaptureDraft)!(event)).toEqual({ kind: 'idea', text: '下一条未保存', repo: '', waiting: false })
    expect(harness.ideaStore.create).toHaveBeenCalledOnce()
  })

  it('草稿删除失败也回报创建成功，并在本次运行中抑制旧草稿恢复', async () => {
    const harness = await createHarness({ failDraftRemoval: true })
    harness.settingsOptions[0].onHotkey()
    const firstWindow = harness.captureWindows[0]
    const draftFile = path.join(harness.userDataDirectory, 'capture-draft.json')
    fs.writeFileSync(draftFile, '{"kind":"idea","text":"已成功创建"}', 'utf8')
    const created = await harness.handlers.get(IpcChannel.createIdea)!({ sender: firstWindow.webContents }, { text: '已成功创建' })
    expect(created.ok).toBe(true)
    expect(fs.existsSync(draftFile)).toBe(true)
    firstWindow.destroyed = true
    firstWindow.emit('closed')
    harness.settingsOptions[0].onHotkey()
    expect(await harness.handlers.get(IpcChannel.getCaptureDraft)!({ sender: harness.captureWindows[1].webContents }))
      .toEqual({ text: '', repo: '', waiting: false })
    expect(harness.ideaStore.create).toHaveBeenCalledOnce()
  })

  it('捕获窗口仍在加载时跳过页面快照并保留已有草稿', async () => {
    const harness = await createHarness()
    const settingsOptions = harness.settingsOptions[0]
    const draftFile = path.join(harness.userDataDirectory, 'capture-draft.json')
    const existingDraft = '{"text":"已有草稿"}\n'
    fs.writeFileSync(draftFile, existingDraft, 'utf8')

    const onHotkey = settingsOptions.onHotkey as () => void
    onHotkey()
    const captureWindow = harness.captureWindows[0]
    captureWindow.webContents.isLoading.mockReturnValue(true)

    harness.emitAppEvent('before-quit', preventableEvent())
    await flushMicrotasks()
    expect(captureWindow.webContents.isLoading).toHaveBeenCalledOnce()
    expect(captureWindow.webContents.executeJavaScript).not.toHaveBeenCalled()
    expect(harness.toolIpcOptions?.rehearsals.cancelAll).toHaveBeenCalledOnce()
    expect(harness.toolRunner?.abortAll).toHaveBeenCalledOnce()
    expect(harness.app.quit).not.toHaveBeenCalled()

    harness.pendingToolShutdown.resolve(undefined)
    harness.pendingCommandAbort.resolve(undefined)
    await flushMicrotasks()

    expect(harness.app.quit).toHaveBeenCalledOnce()
    expect(fs.readFileSync(draftFile, 'utf8')).toBe(existingDraft)
  })
})
