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

  it('parses tray actions plus capture and todo reads, and ignores anything else', () => {
    expect(parseTestHookAction(['Arckeep.exe', '--arckeep-test=close'])).toBe('close')
    expect(parseTestHookAction(['--arckeep-test=show'])).toBe('show')
    expect(parseTestHookAction(['--arckeep-test=quit'])).toBe('quit')
    expect(parseTestHookAction(['--arckeep-test=capture'])).toBe('capture')
    expect(parseTestHookAction(['--arckeep-test=todos'])).toBe('todos')
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

    const openCapture = vi.fn()
    const onTodos = vi.fn()
    expect(dispatchTestHook({}, 'capture', actions, { openCapture, readTodos: () => ['secret'], onTodos })).toBe(false)
    expect(dispatchTestHook({ ARCKEEP_TEST_HOOKS: 'true' }, 'todos', actions, { openCapture, onTodos })).toBe(false)
    expect(openCapture).not.toHaveBeenCalled()
    expect(onTodos).not.toHaveBeenCalled()
  })

  it('opens capture and returns store contents only when hooks are enabled', () => {
    const actions: TrayActions = {
      closeWindow: vi.fn(),
      showWindow: vi.fn(),
      quit: vi.fn()
    }
    const openCapture = vi.fn()
    const onTodos = vi.fn()
    const todos = [{ id: '1', text: '记一下' }]
    let exposed: { openCapture(): void, readTodos(): unknown } | null = null
    let ipc: ((action: unknown) => unknown) | null = null
    const installed = installTrayTestHooks({ ARCKEEP_TEST_HOOKS: '1' }, {
      argv: ['Arckeep.exe', '--arckeep-test=capture'],
      actions,
      extras: {
        openCapture,
        readTodos: () => todos,
        onTodos
      },
      expose(handlers) {
        exposed = handlers
      },
      registerIpc(handler) {
        ipc = handler
      }
    })
    expect(installed.registered).toBe(true)
    expect(openCapture).toHaveBeenCalledOnce()
    expect(exposed).not.toBeNull()
    exposed?.openCapture()
    expect(openCapture).toHaveBeenCalledTimes(2)
    expect(exposed?.readTodos()).toEqual(todos)
    expect(onTodos).not.toHaveBeenCalled()
    expect(ipc?.('todos')).toEqual(todos)
    expect(onTodos).toHaveBeenCalledWith(todos)
    expect(ipc?.('nope')).toBeNull()
    expect(dispatchTestHook({ ARCKEEP_TEST_HOOKS: '1' }, 'todos', actions, {
      readTodos: () => todos,
      onTodos
    })).toBe(true)
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
