import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsService } from '../src/main/settings-service.js'
import type { ToolRehearsals } from '../src/main/tool-rehearse.js'
import { TaskScope } from '../src/shared/task-scope.js'

const { handlers, showOpenDialog, showSaveDialog, readFileCalls, writeFileCalls } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  readFileCalls: vi.fn(),
  writeFileCalls: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  dialog: { showOpenDialog, showSaveDialog }
}))

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => {
      readFileCalls(...args)
      return actual.readFileSync(...args)
    }),
    writeFileSync: vi.fn((...args: Parameters<typeof actual.writeFileSync>) => {
      writeFileCalls(...args)
      return actual.writeFileSync(...args)
    })
  }
})

import { registerToolIpc } from '../src/main/tool-ipc.js'
import { ToolRunner } from '../src/main/tool-runner.js'
import { IpcChannel } from '../src/shared/ipc.js'

interface OpenDialogResult {
  canceled: boolean
  filePaths: string[]
}

interface SaveDialogResult {
  canceled: boolean
  filePath?: string
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`)
  return Promise.resolve(handler({} as IpcMainInvokeEvent, ...args))
}

async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('tool shelf native dialog lifecycle', () => {
  let directory: string
  let scope: TaskScope
  let lifecycle: ReturnType<typeof registerToolIpc>

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'arckeep-tool-dialog-'))
    handlers.clear()
    showOpenDialog.mockReset()
    showSaveDialog.mockReset()
    readFileCalls.mockClear()
    writeFileCalls.mockClear()
    scope = new TaskScope()
    lifecycle = registerToolIpc({
      guard: () => {},
      getWindow: () => null,
      settings: {} as SettingsService,
      runner: new ToolRunner(() => {}),
      rehearsals: {
        rehearse: vi.fn(),
        cancel: vi.fn(async () => {}),
        cancelAll: vi.fn(async () => {}),
        close: vi.fn()
      } as unknown as ToolRehearsals,
      tasks: scope
    })
  })

  afterEach(async () => {
    scope.close()
    await scope.drain()
    lifecycle.close()
    handlers.clear()
    await rm(directory, { recursive: true, force: true })
  })

  it('cancels a late folder picker reply and drains the task', async () => {
    const dialog = deferred<OpenDialogResult>()
    showOpenDialog.mockReturnValue(dialog.promise)
    const pending = invoke(IpcChannel.pickFolder)
    await tick()
    expect(showOpenDialog).toHaveBeenCalledOnce()

    scope.close()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(scope.drain()).resolves.toBeUndefined()
    expect(scope.pendingCount).toBe(0)

    dialog.resolve({ canceled: false, filePaths: [directory] })
    await tick()
    expect(readFileCalls).not.toHaveBeenCalled()
    expect(writeFileCalls).not.toHaveBeenCalled()
  })

  it('does not read an import path when the native picker replies after close', async () => {
    const file = path.join(directory, 'tool-shelf.json')
    await writeFile(file, '{"version":1,"actions":[]}', 'utf8')
    const dialog = deferred<OpenDialogResult>()
    showOpenDialog.mockReturnValue(dialog.promise)
    const pending = invoke(IpcChannel.importToolShelf)
    await tick()
    expect(showOpenDialog).toHaveBeenCalledOnce()

    scope.close()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(scope.drain()).resolves.toBeUndefined()
    expect(scope.pendingCount).toBe(0)

    dialog.resolve({ canceled: false, filePaths: [file] })
    await tick()
    expect(readFileCalls).not.toHaveBeenCalled()
    expect(await readFile(file, 'utf8')).toBe('{"version":1,"actions":[]}')
  })

  it('does not write an export path when the native save dialog replies after close', async () => {
    const file = path.join(directory, 'tool-shelf.json')
    await writeFile(file, 'keep existing file', 'utf8')
    const dialog = deferred<SaveDialogResult>()
    showSaveDialog.mockReturnValue(dialog.promise)
    const pending = invoke(IpcChannel.exportToolShelf, '{"version":1,"actions":[]}')
    await tick()
    expect(showSaveDialog).toHaveBeenCalledOnce()

    scope.close()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(scope.drain()).resolves.toBeUndefined()
    expect(scope.pendingCount).toBe(0)

    dialog.resolve({ canceled: false, filePath: file })
    await tick()
    expect(writeFileCalls).not.toHaveBeenCalled()
    expect(await readFile(file, 'utf8')).toBe('keep existing file')
  })
})
