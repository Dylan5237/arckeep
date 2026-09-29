import { assertPlaceholders, expandCommand, expandRaw, powershellLaunchScript } from './quote.js'
import type { ActionPreview, ToolAction } from './types.js'

export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0
  if (safe < 1000) return `${safe} 毫秒`
  return `${(safe / 1000).toFixed(1)} 秒`
}

export function collectParams(
  action: ToolAction,
  input: Readonly<Record<string, string>>
): Record<string, string> {
  const declared = action.params ?? []
  const known = new Set(declared.map(param => param.key))
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw new Error(`未知参数：${key}`)
  }
  const values: Record<string, string> = {}
  for (const param of declared) {
    const value = Object.prototype.hasOwnProperty.call(input, param.key)
      ? input[param.key]
      : (param.default ?? '')
    if (value.includes('\0')) throw new Error(`${param.label}包含无效字符`)
    if (value.length > 8000) throw new Error(`${param.label}过长`)
    if (param.required && value.trim() === '') throw new Error(`请填写${param.label}`)
    values[param.key] = value
  }
  return values
}

export function expandUrl(template: string, params: Readonly<Record<string, string>>): string {
  assertPlaceholders(template, new Set(Object.keys(params)))
  const encoded = template.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_match, key: string) => {
    return encodeURIComponent(params[key] ?? '')
  })
  let parsed: URL
  try {
    parsed = new URL(encoded)
  } catch {
    throw new Error('展开后不是有效的网址')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('只允许打开 http 或 https 链接')
  }
  if (parsed.username || parsed.password) throw new Error('链接不能带账号或密码')
  return parsed.href
}

function displayArgv(argv: string[]): string {
  return argv.map(token => JSON.stringify(token)).join('\n')
}

export function buildPreview(
  action: ToolAction,
  input: Readonly<Record<string, string>>,
  baseCwd: string,
  powershellExecutable = 'powershell.exe'
): ActionPreview {
  const params = collectParams(action, input)
  if (action.type === 'open-url') {
    return {
      actionId: action.id,
      title: action.title,
      type: action.type,
      text: expandUrl(action.url, params)
    }
  }
  if (action.type === 'template') {
    return {
      actionId: action.id,
      title: action.title,
      type: action.type,
      text: expandRaw(action.text, params)
    }
  }
  if (action.type === 'open-folder') {
    const folder = expandRaw(action.path, params)
    if (!folder.trim() || /[\0\r\n]/.test(folder)) throw new Error('文件夹路径无效')
    const editor = action.editor ? expandRaw(action.editor, params).trim() : ''
    if (/[\0\r\n"]/.test(editor)) throw new Error('编辑器路径无效')
    const argv = editor ? [editor, folder] : [folder]
    return {
      actionId: action.id,
      title: action.title,
      type: action.type,
      text: editor ? displayArgv(argv) : folder,
      argv,
      cwd: folder
    }
  }
  const script = expandCommand(action.command, params, action.shell)
  if (!script.trim()) throw new Error('命令是空的')
  const cwd = action.cwd ? expandRaw(action.cwd, params) : baseCwd
  if (!cwd.trim() || /[\0\r\n]/.test(cwd)) throw new Error('工作目录无效')
  return {
    actionId: action.id,
    title: action.title,
    type: action.type,
    text: action.shell === 'powershell' ? powershellLaunchScript(script, powershellExecutable) : script,
    shell: action.shell,
    cwd
  }
}

/** Preview is staged before confirm. Cancel never asks to execute. */
export function createRunGate(): {
  stage(): void
  confirm(): boolean
  cancel(): boolean
} {
  let armed = false
  return {
    stage() {
      armed = true
    },
    confirm() {
      if (!armed) return false
      armed = false
      return true
    },
    cancel() {
      armed = false
      return false
    }
  }
}
