import { describe, expect, it } from 'vitest'
import { createRunGate, expandUrl, formatDuration } from '../src/shared/tools/preview.js'
import {
  expandCommand,
  powershellLaunchScript,
  quoteBashArg,
  quoteCmdArg,
  quotePowerShellArg,
  windowsNativeArgumentToken
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

/** Mirrors Windows PowerShell 5.1 NativeCommandParameterBinder.NeedQuotes + append. */
function legacyAppend(arg: string): string {
  if (!arg) return ''
  let needQuotes = false
  let followingBackslash = false
  let quoteCount = 0
  for (const ch of arg) {
    if (ch === '"' && !followingBackslash) quoteCount += 1
    else if (/\s/.test(ch) && quoteCount % 2 === 0) needQuotes = true
    followingBackslash = ch === '\\'
  }
  if (!needQuotes) return arg
  let extra = ''
  for (let i = arg.length - 1; i >= 0 && arg[i] === '\\'; i -= 1) extra += '\\'
  return `"${arg}${extra}"`
}

/** CommandLineToArgvW for one already-split command line (no program name). */
function commandLineToArgv(commandLine: string): string[] {
  const args: string[] = []
  let i = 0
  while (i < commandLine.length) {
    while (commandLine[i] === ' ' || commandLine[i] === '\t') i += 1
    if (i >= commandLine.length) break
    let current = ''
    let inQuotes = false
    while (i < commandLine.length) {
      let slashes = 0
      while (commandLine[i] === '\\') {
        slashes += 1
        i += 1
      }
      if (commandLine[i] === '"') {
        current += '\\'.repeat(Math.floor(slashes / 2))
        if (slashes % 2 === 0) {
          if (inQuotes && commandLine[i + 1] === '"') {
            current += '"'
            i += 2
            continue
          }
          inQuotes = !inQuotes
        } else {
          current += '"'
        }
        i += 1
        continue
      }
      current += '\\'.repeat(slashes)
      if (i >= commandLine.length) break
      const ch = commandLine[i]
      if (!inQuotes && (ch === ' ' || ch === '\t')) break
      current += ch
      i += 1
    }
    args.push(current)
  }
  return args
}

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
    expect(quotePowerShellArg('"')).toBe(`'"\\""'`)
    expect(quotePowerShellArg('$(whoami)')).toBe("'$(whoami)'")
    expect(quotePowerShellArg('`whoami`')).toBe("'`whoami`'")
    expect(quotePowerShellArg('%PATH%')).toBe("'%PATH%'")
    expect(quotePowerShellArg("line\nsecond")).toBe("'line\nsecond'")
    expect(quotePowerShellArg("it's")).toBe("'it''s'")
    expect(powershellLaunchScript('apo init --name \'demo\'')).toBe("apo init --name 'demo'\nexit $LASTEXITCODE")
    expect(powershellLaunchScript('apo init', 'pwsh.exe')).toBe(
      "$PSNativeCommandArgumentPassing = 'Legacy'\napo init\nexit $LASTEXITCODE"
    )
    expect(powershellLaunchScript(powershellLaunchScript('apo init', 'pwsh'), 'powershell.exe')).toBe(
      'apo init\nexit $LASTEXITCODE'
    )
  })

  it('keeps a literal double quote through the Windows PowerShell 5.1 native binder', () => {
    for (const value of ['"', 'a "b', 'say "hello"', '""', 'trail\\', 'a\\" b']) {
      const quoted = quotePowerShellArg(value)
      expect(quoted.startsWith("'") && quoted.endsWith("'")).toBe(true)
      const embedded = quoted.slice(1, -1).replace(/''/g, "'")
      const commandLine = legacyAppend(embedded)
      expect(commandLineToArgv(commandLine), value).toEqual([value])
    }
    expect(windowsNativeArgumentToken('"')).toBe('"\\""')
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
