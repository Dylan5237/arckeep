import { describe, expect, it, vi } from 'vitest'
import { clipboard } from 'electron'
import { toolShelfExampleText } from '../src/main/tool-assets.js'
import type { ShellPlan } from '../src/main/tool-launch.js'
import { confirmToolAction } from '../src/main/tool-actions.js'
import type { SettingsService } from '../src/main/settings-service.js'
import { previewStoredAction } from '../src/main/tool-request.js'
import type { ToolRunner } from '../src/main/tool-runner.js'

vi.mock('electron', () => ({ clipboard: { writeText: vi.fn() }, dialog: {}, shell: {} }))

function settingsWith(toolShelfJson: string): SettingsService {
  return { getSettings: () => ({ toolShelfJson }) } as unknown as SettingsService
}

const commandShelf = JSON.stringify({
  version: 1,
  actions: [{
    id: 'same-action',
    title: '初始化项目',
    type: 'run-command',
    shell: 'git-bash',
    command: 'node --version',
    cwd: process.cwd()
  }]
})

describe('confirmToolAction', () => {
  it('copies the APO prompt directly without launching a command or a rehearsal', async () => {
    const start = vi.fn(() => 'unexpected-run')
    const result = await confirmToolAction({
      settings: settingsWith(toolShelfExampleText()),
      runner: { start } as unknown as ToolRunner,
      actionId: 'apo-init',
      params: {}
    })

    expect(result).toEqual({
      ok: true,
      data: { kind: 'template', text: '使用 https://github.com/Dylan5237/agent-project-ops 初始化当前项目。' }
    })
    expect(clipboard.writeText).toHaveBeenCalledWith('使用 https://github.com/Dylan5237/agent-project-ops 初始化当前项目。')
    expect(start).not.toHaveBeenCalled()
  })

  it('does not let a stale direct-action button run a newly configured command', async () => {
    const start = vi.fn(() => 'unexpected-run')
    const result = await confirmToolAction({
      settings: settingsWith(commandShelf),
      runner: { start } as unknown as ToolRunner,
      actionId: 'same-action',
      params: {}
    })

    expect(result).toEqual({ ok: false, error: '请先预览要执行的命令' })
    expect(start).not.toHaveBeenCalled()
  })

  it('starts the stored plan associated with a confirmed preview', async () => {
    const settings = settingsWith(commandShelf)
    const preview = previewStoredAction(commandShelf, 'same-action', {}, process.cwd())
    const plan = {
      file: 'cached-shell.exe',
      args: ['--the-confirmed-plan'],
      windowsVerbatimArguments: false
    } as ShellPlan
    const start = vi.fn(() => 'run-1')
    const result = await confirmToolAction({
      settings,
      runner: { start } as unknown as ToolRunner,
      actionId: 'same-action',
      params: {},
      baseCwd: process.cwd(),
      confirmedCommand: { preview, plan }
    })

    expect(result).toEqual({ ok: true, data: { kind: 'run', runId: 'run-1' } })
    expect(start).toHaveBeenCalledWith(plan, preview.cwd)
  })
})
