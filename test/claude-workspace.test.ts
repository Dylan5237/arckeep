import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyClaudeWorkspace } from '../src/main/claude/service.js'

let directory = ''

function git(args: string[]): void {
  execFileSync('git', args, { windowsHide: true, stdio: 'ignore' })
}

function repository(remote: string, name = 'repo'): string {
  const root = path.join(directory, name)
  mkdirSync(root, { recursive: true })
  git(['init', '--quiet', root])
  git(['-C', root, 'remote', 'add', 'origin', remote])
  return root
}

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = ''
})

describe('Claude workspace verification', () => {
  it('resolves a selected subdirectory to its GitHub repository root', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-workspace-'))
    const root = repository('git@github.com:octocat/hello.git')
    const nested = path.join(root, 'packages', 'app')
    mkdirSync(nested, { recursive: true })

    await expect(verifyClaudeWorkspace(nested, 'OCTOCAT/HELLO')).resolves.toBe(await realpath(root))
    const httpsRoot = repository('https://github.com/octocat/hello.git', 'https-repo')
    await expect(verifyClaudeWorkspace(httpsRoot, 'octocat/hello')).resolves.toBe(await realpath(httpsRoot))
  })

  it('rejects a directory whose origin belongs to another GitHub project', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-workspace-mismatch-'))
    const root = repository('https://github.com/octocat/other.git')

    await expect(verifyClaudeWorkspace(root, 'octocat/hello')).rejects.toThrow('origin 与当前项目不匹配')
  })

  it('rejects remotes that merely contain a github.com path but use another host', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-workspace-host-'))
    const remotes = [
      'https://notgithub.com/octocat/hello.git',
      'https://gitlab.example/path/github.com/octocat/hello.git'
    ]
    for (const [index, remote] of remotes.entries()) {
      const root = repository(remote, 'repo-' + index)
      await expect(verifyClaudeWorkspace(root, 'octocat/hello')).rejects.toThrow('origin 与当前项目不匹配')
    }
  })

  it('rejects a non-repository directory', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'arckeep-claude-workspace-invalid-'))
    const plain = path.join(directory, 'plain')
    mkdirSync(plain)

    await expect(verifyClaudeWorkspace(plain, 'octocat/hello')).rejects.toThrow('不是有效的 GitHub 仓库')
  })
})
