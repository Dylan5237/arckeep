import { describe, expect, it, vi, afterEach } from 'vitest'
import { createGracefulShutdownHandler } from '../src/main/graceful-shutdown.js'

afterEach(() => { vi.useRealTimers() })

describe('createGracefulShutdownHandler', () => {
  it('waits for asynchronous cleanup before allowing Electron to quit', async () => {
    let releaseCleanup: () => void = () => {}
    let quitCalls = 0
    let prevented = 0
    const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve })
    const handler = createGracefulShutdownHandler({
      quit: () => { quitCalls += 1 },
      shutdown: () => cleanup
    })
    const event = { preventDefault: () => { prevented += 1 } }

    const first = handler(event)
    const second = handler(event)
    expect(first).toBe(second)
    expect(prevented).toBe(2)
    expect(quitCalls).toBe(0)

    releaseCleanup()
    await first
    expect(quitCalls).toBe(1)

    handler(event)
    expect(prevented).toBe(2)
    expect(quitCalls).toBe(1)
  })

  it('requires quit and shutdown functions', () => {
    expect(() => createGracefulShutdownHandler({
      quit: undefined as unknown as () => void,
      shutdown: () => {}
    })).toThrow(/must be functions/)
  })

  it('reports a bounded shutdown timeout and quits once despite late cleanup completion', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const cleanup = new Promise<void>(resolve => { finish = resolve })
    const quit = vi.fn()
    const onError = vi.fn()
    const handler = createGracefulShutdownHandler({ quit, shutdown: () => cleanup, onError, timeoutMs: 30 })
    const first = handler({ preventDefault: vi.fn() })
    expect(handler({ preventDefault: vi.fn() })).toBe(first)
    await vi.advanceTimersByTimeAsync(30)
    await first
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: '应用关闭清理超时' }))
    expect(quit).toHaveBeenCalledTimes(1)
    finish()
    await Promise.resolve()
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('continues quitting after a cleanup error even if error reporting fails', async () => {
    const quit = vi.fn()
    const handler = createGracefulShutdownHandler({ quit,
      shutdown: async () => { throw new Error('cleanup failure') },
      onError: () => { throw new Error('reporting failure') }
    })
    await handler()
    expect(quit).toHaveBeenCalledTimes(1)
  })
})
