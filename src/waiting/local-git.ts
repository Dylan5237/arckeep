import { execFile } from 'node:child_process'
import { parseAheadRefLines } from '../shared/waiting/local-branch.js'
import type { LocalBranchHit, SourceError } from '../shared/waiting/types.js'

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

export type GitRunner = (args: readonly string[]) => Promise<GitResult>

export function execGit(args: readonly string[]): Promise<GitResult> {
  return new Promise(resolve => {
    execFile('git', [...args], { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolve({ code: 127, stdout: '', stderr: 'git 不在 PATH 里' })
        return
      }
      const code = error && typeof (error as { code?: unknown }).code === 'number'
        ? (error as { code: number }).code
        : error ? 1 : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

const REF_FORMAT = '%(refname:short)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:iso-strict)%00%(objectname:short)%00%(subject)'

export async function loadUnpushedBranches(dirs: readonly string[], git: GitRunner = execGit): Promise<{
  hits: LocalBranchHit[]
  errors: SourceError[]
}> {
  const hits: LocalBranchHit[] = []
  const errors: SourceError[] = []
  for (const dir of dirs) {
    const inside = await git(['-C', dir, 'rev-parse', '--is-inside-work-tree'])
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
      errors.push({ source: '本地没推送', message: `不是 git 仓库：${dir}` })
      continue
    }
    const remote = await git(['-C', dir, 'remote', 'get-url', 'origin'])
    const remoteUrl = remote.code === 0 ? remote.stdout.trim() : null
    const refs = await git(['-C', dir, 'for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads'])
    if (refs.code !== 0) {
      errors.push({ source: '本地没推送', message: refs.stderr.trim() || `无法读取分支：${dir}` })
      continue
    }
    hits.push(...parseAheadRefLines(refs.stdout, dir, remoteUrl))
  }
  return { hits, errors }
}
