import type { ToolParam, ToolParamInput } from './types.js'

/** How a parameter is entered. Template body is the only multiline case. */
export function paramKind(param: ToolParam): ToolParamInput {
  if (param.input) return param.input
  if (param.key === 'cwd' || param.label.includes('工作目录')) return 'directory'
  if (param.key === 'body' || param.label.includes('正文')) return 'multiline'
  return 'line'
}
