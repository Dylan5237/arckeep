import type { ShellKind } from './types.js'

const CMD_SPECIAL = new Set(['!', '%', '&', '<', '>', '^', '|'])

function isCmdControl(ch: string): boolean {
  const code = ch.charCodeAt(0)
  return code === 0 || code === 8 || code === 0x1b || code === 0x9b
}

/**
 * One cmd.exe argument. Metacharacters are caret-escaped outside quotes so
 * `%VAR%`, `&`, and redirects stay data. Newlines cannot be arguments in cmd,
 * so they become spaces (still inside the quoted word, never a new command).
 */
export function quoteCmdArg(value: string): string {
  let body = ''
  const cleaned = [...value].filter(ch => !isCmdControl(ch)).join('')
  for (const ch of cleaned) {
    if (ch === '\n' || ch === '\r') {
      body += ' '
      continue
    }
    if (ch === '"') {
      body += '""'
      continue
    }
    if (CMD_SPECIAL.has(ch)) {
      body += `"^${ch}"`
      continue
    }
    body += ch
  }
  return `"${body}"`
}

/**
 * Windows PowerShell 5.1 appends a native argument as raw command-line text.
 * A value whose only character is `"` is appended as `"`, and CommandLineToArgvW
 * reads that as an empty argument. Emit a token the legacy binder copies through
 * unchanged (`NeedQuotes` is false) and that CommandLineToArgvW parses back to
 * the original value. pwsh must run with `$PSNativeCommandArgumentPassing = 'Legacy'`
 * or it would pass this token through ArgumentList literally.
 */
export function windowsNativeArgumentToken(value: string): string {
  if (value.length === 0) return '""'
  let quote = false
  for (const ch of value) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '"') {
      quote = true
      break
    }
  }
  if (!quote) return value
  let out = '"'
  let backslashes = 0
  for (const ch of value) {
    if (ch === '\\') {
      backslashes += 1
      continue
    }
    if (ch === '"') {
      // With no preceding slashes, doubled quotes keep Legacy mode's quote
      // count open across spaces. With slashes, the standard odd-slash escape
      // keeps both PowerShell's binder and CommandLineToArgvW in agreement.
      out += backslashes === 0 ? '' : '\\'.repeat(backslashes * 2 + 1)
      out += backslashes === 0 ? '""' : '"'
      backslashes = 0
      continue
    }
    if (backslashes > 0) {
      out += '\\'.repeat(backslashes)
      backslashes = 0
    }
    out += ch
  }
  if (backslashes > 0) out += '\\'.repeat(backslashes * 2)
  out += '"'
  return out
}

const POWERSHELL_LEGACY_LINE = "$PSNativeCommandArgumentPassing = 'Legacy'"
const WRAPPER_START = '# <ARCKEEP_POWERSHELL_LAUNCH_V1>'
const USER_SCRIPT_START = '# <ARCKEEP_USER_SCRIPT>'
const USER_SCRIPT_END = '# </ARCKEEP_USER_SCRIPT>'

function unwrapLaunchScript(script: string): string {
  if (!script.startsWith(`${WRAPPER_START}\n`)) return script
  const start = script.indexOf(`${USER_SCRIPT_START}\n`, WRAPPER_START.length)
  const end = script.lastIndexOf(`\n${USER_SCRIPT_END}`)
  if (start < 0 || end < start) return script
  return script.slice(start + USER_SCRIPT_START.length + 1, end)
}

/** Human-readable script that powershell.exe / pwsh actually executes. */
export function powershellLaunchScript(userScript: string, executable = 'powershell.exe'): string {
  const body = unwrapLaunchScript(userScript)
  const base = executable.replace(/^.*[\\/]/, '').toLowerCase()
  const core = base === 'pwsh' || base === 'pwsh.exe'
  const corePrefix = core ? `${POWERSHELL_LEGACY_LINE}\n` : ''
  return [
    WRAPPER_START,
    corePrefix + '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "$ProgressPreference = 'SilentlyContinue'",
    "$ErrorActionPreference = 'Stop'",
    'try {',
    ...powershellRuntimeArgumentPrelude(body),
    USER_SCRIPT_START,
    body,
    USER_SCRIPT_END,
    '  if ($null -ne $global:LASTEXITCODE) { exit $global:LASTEXITCODE }',
    '  exit 0',
    '} catch {',
    '  $arckeepErrorText = ($_ | Out-String).TrimEnd()',
    '  [Console]::Error.WriteLine($arckeepErrorText)',
    '  exit 1',
    '}'
  ].filter(Boolean).join('\n')
}

/** PowerShell single-quoted string. Only `'` is special, and it is doubled. */
export function quotePowerShellArg(value: string): string {
  return `'${value.replace(/\0/g, '').replace(/'/g, "''")}'`
}

/** Encode one value for the legacy PowerShell native argument binder. */
export function quotePowerShellNativeArg(value: string): string {
  const token = windowsNativeArgumentToken(value.replace(/\0/g, ''))
  return `'${token.replace(/'/g, "''")}'`
}

/** Bash single-quoted string. Embedded quotes use the `'\''` break. */
export function quoteBashArg(value: string): string {
  return `'${value.replace(/\0/g, '').replace(/'/g, `'\\''`)}'`
}

export function quoteForShell(shell: ShellKind, value: string, powershellNative = false): string {
  if (shell === 'cmd') return quoteCmdArg(value)
  if (shell === 'powershell') return powershellNative ? quotePowerShellNativeArg(value) : quotePowerShellArg(value)
  return quoteBashArg(value)
}

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g

const POWERSHELL_ARGUMENT_HELPER = '__ArckeepResolvePlaceholderArgument'
const POWERSHELL_ARGUMENT_ID_PREFIX = '__ARCKEEP_ARGUMENT_'

function quotePowerShellRuntimeArgument(value: string, id: string): string {
  const plain = quotePowerShellArg(value)
  const native = quotePowerShellNativeArg(value)
  return `$(${POWERSHELL_ARGUMENT_HELPER} ${quotePowerShellArg(id)} ${plain} ${native})`
}

function powershellRuntimeArgumentPrelude(body: string): string[] {
  if (!body.includes(`${POWERSHELL_ARGUMENT_HELPER} '${POWERSHELL_ARGUMENT_ID_PREFIX}`)) return []
  return [
    `$script:__arckeepArgumentAst = [scriptblock]::Create(${quotePowerShellArg(body)}).Ast`,
    `function ${POWERSHELL_ARGUMENT_HELPER}([string]$id, [string]$plain, [string]$native) {`,
    '  $helperCall = $script:__arckeepArgumentAst.Find({',
    '    param($node)',
    `    if ($node -isnot [System.Management.Automation.Language.CommandAst] -or $node.GetCommandName() -ne '${POWERSHELL_ARGUMENT_HELPER}') { return $false }`,
    '    foreach ($element in $node.CommandElements) {',
    '      if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $element.Value -eq $id) { return $true }',
    '    }',
    '    return $false',
    '  }, $true)',
    "  if (-not $helperCall) { throw '无法识别含双引号参数的 PowerShell 调用上下文，命令未执行。' }",
    '  $commandAst = $helperCall.Parent',
    `  while ($commandAst -and -not ($commandAst -is [System.Management.Automation.Language.CommandAst] -and $commandAst.GetCommandName() -ne '${POWERSHELL_ARGUMENT_HELPER}')) { $commandAst = $commandAst.Parent }`,
    '  if (-not $commandAst) { return $plain }',
    '  $commandName = $commandAst.GetCommandName()',
    "  if (-not $commandName) { throw '含双引号参数的 PowerShell 调用使用动态命令名，命令未执行；请改用静态命令名。' }",
    '  $resolvedCommand = Microsoft.PowerShell.Core\\Get-Command -Name $commandName -ErrorAction SilentlyContinue',
    "  if (-not $resolvedCommand) { throw '无法解析含双引号参数对应的 PowerShell 命令，命令未执行。' }",
    '  for ($i = 0; $resolvedCommand -and $resolvedCommand.CommandType -eq [System.Management.Automation.CommandTypes]::Alias -and $i -lt 16; $i += 1) {',
    '    $nextCommand = $resolvedCommand.ResolvedCommand',
    '    if (-not $nextCommand -or $nextCommand -eq $resolvedCommand) { break }',
    '    $resolvedCommand = $nextCommand',
    '  }',
    "  if ($resolvedCommand.CommandType -eq [System.Management.Automation.CommandTypes]::Alias) { throw '无法解析含双引号参数对应的 PowerShell 命令别名，命令未执行。' }",
    '  if ($resolvedCommand -and $resolvedCommand.CommandType -eq [System.Management.Automation.CommandTypes]::Application) { return $native }',
    '  return $plain',
    '}'
  ]
}

export function placeholderInsideQuotes(template: string, shell: ShellKind): boolean {
  let mode: 'none' | 'single' | 'double' = 'none'
  for (let i = 0; i < template.length; i += 1) {
    const ch = template[i]
    if (mode === 'single') {
      if (ch === "'") {
        if (shell === 'powershell' && template[i + 1] === "'") {
          i += 1
          continue
        }
        mode = 'none'
      } else if (template.startsWith('{{', i)) {
        return true
      }
      continue
    }
    if (mode === 'double') {
      if (shell === 'git-bash' && ch === '\\') {
        i += 1
        continue
      }
      if (shell === 'powershell' && ch === '`') {
        i += 1
        continue
      }
      if (ch === '"') {
        mode = 'none'
        continue
      }
      if (template.startsWith('{{', i)) return true
      continue
    }
    if (ch === '"') mode = 'double'
    else if (ch === "'" && shell !== 'cmd') mode = 'single'
  }
  return false
}

export function listPlaceholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map(match => match[1])
}

export function assertPlaceholders(template: string, allowed: ReadonlySet<string>): void {
  for (const match of template.matchAll(/\{\{([^{}]*)\}\}/g)) {
    const key = match[1]
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || !allowed.has(key)) {
      throw new Error(`占位符无效：{{${key}}}`)
    }
  }
  const stripped = template.replace(/\{\{[A-Za-z][A-Za-z0-9_]*\}\}/g, '')
  if (stripped.includes('{{') || stripped.includes('}}')) {
    throw new Error('占位符需要写成 {{name}}')
  }
}

export function expandRaw(template: string, params: Readonly<Record<string, string>>): string {
  assertPlaceholders(template, new Set(Object.keys(params)))
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) {
      throw new Error(`未知参数：${key}`)
    }
    return params[key] ?? ''
  })
}

export function expandCommand(
  template: string,
  params: Readonly<Record<string, string>>,
  shell: ShellKind
): string {
  assertPlaceholders(template, new Set(Object.keys(params)))
  if (placeholderInsideQuotes(template, shell)) {
    throw new Error('参数占位符必须写在引号外面，执行时会按 shell 加引号')
  }
  if (shell === 'cmd' && /[\r\n]/.test(template)) {
    throw new Error('cmd 命令模板不能换行')
  }
  let argumentIndex = 0
  return template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = params[key] ?? ''
    if (shell === 'powershell' && value.includes('"')) {
      const id = `${POWERSHELL_ARGUMENT_ID_PREFIX}${argumentIndex}__`
      argumentIndex += 1
      return quotePowerShellRuntimeArgument(value, id)
    }
    return quoteForShell(shell, value)
  })
}
