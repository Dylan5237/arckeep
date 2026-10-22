import { describe, expect, it } from 'vitest'
import { prepareWindowsJobRelay } from '../src/main/process-ownership.js'

describe('windows relay preparation', () => {
  it.skipIf(process.platform !== 'win32')('compiles the relay once and reuses the ready executable', async () => {
    await expect(prepareWindowsJobRelay()).resolves.toBe(true)
    const first = await prepareWindowsJobRelay()
    const second = await prepareWindowsJobRelay()
    expect(first).toBe(true)
    expect(second).toBe(true)
  }, 30_000)
})
