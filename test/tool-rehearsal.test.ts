import { describe, expect, it } from 'vitest'
import { toolShelfExampleText } from '../src/main/tool-assets.js'
import { powershellScriptFromPlan } from '../src/main/tool-launch.js'
import { rehearsePreview } from '../src/main/tool-rehearse.js'
import { validateToolShelfText } from '../src/main/tool-validate.js'
import {
  confirmsBeforeRun,
  describeEffect,
  directActionLabel,
  entryStep,
  outputBlocks,
  paramsSubmitsToPreview
} from '../src/shared/tools/flow.js'
import { createRunGate } from '../src/shared/tools/preview.js'
import { buildPreview } from '../src/shared/tools/preview.js'
import {
  firstOutputLines,
  foldedCommandLines,
  parseCreatedFiles,
  summarizeDryRun,
  unavailableRehearsal
} from '../src/shared/tools/rehearsal.js'
import type { KnownRepo } from '../src/shared/tools/repos.js'
import type { ToolAction } from '../src/shared/tools/types.js'

const created = [
  'create README.md',
  'create src/app.ts',
  'create package.json',
  'create tsconfig.json',
  'create .gitignore'
].join('\n')

function exampleActions(): ToolAction[] {
  const validated = validateToolShelfText(toolShelfExampleText())
  if (!validated.ok) throw new Error(validated.error)
  return validated.config.actions
}

function commandAction(): ToolAction {
  return {
    id: 'command-test',
    title: '输出参数',
    type: 'run-command',
    shell: 'powershell',
    cwd: '{{cwd}}',
    previewCommand: 'Write-Output {{name}}',
    command: 'Write-Output {{name}}; Write-Output "confirmed"',
    params: [
      { key: 'cwd', label: '目录', input: 'directory', required: true },
      { key: 'name', label: '名称', required: true }
    ]
  }
}

describe('dry-run output becomes a file summary', () => {
  it('parses created files into one sentence', () => {
    expect(parseCreatedFiles(created)).toEqual([
      'README.md',
      'src/app.ts',
      'package.json',
      'tsconfig.json',
      '.gitignore'
    ])
    const rehearsal = summarizeDryRun({
      cwd: 'C:\\work\\demo',
      code: 0,
      stdout: created,
      stderr: '',
      aborted: false
    })
    expect(rehearsal.status).toBe('files')
    expect(rehearsal.canConfirm).toBe(true)
    expect(rehearsal.summary).toBe(
      '将在 C:\\work\\demo 创建 5 个文件：README.md、src/app.ts、package.json、tsconfig.json、.gitignore'
    )
  })

  it('falls back to the first lines when the output is not a file list', () => {
    const prose = [
      'Dry run finished.',
      'Nothing to create.',
      'Looked at the tree.',
      'line-4',
      'line-5',
      'line-6',
      'line-7-hidden',
      'line-8-hidden'
    ].join('\n')
    expect(parseCreatedFiles(prose)).toEqual([])
    const rehearsal = summarizeDryRun({
      cwd: 'C:\\work\\demo',
      code: 0,
      stdout: prose,
      stderr: 'warning only',
      aborted: false
    })
    expect(rehearsal.status).toBe('raw')
    expect(rehearsal.canConfirm).toBe(true)
    expect(rehearsal.summary).toBe(firstOutputLines(prose))
    expect(rehearsal.summary).not.toContain('line-7-hidden')
    expect(rehearsal.summary.split('\n')).toHaveLength(6)
  })

  it('refuses confirm when the dry-run fails, and keeps exit code 3', () => {
    const rehearsal = summarizeDryRun({
      cwd: 'C:\\work\\demo',
      code: 3,
      stdout: '',
      stderr: '目标目录不为空',
      aborted: false
    })
    expect(rehearsal.canConfirm).toBe(false)
    expect(rehearsal.status).toBe('failed')
    expect(rehearsal.summary).toBe('预演失败（退出码 3）：目标目录不为空')
    const gate = createRunGate()
    if (rehearsal.canConfirm) gate.stage()
    expect(gate.confirm()).toBe(false)
  })

  it('plans the dry-run with PowerShell quotes and does not confirm a failed run', async () => {
    const preview = buildPreview(commandAction(), { cwd: 'C:\\work\\demo', name: "o'hare" }, 'C:\\work\\demo')
    let calls = 0
    const failed = await rehearsePreview(preview, {
      platform: 'win32',
      cwdExists: () => true,
      run: async plan => {
        calls += 1
        const script = powershellScriptFromPlan(plan)
        expect(script).toContain("Write-Output 'o''hare'")
        expect(script).toContain('exit $global:LASTEXITCODE')
        expect(script).not.toContain('Write-Output "confirmed"')
        return { code: 3, stdout: '', stderr: '拒绝初始化', aborted: false }
      }
    })
    expect(calls).toBe(1)
    expect(failed.canConfirm).toBe(false)
    expect(failed.summary).toContain('退出码 3')
    expect(failed.summary).not.toContain('退出码 1')
    expect(foldedCommandLines({ ...preview, rehearsal: failed }).join('\n')).not.toContain('--dry-run')
    expect(foldedCommandLines(preview).join('\n')).toContain("Write-Output 'o''hare'; Write-Output \"confirmed\"")
    expect(foldedCommandLines(preview).join('\n')).toContain('shell: PowerShell')
  })

  it('does not spawn when the working directory is missing', async () => {
    const preview = buildPreview(commandAction(), { cwd: 'C:\\work\\demo', name: 'demo' }, 'C:\\work\\demo')
    const rehearsal = await rehearsePreview(preview, {
      platform: 'win32',
      cwdExists: () => false,
      run: async () => {
        throw new Error('should not run')
      }
    })
    expect(rehearsal.canConfirm).toBe(false)
    expect(rehearsal.summary).toContain('工作目录不存在')
  })
})

describe('read-only actions skip the confirm dialog', () => {
  it('opens, copies, and runs folders without a preview step', () => {
    const [openRepo, openFolder, init, note] = exampleActions()
    for (const action of [openRepo, openFolder, note]) {
      expect(confirmsBeforeRun(action)).toBe(false)
      expect(paramsSubmitsToPreview(action)).toBe(false)
      expect(entryStep(action)).toBe('params')
      expect(entryStep({ ...action, params: undefined })).toBe('run')
    }
    expect(directActionLabel(openRepo)).toBe('打开')
    expect(directActionLabel(openFolder)).toBe('打开')
    expect(directActionLabel(note)).toBe('复制')
    expect(confirmsBeforeRun(init)).toBe(false)
    expect(paramsSubmitsToPreview(init)).toBe(false)
    expect(entryStep(init)).toBe('run')
    expect(directActionLabel(init)).toBe('复制')
    const command = commandAction()
    expect(confirmsBeforeRun(command)).toBe(true)
    expect(paramsSubmitsToPreview(command)).toBe(true)
    expect(entryStep(command)).toBe('params')
    expect(entryStep({ ...command, params: undefined })).toBe('preview')
    expect(directActionLabel(command)).toBe('预览')
  })

  it('describes an open action before the button runs it', () => {
    const known: KnownRepo[] = [{
      id: 'north/atlas',
      label: 'north/atlas',
      github: 'north/atlas',
      path: null,
      sources: ['github']
    }]
    expect(describeEffect(exampleActions()[0], { repo: 'north/atlas' }, known))
      .toBe('将打开 https://github.com/north/atlas')
  })

  it('says a command without a dry-run cannot be rehearsed', () => {
    const rehearsal = unavailableRehearsal('C:\\work\\demo', "echo smoke-'north'")
    expect(rehearsal.canConfirm).toBe(true)
    expect(rehearsal.mark).toBe('无法预演')
    expect(rehearsal.summary).toBe("将在 C:\\work\\demo 运行 echo smoke-'north'")
  })
})

describe('empty command output stays hidden', () => {
  it('drops an empty stderr block on success and an empty stdout block on failure', () => {
    expect(outputBlocks({ stdout: '已创建项目 北区', stderr: '', stderrFirst: false })).toEqual([
      { stream: 'stdout', title: '标准输出', text: '已创建项目 北区' }
    ])
    expect(outputBlocks({ stdout: '', stderr: '初始化失败', stderrFirst: true })).toEqual([
      { stream: 'stderr', title: '标准错误', text: '初始化失败' }
    ])
    expect(outputBlocks({ stdout: '', stderr: '', stderrFirst: false })).toEqual([])
    const titles = outputBlocks({ stdout: '已创建项目 北区', stderr: '', stderrFirst: false })
      .map(block => block.title)
    expect(titles).not.toContain('标准错误')
    expect(JSON.stringify(outputBlocks({ stdout: '', stderr: '', stderrFirst: false }))).not.toContain('（无）')
  })
})
