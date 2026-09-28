import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('pack script', () => {
  it('documents the NSIS installer and portable exe flows', () => {
    const output = execFileSync(process.execPath, ['scripts/pack.mjs', '--help'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8'
    })
    expect(output).toMatch(/NSIS/)
    expect(output).toMatch(/portable/)
    expect(output).toMatch(/dist-fast/)
  })
})
