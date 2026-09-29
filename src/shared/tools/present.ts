import { expandRaw } from './quote.js'
import { TOOL_TYPE_LABEL, type ToolAction } from './types.js'

export type RunPhase = 'running' | 'done' | 'aborted'
export type RunTone = 'running' | 'ok' | 'failed' | 'aborted'

export function runStatus(phase: RunPhase, exitCode: number | null): {
  tone: RunTone
  label: string
  stderrFirst: boolean
} {
  if (phase === 'running') return { tone: 'running', label: '运行中', stderrFirst: false }
  if (phase === 'aborted') return { tone: 'aborted', label: '已终止', stderrFirst: false }
  if (exitCode === 0) return { tone: 'ok', label: '完成', stderrFirst: false }
  const code = exitCode === null ? '无' : String(exitCode)
  return { tone: 'failed', label: `失败（退出码 ${code}）`, stderrFirst: true }
}

export function copyFeedback(ok: boolean): string {
  return ok ? '已复制' : '复制失败'
}

export function errorLine(message: string): number | null {
  const match = /第\s*(\d+)\s*行/.exec(message)
  if (!match) return null
  const line = Number(match[1])
  return Number.isInteger(line) && line > 0 ? line : null
}

/** Confirm button names the effect, using the values the user actually filled in. */
export function confirmButtonLabel(action: ToolAction, values: Readonly<Record<string, string>>): string {
  if (action.confirmLabel) {
    const allowed: Record<string, string> = {}
    for (const param of action.params ?? []) allowed[param.key] = values[param.key] ?? param.default ?? ''
    const label = expandRaw(action.confirmLabel, allowed).replace(/\s+/g, ' ').trim()
    if (label) return label
  }
  if (action.type === 'template') return `复制${action.title}`
  const filled = (key: string) => {
    const param = action.params?.find(item => item.key === key)
    return (values[key] ?? param?.default ?? '').trim()
  }
  if (action.type === 'open-folder') {
    const folder = filled(action.params?.[0]?.key ?? 'folder')
    return action.editor ? `用编辑器打开 ${folder}` : `打开 ${folder}`
  }
  if (action.type === 'open-url') {
    const repo = filled('repo') || filled(action.params?.[0]?.key ?? 'url')
    return repo ? `打开 ${repo}` : `打开${action.title}`
  }
  const cwd = filled('cwd')
  const name = filled('name')
  if (cwd && name && action.title.includes('初始化')) return `在 ${cwd} 初始化 ${name}`
  if (cwd) return `在 ${cwd} 运行${action.title}`
  return `运行${action.title}`
}

export function filterActions(actions: readonly ToolAction[], query: string): ToolAction[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...actions]
  return actions.filter(action => {
    const hay = `${action.title}\n${action.description ?? ''}\n${TOOL_TYPE_LABEL[action.type]}`.toLowerCase()
    return hay.includes(needle)
  })
}
