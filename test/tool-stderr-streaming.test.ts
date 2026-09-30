import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { PowerShellStderrDecoder, runPlan, ToolRunner } from '../src/main/tool-runner.js'
import { planShell } from '../src/main/tool-launch.js'
import type { ToolRunEvent } from '../src/shared/tools/types.js'

describe('incremental PowerShell stderr', () => {
  it('emits plain diagnostics before close and retains a split CLIXML prefix', () => {
    const decoder = new PowerShellStderrDecoder()
    expect(decoder.write('中文诊断\n#< CLI')).toBe('中文诊断\n')
    expect(decoder.write('XML\r\n<Objs><S S="progress">ignore</S><S S="Error">错')).toBe('')
    expect(decoder.write('误_x000D__x000A_</S>')).toBe('错误\r\n')
    expect(decoder.write('</Objs>ordinary-tail')).toBe('ordinary-tail')
    expect(decoder.end()).toBe('')
  })

  it('handles repeated documents, split record tags and incomplete plain marker text', () => {
    const decoder = new PowerShellStderrDecoder()
    const chunks = ['#< CLIXML\n<Objs><', 'S S="Warning">one</S></Ob', 'js>#< CLIXML\n<Objs><S S="Error">two</S></Objs>#< CLI']
    expect(chunks.map(chunk => decoder.write(chunk)).join('') + decoder.end()).toBe('onetwo#< CLI')
  })
})

const hosts = process.platform === 'win32'
  ? ['powershell.exe', 'pwsh.exe'].filter(host => !spawnSync(host, ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).error)
  : []

describe('live stderr visibility and dual-stream limits', () => {
  for (const host of hosts) {
    const env = { ...process.env, ARCKEEP_POWERSHELL: host }
    it(`${host} emits diagnostics while the command is still running`, async () => {
      const events: ToolRunEvent[] = []
      let seenDiagnostic: (() => void) | undefined
      const early = new Promise<void>(resolve => { seenDiagnostic = resolve })
      let finish: (() => void) | undefined
      const done = new Promise<void>(resolve => { finish = resolve })
      const runner = new ToolRunner(event => {
        events.push(event)
        if (event.type === 'output' && event.stream === 'stderr' && event.text?.includes('EARLY-STDERR')) seenDiagnostic?.()
        if (event.type === 'done') finish?.()
      })
      try {
        runner.start(planShell('powershell', '[Console]::Error.WriteLine("EARLY-STDERR"); Start-Sleep -Seconds 2; Write-Output "DONE"', env), process.cwd())
        await Promise.race([early, done.then(() => { throw new Error('stderr was not visible before done') })])
        expect(events.some(event => event.type === 'done')).toBe(false)
        expect(events.some(event => event.stream === 'stdout' && event.text?.includes('DONE'))).toBe(false)
        await done
        expect(events.findIndex(event => event.stream === 'stderr')).toBeLessThan(events.findIndex(event => event.stream === 'stdout'))
      } finally {
        await runner.abortAll()
      }
    }, 15_000)

    it(`${host} retains diagnostics even when stdout fills its quota first`, async () => {
      const result = await runPlan(planShell('powershell', '[Console]::Error.WriteLine("EARLY-DIAGNOSTIC"); [Console]::Out.Write(("x" * 200001))', env), process.cwd())
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('输出已截断')
      expect(result.stderr).toContain('EARLY-DIAGNOSTIC')
      expect(result.stdout.length + result.stderr.length).toBeLessThanOrEqual(200_020)
      const reversed = await runPlan(planShell('powershell', '[Console]::Error.Write(("x" * 200001)); [Console]::Out.Write("STDOUT-SENTINEL")', env), process.cwd())
      expect(reversed.code).toBe(0)
      expect(reversed.stderr).toContain('输出已截断')
      expect(reversed.stdout).toContain('STDOUT-SENTINEL')
      expect(reversed.stdout.length + reversed.stderr.length).toBeLessThanOrEqual(200_020)
    }, 15_000)
  }
})
