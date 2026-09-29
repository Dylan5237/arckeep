import { Ajv2020, type AnySchema, type ErrorObject } from 'ajv/dist/2020.js'
import { toolShelfSchemaDocument } from './tool-assets.js'
import { locateJsonPointer, syntaxErrorLocation } from '../shared/tools/locate.js'
import { assertPlaceholders, placeholderInsideQuotes } from '../shared/tools/quote.js'
import type { ShellKind, ToolAction, ToolShelfConfig } from '../shared/tools/types.js'

export interface ToolConfigFailure {
  ok: false
  error: string
  line: number
  column: number
  path: string
}

export type ToolConfigResult = { ok: true, config: ToolShelfConfig } | ToolConfigFailure

const ajv = new Ajv2020({ allErrors: true, strict: false })
const validateSchema = ajv.compile(toolShelfSchemaDocument() as AnySchema)

function describe(error: ErrorObject): string {
  const at = error.instancePath || '/'
  switch (error.keyword) {
    case 'enum':
      return `${at} 不在允许的取值里`
    case 'const':
      return `${at} 必须是 1`
    case 'required':
      return `${at} 缺少 ${String(error.params.missingProperty)}`
    case 'additionalProperties':
      return `${at} 有未知字段 ${String(error.params.additionalProperty)}`
    case 'type':
      return `${at} 类型应为 ${String(error.params.type)}`
    case 'pattern':
      return `${at} 格式不匹配`
    case 'minLength':
      return `${at} 不能为空`
    case 'maxLength':
      return `${at} 太长`
    case 'maxItems':
      return `${at} 数量超过上限`
    case 'false schema':
      return `${at} 这个类型不能带这个字段`
    default:
      return `${at} ${error.message ?? '不符合 schema'}`
  }
}

function failure(text: string, pointer: string, message: string): ToolConfigFailure {
  const location = pointer ? locateJsonPointer(text, pointer) : { line: 1, column: 1 }
  const pathLabel = pointer || '/'
  return {
    ok: false,
    path: pathLabel,
    line: location.line,
    column: location.column,
    error: `${pathLabel} · 第 ${location.line} 行，第 ${location.column} 列：${message}`
  }
}

function templatesOf(action: ToolAction): Array<{ field: string, value: string, shell?: ShellKind }> {
  if (action.type === 'open-url') return [{ field: 'url', value: action.url }]
  if (action.type === 'template') return [{ field: 'text', value: action.text }]
  if (action.type === 'open-folder') {
    const fields = [{ field: 'path', value: action.path }]
    if (action.editor) fields.push({ field: 'editor', value: action.editor })
    return fields
  }
  const fields: Array<{ field: string, value: string, shell?: ShellKind }> = [
    { field: 'command', value: action.command, shell: action.shell }
  ]
  if (action.cwd) fields.push({ field: 'cwd', value: action.cwd })
  return fields
}

function checkAction(action: ToolAction, index: number, text: string, seen: Set<string>): ToolConfigFailure | null {
  const base = `/actions/${index}`
  if (seen.has(action.id)) return failure(text, `${base}/id`, `动作 id 重复：${action.id}`)
  seen.add(action.id)
  const keys = new Set<string>()
  for (const [paramIndex, param] of (action.params ?? []).entries()) {
    if (keys.has(param.key)) {
      return failure(text, `${base}/params/${paramIndex}/key`, `参数名重复：${param.key}`)
    }
    keys.add(param.key)
  }
  if (action.type === 'run-command' && action.shell === 'cmd' && /[\r\n]/.test(action.command)) {
    return failure(text, `${base}/command`, 'cmd 命令模板不能换行')
  }
  for (const template of templatesOf(action)) {
    try {
      assertPlaceholders(template.value, keys)
      if (template.shell && placeholderInsideQuotes(template.value, template.shell)) {
        throw new Error('参数占位符必须写在引号外面，执行时会按 shell 加引号')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '占位符无效'
      return failure(text, `${base}/${template.field}`, message)
    }
  }
  return null
}

export function validateToolShelfText(text: string): ToolConfigResult {
  if (text.length > 200_000) {
    return { ok: false, error: '/ · 第 1 行，第 1 列：配置太长', line: 1, column: 1, path: '/' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    const location = syntaxErrorLocation(text, error instanceof Error ? error : new Error('JSON'))
    const detail = error instanceof Error ? error.message : 'JSON 无法解析'
    return {
      ok: false,
      path: '/',
      line: location.line,
      column: location.column,
      error: `/ · 第 ${location.line} 行，第 ${location.column} 列：JSON 无法解析（${detail}）`
    }
  }
  if (!validateSchema(parsed)) {
    const errors = validateSchema.errors ?? []
    const first = errors[0]
    const pointer = first?.instancePath ?? ''
    const extra = first?.keyword === 'additionalProperties' && typeof first.params.additionalProperty === 'string'
      ? `${pointer}/${String(first.params.additionalProperty)}`
      : pointer
    const message = errors.slice(0, 3).map(describe).join('；') || '不符合 schema'
    return failure(text, extra, message)
  }
  const config = parsed as ToolShelfConfig
  const seen = new Set<string>()
  for (const [index, action] of config.actions.entries()) {
    const problem = checkAction(action, index, text, seen)
    if (problem) return problem
  }
  return { ok: true, config }
}
