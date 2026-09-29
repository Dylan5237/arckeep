import { buildPreview } from './preview.js'
import type { KnownRepo } from './repos.js'
import type { ToolAction } from './types.js'

/** Only run-command asks for a preview and a confirm click. */
export function confirmsBeforeRun(action: ToolAction): boolean {
  return action.type === 'run-command'
}

/** What a shelf click does. Read-only actions with no fields run immediately. */
export function entryStep(action: ToolAction): 'params' | 'preview' | 'run' {
  if ((action.params?.length ?? 0) > 0) return 'params'
  if (confirmsBeforeRun(action)) return 'preview'
  return 'run'
}

/** The params page primary button opens a preview only for commands. */
export function paramsSubmitsToPreview(action: ToolAction): boolean {
  return confirmsBeforeRun(action)
}

export function directActionLabel(action: ToolAction): '打开' | '复制' | '预览' {
  if (action.type === 'template') return '复制'
  if (action.type === 'open-url' || action.type === 'open-folder') return '打开'
  return '预览'
}

export function paramsIntro(action: ToolAction): string {
  if (action.type === 'template') return '填写后点复制。这一步不改动文件。'
  if (action.type === 'open-url' || action.type === 'open-folder') return '填写后点打开。这一步不改动文件。'
  return '填写参数。下一步只生成预览，还不会执行。'
}

export function shelfIntro(count: number): string {
  return `${count} 个动作。输入即筛选。打开和复制会直接执行，运行命令会先预览。`
}

export function describeEffect(
  action: ToolAction,
  values: Readonly<Record<string, string>>,
  knownRepos: readonly KnownRepo[] = []
): string {
  if (action.type === 'run-command') return ''
  try {
    const preview = buildPreview(action, values, '', knownRepos)
    if (preview.type === 'open-url') return `将打开 ${preview.text}`
    if (preview.type === 'open-folder') {
      const folder = preview.argv?.[preview.argv.length - 1] ?? preview.text
      return `将打开 ${folder}`
    }
    if (preview.type === 'template') return '将复制到剪贴板'
    return ''
  } catch (error) {
    const repoField = (action.params ?? []).some(param => param.input === 'repo')
    if (action.type === 'open-url' && repoField) {
      return '从已知仓库里选一个。列表来自关注列表、GitHub 拉到的仓库和本地路径。'
    }
    return error instanceof Error ? error.message : ''
  }
}

export interface OutputBlock {
  stream: 'stdout' | 'stderr'
  title: string
  text: string
}

/** Empty streams are omitted so a success page never shows a red「（无）」. */
export function outputBlocks(options: {
  stdout: string
  stderr: string
  stderrFirst: boolean
}): OutputBlock[] {
  const stdout = options.stdout.length > 0
    ? [{ stream: 'stdout' as const, title: '标准输出', text: options.stdout }]
    : []
  const stderr = options.stderr.length > 0
    ? [{ stream: 'stderr' as const, title: '标准错误', text: options.stderr }]
    : []
  return options.stderrFirst ? [...stderr, ...stdout] : [...stdout, ...stderr]
}
