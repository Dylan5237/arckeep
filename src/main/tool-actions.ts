import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { clipboard, dialog, shell, type BrowserWindow } from 'electron'
import type { KnownRepo } from '../shared/tools/repos.js'
import type { ActionPreview, ToolRunEvent } from '../shared/tools/types.js'
import type { IpcResult } from '../shared/types.js'
import type { ShellPlan } from './tool-launch.js'
import { normalizeActionId, normalizeParamInput, previewStoredAction } from './tool-request.js'
import { ToolRunner } from './tool-runner.js'
import { toolShelfExampleText } from './tool-assets.js'
import type { SettingsService } from './settings-service.js'

async function openFolder(preview: ActionPreview): Promise<void> {
  const argv = preview.argv ?? []
  if (argv.length >= 2) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(argv[0], argv.slice(1), {
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: 'ignore'
      })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
    return
  }
  const folder = argv[0] ?? preview.text
  const message = await shell.openPath(folder)
  if (message) throw new Error(message)
}

export async function confirmToolAction(options: {
  settings: SettingsService
  runner: ToolRunner
  actionId: unknown
  params: unknown
  baseCwd?: string
  knownRepos?: readonly KnownRepo[]
  confirmedCommand?: { preview: ActionPreview, plan: ShellPlan }
}): Promise<IpcResult<
  | { kind: 'run', runId: string }
  | { kind: 'open-url' }
  | { kind: 'open-folder' }
  | { kind: 'template', text: string }
>> {
  let actionId: string
  let params: Record<string, string>
  try {
    actionId = normalizeActionId(options.actionId)
    params = normalizeParamInput(options.params)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '参数无效' }
  }
  let preview: ActionPreview
  try {
    preview = previewStoredAction(
      options.settings.getSettings().toolShelfJson,
      actionId,
      params,
      options.baseCwd ?? process.cwd(),
      options.knownRepos ?? []
    )
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '无法预览' }
  }
  try {
    if (preview.type === 'open-url') {
      await shell.openExternal(preview.text)
      return { ok: true, data: { kind: 'open-url' } }
    }
    if (preview.type === 'template') {
      clipboard.writeText(preview.text)
      return { ok: true, data: { kind: 'template', text: preview.text } }
    }
    if (preview.type === 'open-folder') {
      await openFolder(preview)
      return { ok: true, data: { kind: 'open-folder' } }
    }
    if (!options.confirmedCommand) return { ok: false, error: '请先预览要执行的命令' }
    preview = options.confirmedCommand.preview
    if (preview.type !== 'run-command') return { ok: false, error: '预览已失效，请重新预览' }
    if (!preview.shell || !preview.cwd) throw new Error('命令缺少 shell 或工作目录')
    if (!existsSync(preview.cwd) || !statSync(preview.cwd).isDirectory()) {
      throw new Error('工作目录不存在')
    }
    if (preview.shell === 'cmd' && process.platform !== 'win32') throw new Error('cmd 只能在 Windows 上运行')
    if (preview.shell === 'powershell' && process.platform !== 'win32') {
      throw new Error('PowerShell 只能在 Windows 上运行')
    }
    // Start the exact plan created with the preview; never rebuild it during confirmation.
    const runId = options.runner.start(options.confirmedCommand.plan, preview.cwd)
    return { ok: true, data: { kind: 'run', runId } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '执行失败' }
  }
}

export async function pickToolFolder(window: BrowserWindow | null): Promise<
  IpcResult<{ cancelled: true } | { cancelled: false, path: string }>
> {
  const dialogOptions = {
    title: '选择文件夹',
    properties: ['openDirectory'] as Array<'openDirectory'>
  }
  const result = window
    ? await dialog.showOpenDialog(window, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)
  if (result.canceled || result.filePaths.length === 0) return { ok: true, data: { cancelled: true } }
  return { ok: true, data: { cancelled: false, path: result.filePaths[0] } }
}

export async function importToolShelfFile(window: BrowserWindow | null): Promise<
  IpcResult<{ cancelled: true } | { cancelled: false, text: string }>
> {
  const dialogOptions = {
    title: '导入工具架 JSON',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'] as Array<'openFile'>
  }
  const result = window
    ? await dialog.showOpenDialog(window, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)
  if (result.canceled || result.filePaths.length === 0) return { ok: true, data: { cancelled: true } }
  try {
    const text = readFileSync(result.filePaths[0], 'utf8')
    if (text.length > 200_000) return { ok: false, error: '文件太大' }
    return { ok: true, data: { cancelled: false, text } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '无法读取文件' }
  }
}

export async function exportToolShelfFile(
  window: BrowserWindow | null,
  text: unknown
): Promise<IpcResult<{ cancelled: boolean }>> {
  if (typeof text !== 'string') return { ok: false, error: '没有可导出的内容' }
  if (text.length > 200_000) return { ok: false, error: '内容太大' }
  const dialogOptions = {
    title: '导出工具架 JSON',
    defaultPath: 'tool-shelf.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  }
  const result = window
    ? await dialog.showSaveDialog(window, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions)
  if (result.canceled || !result.filePath) return { ok: true, data: { cancelled: true } }
  try {
    writeFileSync(result.filePath, text, 'utf8')
    return { ok: true, data: { cancelled: false } }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '无法写入文件' }
  }
}

export function toolExampleText(): string {
  return toolShelfExampleText()
}

export type { ToolRunEvent }
