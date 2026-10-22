import { describe, expect, it } from 'vitest'
import type { KnownRepo } from '../src/shared/tools/repos.js'
import type { ActionPreview } from '../src/shared/tools/types.js'
import type { ShellPlan } from '../src/main/tool-launch.js'
import { ToolPreviewBindings } from '../src/main/tool-request.js'

const repos: KnownRepo[] = [{
  id: 'north/atlas',
  label: 'north/atlas',
  github: 'north/atlas',
  path: 'C:\\work\\atlas',
  sources: ['github', 'local']
}]

const preview: ActionPreview = {
  actionId: 'init-project',
  title: '初始化项目',
  type: 'run-command',
  text: 'tool init --name demo',
  dryRun: 'tool init --dry-run --name demo',
  shell: 'powershell',
  cwd: 'C:\\work\\atlas',
  rehearsal: { status: 'raw', summary: 'Dry run finished', canConfirm: true }
}

const plan = {
  file: 'powershell.exe',
  args: ['-NoProfile', '-Command', 'tool init --name demo'],
  windowsVerbatimArguments: false
} as ShellPlan

function bindingInput(overrides: Partial<{
  requestId: string
  actionId: string
  params: Record<string, string>
  configurationRevision: number
  toolShelfJson: string
  knownRepos: KnownRepo[]
  preview: ActionPreview
  plan: ShellPlan
}> = {}) {
  return {
    requestId: 'request-1',
    actionId: 'init-project',
    params: { name: 'demo' },
    configurationRevision: 4,
    toolShelfJson: '{"version":1}',
    knownRepos: repos,
    preview,
    plan,
    ...overrides
  }
}

describe('ToolPreviewBindings', () => {
  it('returns the exact single-use plan only while config, params, and repo mapping match', () => {
    const bindings = new ToolPreviewBindings(() => 'one-time-id', () => 1000)
    const input = bindingInput()
    const id = bindings.issue(input)
    expect(bindings.take(id, input)).toEqual({ ok: true, data: { preview, plan } })
    expect(bindings.take(id, input)).toEqual({ ok: false, error: '预览已失效，请重新预览' })
  })

  it('invalidates a confirmed preview when the config revision, params, or repo mapping changes', () => {
    const bindings = new ToolPreviewBindings(() => 'one-time-id', () => 1000)
    const input = bindingInput()
    const id = bindings.issue(input)
    expect(bindings.take(id, { ...input, configurationRevision: input.configurationRevision + 1 }).ok).toBe(false)

    const next = bindings.issue(input)
    expect(bindings.take(next, { ...input, params: { name: 'other' } }).ok).toBe(false)

    const third = bindings.issue(input)
    expect(bindings.take(third, { ...input, knownRepos: [{ ...repos[0], path: 'C:\\work\\moved' }] }).ok).toBe(false)
  })

  it('invalidates a preview when the expanded command, shell, or working directory differs', () => {
    const bindings = new ToolPreviewBindings(() => 'one-time-id', () => 1000)
    const input = bindingInput()
    const command = bindings.issue(input)
    expect(bindings.take(command, { ...input, preview: { ...preview, text: 'tool init --name other' } }).ok).toBe(false)

    const shell = bindings.issue(input)
    expect(bindings.take(shell, { ...input, preview: { ...preview, shell: 'cmd' } }).ok).toBe(false)

    const cwd = bindings.issue(input)
    expect(bindings.take(cwd, { ...input, preview: { ...preview, cwd: 'C:\\work\\other' } }).ok).toBe(false)
  })

  it('invalidates previews when cancelled or expired', () => {
    let now = 1000
    const bindings = new ToolPreviewBindings(() => 'one-time-id', () => now)
    const input = bindingInput()
    const cancelled = bindings.issue(input)
    bindings.cancelRequest(input.requestId)
    expect(bindings.take(cancelled, input).ok).toBe(false)

    const expired = bindings.issue(input)
    now += 10 * 60_000 + 1
    expect(bindings.take(expired, input).ok).toBe(false)
  })
})
