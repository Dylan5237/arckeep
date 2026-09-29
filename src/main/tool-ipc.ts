import { clipboard, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { IpcChannel } from '../shared/ipc.js'
import { collectKnownRepos, type KnownRepo } from '../shared/tools/repos.js'
import { buildToolFixture } from './screenshot-tools.js'
import type { SettingsService } from './settings-service.js'
import {
  confirmToolAction,
  exportToolShelfFile,
  importToolShelfFile,
  pickToolFolder,
  toolExampleText
} from './tool-actions.js'
import { normalizeActionId, normalizeParamInput, previewStoredAction } from './tool-request.js'
import { ToolRunner } from './tool-runner.js'
import { validateToolShelfText } from './tool-validate.js'

export interface KnownRepoLookup {
  observedGithubRepos(): readonly string[]
  observedLocalLinks(): readonly { github: string, path: string }[]
}

export function registerToolIpc(options: {
  guard: (event: IpcMainInvokeEvent) => void
  getWindow: () => BrowserWindow | null
  settings: SettingsService
  runner: ToolRunner
  repos?: KnownRepoLookup | null
  screenshotScene?: string
}): void {
  const { guard, settings, runner } = options
  const knownRepos = (): KnownRepo[] => collectKnownRepos({
    watchedRepos: settings.getSettings().watchedRepos,
    githubRepos: options.repos?.observedGithubRepos() ?? [],
    localPaths: settings.getSettings().waiting.localRepoDirs,
    linked: options.repos?.observedLocalLinks() ?? []
  })
  ipcMain.handle(IpcChannel.setToolShelf, (event, json: unknown) => {
    guard(event)
    return settings.setToolShelfJson(json)
  })
  ipcMain.handle(IpcChannel.getToolExample, event => {
    guard(event)
    return toolExampleText()
  })
  ipcMain.handle(IpcChannel.getKnownRepos, event => {
    guard(event)
    return knownRepos()
  })
  ipcMain.handle(IpcChannel.pickFolder, event => {
    guard(event)
    return pickToolFolder(options.getWindow())
  })
  ipcMain.handle(IpcChannel.getToolCatalog, event => {
    guard(event)
    const validated = validateToolShelfText(settings.getSettings().toolShelfJson)
    if (!validated.ok) return { ok: false as const, error: validated.error }
    return { ok: true as const, actions: validated.config.actions }
  })
  ipcMain.handle(IpcChannel.importToolShelf, event => {
    guard(event)
    return importToolShelfFile(options.getWindow())
  })
  ipcMain.handle(IpcChannel.exportToolShelf, (event, json: unknown) => {
    guard(event)
    return exportToolShelfFile(options.getWindow(), json)
  })
  ipcMain.handle(IpcChannel.previewTool, (event, actionId: unknown, params: unknown) => {
    guard(event)
    try {
      const preview = previewStoredAction(
        settings.getSettings().toolShelfJson,
        normalizeActionId(actionId),
        normalizeParamInput(params),
        process.cwd(),
        knownRepos()
      )
      return { ok: true as const, data: preview }
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : '无法预览' }
    }
  })
  ipcMain.handle(IpcChannel.runTool, (event, actionId: unknown, params: unknown) => {
    guard(event)
    return confirmToolAction({ settings, runner, actionId, params, knownRepos: knownRepos() })
  })
  ipcMain.handle(IpcChannel.abortTool, (event, runId: unknown) => {
    guard(event)
    if (typeof runId !== 'string' || runId.length > 80) return { ok: false as const, error: '没有可中止的命令' }
    if (!runner.abort(runId)) return { ok: false as const, error: '没有可中止的命令' }
    return { ok: true as const, data: true as const }
  })
  ipcMain.handle(IpcChannel.copyText, (event, text: unknown) => {
    guard(event)
    if (typeof text !== 'string' || text.length > 500_000) return { ok: false as const, error: '没有可复制的内容' }
    clipboard.writeText(text)
    return { ok: true as const, data: true as const }
  })
  ipcMain.handle(IpcChannel.getToolFixture, event => {
    guard(event)
    if (!process.env.ARCKEEP_SCREENSHOT) return null
    return buildToolFixture(options.screenshotScene ?? '')
  })
}
