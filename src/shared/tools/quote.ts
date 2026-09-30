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

/**
 * PowerShell 5.1's native binder appends already quoted string values as raw
 * command-line text. Encode native argv only for native commands; cmdlets and
 * PowerShell scripts need the original value as a PowerShell string.
 */
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

const POWERSHELL_ALIASES = new Set([
  'cat', 'cd', 'chdir', 'clear', 'clc', 'copy', 'cp', 'del', 'dir', 'echo', 'erase', 'fl', 'foreach',
  'ft', 'gc', 'gci', 'gcm', 'gdr', 'gmo', 'gps', 'group', 'gm', 'iex', 'ii', 'kill', 'ls', 'measure',
  'md', 'mi', 'mount', 'move', 'mp', 'mv', 'nal', 'ndr', 'ni', 'nsn', 'nv', 'ogv', 'oh', 'popd', 'ps',
  'pushd', 'pwd', 'r', 'rbp', 'rdr', 'ren', 'ri', 'rm', 'rmdir', 'rni', 'rnp', 'rp', 'rsn', 'rv', 'rwmi',
  'sajb', 'sal', 'saps', 'sasv', 'sbp', 'sc', 'select', 'set', 'shcm', 'si', 'sl', 'sleep', 'sls', 'sort',
  'sp', 'spps', 'spsv', 'start', 'stz', 'sv', 'tee', 'where', 'write'
])

const POWERSHELL_KEYWORDS = new Set([
  'begin', 'catch', 'class', 'data', 'do', 'dynamicparam', 'else', 'elseif', 'end', 'filter', 'finally',
  'for', 'foreach', 'function', 'if', 'in', 'param', 'process', 'return', 'switch', 'throw', 'trap', 'try',
  'until', 'while'
])

const POWERSHELL_VERBS = /^(?:Add|Approve|Assert|Backup|Block|Build|Checkpoint|Clear|Close|Compare|Complete|Compress|Connect|Convert|Copy|Debug|Deny|Disable|Disconnect|Dismount|Edit|Enable|Enter|Exit|Expand|Export|Find|Format|Get|Grant|Group|Hide|Import|Initialize|Install|Invoke|Join|Limit|Lock|Measure|Merge|Mount|Move|New|Open|Optimize|Out|Pop|Protect|Publish|Push|Read|Receive|Redo|Register|Remove|Rename|Repair|Reset|Resize|Resolve|Restart|Restore|Resume|Revoke|Save|Search|Select|Send|Set|Show|Skip|Split|Start|Step|Stop|Submit|Suspend|Switch|Sync|Test|Trace|Unblock|Undo|Uninstall|Unlock|Unregister|Update|Use|Wait|Watch|Write)-[A-Za-z][A-Za-z0-9]*$/i

function commandToken(segment: string): string {
  let source = segment.trimStart()
  source = source.replace(/^&\s*/, '')
  source = source.replace(/^\.(?=\s)/, '').trimStart()
  source = source.replace(/^\$[A-Za-z_][\w:]*\s*=\s*/, '')
  const first = source[0]
  if (first === "'") {
    let token = ''
    for (let i = 1; i < source.length; i += 1) {
      if (source[i] === "'") {
        if (source[i + 1] === "'") {
          token += "'"
          i += 1
          continue
        }
        return token
      }
      token += source[i]
    }
    return token
  }
  if (first === '"') {
    let token = ''
    for (let i = 1; i < source.length; i += 1) {
      if (source[i] === '`') {
        token += source[i + 1] ?? ''
        i += 1
      } else if (source[i] === '"') {
        return token
      } else {
        token += source[i]
      }
    }
    return token
  }
  return source.match(/^[^\s;|&{}()[\]]+/)?.[0] ?? ''
}

/**
 * Select the Windows native argv encoder only when the placeholder belongs to
 * a native command. PowerShell command separators and quoted strings are
 * tracked so a cmdlet elsewhere in a script does not affect the decision.
 */
function powershellPlaceholderIsNative(template: string, placeholderOffset: number): boolean {
  let start = 0
  let single = false
  let double = false
  let escaped = false
  let parens = 0
  let brackets = 0
  let braces = 0
  for (let i = 0; i < placeholderOffset; i += 1) {
    const ch = template[i]
    if (single) {
      if (ch === "'") {
        if (template[i + 1] === "'") i += 1
        else single = false
      }
      continue
    }
    if (double) {
      if (escaped) escaped = false
      else if (ch === '`') escaped = true
      else if (ch === '"') double = false
      continue
    }
    if (ch === '`') {
      i += 1
      continue
    }
    if (ch === "'") {
      single = true
      continue
    }
    if (ch === '"') {
      double = true
      continue
    }
    if (ch === '{') {
      braces += 1
      start = i + 1
      continue
    }
    if (ch === '}') {
      braces = Math.max(0, braces - 1)
      start = i + 1
      continue
    }
    if (ch === '(') parens += 1
    else if (ch === ')') parens = Math.max(0, parens - 1)
    else if (ch === '[') brackets += 1
    else if (ch === ']') brackets = Math.max(0, brackets - 1)
    else if (parens === 0 && brackets === 0 && braces === 0) {
      if (ch === ';' || ch === '\n' || ch === '\r') {
        if (ch === '\n' && template[i - 1] === '`') continue
        start = i + 1
      } else if (ch === '|') {
        start = i + (template[i + 1] === '|' ? 2 : 1)
        if (template[i + 1] === '|') i += 1
      }
    }
  }

  const segment = template.slice(start, placeholderOffset).trimStart()
  const control = segment.match(/^(begin|catch|data|do|dynamicparam|else|elseif|end|finally|for|foreach|function|if|param|process|switch|throw|trap|try|until|while)\b/i)?.[1]
  if (control) return false
  const token = commandToken(segment)
  if (!token) return false
  const normalized = token.toLowerCase()
  if (POWERSHELL_KEYWORDS.has(normalized) || POWERSHELL_ALIASES.has(normalized)) return false
  if (/\.(?:ps1|psm1|psd1)$/i.test(token)) return false
  if (/\.(?:exe|com|bat|cmd|sh|py|js|mjs|cjs)$/i.test(token) || /[\\/]/.test(token)) return true
  if (POWERSHELL_VERBS.test(token)) return false
  if (/^[$([]/.test(token)) return false
  return true
}

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g

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
  return template.replace(PLACEHOLDER, (_match, key: string, offset: number) => {
    const native = shell === 'powershell' && powershellPlaceholderIsNative(template, offset)
    return quoteForShell(shell, params[key] ?? '', native)
  })
}
