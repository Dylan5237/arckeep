import type { ToolFixture } from '../shared/tools/fixture.js'
import { buildPreview } from '../shared/tools/preview.js'
import { summarizeDryRun } from '../shared/tools/rehearsal.js'
import type { KnownRepo } from '../shared/tools/repos.js'
import type { ToolAction } from '../shared/tools/types.js'
import { validateToolShelfText } from './tool-validate.js'

export const TOOL_SCREENSHOT_SCENES = [
  'tools',
  'tools-params',
  'tools-preview',
  'tools-preview-failed',
  'tools-running',
  'tools-success',
  'tools-failed',
  'tools-aborted',
  'tools-copied',
  'tools-invalid',
  'tools-empty',
  'tools-narrow'
] as const

export type ToolScreenshotScene = (typeof TOOL_SCREENSHOT_SCENES)[number]

const knownRepos: KnownRepo[] = [
  {
    id: 'example/demo',
    label: 'example/demo · C:\\work\\demo',
    github: 'example/demo',
    path: 'C:\\work\\demo',
    sources: ['watched', 'local']
  },
  {
    id: 'north/atlas',
    label: 'north/atlas',
    github: 'north/atlas',
    path: null,
    sources: ['github']
  },
  {
    id: 'C:\\work\\notes',
    label: 'C:\\work\\notes',
    github: null,
    path: 'C:\\work\\notes',
    sources: ['local']
  },
  {
    id: 'south/harbor',
    label: 'south/harbor',
    github: 'south/harbor',
    path: null,
    sources: ['todo']
  }
]

const shelfActions: ToolAction[] = [
  {
    id: 'open-repo',
    title: '打开仓库',
    description: '从已知仓库里选一个打开。',
    confirmLabel: '打开 {{repo}}',
    type: 'open-url',
    url: 'https://github.com/{{repo}}',
    params: [{ key: 'repo', label: '仓库', required: true, input: 'repo' }]
  },
  {
    id: 'open-folder-editor',
    title: '在编辑器中打开文件夹',
    description: '用编辑器打开一个本地文件夹。',
    confirmLabel: '用编辑器打开 {{folder}}',
    type: 'open-folder',
    editor: 'code',
    path: '{{folder}}',
    params: [{ key: 'folder', label: '文件夹', required: true, input: 'directory', default: 'C:\\work\\demo' }]
  },
  {
    id: 'apo-init',
    title: 'apo 项目初始化',
    description: '初始化一个 apo 项目。',
    confirmLabel: '在 {{cwd}} 初始化 {{name}}',
    type: 'run-command',
    shell: 'powershell',
    cwd: '{{cwd}}',
    previewCommand: 'apo init --dry-run --name {{name}}',
    command: 'apo init --name {{name}}',
    params: [
      { key: 'cwd', label: '工作目录', required: true, input: 'directory', default: 'C:\\work\\demo' },
      { key: 'name', label: '项目名', required: true, default: 'demo' }
    ]
  },
  {
    id: 'dispatch-note',
    title: '派工说明',
    description: '生成派工说明并复制到剪贴板。',
    confirmLabel: '复制派工说明',
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
    params: [{ key: 'folder', label: '日志目录', input: 'directory', default: 'C:\\work\\demo\\logs' }]
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
      { key: 'cwd', label: '工作目录', input: 'directory', default: 'C:\\work\\demo' },
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
  const action = shelfActions.find(item => item.id === 'apo-init')
  if (!action || action.type !== 'run-command') throw new Error('missing apo fixture')
  return action
}

function openRepoAction(): ToolAction {
  const action = shelfActions.find(item => item.id === 'open-repo')
  if (!action) throw new Error('missing open-repo fixture')
  return action
}

export function buildToolFixture(scene: string): ToolFixture | null {
  if (scene === 'tools' || scene === 'tools-narrow') {
    return {
      page: 'tools',
      scene: scene === 'tools-narrow' ? 'narrow' : 'shelf',
      actions: shelfActions,
      query: ''
    }
  }
  if (scene === 'tools-empty') return { page: 'tools', scene: 'empty' }
  if (scene === 'tools-params') {
    return {
      page: 'tools',
      scene: 'params',
      action: openRepoAction(),
      values: { repo: 'north/atlas' },
      knownRepos
    }
  }
  if (scene === 'tools-preview' || scene === 'tools-preview-failed') {
    const action = apoAction()
    const values = { cwd: 'C:\\work\\demo', name: 'demo' }
    const preview = buildPreview(action, values, 'C:\\work\\demo')
    const failed = scene === 'tools-preview-failed'
    const rehearsal = summarizeDryRun({
      cwd: 'C:\\work\\demo',
      code: failed ? 2 : 0,
      stdout: failed
        ? ''
        : [
          'create README.md',
          'create src/app.ts',
          'create package.json',
          'create tsconfig.json',
          'create .gitignore'
        ].join('\n'),
      stderr: failed ? '目标目录不为空' : '',
      aborted: false
    })
    return {
      page: 'tools',
      scene: failed ? 'preview-failed' : 'preview',
      action,
      values,
      previewText: preview.text,
      dryRun: preview.dryRun,
      cwd: 'C:\\work\\demo',
      shellLabel: 'PowerShell',
      rehearsal
    }
  }
  const command = "apo init --name '北区'"
  if (scene === 'tools-running') {
    return {
      page: 'tools',
      scene: 'running',
      title: 'apo 项目初始化',
      command,
      lines: [{ stream: 'stdout', text: '正在初始化北区' }],
      status: '运行中'
    }
  }
  if (scene === 'tools-success') {
    return {
      page: 'tools',
      scene: 'success',
      title: 'apo 项目初始化',
      command,
      lines: [{ stream: 'stdout', text: '已创建项目 北区' }],
      status: '完成'
    }
  }
  if (scene === 'tools-failed') {
    return {
      page: 'tools',
      scene: 'failed',
      title: 'apo 项目初始化',
      command,
      lines: [
        { stream: 'stdout', text: '正在准备北区' },
        { stream: 'stderr', text: '初始化失败：目标目录不为空' }
      ],
      status: '失败（退出码 3）'
    }
  }
  if (scene === 'tools-aborted') {
    return {
      page: 'tools',
      scene: 'aborted',
      title: 'apo 项目初始化',
      command,
      lines: [{ stream: 'stdout', text: '正在初始化北区' }],
      status: '已终止'
    }
  }
  if (scene === 'tools-copied') {
    return {
      page: 'tools',
      scene: 'copied',
      title: '派工说明',
      text: '派工说明\n项目：北区\n任务：补齐验收步骤\n截止：本周五\n请按上面的范围处理，完成后回复结果。'
    }
  }
  if (scene === 'tools-invalid') {
    const validated = validateToolShelfText(invalidDraft)
    if (validated.ok) throw new Error('invalid fixture unexpectedly passed schema')
    return {
      page: 'settings',
      scene: 'invalid',
      draft: invalidDraft,
      error: validated.error,
      line: validated.line
    }
  }
  return null
}

export function toolScreenshotExpectation(scene: string): string | null {
  switch (scene) {
    case 'tools':
      return '打开发布说明'
    case 'tools-narrow':
      return '打开发布说明'
    case 'tools-params':
      return '将打开 https://github.com/north/atlas'
    case 'tools-preview':
      return '将在 C:\\work\\demo 创建 5 个文件：README.md、src/app.ts、package.json、tsconfig.json、.gitignore'
    case 'tools-preview-failed':
      return '预演失败（退出码 2）：目标目录不为空'
    case 'tools-running':
      return '正在初始化北区'
    case 'tools-success':
      return '完成'
    case 'tools-failed':
      return '失败（退出码 3）'
    case 'tools-aborted':
      return '已终止'
    case 'tools-copied':
      return '已复制'
    case 'tools-invalid':
      return '只能是 open-url、open-folder、run-command、template 其中之一'
    case 'tools-empty':
      return '工具架还是空的'
    default:
      return null
  }
}

/** Extra DOM checks for scenes whose visible copy is easy to regress. */
export function toolScreenshotCheck(scene: string): string | null {
  if (scene === 'tools-preview') {
    return `(() => {
      const fold = document.querySelector('details.tool-command')
      return fold instanceof HTMLDetailsElement
        && fold.open === false
        && document.body.innerText.includes('查看命令')
        && !document.body.innerText.includes('shell:')
        && !document.body.innerText.includes('--dry-run')
    })()`
  }
  if (scene === 'tools-preview-failed') {
    return `(() => {
      const labels = [...document.querySelectorAll('button')].map(button => button.textContent ?? '')
      return document.body.innerText.includes('预演没有成功，不能继续执行。')
        && !labels.some(label => label.includes('初始化'))
        && labels.includes('取消')
    })()`
  }
  if (scene === 'tools-params') {
    return `(() => {
      const labels = [...document.querySelectorAll('button')].map(button => button.textContent ?? '')
      return labels.includes('打开') && !labels.includes('预览') && !document.body.innerText.includes('即将执行')
    })()`
  }
  if (scene === 'tools-success') {
    return `!document.body.innerText.includes('（无）')
      && !document.body.innerText.includes('标准错误')
      && document.body.innerText.includes('标准输出')
      && document.body.innerText.includes('已创建项目 北区')`
  }
  if (scene === 'tools-narrow') {
    return 'window.innerWidth < 900'
  }
  return null
}
