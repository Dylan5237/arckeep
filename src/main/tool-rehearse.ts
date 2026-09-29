import { existsSync, statSync } from 'node:fs'
import type { ShellPlan } from './tool-launch.js'
import { planShell } from './tool-launch.js'
import { runPlan } from './tool-runner.js'
import {
  summarizeDryRun,
  unavailableRehearsal
} from '../shared/tools/rehearsal.js'
import type { ActionPreview, Rehearsal } from '../shared/tools/types.js'

export interface RehearseRunResult {
  code: number | null
  stdout: string
  stderr: string
  aborted: boolean
  error?: string
}

export interface RehearseDeps {
  platform?: NodeJS.Platform
  cwdExists?: (cwd: string) => boolean
  run?: (plan: ShellPlan, cwd: string) => Promise<RehearseRunResult>
}

function failed(summary: string): Rehearsal {
  return { status: 'failed', summary: summary.startsWith('预演失败') ? summary : `预演失败：${summary}`, canConfirm: false }
}

function directoryExists(cwd: string): boolean {
  try {
    return existsSync(cwd) && statSync(cwd).isDirectory()
  } catch {
    return false
  }
}

/**
 * Run the configured dry-run command and attach a summary.
 * Confirm stays disarmed when that command fails. The real command is not started here.
 */
export async function rehearsePreview(preview: ActionPreview, deps: RehearseDeps = {}): Promise<Rehearsal> {
  if (preview.type !== 'run-command' || !preview.dryRun) {
    if (preview.type !== 'run-command') {
      return { status: 'unavailable', summary: preview.text, canConfirm: true }
    }
    return unavailableRehearsal(preview.cwd ?? '', preview.text)
  }
  const platform = deps.platform ?? process.platform
  if (!preview.shell || !preview.cwd) return failed('命令缺少 shell 或工作目录')
  if (preview.shell === 'cmd' && platform !== 'win32') return failed('cmd 只能在 Windows 上运行')
  if (preview.shell === 'powershell' && platform !== 'win32') return failed('PowerShell 只能在 Windows 上运行')
  const cwdExists = deps.cwdExists ?? directoryExists
  if (!cwdExists(preview.cwd)) return failed('工作目录不存在')
  try {
    const plan = planShell(preview.shell, preview.dryRun, process.env, platform)
    const run = deps.run ?? ((item, cwd) => runPlan(item, cwd))
    const result = await run(plan, preview.cwd)
    return summarizeDryRun({
      cwd: preview.cwd,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      aborted: result.aborted,
      error: result.error
    })
  } catch (error) {
    return failed(error instanceof Error ? error.message : '无法预演')
  }
}
