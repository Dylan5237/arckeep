import { describe, expect, it } from 'vitest'
import { createTaskTerminalPlan } from '../src/main/tasks/terminal.js'

const CWD = 'C:\\work\\demo'
const SESSION = '123e4567-e89b-42d3-a456-426614174001'
const ENV = {
  SystemRoot: 'C:\\Windows',
  PATH: 'C:\\tools'
}
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

function existsSet(files: string[]) {
  const set = new Set(files.map(item => item.toLowerCase()))
  return (candidate: string) => set.has(candidate.toLowerCase())
}

function decoded(plan: { args: string[] }): string {
  const encoded = plan.args.at(-1) ?? ''
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

describe('task manual takeover', () => {
  it('resumes a Codex session in Windows Terminal', () => {
    const plan = createTaskTerminalPlan({
      title: '修复登录',
      cwd: CWD,
      agent: 'codex',
      sessionId: 'thread-1',
      env: ENV,
      exists: existsSet(['C:\\tools\\codex.cmd', 'C:\\tools\\wt.exe', POWERSHELL])
    })
    expect(plan.terminal).toBe('windows-terminal')
    expect(plan.title).toContain('修复登录')
    const command = decoded(plan)
    expect(command).toContain('resume')
    expect(command).toContain('thread-1')
    expect(command).toContain('Set-Location')
  })

  it('resumes a Claude session through the existing launcher plan', () => {
    const plan = createTaskTerminalPlan({
      title: 'Claude 任务',
      cwd: CWD,
      agent: 'claude',
      sessionId: SESSION,
      repo: 'example/demo',
      env: ENV,
      platform: 'win32',
      exists: existsSet(['C:\\tools\\claude.exe', 'C:\\tools\\wt.exe', POWERSHELL])
    })
    expect(plan.terminal).toBe('windows-terminal')
    const command = decoded(plan)
    expect(command).toContain('--resume')
    expect(command).toContain(SESSION)
  })

  it('falls back to PowerShell and opens a fresh CLI when no session exists', () => {
    const plan = createTaskTerminalPlan({
      title: '手工接管',
      cwd: CWD,
      agent: 'codex',
      sessionId: null,
      env: ENV,
      exists: existsSet(['C:\\tools\\codex.cmd', POWERSHELL])
    })
    expect(plan.terminal).toBe('powershell')
    const command = decoded(plan)
    expect(command).not.toContain('resume')
    expect(command).toContain('codex.cmd')
  })

  it('refuses to open a takeover terminal when the agent CLI is missing', () => {
    expect(() => createTaskTerminalPlan({
      title: '缺少 CLI',
      cwd: CWD,
      agent: 'codex',
      sessionId: null,
      env: ENV,
      exists: existsSet([POWERSHELL])
    })).toThrow('未找到 Codex CLI')
  })
})
