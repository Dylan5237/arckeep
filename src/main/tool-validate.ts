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

function fieldName(pointer: string): string {
  const parts = pointer.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? '配置'
}

function describe(error: ErrorObject): string {
  const field = fieldName(error.instancePath || '')
  switch (error.keyword) {
    case 'enum': {
      const allowed = Array.isArray(error.params.allowedValues)
        ? error.params.allowedValues.map(value => String(value))
        : []
      if (allowed.length === 0) return `${field} 不在允许的取值里`
      return `${field} 只能是 ${allowed.join('、')} 其中之一`
    }
    case 'const':
      return `${field} 必须是 ${String(error.params.allowedValue ?? error.params.allowedValues ?? 1)}`
    case 'required':
      return `缺少 ${String(error.params.missingProperty)}`
    case 'additionalProperties':
      return `有未知字段 ${String(error.params.additionalProperty)}`
    case 'type':
      return `${field} 类型应为 ${String(error.params.type)}`
    case 'pattern':
      return `${field} 格式不匹配`
    case 'minLength':
      return `${field} 不能为空`
    case 'maxLength':
      return `${field} 太长`
    case 'maxItems':
      return `${field} 数量超过上限`
    case 'false schema':
      return `${field} 这个类型不能带这个字段`
    default:
      return error.message ?? '不符合 schema'
  }
}

function errorPointer(error: ErrorObject): string {
  if (error.keyword === 'additionalProperties' && typeof error.params.additionalProperty === 'string') {
    return `${error.instancePath}/${String(error.params.additionalProperty)}`
  }
  return error.instancePath || ''
}

function schemaMessages(errors: readonly ErrorObject[]): { pointer: string, message: string } {
  const ranked = [...errors].sort((a, b) => {
    const score = (error: ErrorObject) => (error.keyword === 'enum' ? 0 : error.instancePath ? 1 : 2)
    return score(a) - score(b)
  })
  const seen = new Set<string>()
  const messages: string[] = []
  let pointer = ''
  for (const error of ranked) {
    const path = errorPointer(error)
    const key = path || error.keyword
    if (seen.has(key)) continue
    seen.add(key)
    if (!pointer) pointer = path
    messages.push(describe(error))
    if (messages.length >= 3) break
  }
  return { pointer, message: messages.join('；') || '不符合 schema' }
}

function failure(text: string, pointer: string, message: string): ToolConfigFailure {
  const location = pointer ? locateJsonPointer(text, pointer) : { line: 1, column: 1 }
  return {
    ok: false,
    path: pointer || '/',
    line: location.line,
    column: location.column,
    error: `第 ${location.line} 行：${message}`
  }
}

function templatesOf(action: ToolAction): Array<{ field: string, value: string, shell?: ShellKind }> {
  const confirm = action.confirmLabel ? [{ field: 'confirmLabel', value: action.confirmLabel }] : []
  if (action.type === 'open-url') return [{ field: 'url', value: action.url }, ...confirm]
  if (action.type === 'template') return [{ field: 'text', value: action.text }, ...confirm]
  if (action.type === 'open-folder') {
    const fields: Array<{ field: string, value: string, shell?: ShellKind }> = [{ field: 'path', value: action.path }]
    if (action.editor) fields.push({ field: 'editor', value: action.editor })
    return [...fields, ...confirm]
  }
  const fields: Array<{ field: string, value: string, shell?: ShellKind }> = [
    { field: 'command', value: action.command, shell: action.shell }
  ]
  if (action.previewCommand) {
    fields.push({ field: 'previewCommand', value: action.previewCommand, shell: action.shell })
  }
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
    return { ok: false, error: '第 1 行：配置太长', line: 1, column: 1, path: '/' }
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
      error: `第 ${location.line} 行，第 ${location.column} 列：JSON 无法解析（${detail}）`
    }
  }
  if (!validateSchema(parsed)) {
    const summary = schemaMessages(validateSchema.errors ?? [])
    return failure(text, summary.pointer, summary.message)
  }
  const config = parsed as ToolShelfConfig
  const seen = new Set<string>()
  for (const [index, action] of config.actions.entries()) {
    const problem = checkAction(action, index, text, seen)
    if (problem) return problem
  }
  return { ok: true, config }
}
