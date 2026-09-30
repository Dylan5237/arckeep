import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildPreview } from '../shared/tools/preview.js'
import type { KnownRepo } from '../shared/tools/repos.js'
import type { ActionPreview } from '../shared/tools/types.js'
import { validateToolShelfText } from './tool-validate.js'
import type { ShellPlan } from './tool-launch.js'

const PREVIEW_TTL_MS = 10 * 60_000
const MAX_PREVIEWS = 64

export interface PreviewBindingInput {
  requestId: string
  actionId: string
  params: Record<string, string>
  configurationRevision: number
  toolShelfJson: string
  knownRepos: readonly KnownRepo[]
  preview: ActionPreview
  plan: ShellPlan
}

export interface PreviewBindingCurrent {
  actionId: string
  params: Record<string, string>
  configurationRevision: number
  toolShelfJson: string
  knownRepos: readonly KnownRepo[]
  preview: ActionPreview
}

export interface BoundCommandPreview {
  preview: ActionPreview
  plan: ShellPlan
}

interface StoredPreviewBinding {
  requestId: string
  actionId: string
  paramsSignature: string
  configurationRevision: number
  toolShelfJson: string
  knownReposSignature: string
  previewSignature: string
  preview: ActionPreview
  plan: ShellPlan
  createdAt: number
}

function paramsSignature(params: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(params).sort(([a], [b]) => a.localeCompare(b)))
}

export function knownReposSignature(knownRepos: readonly KnownRepo[]): string {
  return JSON.stringify(knownRepos.map(repo => ({
    id: repo.id,
    label: repo.label,
    github: repo.github,
    path: repo.path,
    sources: [...repo.sources].sort()
  })).sort((a, b) => a.id.localeCompare(b.id)))
}

function previewSignature(preview: ActionPreview): string {
  return JSON.stringify({
    actionId: preview.actionId,
    title: preview.title,
    type: preview.type,
    text: preview.text,
    dryRun: preview.dryRun,
    shell: preview.shell,
    cwd: preview.cwd,
    argv: preview.argv
  })
}

function copyPreview(preview: ActionPreview): ActionPreview {
  return {
    ...preview,
    argv: preview.argv ? [...preview.argv] : undefined,
    rehearsal: preview.rehearsal
      ? { ...preview.rehearsal, files: preview.rehearsal.files ? [...preview.rehearsal.files] : undefined }
      : undefined,
    confirmationId: undefined
  }
}

function copyPlan(plan: ShellPlan): ShellPlan {
  return { ...plan, args: [...plan.args] }
}

/** Single-use, expiring bindings between the UI's preview and the exact main-process command plan. */
export class ToolPreviewBindings {
  private readonly bindings = new Map<string, StoredPreviewBinding>()

  constructor(
    private readonly createId: () => string = randomUUID,
    private readonly now: () => number = Date.now
  ) {}

  issue(input: PreviewBindingInput): string {
    this.prune()
    while (this.bindings.size >= MAX_PREVIEWS) {
      const oldest = this.bindings.keys().next().value as string | undefined
      if (!oldest) break
      this.bindings.delete(oldest)
    }
    let id = this.createId()
    while (this.bindings.has(id)) id = this.createId()
    const preview = copyPreview(input.preview)
    this.bindings.set(id, {
      requestId: input.requestId,
      actionId: input.actionId,
      paramsSignature: paramsSignature(input.params),
      configurationRevision: input.configurationRevision,
      toolShelfJson: input.toolShelfJson,
      knownReposSignature: knownReposSignature(input.knownRepos),
      previewSignature: previewSignature(preview),
      preview,
      plan: copyPlan(input.plan),
      createdAt: this.now()
    })
    return id
  }

  take(id: unknown, current: PreviewBindingCurrent):
    | { ok: true, data: BoundCommandPreview }
    | { ok: false, error: string } {
    this.prune()
    if (typeof id !== 'string') return { ok: false, error: '请先预览要执行的命令' }
    const binding = this.bindings.get(id)
    this.bindings.delete(id)
    if (!binding) return { ok: false, error: '预览已失效，请重新预览' }
    if (
      binding.actionId !== current.actionId
      || binding.paramsSignature !== paramsSignature(current.params)
      || binding.configurationRevision !== current.configurationRevision
      || binding.toolShelfJson !== current.toolShelfJson
      || binding.knownReposSignature !== knownReposSignature(current.knownRepos)
      || binding.previewSignature !== previewSignature(current.preview)
    ) {
      return { ok: false, error: '配置、参数或仓库映射已变化，请重新预览' }
    }
    return { ok: true, data: { preview: binding.preview, plan: binding.plan } }
  }

  cancelRequest(requestId: string): void {
    for (const [id, binding] of this.bindings) {
      if (binding.requestId === requestId) this.bindings.delete(id)
    }
  }

  clear(): void {
    this.bindings.clear()
  }

  private prune(): void {
    const cutoff = this.now() - PREVIEW_TTL_MS
    for (const [id, binding] of this.bindings) {
      if (binding.createdAt < cutoff) this.bindings.delete(id)
    }
  }
}

export function normalizeActionId(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-z0-9][a-z0-9-]{0,60}$/.test(input)) {
    throw new Error('动作 id 无效')
  }
  return input
}

export function normalizeParamInput(input: unknown): Record<string, string> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('参数无效')
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key)) throw new Error('参数名无效')
    if (typeof value !== 'string') throw new Error('参数必须是字符串')
    if (value.length > 8000) throw new Error('参数过长')
    values[key] = value
  }
  return values
}

export function previewStoredAction(
  json: string,
  actionId: string,
  params: Record<string, string>,
  baseCwd: string,
  knownRepos: readonly KnownRepo[] = []
): ActionPreview {
  const validated = validateToolShelfText(json)
  if (!validated.ok) throw new Error(validated.error)
  const action = validated.config.actions.find(item => item.id === actionId)
  if (!action) throw new Error('没有这个动作')
  const preview = buildPreview(action, params, baseCwd, knownRepos)
  if (preview.cwd) preview.cwd = path.resolve(preview.cwd)
  return preview
}
