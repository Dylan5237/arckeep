import { existsSync } from 'node:fs'
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

export function planShell(
  shell: ShellKind,
  script: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): ShellPlan {
  if (shell === 'cmd') {
    if (/[\r\n\0]/.test(script)) throw new Error('cmd 命令不能包含换行')
    return {
      shell,
      script,
      file: env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${script}"`],
      windowsVerbatimArguments: true
    }
  }
  if (shell === 'powershell') {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    return {
      shell,
      script,
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
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
  const encoded = plan.args[3]
  if (!encoded) throw new Error('缺少 EncodedCommand')
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

export function cmdScriptFromPlan(plan: ShellPlan): string {
  const wrapped = plan.args[3] ?? ''
  if (!wrapped.startsWith('"') || !wrapped.endsWith('"')) throw new Error('cmd 参数缺少外层引号')
  return wrapped.slice(1, -1)
}
