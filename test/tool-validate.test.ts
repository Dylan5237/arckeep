import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { toolShelfExampleText } from '../src/main/tool-assets.js'
import { cmdScriptFromPlan, planShell, powershellScriptFromPlan } from '../src/main/tool-launch.js'
import { validateToolShelfText } from '../src/main/tool-validate.js'
import { indexToLocation } from '../src/shared/tools/locate.js'
import { confirmButtonLabel, copyFeedback, errorLine, filterActions, runStatus } from '../src/shared/tools/present.js'
import { buildPreview } from '../src/shared/tools/preview.js'
import { powershellLaunchScript } from '../src/shared/tools/quote.js'
import { collectKnownRepos, knownRepoSourceLabel } from '../src/shared/tools/repos.js'
import { paramKind } from '../src/shared/tools/params.js'

describe('tool shelf schema', () => {
  it('accepts the shipped example and keeps the four built-in actions editable', () => {
    const text = toolShelfExampleText()
    const result = validateToolShelfText(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.config.actions.map(action => action.title)).toEqual([
      '打开仓库',
      '在编辑器中打开文件夹',
      'apo 项目初始化',
      '派工说明'
    ])
    expect(text).not.toMatch(/C:\\Users\\/i)
    expect(text).not.toMatch(/\/home\//)
    expect(text).not.toContain('Dylan5237')
    expect(text).not.toContain('演练')
    expect(text).not.toContain('确认前不会运行')
    for (const action of result.config.actions) {
      expect(action.title).not.toContain('演练')
      expect(action.title).not.toContain('确认前不会运行')
      expect(action.description ?? '').not.toContain('演练')
      expect(action.description ?? '').not.toContain('确认前不会运行')
    }
    expect(text).toContain('C:\\\\work\\\\demo')
    expect(text).toContain('apo init --dry-run')
    const apo = result.config.actions[2]
    const preview = buildPreview(apo, { cwd: 'C:\\work\\demo', name: 'demo' }, 'C:\\work\\demo')
    expect(preview.dryRun).toBe("apo init --dry-run --name 'demo'")
    expect(preview.text).toBe("apo init --name 'demo'")
    expect(preview.text).not.toContain('--dry-run')
    expect(preview.text).not.toContain('LASTEXITCODE')
    expect(preview.shell).toBe('powershell')
    const plan = planShell('powershell', preview.text, {}, 'win32')
    const executed = powershellScriptFromPlan(plan)
    expect(executed).toContain("apo init --name 'demo'")
    expect(executed).toContain('exit $LASTEXITCODE')
    expect(executed).not.toContain('--dry-run')
    const onDisk = readFileSync(new URL('../schema/tool-shelf.example.json', import.meta.url), 'utf8')
    expect(onDisk).toBe(text)
  })

  it('reports schema failures with a JSON pointer and line', () => {
    const text = '{\n  "version": 1,\n  "actions": [\n    {\n      "id": "bad",\n      "title": "坏动作",\n      "type": "launch-missile"\n    }\n  ]\n}\n'
    const result = validateToolShelfText(text)
    expect(result.ok).toBe(false)
    if (result.ok) return
    const line = indexToLocation(text, text.indexOf('"launch-missile"')).line
    expect(result.path).toBe('/actions/0/type')
    expect(result.line).toBe(line)
    expect(result.error).toBe(`第 ${line} 行：type 只能是 open-url、open-folder、run-command、template 其中之一`)
    expect(result.error.split('/actions/0/type').length - 1).toBe(0)
    expect(errorLine(result.error)).toBe(line)
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
    expect(powershellScriptFromPlan(plan)).toBe(powershellLaunchScript(script))
    expect(plan.args.slice(0, 5)).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand'
    ])
    const core = planShell('powershell', script, { ARCKEEP_POWERSHELL: 'pwsh.exe' }, 'win32')
    expect(core.file).toBe('pwsh.exe')
    expect(powershellScriptFromPlan(core)).toBe(powershellLaunchScript(script, 'pwsh.exe'))
    expect(powershellScriptFromPlan(planShell('powershell', powershellLaunchScript(script), {}, 'win32'))).toBe(
      powershellScriptFromPlan(plan)
    )
  })

  it('wraps the cmd script once for /d /s /c', () => {
    const script = 'echo ""^&" echo pwned"'
    const plan = planShell('cmd', script, { ComSpec: 'cmd.exe' }, 'win32')
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c'])
    expect(plan.windowsVerbatimArguments).toBe(true)
    expect(cmdScriptFromPlan(plan)).toBe(script)
  })
})

describe('run outcome, copy, and known repositories', () => {
  it('names success, failure, and abort without treating a dry-run as the real command', () => {
    expect(runStatus('done', 0)).toEqual({ tone: 'ok', label: '完成', stderrFirst: false })
    expect(runStatus('done', 3)).toEqual({ tone: 'failed', label: '失败（退出码 3）', stderrFirst: true })
    expect(runStatus('aborted', null)).toEqual({ tone: 'aborted', label: '已终止', stderrFirst: false })
    expect(runStatus('running', null).label).toBe('运行中')
    expect(copyFeedback(true)).toBe('已复制')
    expect(copyFeedback(false)).toBe('复制失败')
  })

  it('copies the expanded dispatch note and only uses a multiline field for template body', () => {
    const validated = validateToolShelfText(toolShelfExampleText())
    expect(validated.ok).toBe(true)
    if (!validated.ok) return
    const note = validated.config.actions.find(action => action.id === 'dispatch-note')
    expect(note?.type).toBe('template')
    if (!note) return
    const preview = buildPreview(note, { project: '北区', task: '补齐验收步骤', due: '本周五' }, 'C:\\work\\demo')
    expect(preview.type).toBe('template')
    expect(preview.text).toContain('派工说明')
    expect(preview.text).toContain('项目：北区')
    expect(copyFeedback(true)).toBe('已复制')
    for (const param of note.params ?? []) expect(paramKind(param)).toBe('line')
    expect(paramKind({ key: 'body', label: '模板正文' })).toBe('multiline')
    expect(paramKind({ key: 'cwd', label: '目录' })).toBe('directory')
    expect(paramKind({ key: 'name', label: '项目名', input: 'line' })).toBe('line')
  })

  it('opens any known repository from watch list, GitHub, and local paths', () => {
    const known = collectKnownRepos({
      watchedRepos: ['example/demo'],
      githubRepos: ['north/atlas', 'example/demo'],
      localPaths: ['C:\\work\\notes', 'C:\\work\\demo'],
      linked: [{ github: 'example/demo', path: 'C:\\work\\demo' }]
    })
    expect(known.map(repo => repo.github).filter(Boolean).sort()).toEqual(['example/demo', 'north/atlas'])
    expect(known.some(repo => repo.path === 'C:\\work\\notes')).toBe(true)
    expect(known.some(repo => repo.id.includes('Dylan5237'))).toBe(false)
    const validated = validateToolShelfText(toolShelfExampleText())
    if (!validated.ok) throw new Error(validated.error)
    const open = validated.config.actions[0]
    const github = buildPreview(open, { repo: 'north/atlas' }, 'C:\\work\\demo', known)
    expect(github).toMatchObject({ type: 'open-url', text: 'https://github.com/north/atlas' })
    const local = buildPreview(open, { repo: 'C:\\work\\notes' }, 'C:\\work\\demo', known)
    expect(local).toMatchObject({ type: 'open-folder', text: 'C:\\work\\notes' })
    expect(() => buildPreview(open, { repo: 'Dylan5237/arckeep' }, 'C:\\work\\demo', known)).toThrow(/已知仓库/)
    const withTodos = collectKnownRepos({
      watchedRepos: ['example/demo'],
      githubRepos: [],
      localPaths: [],
      todoRepos: ['example/demo', 'south/harbor', 'not a repo']
    })
    expect(withTodos.find(repo => repo.github === 'south/harbor')?.sources).toEqual(['todo'])
    expect(withTodos.find(repo => repo.github === 'example/demo')?.sources).toEqual(['watched', 'todo'])
    expect(knownRepoSourceLabel(['watched', 'todo'])).toBe('关注列表、待办')
  })

  it('names the confirm button after the filled-in effect', () => {
    const validated = validateToolShelfText(toolShelfExampleText())
    if (!validated.ok) throw new Error(validated.error)
    const [openRepo, openFolder, init, note] = validated.config.actions
    expect(confirmButtonLabel(openRepo, { repo: 'owner/repo' })).toBe('打开 owner/repo')
    expect(confirmButtonLabel(openFolder, { folder: 'owner/repo' })).toBe('用编辑器打开 owner/repo')
    expect(confirmButtonLabel(init, { cwd: 'C:\\work\\demo', name: 'demo' })).toBe('在 C:\\work\\demo 初始化 demo')
    expect(confirmButtonLabel(note, { project: '北区', task: '补齐验收步骤', due: '本周五' })).toBe('复制派工说明')
    expect(confirmButtonLabel(init, { cwd: 'C:\\work\\demo', name: 'demo' })).not.toBe('确认执行')
  })

  it('filters the shelf as the query is typed', () => {
    const validated = validateToolShelfText(toolShelfExampleText())
    if (!validated.ok) throw new Error(validated.error)
    expect(filterActions(validated.config.actions, '').length).toBe(4)
    expect(filterActions(validated.config.actions, '派工').map(action => action.id)).toEqual(['dispatch-note'])
    expect(filterActions(validated.config.actions, '没有这个')).toEqual([])
  })
})
