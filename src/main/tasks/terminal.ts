import path from 'node:path'
import { quotePowerShellArg } from '../../shared/tools/quote.js'
import { createClaudeLaunchPlan, resolvePowerShell, resolveWindowsExecutable, windowsPathExists } from '../claude/launcher.js'
import type { TaskAgent } from '../../shared/tasks/types.js'

export interface TaskTerminalPlan {
  file: string
  args: string[]
  cwd: string
  title: string
  terminal: 'windows-terminal' | 'powershell'
}

function safeTitle(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.\-㐀-鿿]/g, '_').slice(0, 70) || 'task'
  return 'Arckeep - ' + safe
}

function encode(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function buildPlan(input: {
  title: string
  cwd: string
  script: string
  env: NodeJS.ProcessEnv
  exists: (candidate: string) => boolean
}): TaskTerminalPlan {
  const cwd = path.win32.resolve(input.cwd)
  const powerShell = resolvePowerShell(input.env, input.exists)
  const terminal = resolveWindowsExecutable('wt.exe', input.env, input.exists)
  const args = ['-NoProfile', '-NoExit', '-EncodedCommand', encode(input.script)]
  if (terminal) {
    return {
      file: terminal,
      args: ['-w', 'new', 'new-tab', '--title', input.title, '--useApplicationTitle', powerShell, ...args],
      cwd,
      title: input.title,
      terminal: 'windows-terminal'
    }
  }
  return { file: powerShell, args, cwd, title: input.title, terminal: 'powershell' }
}

/**
 * Opens a real interactive terminal for manual takeover. When a resumable
 * Claude/Codex session exists it is resumed; otherwise the directory opens.
 */
export function createTaskTerminalPlan(input: {
  title: string
  cwd: string
  agent: TaskAgent
  sessionId: string | null
  repo?: string | null
  env?: NodeJS.ProcessEnv
  exists?: (candidate: string) => boolean
}): TaskTerminalPlan {
  const env = input.env ?? process.env
  const exists = input.exists ?? windowsPathExists
  if (input.agent === 'claude' && input.sessionId) {
    return createClaudeLaunchPlan({
      repo: input.repo ?? 'local/task',
      cwd: input.cwd,
      sessionId: input.sessionId,
      resume: true,
      env,
      exists
    })
  }
  const title = safeTitle(input.title)
  const cli = resolveWindowsExecutable(input.agent === 'codex' ? 'codex' : 'claude', env, exists)
  if (!cli) throw new Error('未找到 ' + (input.agent === 'codex' ? 'Codex' : 'Claude Code') + ' CLI，无法接管')
  const resume = input.sessionId ? ['resume', input.sessionId] : []
  const command = '& ' + quotePowerShellArg(cli) + (resume.length ? ' ' + resume.map(quotePowerShellArg).join(' ') : '')
  const script = [
    '$host.UI.RawUI.WindowTitle = ' + quotePowerShellArg(title),
    'try { Set-Location -LiteralPath ' + quotePowerShellArg(path.win32.resolve(input.cwd)) + ' -ErrorAction Stop',
    '  ' + command,
    '} finally { $host.UI.RawUI.WindowTitle = ' + quotePowerShellArg(title + ' (ended)') + ' }'
  ].join('\n')
  return buildPlan({ title, cwd: input.cwd, script, env, exists })
}
