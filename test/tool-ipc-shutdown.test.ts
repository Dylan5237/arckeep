import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { SettingsService } from '../src/main/settings-service.js'
import type { ToolRehearsals } from '../src/main/tool-rehearse.js'
import type { Rehearsal } from '../src/shared/tools/types.js'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
  clipboard: { writeText: vi.fn() },
  shell: {},
  dialog: {}
}))

import { registerToolIpc } from '../src/main/tool-ipc.js'
import { ToolRunner } from '../src/main/tool-runner.js'
import { IpcChannel } from '../src/shared/ipc.js'

describe('tool IPC shutdown admission', () => {
  it('rejects new work and never issues authorization to an in-flight preview after close', async () => {
    let finishPreview: (value: Rehearsal) => void = () => {}
    const pendingPreview = new Promise<Rehearsal>(resolve => { finishPreview = resolve })
    let finishCleanup: () => void = () => {}
    const pendingCleanup = new Promise<void>(resolve => { finishCleanup = resolve })
    const rehearsals: ToolRehearsals = {
      rehearse: vi.fn(() => pendingPreview),
      cancel: vi.fn(async () => {}),
      cancelAll: vi.fn(() => pendingCleanup),
      close: vi.fn()
    }
    const settings = {
      getSettings: () => ({
        watchedRepos: [],
        waiting: { localRepoDirs: [] },
        toolShelfJson: JSON.stringify({ version: 1, actions: [{
          id: 'closing-preview', title: '关闭测试', type: 'run-command', shell: 'powershell',
          command: 'Write-Output real', previewCommand: 'Write-Output dry', cwd: process.cwd()
        }] })
      })
    } as unknown as SettingsService
    const runner = new ToolRunner(() => {})
    const lifecycle = registerToolIpc({ guard: () => {}, getWindow: () => null, settings, runner, rehearsals })
    const event = {} as IpcMainInvokeEvent
    const preview = handlers.get(IpcChannel.previewTool)!
    const run = handlers.get(IpcChannel.runTool)!
    const inFlight = preview(event, 'closing-preview', {}, 'preview-A')
    const shutdown = lifecycle.shutdown()
    try {
      expect(await preview(event, 'closing-preview', {}, 'preview-B')).toMatchObject({ ok: false, error: expect.stringContaining('关闭') })
      expect(await run(event, 'closing-preview', {}, undefined)).toMatchObject({ ok: false, error: expect.stringContaining('关闭') })
      expect(rehearsals.rehearse).toHaveBeenCalledTimes(1)
      expect(() => runner.start({ shell: 'git-bash', script: '', file: process.execPath, args: [], windowsVerbatimArguments: false }, process.cwd())).toThrow('关闭')
      finishPreview({ status: 'raw', summary: 'dry result', canConfirm: true })
      expect(await inFlight).toMatchObject({ ok: false, error: expect.stringContaining('关闭') })
      expect(rehearsals.close).toHaveBeenCalledTimes(1)
    } finally {
      finishCleanup()
      finishPreview({ status: 'failed', summary: 'cancelled', canConfirm: false })
      await shutdown
      handlers.clear()
    }
  })
})
