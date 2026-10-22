import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { activateClaudeTerminal, createClaudeLaunchPlan, createClaudeTerminalTitle, launchClaudeInTerminal, resolveWindowsExecutable } from '../src/main/claude/launcher.js'

const SESSION = '123e4567-e89b-42d3-a456-426614174000'
const env = {
  PATH: 'C:\\Claude;C:\\PowerShell;C:\\WindowsApps',
  PATHEXT: '.EXE;.CMD;.BAT',
  SystemRoot: 'C:\\Windows'
}

function exists(candidate: string): boolean {
  const normalized = candidate.toLowerCase()
  return normalized === 'c:\\claude\\claude.cmd'
    || normalized === 'c:\\powershell\\powershell.exe'
    || normalized === 'c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe'
    || normalized === 'c:\\windowsapps\\wt.exe'
}

function decodedPowerShellCommand(planArgs: string[]): string {
  const index = planArgs.indexOf('-EncodedCommand')
  expect(index).toBeGreaterThanOrEqual(0)
  return Buffer.from(planArgs[index + 1], 'base64').toString('utf16le')
}

describe('Claude external terminal launcher', () => {
  it('starts an isolated Windows Terminal window with an encoded command and invokes CLI shims through PowerShell', () => {
    const plan = createClaudeLaunchPlan({
      repo: 'octocat/hello', cwd: 'C:\\work trees\\hello', sessionId: SESSION,
      env, platform: 'win32', exists
    })

    expect(plan.terminal).toBe('windows-terminal')
    expect(plan.file).toBe('C:\\WindowsApps\\wt.exe')
    expect(plan.cwd).toBe('C:\\work trees\\hello')
    expect(plan.args.slice(0, 7)).toEqual([
      '-w', 'new', 'new-tab',
      '--title', 'Arckeep - octocat_hello - ' + SESSION,
      '--useApplicationTitle',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    ])
    const command = decodedPowerShellCommand(plan.args)
    expect(plan.args).toContain('--useApplicationTitle')
    expect(command).toContain("Set-Location -LiteralPath 'C:\\work trees\\hello' -ErrorAction Stop")
    expect(command.indexOf('Set-Location')).toBeLessThan(command.indexOf("& 'C:\\Claude\\claude.cmd'"))
    expect(command).toContain("$env:CLAUDE_CODE_DISABLE_TERMINAL_TITLE = '1'")
    expect(command).toContain("& 'C:\\Claude\\claude.cmd' '--session-id' '" + SESSION + "'")
    expect(command).toContain("$host.UI.RawUI.WindowTitle = 'Arckeep - octocat_hello - " + SESSION + "'")
    expect(command).toContain("finally { $host.UI.RawUI.WindowTitle = 'Arckeep - Claude session ended' }")
    expect(plan.args.join(' ')).not.toContain(';')
  })

  it('keeps semicolons in a workspace path inside the encoded PowerShell payload', () => {
    const plan = createClaudeLaunchPlan({
      repo: 'octocat/hello', cwd: 'C:\\work;trees\\hello', sessionId: SESSION,
      env, platform: 'win32', exists
    })

    expect(plan.args.join(' ')).not.toContain(';')
    expect(decodedPowerShellCommand(plan.args)).toContain("Set-Location -LiteralPath 'C:\\work;trees\\hello' -ErrorAction Stop")
  })

  it('uses --resume for an existing session and falls back to a visible PowerShell window when wt is absent', () => {
    const plan = createClaudeLaunchPlan({
      repo: 'octocat/hello', cwd: 'C:\\repo', sessionId: SESSION, resume: true,
      env, platform: 'win32', exists: candidate => exists(candidate) && !candidate.toLowerCase().endsWith('wt.exe')
    })

    expect(plan.terminal).toBe('powershell')
    expect(plan.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(plan.args.slice(0, 3)).toEqual(['-NoProfile', '-NoExit', '-EncodedCommand'])
    expect(decodedPowerShellCommand(plan.args)).toContain("'--resume' '" + SESSION + "'")
  })

  it('rejects unsupported platforms and invalid session ids before constructing a command', () => {
    expect(() => createClaudeLaunchPlan({ repo: 'octocat/hello', cwd: 'C:\\repo', sessionId: SESSION, platform: 'linux' }))
      .toThrow('只支持 Windows')
    expect(() => createClaudeLaunchPlan({ repo: 'octocat/hello', cwd: 'C:\\repo', sessionId: 'not-an-id', env, platform: 'win32', exists }))
      .toThrow('会话编号无效')
  })

  it('uses a unique stable title to reactivate an existing terminal and fails closed when activation cannot be checked', async () => {
    const title = createClaudeTerminalTitle('octocat/hello', SESSION)
    const run = vi.fn(async (_file: string, _args: string[]) => '1')
    await expect(activateClaudeTerminal(title, { env, platform: 'win32', exists, run })).resolves.toBe(true)
    const activationArgs = run.mock.calls[0]?.[1]
    expect(activationArgs).toContain('-EncodedCommand')
    expect(Buffer.from(activationArgs?.at(-1) ?? '', 'base64').toString('utf16le'))
      .toContain("AppActivate('" + title + "')")
    await expect(activateClaudeTerminal(title, { env, platform: 'win32', exists, run: async () => '0' })).resolves.toBe(false)
    await expect(activateClaudeTerminal(title, { env, platform: 'win32', exists, run: async () => { throw new Error('no PowerShell') } }))
      .rejects.toThrow('为避免重复启动')
  })

  it('ignores empty and relative PATH entries instead of searching the current project directory', () => {
    const resolved = resolveWindowsExecutable(
      'claude',
      { PATH: ';.;C:\\Claude', PATHEXT: '.EXE' },
      candidate => candidate.toLowerCase() === 'claude.exe' || candidate.toLowerCase() === 'c:\\claude\\claude.exe'
    )

    expect(resolved).toBe('C:\\Claude\\claude.exe')
  })

  it('detaches the external terminal process after it has spawned', async () => {
    const child = new EventEmitter() as ChildProcess
    const unref = vi.fn()
    child.unref = unref
    const start = vi.fn(() => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
    const plan = createClaudeLaunchPlan({ repo: 'octocat/hello', cwd: 'C:\\repo', sessionId: SESSION, env, platform: 'win32', exists })

    await expect(launchClaudeInTerminal(plan, start as never)).resolves.toBeUndefined()
    expect(start).toHaveBeenCalledWith(plan.file, plan.args, expect.objectContaining({
      cwd: plan.cwd, detached: true, shell: false, windowsHide: false, stdio: 'ignore'
    }))
    expect(unref).toHaveBeenCalledOnce()
  })

  it('rejects a terminal that exits unsuccessfully during startup', async () => {
    const child = new EventEmitter() as ChildProcess
    child.unref = vi.fn()
    const start = vi.fn(() => {
      queueMicrotask(() => {
        child.emit('spawn')
        child.emit('exit', 23, null)
      })
      return child
    })
    const plan = createClaudeLaunchPlan({ repo: 'octocat/hello', cwd: 'C:\\repo', sessionId: SESSION, env, platform: 'win32', exists })

    await expect(launchClaudeInTerminal(plan, start as never)).rejects.toThrow('退出码 23')
  })
})
