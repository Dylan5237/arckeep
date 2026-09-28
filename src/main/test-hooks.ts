export type TestHookAction = 'close' | 'show' | 'quit' | 'capture' | 'todos' | 'hotkey-fail'

export interface TrayActions {
  closeWindow(): void
  showWindow(): void
  quit(): void
}

export interface TestHookExtras {
  openCapture?: () => void
  readTodos?: () => unknown
  /** Called only for the `todos` action, so a checker can read a dump file. */
  onTodos?: (todos: unknown) => void
  /** Marks the capture hotkey as unregistered. Ignored unless hooks are enabled. */
  failHotkey?: () => void
}

const ACTIONS = new Set<TestHookAction>(['close', 'show', 'quit', 'capture', 'todos', 'hotkey-fail'])

/** Test hooks stay off unless this exact value is set. */
export function testHooksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARCKEEP_TEST_HOOKS === '1'
}

/** Startup flag: the initial globalShortcut.register must fail. Off unless hooks are enabled. */
export function hotkeyFailureRequested(env: NodeJS.ProcessEnv, argv: readonly string[]): boolean {
  return testHooksEnabled(env) && argv.includes('--arckeep-test=hotkey-fail')
}

export function parseTestHookName(value: unknown): TestHookAction | null {
  if (typeof value !== 'string') return null
  if (ACTIONS.has(value as TestHookAction)) return value as TestHookAction
  return null
}

export function parseTestHookAction(argv: readonly string[]): TestHookAction | null {
  for (const arg of argv) {
    if (!arg.startsWith('--arckeep-test=')) continue
    return parseTestHookName(arg.slice('--arckeep-test='.length))
  }
  return null
}

export function runTestHook(
  action: TestHookAction,
  actions: TrayActions,
  extras: TestHookExtras = {}
): unknown {
  if (action === 'close') {
    actions.closeWindow()
    return null
  }
  if (action === 'show') {
    actions.showWindow()
    return null
  }
  if (action === 'quit') {
    actions.quit()
    return null
  }
  if (action === 'capture') {
    extras.openCapture?.()
    return null
  }
  if (action === 'hotkey-fail') {
    extras.failHotkey?.()
    return null
  }
  const todos = extras.readTodos?.() ?? []
  extras.onTodos?.(todos)
  return todos
}

export function dispatchTestHook(
  env: NodeJS.ProcessEnv,
  action: TestHookAction | null,
  actions: TrayActions,
  extras: TestHookExtras = {}
): boolean {
  if (!testHooksEnabled(env) || !action) return false
  runTestHook(action, actions, extras)
  return true
}

export interface TestHookHandlers {
  close(): void
  show(): void
  quit(): void
  openCapture(): void
  readTodos(): unknown
  failHotkey(): void
}

export interface TestHookInstaller {
  argv: readonly string[]
  actions: TrayActions
  extras?: TestHookExtras
  expose(handlers: TestHookHandlers): void
  registerIpc(handler: (action: unknown) => unknown): void
}

/** Registers nothing and ignores flags unless ARCKEEP_TEST_HOOKS is exactly "1". */
export function installTrayTestHooks(env: NodeJS.ProcessEnv, host: TestHookInstaller): { registered: boolean } {
  if (!testHooksEnabled(env)) return { registered: false }
  const extras = host.extras ?? {}
  const handlers: TestHookHandlers = {
    close: () => runTestHook('close', host.actions, extras),
    show: () => runTestHook('show', host.actions, extras),
    quit: () => runTestHook('quit', host.actions, extras),
    openCapture: () => runTestHook('capture', host.actions, extras),
    readTodos: () => extras.readTodos?.() ?? [],
    failHotkey: () => runTestHook('hotkey-fail', host.actions, extras)
  }
  host.expose(handlers)
  host.registerIpc(action => {
    const parsed = parseTestHookName(action)
    if (!parsed) return null
    return runTestHook(parsed, host.actions, extras)
  })
  dispatchTestHook(env, parseTestHookAction(host.argv), host.actions, extras)
  return { registered: true }
}
