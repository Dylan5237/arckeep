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
      out += '\\'.repeat(backslashes * 2 + 1)
      out += '"'
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
const POWERSHELL_EXIT_LINE = 'exit $LASTEXITCODE'

/** Human-readable script that powershell.exe / pwsh actually executes. */
export function powershellLaunchScript(userScript: string, executable = 'powershell.exe'): string {
  const exitSuffix = `\n${POWERSHELL_EXIT_LINE}`
  const legacyPrefix = `${POWERSHELL_LEGACY_LINE}\n`
  let body = userScript
  if (body.endsWith(exitSuffix)) {
    body = body.slice(0, -exitSuffix.length)
    if (body.startsWith(legacyPrefix)) body = body.slice(legacyPrefix.length)
  }
  const base = executable.replace(/^.*[\\/]/, '').toLowerCase()
  const core = base === 'pwsh' || base === 'pwsh.exe'
  return `${core ? legacyPrefix : ''}${body}${exitSuffix}`
}

/** PowerShell single-quoted string. Only `'` is special, and it is doubled. */
export function quotePowerShellArg(value: string): string {
  const cleaned = value.replace(/\0/g, '')
  const embedded = cleaned.includes('"') ? windowsNativeArgumentToken(cleaned) : cleaned
  return `'${embedded.replace(/'/g, "''")}'`
}

/** Bash single-quoted string. Embedded quotes use the `'\''` break. */
export function quoteBashArg(value: string): string {
  return `'${value.replace(/\0/g, '').replace(/'/g, `'\\''`)}'`
}

export function quoteForShell(shell: ShellKind, value: string): string {
  if (shell === 'cmd') return quoteCmdArg(value)
  if (shell === 'powershell') return quotePowerShellArg(value)
  return quoteBashArg(value)
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
  return template.replace(PLACEHOLDER, (_match, key: string) => quoteForShell(shell, params[key] ?? ''))
}
