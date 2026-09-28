import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('electron fuses', () => {
  it('keeps the inspect arguments Playwright uses to attach', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      build: { electronFuses: Record<string, boolean> }
    }
    const fuses = pkg.build.electronFuses
    expect(fuses.enableNodeCliInspectArguments).toBe(true)
    expect(fuses.enableNodeOptionsEnvironmentVariable).toBe(true)
    expect(fuses.runAsNode).toBe(true)
  })
})