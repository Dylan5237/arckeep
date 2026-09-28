import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { settingsFilePath } from '../src/main/paths.js'
import {
  MOCK_EXPIRED_TOKEN,
  MOCK_GH_TOKEN,
  MOCK_GITHUB_LOGIN,
  createScreenshotSettings,
  parseScreenshotScene,
  screenshotOpensSettings,
  screenshotWindowSize
} from '../src/main/screenshot-scene.js'

describe('screenshot fixtures', () => {
  it('uses an 800px window only for the narrow scene and opens settings for auth states', () => {
    expect(screenshotWindowSize('narrow')).toEqual({ width: 800, height: 760 })
    expect(screenshotWindowSize('nav').width).toBe(1120)
    expect(screenshotOpensSettings('nav')).toBe(false)
    expect(screenshotOpensSettings('narrow')).toBe(false)
    expect(screenshotOpensSettings('signed-out')).toBe(true)
    expect(parseScreenshotScene('not-a-scene')).toBe('nav')
  })

  it('builds mocked auth states without writing the stand-in secrets as plaintext', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'arckeep-shot-'))
    const file = settingsFilePath(dir)
    const invalid = createScreenshotSettings('invalid-token', file)
    const invalidState = await invalid.getState()
    expect(invalidState.github.source).toBe('pat')
    const disk = readFileSync(file, 'utf8')
    expect(disk.includes(MOCK_EXPIRED_TOKEN.slice(0, 8))).toBe(false)

    const connected = createScreenshotSettings('connected', settingsFilePath(`${dir}-ok`))
    const state = await connected.getState()
    expect(state.github.sourceLabel).toBe('来源：gh CLI')
    expect(JSON.stringify(state).includes(MOCK_GH_TOKEN)).toBe(false)
    await expect(connected.testConnection()).resolves.toEqual({ ok: true, login: MOCK_GITHUB_LOGIN })

    const signedOut = createScreenshotSettings('signed-out', settingsFilePath(`${dir}-out`))
    await expect(signedOut.getState()).resolves.toMatchObject({
      github: { source: 'none', sourceLabel: '未配置' }
    })

    const conflict = createScreenshotSettings('hotkey-conflict', settingsFilePath(`${dir}-hotkey`))
    const hotkey = await conflict.getState()
    expect(hotkey.hotkeyWarning).toMatch(/冲突/)
  })
})
