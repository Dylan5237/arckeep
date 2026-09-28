import { describe, expect, it } from 'vitest'
import { createRunGate, expandUrl, formatDuration } from '../src/shared/tools/preview.js'
import {
  expandCommand,
  quoteBashArg,
  quoteCmdArg,
  quotePowerShellArg
} from '../src/shared/tools/quote.js'

const samples = [
  '& echo pwned',
  '; rm -rf x',
  '"',
  '$(whoami)',
  '`whoami`',
  '%PATH%',
  'line\nsecond'
]

describe('shell quoting', () => {
  it('quotes cmd metacharacters as data', () => {
    expect(quoteCmdArg('& echo pwned')).toBe('""^&" echo pwned"')
    expect(quoteCmdArg('; rm -rf x')).toBe('"; rm -rf x"')
    expect(quoteCmdArg('"')).toBe('""""')
    expect(quoteCmdArg('$(whoami)')).toBe('"$(whoami)"')
    expect(quoteCmdArg('`whoami`')).toBe('"`whoami`"')
    expect(quoteCmdArg('%PATH%')).toBe('""^%"PATH"^%""')
    expect(quoteCmdArg('line\nsecond')).toBe('"line second"')
    expect(quoteCmdArg('line\nsecond')).not.toContain('\n')
  })

  it('quotes PowerShell with single quotes', () => {
    expect(quotePowerShellArg('& echo pwned')).toBe("'& echo pwned'")
    expect(quotePowerShellArg('; rm -rf x')).toBe("'; rm -rf x'")
    expect(quotePowerShellArg('"')).toBe(`'"'`)
    expect(quotePowerShellArg('$(whoami)')).toBe("'$(whoami)'")
    expect(quotePowerShellArg('`whoami`')).toBe("'`whoami`'")
    expect(quotePowerShellArg('%PATH%')).toBe("'%PATH%'")
    expect(quotePowerShellArg("line\nsecond")).toBe("'line\nsecond'")
    expect(quotePowerShellArg("it's")).toBe("'it''s'")
  })

  it('quotes bash with single quotes', () => {
    expect(quoteBashArg('& echo pwned')).toBe("'& echo pwned'")
    expect(quoteBashArg('; rm -rf x')).toBe("'; rm -rf x'")
    expect(quoteBashArg('"')).toBe(`'"'`)
    expect(quoteBashArg('$(whoami)')).toBe("'$(whoami)'")
    expect(quoteBashArg('`whoami`')).toBe("'`whoami`'")
    expect(quoteBashArg('%PATH%')).toBe("'%PATH%'")
    expect(quoteBashArg("line\nsecond")).toBe("'line\nsecond'")
    expect(quoteBashArg("it's")).toBe("'it'\\''s'")
  })

  it('inserts a quoted word and rejects placeholders inside quotes', () => {
    for (const sample of samples) {
      expect(expandCommand('echo {{value}}', { value: sample }, 'powershell')).toBe(`echo ${quotePowerShellArg(sample)}`)
      expect(expandCommand('echo {{value}}', { value: sample }, 'git-bash')).toBe(`echo ${quoteBashArg(sample)}`)
      expect(expandCommand('echo {{value}}', { value: sample }, 'cmd')).toBe(`echo ${quoteCmdArg(sample)}`)
    }
    expect(() => expandCommand('echo "{{value}}"', { value: 'x' }, 'powershell')).toThrow(/引号/)
    expect(() => expandCommand("echo '{{value}}'", { value: 'x' }, 'git-bash')).toThrow(/引号/)
  })

  it('percent-encodes URL parameters and keeps the preview equal to the opened href', () => {
    expect(expandUrl('https://github.com/{{owner}}/{{repo}}', { owner: 'Dylan5237', repo: 'arckeep' }))
      .toBe('https://github.com/Dylan5237/arckeep')
    expect(expandUrl('https://example.com/{{q}}', { q: 'a b&c' })).toBe('https://example.com/a%20b%26c')
    expect(() => expandUrl('file:///tmp/{{name}}', { name: 'demo' })).toThrow(/http/)
  })

  it('arms execution only after preview, and cancel disarms it', () => {
    const gate = createRunGate()
    expect(gate.confirm()).toBe(false)
    gate.stage()
    expect(gate.cancel()).toBe(false)
    expect(gate.confirm()).toBe(false)
    gate.stage()
    expect(gate.confirm()).toBe(true)
    expect(gate.confirm()).toBe(false)
    expect(formatDuration(1400)).toBe('1.4 秒')
  })
})
