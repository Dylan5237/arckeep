import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { toolShelfExampleText } from '../src/main/tool-assets.js'
import { validateToolShelfText } from '../src/main/tool-validate.js'
import { indexToLocation } from '../src/shared/tools/locate.js'
import { buildPreview } from '../src/shared/tools/preview.js'
import { cmdScriptFromPlan, planShell, powershellScriptFromPlan } from '../src/main/tool-launch.js'

describe('tool shelf schema', () => {
  it('accepts the shipped example and keeps the four built-in actions editable', () => {
    const text = toolShelfExampleText()
    const result = validateToolShelfText(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.actions.map(action => action.title)).toEqual([
      '打开 Arckeep 仓库',
      '在编辑器中打开文件夹',
      'apo 项目初始化（演练）',
      '派工说明'
    ])
    expect(text).not.toMatch(/C:\\Users\\/i)
    expect(text).not.toMatch(/\/home\//)
    expect(text).toContain('C:\\\\work\\\\demo')
    expect(text).toContain('apo init --dry-run')
    const apo = result.config.actions[2]
    const preview = buildPreview(apo, { cwd: 'C:\\work\\demo', name: 'demo' }, 'C:\\work\\demo')
    expect(preview.text).toBe("apo init --dry-run --name 'demo'")
    expect(preview.shell).toBe('powershell')
    const onDisk = readFileSync(new URL('../schema/tool-shelf.example.json', import.meta.url), 'utf8')
    expect(onDisk).toBe(text)
  })

  it('reports schema failures with a JSON pointer and line', () => {
    const text = '{\n  "version": 1,\n  "actions": [\n    {\n      "id": "bad",\n      "title": "坏动作",\n      "type": "launch-missile"\n    }\n  ]\n}\n'
    const result = validateToolShelfText(text)
    expect(result.ok).toBe(false)
    if (result.ok) return
    const line = indexToLocation(text, text.indexOf('"launch-missile"')).line
    expect(result.path).toContain('/actions/0/type')
    expect(result.line).toBe(line)
    expect(result.error).toContain(`第 ${line} 行`)
    expect(result.error).toContain('不在允许的取值里')
  })

  it('reports JSON syntax errors with a line and column', () => {
    const text = '{\n  "version": 1,\n}\n'
    const result = validateToolShelfText(text)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.line).toBeGreaterThan(1)
    expect(result.error).toContain('JSON 无法解析')
    expect(result.error).toContain(`第 ${result.line} 行`)
    expect(result.error).toContain(`第 ${result.column} 列`)
  })

  it('rejects a placeholder written inside shell quotes', () => {
    const text = JSON.stringify({
      version: 1,
      actions: [{
        id: 'quoted',
        title: '引号里的参数',
        type: 'run-command',
        shell: 'powershell',
        command: 'echo "{{name}}"',
        params: [{ key: 'name', label: '名称', default: 'demo' }]
      }]
    })
    const result = validateToolShelfText(text)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('引号')
  })
})

describe('launch plan matches the preview script', () => {
  it('passes the PowerShell script through EncodedCommand unchanged', () => {
    const script = "apo init --dry-run --name 'demo'"
    const plan = planShell('powershell', script, {}, 'win32')
    expect(powershellScriptFromPlan(plan)).toBe(script)
    expect(plan.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
  })

  it('wraps the cmd script once for /d /s /c', () => {
    const script = 'echo ""^&" echo pwned"'
    const plan = planShell('cmd', script, { ComSpec: 'cmd.exe' }, 'win32')
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(plan.windowsVerbatimArguments).toBe(true)
    expect(cmdScriptFromPlan(plan)).toBe(script)
  })
})
