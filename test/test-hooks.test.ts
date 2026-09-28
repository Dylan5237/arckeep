import { describe, expect, it, vi } from 'vitest'
import {
  dispatchTestHook,
  installTrayTestHooks,
  parseTestHookAction,
  runTestHook,
  testHooksEnabled,
  type TrayActions
} from '../src/main/test-hooks.js'

describe('tray test hooks', () => {
  it('stays disabled unless ARCKEEP_TEST_HOOKS is exactly 1', () => {
    expect(testHooksEnabled({})).toBe(false)
    expect(testHooksEnabled({ ARCKEEP_TEST_HOOKS: 'true' })).toBe(false)
    expect(testHooksEnabled({ ARCKEEP_TEST_HOOKS: '1' })).toBe(true)
  })

  it('parses the three tray actions and ignores anything else', () => {
    expect(parseTestHookAction(['Arckeep.exe', '--arckeep-test=close'])).toBe('close')
    expect(parseTestHookAction(['--arckeep-test=show'])).toBe('show')
    expect(parseTestHookAction(['--arckeep-test=quit'])).toBe('quit')
    expect(parseTestHookAction(['--arckeep-test=nope'])).toBe(null)
    expect(parseTestHookAction([])).toBe(null)
  })

  it('does nothing when ARCKEEP_TEST_HOOKS is not 1: flags and IPC stay unregistered', () => {
    const actions: TrayActions = {
      closeWindow: vi.fn(),
      showWindow: vi.fn(),
      quit: vi.fn()
    }
    const expose = vi.fn()
    const registerIpc = vi.fn()
    const installed = installTrayTestHooks({}, {
      argv: ['Arckeep.exe', '--arckeep-test=quit'],
      actions,
      expose,
      registerIpc
    })
    expect(installed.registered).toBe(false)
    expect(expose).not.toHaveBeenCalled()
    expect(registerIpc).not.toHaveBeenCalled()
    expect(dispatchTestHook({}, 'quit', actions)).toBe(false)
    expect(dispatchTestHook({ ARCKEEP_TEST_HOOKS: 'true' }, 'close', actions)).toBe(false)
    expect(actions.quit).not.toHaveBeenCalled()
    expect(actions.closeWindow).not.toHaveBeenCalled()
    expect(actions.showWindow).not.toHaveBeenCalled()
  })

  it('dispatches onto the same close, show, and quit functions the tray uses', () => {
    const actions: TrayActions = {
      closeWindow: vi.fn(),
      showWindow: vi.fn(),
      quit: vi.fn()
    }
    runTestHook('close', actions)
    runTestHook('show', actions)
    runTestHook('quit', actions)
    expect(actions.closeWindow).toHaveBeenCalledOnce()
    expect(actions.showWindow).toHaveBeenCalledOnce()
    expect(actions.quit).toHaveBeenCalledOnce()
  })
})
