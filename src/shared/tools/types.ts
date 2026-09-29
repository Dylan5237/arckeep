export type ShellKind = 'cmd' | 'powershell' | 'git-bash'

export type ToolParamInput = 'line' | 'multiline' | 'directory' | 'repo'

export interface ToolParam {
  key: string
  label: string
  default?: string
  required?: boolean
  /** line: single-line text. multiline: template body. directory / repo: pickers. */
  input?: ToolParamInput
}

interface ToolActionBase {
  id: string
  title: string
  description?: string
  params?: ToolParam[]
}

export interface OpenUrlAction extends ToolActionBase {
  type: 'open-url'
  url: string
}

export interface OpenFolderAction extends ToolActionBase {
  type: 'open-folder'
  path: string
  editor?: string
}

export interface RunCommandAction extends ToolActionBase {
  type: 'run-command'
  shell: ShellKind
  command: string
  /**
   * Optional command shown in the preview (often with --dry-run).
   * Confirm runs `command`, never this string.
   */
  previewCommand?: string
  cwd?: string
}

export interface TemplateAction extends ToolActionBase {
  type: 'template'
  text: string
}

export type ToolAction = OpenUrlAction | OpenFolderAction | RunCommandAction | TemplateAction

export interface ToolShelfConfig {
  version: 1
  actions: ToolAction[]
}

export interface ActionPreview {
  actionId: string
  title: string
  type: ToolAction['type']
  /**
   * What confirm uses: URL, folder display, clipboard text, or the shell script.
   * The script is the user command, without runner details such as `exit $LASTEXITCODE`.
   */
  text: string
  /** Dry-run (or other preview) command. Shown only. Confirm does not run it. */
  dryRun?: string
  shell?: ShellKind
  cwd?: string
  argv?: string[]
}

export interface ToolRunEvent {
  type: 'output' | 'done'
  runId: string
  stream?: 'stdout' | 'stderr'
  text?: string
  exitCode?: number | null
  durationMs?: number
  aborted?: boolean
  error?: string
}

export const TOOL_TYPE_LABEL: Record<ToolAction['type'], string> = {
  'open-url': '打开链接',
  'open-folder': '打开文件夹',
  'run-command': '运行命令',
  template: '复制模板'
}

export const SHELL_LABEL: Record<ShellKind, string> = {
  cmd: 'cmd',
  powershell: 'PowerShell',
  'git-bash': 'Git Bash'
}
