import path from 'node:path'
import { buildPreview } from '../shared/tools/preview.js'
import type { KnownRepo } from '../shared/tools/repos.js'
import type { ActionPreview } from '../shared/tools/types.js'
import { validateToolShelfText } from './tool-validate.js'

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
