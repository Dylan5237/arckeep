import { existsSync } from 'node:fs'
import { powershellLaunchScript, quotePowerShellArg } from '../shared/tools/quote.js'
import type { ShellKind } from '../shared/tools/types.js'

export interface ShellPlan {
  shell: ShellKind
  script: string
  file: string
  args: string[]
  windowsVerbatimArguments: boolean
}

export function resolveBash(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const override = env.ARCKEEP_GIT_BASH
  if (override) return existsSync(override) ? override : null
  if (platform !== 'win32') return 'bash'
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

/** Give cmd a hidden console so its code-page switch applies to redirected output. */
function cmdRunnerScript(executable: string, commandLine: string): string {
  return [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $psi = [System.Diagnostics.ProcessStartInfo]::new(${quotePowerShellArg(executable)})`,
    '  $psi.UseShellExecute = $false',
    '  $psi.CreateNoWindow = $false',
    '  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden',
    '  $psi.RedirectStandardInput = $true',
    '  $psi.RedirectStandardOutput = $true',
    '  $psi.RedirectStandardError = $true',
    `  $psi.Arguments = ${quotePowerShellArg(commandLine)}`,
    '  $process = [System.Diagnostics.Process]::new()',
    '  $process.StartInfo = $psi',
    '  $null = $process.Start()',
    '  $process.StandardInput.Close()',
    '  $stdoutCopy = $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())',
    '  $stderrCopy = $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())',
    '  $process.WaitForExit()',
    '  [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($stdoutCopy, $stderrCopy))',
    '  exit $process.ExitCode',
    '} catch {',
    '  [Console]::Error.WriteLine(($_ | Out-String).TrimEnd())',
    '  exit 1',
    '}'
  ].join('\n')
}

export function planShell(
  shell: ShellKind,
  script: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): ShellPlan {
  if (shell === 'cmd') {
    if (/[\r\n\0]/.test(script)) throw new Error('cmd 命令不能包含换行')
    // Pipe-only cmd kept using OEM bytes after chcp; relay it through a hidden console.
    const runnable = `chcp 65001 >NUL & ${script}`
    const commandLine = `/d /s /c "${runnable}"`
    const encoded = Buffer.from(cmdRunnerScript(env.ComSpec || 'cmd.exe', commandLine), 'utf16le').toString('base64')
    return {
      shell,
      script: runnable,
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      windowsVerbatimArguments: false
    }
  }
  if (shell === 'powershell') {
    const file = env.ARCKEEP_POWERSHELL?.trim() || 'powershell.exe'
    const runnable = powershellLaunchScript(script, file)
    const encoded = Buffer.from(runnable, 'utf16le').toString('base64')
    return {
      shell,
      script: runnable,
      file,
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      windowsVerbatimArguments: false
    }
  }
  const bash = resolveBash(env, platform)
  if (!bash) throw new Error('没有找到 Git Bash。可以设置 ARCKEEP_GIT_BASH 指向 bash.exe')
  return {
    shell,
    script,
    file: bash,
    args: ['--noprofile', '--norc', '-c', script],
    windowsVerbatimArguments: false
  }
}

export function powershellScriptFromPlan(plan: ShellPlan): string {
  const index = plan.args.indexOf('-EncodedCommand')
  const encoded = index >= 0 ? plan.args[index + 1] : undefined
  if (!encoded) throw new Error('缺少 EncodedCommand')
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

export function cmdScriptFromPlan(plan: ShellPlan): string {
  if (plan.shell !== 'cmd') throw new Error('不是 cmd 启动计划')
  const wrapper = powershellScriptFromPlan(plan)
  const commandLine = `/d /s /c "${plan.script}"`
  if (!wrapper.includes(`$psi.Arguments = ${quotePowerShellArg(commandLine)}`)) {
    throw new Error('cmd 参数与启动计划不一致')
  }
  return plan.script
}
