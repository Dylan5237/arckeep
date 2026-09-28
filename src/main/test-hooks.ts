export type TestHookAction = 'close' | 'show' | 'quit'

export interface TrayActions {
  closeWindow(): void
  showWindow(): void
  quit(): void
}

const ACTIONS = new Set<TestHookAction>(['close', 'show', 'quit'])

/** Test hooks stay off unless this exact value is set. */
export function testHooksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARCKEEP_TEST_HOOKS === '1'
}

export function parseTestHookAction(argv: readonly string[]): TestHookAction | null {
  for (const arg of argv) {
    if (!arg.startsWith('--arckeep-test=')) continue
    const value = arg.slice('--arckeep-test='.length)
    if (ACTIONS.has(value as TestHookAction)) return value as TestHookAction
    return null
  }
  return null
}

export function runTestHook(action: TestHookAction, actions: TrayActions): void {
  if (action === 'close') actions.closeWindow()
  else if (action === 'show') actions.showWindow()
  else actions.quit()
}

export function dispatchTestHook(
  env: NodeJS.ProcessEnv,
  action: TestHookAction | null,
  actions: TrayActions
): boolean {
  if (!testHooksEnabled(env) || !action) return false
  runTestHook(action, actions)
  return true
}

export interface TestHookInstaller {
  argv: readonly string[]
  actions: TrayActions
  expose(handlers: { close(): void, show(): void, quit(): void }): void
  registerIpc(handler: (action: unknown) => void): void
}

/** Registers nothing and ignores flags unless ARCKEEP_TEST_HOOKS is exactly "1". */
export function installTrayTestHooks(env: NodeJS.ProcessEnv, host: TestHookInstaller): { registered: boolean } {
  if (!testHooksEnabled(env)) return { registered: false }
  const handlers = {
    close: () => runTestHook('close', host.actions),
    show: () => runTestHook('show', host.actions),
    quit: () => runTestHook('quit', host.actions)
  }
  host.expose(handlers)
  host.registerIpc(action => {
    const parsed = action === 'close' || action === 'show' || action === 'quit' ? action : null
    dispatchTestHook(env, parsed, host.actions)
  })
  dispatchTestHook(env, parseTestHookAction(host.argv), host.actions)
  return { registered: true }
}
