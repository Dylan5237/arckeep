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
import {
  knownReposSignature,
  normalizeActionId,
  normalizeParamInput,
  previewStoredAction,
  ToolPreviewBindings,
  type BoundCommandPreview
} from './tool-request.js'
import { ToolRunner } from './tool-runner.js'
import { planShell } from './tool-launch.js'
import type { ToolRehearsals } from './tool-rehearse.js'
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
  rehearsals: ToolRehearsals
  repos?: KnownRepoLookup | null
  /** Repositories already tagged on todos. Invalid tags are dropped later. */
  todoRepos?: () => readonly string[]
  screenshotScene?: string
}): { shutdown(): Promise<void> } {
  const { guard, settings, runner } = options
  const bindings = new ToolPreviewBindings()
  let configurationRevision = 0
  const knownRepos = (): KnownRepo[] => collectKnownRepos({
    watchedRepos: settings.getSettings().watchedRepos,
    githubRepos: options.repos?.observedGithubRepos() ?? [],
    localPaths: settings.getSettings().waiting.localRepoDirs,
    todoRepos: options.todoRepos?.() ?? [],
    linked: options.repos?.observedLocalLinks() ?? []
  })
  ipcMain.handle(IpcChannel.setToolShelf, (event, json: unknown) => {
    guard(event)
    const result = settings.setToolShelfJson(json)
    if (result.ok) configurationRevision += 1
    return result
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
  ipcMain.handle(IpcChannel.previewTool, async (event, actionId: unknown, params: unknown, rawRequestId: unknown) => {
    guard(event)
    if (typeof rawRequestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(rawRequestId)) {
      return { ok: false as const, error: '预览请求无效，请重新预览' }
    }
    try {
      const configJson = settings.getSettings().toolShelfJson
      const revision = configurationRevision
      const repos = knownRepos()
      const normalizedActionId = normalizeActionId(actionId)
      const normalizedParams = normalizeParamInput(params)
      const preview = previewStoredAction(
        configJson,
        normalizedActionId,
        normalizedParams,
        process.cwd(),
        repos
      )
      if (preview.type === 'run-command') {
        preview.rehearsal = await options.rehearsals.rehearse(rawRequestId, preview)
        const latestConfig = settings.getSettings().toolShelfJson
        const latestRepos = knownRepos()
        if (configurationRevision !== revision || latestConfig !== configJson
          || knownReposSignature(latestRepos) !== knownReposSignature(repos)) {
          bindings.cancelRequest(rawRequestId)
          return { ok: false as const, error: '配置或仓库映射已变化，请重新预览' }
        }
        if (preview.rehearsal.canConfirm) {
          if (!preview.shell || !preview.cwd) throw new Error('命令缺少 shell 或工作目录')
          const plan = planShell(preview.shell, preview.text)
          preview.confirmationId = bindings.issue({
            requestId: rawRequestId,
            actionId: normalizedActionId,
            params: normalizedParams,
            configurationRevision: revision,
            toolShelfJson: configJson,
            knownRepos: repos,
            preview,
            plan
          })
        }
      }
      return { ok: true as const, data: preview }
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : '无法预览' }
    }
  })
  ipcMain.handle(IpcChannel.cancelToolPreview, async (event, rawRequestId: unknown) => {
    guard(event)
    if (typeof rawRequestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(rawRequestId)) {
      return { ok: false as const, error: '预览请求无效' }
    }
    bindings.cancelRequest(rawRequestId)
    try {
      await options.rehearsals.cancel(rawRequestId)
      return { ok: true as const, data: { cancelled: true as const } }
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : '无法取消预演' }
    }
  })
  ipcMain.handle(IpcChannel.runTool, async (event, actionId: unknown, params: unknown, confirmationId: unknown) => {
    guard(event)
    let normalizedActionId: string
    let normalizedParams: Record<string, string>
    try {
      normalizedActionId = normalizeActionId(actionId)
      normalizedParams = normalizeParamInput(params)
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : '参数无效' }
    }
    const configJson = settings.getSettings().toolShelfJson
    const repos = knownRepos()
    let currentPreview: ReturnType<typeof previewStoredAction>
    try {
      currentPreview = previewStoredAction(configJson, normalizedActionId, normalizedParams, process.cwd(), repos)
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : '无法预览' }
    }
    let confirmedCommand: BoundCommandPreview | undefined
    if (confirmationId !== undefined || currentPreview.type === 'run-command') {
      const binding = bindings.take(confirmationId, {
        actionId: normalizedActionId,
        params: normalizedParams,
        configurationRevision,
        toolShelfJson: configJson,
        knownRepos: repos,
        preview: currentPreview
      })
      if (!binding.ok) return binding
      confirmedCommand = binding.data
    }
    return confirmToolAction({
      settings,
      runner,
      actionId: normalizedActionId,
      params: normalizedParams,
      knownRepos: repos,
      confirmedCommand
    })
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

  return {
    async shutdown() {
      bindings.clear()
      await options.rehearsals.cancelAll()
    }
  }
}
