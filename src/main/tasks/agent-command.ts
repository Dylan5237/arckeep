import type { TaskAutonomy } from '../../shared/tasks/types.js'

export interface AgentInvocation {
  file: string
  args: string[]
  shell: boolean
  /** The prompt is always delivered on stdin so user text never enters a command line. */
  stdin: string
}

export function agentArgsForClaude(input: {
  sessionId: string
  resume: boolean
  autonomy: TaskAutonomy
}): string[] {
  // stream-json gives live progress and still ends with the same result object
  // that --output-format json returns.
  const args = ['-p', '--output-format', 'stream-json', '--verbose']
  if (input.resume) args.push('--resume', input.sessionId)
  else args.push('--session-id', input.sessionId)
  if (input.autonomy === 'full') {
    args.push('--dangerously-skip-permissions')
  } else if (input.autonomy === 'read-only') {
    args.push('--permission-mode', 'plan')
  } else {
    // Headless print mode cannot answer permission prompts. Pre-approve the
    // local editing tools and shell; network-capable tools stay off at this level.
    args.push(
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read,Write,Edit,Glob,Grep,LS,NotebookEdit,Bash'
    )
  }
  return args
}

export function agentArgsForCodex(input: {
  sessionId: string
  resume: boolean
  autonomy: TaskAutonomy
}): string[] {
  const args = ['exec']
  if (input.resume) args.push('resume', input.sessionId)
  args.push('--json', '--skip-git-repo-check')
  if (!input.resume) args.push('--color', 'never')
  if (input.autonomy === 'full') {
    args.push('--dangerously-bypass-approvals-and-sandbox')
  } else {
    const sandbox = input.autonomy === 'read-only' ? 'read-only' : 'workspace-write'
    // Single-quoted TOML literal avoids any double quotes on the Windows command line.
    args.push('-c', `sandbox_mode='${sandbox}'`, '-c', "approval_policy='never'")
  }
  args.push('-')
  return args
}

export function buildAgentInvocation(input: {
  agent: 'claude' | 'codex'
  file: string
  sessionId: string
  resume: boolean
  autonomy: TaskAutonomy
  prompt: string
  shell?: boolean
}): AgentInvocation {
  return {
    file: input.file,
    args: input.agent === 'claude'
      ? agentArgsForClaude(input)
      : agentArgsForCodex(input),
    shell: input.shell === true,
    stdin: input.prompt
  }
}

/** Quotes just the executable for the shell:true Windows path; controlled args have no spaces. */
export function shellCommandFile(file: string): string {
  return /[\s"&|<>^]/.test(file) ? '"' + file.replace(/"/g, '""') + '"' : file
}
