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
