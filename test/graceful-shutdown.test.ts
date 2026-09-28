import { describe, expect, it } from 'vitest'
import { createGracefulShutdownHandler } from '../src/main/graceful-shutdown.js'

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
})
