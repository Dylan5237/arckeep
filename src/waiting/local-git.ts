import { throwIfCancelled } from '../shared/task-scope.js'
import { runManagedCommand, type ManagedCommandContext } from '../main/managed-command.js'
import { parseAheadRefLines } from '../shared/waiting/local-branch.js'
import type { LocalBranchHit, SourceError } from '../shared/waiting/types.js'

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

export type GitRunner = (args: readonly string[], options?: ManagedCommandContext) => Promise<GitResult>

export function execGit(args: readonly string[], options?: ManagedCommandContext): Promise<GitResult> {
  return runManagedCommand('git', args, {
    ...options,
    timeoutMs: 20_000,
    maxBuffer: 1024 * 1024,
    label: 'Git 本地查询进程'
  }).then(result => result.code === 127 && result.stderr.trim() === 'ARCKEEP_RELAY_EXECUTABLE_NOT_FOUND'
    ? { code: 127, stdout: '', stderr: 'git 不在 PATH 里' }
    : result).catch(error => {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return { code: 127, stdout: '', stderr: 'git 不在 PATH 里' }
    }
    throw error
  })
}

const REF_FORMAT = '%(refname:short)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:iso-strict)%00%(objectname:short)%00%(subject)'

export async function loadUnpushedBranches(
  dirs: readonly string[],
  git: GitRunner = execGit,
  options: ManagedCommandContext = {}
): Promise<{
  hits: LocalBranchHit[]
  errors: SourceError[]
}> {
  const hits: LocalBranchHit[] = []
  const errors: SourceError[] = []
  const commandOptions = {
    signal: options.signal ?? options.tasks?.signal,
    tasks: options.tasks
  }
  const run = async (args: readonly string[]): Promise<GitResult> => {
    throwIfCancelled(commandOptions.signal)
    const result = await git(args, commandOptions)
    throwIfCancelled(commandOptions.signal)
    return result
  }
  for (const dir of dirs) {
    throwIfCancelled(commandOptions.signal)
    const inside = await run(['-C', dir, 'rev-parse', '--is-inside-work-tree'])
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      errors.push({ source: '本地没推送', message: `不是 git 仓库：${dir}` })
      continue
    }
    const remote = await run(['-C', dir, 'remote', 'get-url', 'origin'])
    const remoteUrl = remote.code === 0 ? remote.stdout.trim() : null
    const refs = await run(['-C', dir, 'for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads'])
    if (refs.code !== 0) {
      errors.push({ source: '本地没推送', message: refs.stderr.trim() || `无法读取分支：${dir}` })
      continue
    }
    hits.push(...parseAheadRefLines(refs.stdout, dir, remoteUrl))
  }
  throwIfCancelled(commandOptions.signal)
  return { hits, errors }
}
