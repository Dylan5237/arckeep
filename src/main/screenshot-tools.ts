import type { ToolFixture } from '../shared/tools/fixture.js'
import { buildPreview, formatDuration } from '../shared/tools/preview.js'
import { powershellLaunchScript } from '../shared/tools/quote.js'
import type { ToolAction } from '../shared/tools/types.js'
import { validateToolShelfText } from './tool-validate.js'

export const TOOL_SCREENSHOT_SCENES = [
  'tools',
  'tools-params',
  'tools-preview',
  'tools-running',
  'tools-exit',
  'tools-aborted',
  'tools-invalid',
  'tools-empty',
  'tools-narrow'
] as const

export type ToolScreenshotScene = (typeof TOOL_SCREENSHOT_SCENES)[number]

const shelfActions: ToolAction[] = [
  {
    id: 'open-arckeep',
    title: '打开 Arckeep 仓库',
    description: '在浏览器中打开仓库页面。',
    type: 'open-url',
    url: 'https://github.com/{{owner}}/{{repo}}',
    params: [
      { key: 'owner', label: '所有者', default: 'Dylan5237' },
      { key: 'repo', label: '仓库', default: 'arckeep' }
    ]
  },
  {
    id: 'open-folder-editor',
    title: '在编辑器中打开文件夹',
    description: '用编辑器打开一个本地文件夹。',
    type: 'open-folder',
    editor: 'code',
    path: '{{folder}}',
    params: [{ key: 'folder', label: '文件夹', default: 'C:\\work\\demo' }]
  },
  {
    id: 'apo-init-dry-run',
    title: 'apo 项目初始化（演练）',
    description: 'apo init --dry-run，确认前不会运行。',
    type: 'run-command',
    shell: 'powershell',
    cwd: '{{cwd}}',
    command: 'apo init --dry-run --name {{name}}',
    params: [
      { key: 'cwd', label: '工作目录', default: 'C:\\work\\demo' },
      { key: 'name', label: '项目名', default: 'demo' }
    ]
  },
  {
    id: 'dispatch-note',
    title: '派工说明',
    description: '生成派工说明并复制到剪贴板。',
    type: 'template',
    text: '派工说明\n项目：{{project}}\n任务：{{task}}',
    params: [
      { key: 'project', label: '项目', default: '示例项目' },
      { key: 'task', label: '任务', default: '补齐验收步骤' }
    ]
  },
  {
    id: 'open-ci',
    title: '打开 CI 页面',
    description: '打开仓库的 Actions 页面。',
    type: 'open-url',
    url: 'https://github.com/{{owner}}/{{repo}}/actions',
    params: [
      { key: 'owner', label: '所有者', default: 'example' },
      { key: 'repo', label: '仓库', default: 'demo' }
    ]
  },
  {
    id: 'open-design',
    title: '打开设计稿',
    description: '打开一份 https 设计稿链接。',
    type: 'open-url',
    url: 'https://example.com/design/{{slug}}',
    params: [{ key: 'slug', label: '稿名', default: 'north' }]
  },
  {
    id: 'open-logs',
    title: '查看日志目录',
    description: '在文件管理器中打开日志目录。',
    type: 'open-folder',
    path: '{{folder}}',
    params: [{ key: 'folder', label: '日志目录', default: 'C:\\work\\demo\\logs' }]
  },
  {
    id: 'smoke-test',
    title: '运行冒烟测试',
    description: '在工作目录里跑一条只打印的命令。',
    type: 'run-command',
    shell: 'powershell',
    cwd: '{{cwd}}',
    command: 'echo smoke-{{name}}',
    params: [
      { key: 'cwd', label: '工作目录', default: 'C:\\work\\demo' },
      { key: 'name', label: '名称', default: 'north' }
    ]
  },
  {
    id: 'weekly-note',
    title: '周报模板',
    description: '复制一段周报开头。',
    type: 'template',
    text: '周报\n本周：{{item}}',
    params: [{ key: 'item', label: '事项', default: '工具架' }]
  },
  {
    id: 'open-release-notes',
    title: '打开发布说明',
    description: '打开发布说明页面。',
    type: 'open-url',
    url: 'https://github.com/{{owner}}/{{repo}}/releases',
    params: [
      { key: 'owner', label: '所有者', default: 'example' },
      { key: 'repo', label: '仓库', default: 'demo' }
    ]
  }
]

const invalidDraft = `{
  "version": 1,
  "actions": [
    {
      "id": "bad",
      "title": "坏动作",
      "type": "launch-missile"
    }
  ]
}
`

function apoAction(): ToolAction {
  const action = shelfActions.find(item => item.id === 'apo-init-dry-run')
  if (!action) throw new Error('missing apo fixture')
  return action
}

export function buildToolFixture(scene: string): ToolFixture | null {
  if (scene === 'tools' || scene === 'tools-narrow') {
    return { page: 'tools', scene: scene === 'tools-narrow' ? 'narrow' : 'shelf', actions: shelfActions }
  }
  if (scene === 'tools-empty') return { page: 'tools', scene: 'empty' }
  if (scene === 'tools-params') {
    const action = apoAction()
    return {
      page: 'tools',
      scene: 'params',
      action,
      values: { cwd: 'C:\\work\\demo', name: 'demo' }
    }
  }
  if (scene === 'tools-preview') {
    const action = apoAction()
    const preview = buildPreview(action, { cwd: 'C:\\work\\demo', name: 'demo' }, 'C:\\work\\demo')
    return {
      page: 'tools',
      scene: 'preview',
      action,
      previewText: preview.text,
      cwd: 'C:\\work\\demo',
      shellLabel: 'PowerShell'
    }
  }
  const command = powershellLaunchScript("apo init --dry-run --name '北区'")
  const lines = [
    { stream: 'stdout' as const, text: '正在编译北区' },
    { stream: 'stderr' as const, text: '警告：示例输出，没有真正执行' }
  ]
  if (scene === 'tools-running') {
    return { page: 'tools', scene: 'running', title: 'apo 项目初始化（演练）', command, lines, status: '运行中' }
  }
  if (scene === 'tools-exit') {
    return {
      page: 'tools',
      scene: 'exit',
      title: 'apo 项目初始化（演练）',
      command,
      lines,
      status: `退出码 3 · 用时 ${formatDuration(1400)}`
    }
  }
  if (scene === 'tools-aborted') {
    return {
      page: 'tools',
      scene: 'aborted',
      title: 'apo 项目初始化（演练）',
      command,
      lines: [{ stream: 'stdout', text: '正在编译北区' }],
      status: '已终止'
    }
  }
  if (scene === 'tools-invalid') {
    const validated = validateToolShelfText(invalidDraft)
    if (validated.ok) throw new Error('invalid fixture unexpectedly passed schema')
    return { page: 'settings', scene: 'invalid', draft: invalidDraft, error: validated.error }
  }
  return null
}

export function toolScreenshotExpectation(scene: string): string | null {
  switch (scene) {
    case 'tools':
    case 'tools-narrow':
      return '打开发布说明'
    case 'tools-params':
      return '项目名'
    case 'tools-preview':
      return '确认执行'
    case 'tools-running':
      return '正在编译北区'
    case 'tools-exit':
      return '退出码 3'
    case 'tools-aborted':
      return '已终止'
    case 'tools-invalid':
      return '不在允许的取值里'
    case 'tools-empty':
      return '工具架还是空的'
    default:
      return null
  }
}
