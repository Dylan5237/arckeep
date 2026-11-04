import { spawn } from 'node:child_process'
import type { TaskAgentStatus } from '../../shared/tasks/types.js'
import { resolveWindowsExecutable } from '../claude/launcher.js'
import { shellCommandFile } from './agent-command.js'

const VERSION_TIMEOUT_MS = 6_000

function readVersion(file: string, shell: boolean): Promise<string | null> {
  return new Promise(resolve => {
    let settled = false
    let child: ReturnType<typeof spawn>
    const finish = (value: string | null) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      child = spawn(shell ? shellCommandFile(file) : file, ['--version'], {
        shell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      finish(null)
      return
    }
    let output = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already exited */ }
      finish(null)
    }, VERSION_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => { if (output.length < 2000) output += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { if (output.length < 2000) output += chunk.toString('utf8') })
    child.once('error', () => { clearTimeout(timer); finish(null) })
    child.once('close', () => {
      clearTimeout(timer)
      const first = output.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? ''
      finish(first.slice(0, 200) || null)
    })
  })
}

async function detectOne(agent: 'claude' | 'codex'): Promise<TaskAgentStatus> {
  const command = resolveWindowsExecutable(agent)
  if (!command) return { agent, available: false, version: null, command: null }
  const version = await readVersion(command, /\.(cmd|bat)$/i.test(command))
  return { agent, available: true, version, command }
}

export async function detectAgents(): Promise<TaskAgentStatus[]> {
  return Promise.all([detectOne('claude'), detectOne('codex')])
}
