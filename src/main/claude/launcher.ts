import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { quotePowerShellArg } from '../../shared/tools/quote.js'
import { normalizeClaudeSessionId } from '../../shared/claude-sessions.js'

const execFileAsync = promisify(execFile)
const TERMINAL_STARTUP_WINDOW_MS = 250

export interface ClaudeLaunchPlan {
  file: string
  args: string[]
  cwd: string
  title: string
  terminal: 'windows-terminal' | 'powershell'
}

function envValue(env: NodeJS.ProcessEnv, key: string): string {
  const found = Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())
  return found?.[1] ?? ''
}

export function resolveWindowsExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = existsSync
): string | null {
  const direct = path.win32.isAbsolute(name)
  const pathEntries = direct
    ? ['']
    : envValue(env, 'PATH').split(path.win32.delimiter)
      .map(item => item.trim().replace(/^"|"$/g, ''))
      .filter(item => item.length > 0 && path.win32.isAbsolute(item))
  const extensions = path.win32.extname(name)
    ? ['']
    : (envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = direct
        ? name + extension.toLowerCase()
        : path.win32.join(entry, name + extension.toLowerCase())
      if (exists(candidate)) return candidate
      if (!extension || extension.toLowerCase() === extension) continue
      const upper = direct
        ? name + extension.toUpperCase()
        : path.win32.join(entry, name + extension.toUpperCase())
      if (exists(upper)) return upper
    }
  }
  return null
}

export function createClaudeTerminalTitle(repo: string, sessionIdInput: string): string {
  const sessionId = normalizeClaudeSessionId(sessionIdInput)
  const safeName = repo.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 70) || 'project'
  return 'Arckeep - ' + safeName + ' - ' + sessionId
}

function resolvePowerShell(env: NodeJS.ProcessEnv, exists: (candidate: string) => boolean): string {
  const systemRoot = envValue(env, 'SystemRoot') || 'C:\\Windows'
  const systemPowerShell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (exists(systemPowerShell)) return systemPowerShell
  return resolveWindowsExecutable('powershell.exe', env, exists) ?? systemPowerShell
}

function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function claudeCommand(cli: string, sessionId: string, resume: boolean, title: string, cwd: string): string {
  const args = resume ? ['--resume', sessionId] : ['--session-id', sessionId]
  const script = '$env:CLAUDE_CODE_DISABLE_TERMINAL_TITLE = \'1\'; $host.UI.RawUI.WindowTitle = '
    + quotePowerShellArg(title)
    + '; try { Set-Location -LiteralPath ' + quotePowerShellArg(cwd) + ' -ErrorAction Stop; & '
    + quotePowerShellArg(cli) + ' ' + args.map(quotePowerShellArg).join(' ')
    + ' } finally { $host.UI.RawUI.WindowTitle = \'Arckeep - Claude session ended\' }'
  return encodePowerShellCommand(script)
}

export function createClaudeLaunchPlan(input: {
  repo: string
  cwd: string
  sessionId: string
  resume?: boolean
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  exists?: (candidate: string) => boolean
}): ClaudeLaunchPlan {
  const platform = input.platform ?? process.platform
  if (platform !== 'win32') throw new Error('Claude 项目终端目前只支持 Windows')
  const env = input.env ?? process.env
  const exists = input.exists ?? existsSync
  const sessionId = normalizeClaudeSessionId(input.sessionId)
  const cwd = path.win32.resolve(input.cwd)
  const cli = resolveWindowsExecutable('claude', env, exists)
  if (!cli) throw new Error('未找到 Claude CLI，请先安装并确认 claude.exe 在 PATH 中')
  const title = createClaudeTerminalTitle(input.repo, sessionId)
  const powerShell = resolvePowerShell(env, exists)
  const command = claudeCommand(cli, sessionId, input.resume === true, title, cwd)
  const terminal = resolveWindowsExecutable('wt.exe', env, exists)
  if (terminal) {
    return {
      file: terminal,
      args: [
        '-w', 'new', 'new-tab',
        '--title', title,
        '--useApplicationTitle',
        powerShell, '-NoProfile', '-NoExit', '-EncodedCommand', command
      ],
      cwd,
      title,
      terminal: 'windows-terminal'
    }
  }
  return {
    file: powerShell,
    args: ['-NoProfile', '-NoExit', '-EncodedCommand', command],
    cwd,
    title,
    terminal: 'powershell'
  }
}

export async function activateClaudeTerminal(
  title: string,
  options: {
    env?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    exists?: (candidate: string) => boolean
    run?: (file: string, args: string[]) => Promise<string>
  } = {}
): Promise<boolean> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') throw new Error('Claude 项目终端目前只支持 Windows')
  const env = options.env ?? process.env
  const exists = options.exists ?? existsSync
  const powershell = resolvePowerShell(env, exists)
  const script = '$shell = New-Object -ComObject WScript.Shell; if ($shell.AppActivate('
    + quotePowerShellArg(title) + ')) { [Console]::Out.Write(\'1\') } else { [Console]::Out.Write(\'0\') }'
  const run = options.run ?? (async (file, args) => {
    const result = await execFileAsync(file, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 1024
    })
    return result.stdout
  })
  try {
    return (await run(powershell, [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-EncodedCommand', encodePowerShellCommand(script)
    ])).trim() === '1'
  } catch {
    throw new Error('无法确认 Claude 终端状态。为避免重复启动，请先检查现有终端后重试')
  }
}

export function launchClaudeInTerminal(
  plan: ClaudeLaunchPlan,
  start: typeof spawn = spawn
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    let settled = false
    let startupTimer: ReturnType<typeof setTimeout> | null = null
    const clearStartupTimer = () => {
      if (startupTimer !== null) clearTimeout(startupTimer)
      startupTimer = null
    }
    try {
      child = start(plan.file, plan.args, {
        cwd: plan.cwd,
        detached: true,
        shell: false,
        windowsHide: false,
        stdio: 'ignore'
      })
    } catch (error) {
      reject(error)
      return
    }
    child.once('error', error => {
      if (settled) return
      settled = true
      clearStartupTimer()
      reject(error)
    })
    child.once('spawn', () => {
      child.unref()
      startupTimer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve()
      }, TERMINAL_STARTUP_WINDOW_MS)
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearStartupTimer()
      if (code === 0 && signal === null) {
        resolve()
      } else {
        const reason = signal ? '信号 ' + signal : '退出码 ' + String(code)
        reject(new Error('外部终端在启动阶段退出（' + reason + '），请检查 Claude CLI 和终端配置'))
      }
    })
  })
}
