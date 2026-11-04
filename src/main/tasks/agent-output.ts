import type { TaskUsage } from '../../shared/tasks/types.js'

export interface ParsedAgentOutput {
  sessionId: string | null
  finalText: string
  usage: TaskUsage
  error: string | null
  producedOutput: boolean
}

function emptyUsage(): TaskUsage {
  return { costUsd: null, inputTokens: null, outputTokens: null }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function parseLines(stdout: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) records.push(parsed as Record<string, unknown>)
    } catch {
      // Ignore non-JSON noise from CLIs or shell wrappers.
    }
  }
  return records
}

function claudeAssistantText(record: Record<string, unknown>): string {
  const message = record.message
  if (!message || typeof message !== 'object' || Array.isArray(message)) return ''
  const content = (message as Record<string, unknown>).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const item = part as Record<string, unknown>
    if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text)
  }
  return texts.join('\n').trim()
}

export function parseClaudeStream(stdout: string): ParsedAgentOutput {
  const records = parseLines(stdout)
  if (records.length === 0) {
    return {
      sessionId: null,
      finalText: stdout.trim().slice(-20_000),
      usage: emptyUsage(),
      error: null,
      producedOutput: stdout.trim().length > 0
    }
  }
  let sessionId: string | null = null
  let finalText = ''
  let error: string | null = null
  let usage = emptyUsage()
  const assistantTexts: string[] = []
  for (const record of records) {
    if (typeof record.session_id === 'string' && /^[0-9a-f-]{36}$/i.test(record.session_id)) sessionId = record.session_id
    if (record.type === 'assistant') {
      const text = claudeAssistantText(record)
      if (text) assistantTexts.push(text)
      continue
    }
    if (record.type !== 'result') continue
    if (typeof record.result === 'string') finalText = record.result
    if (record.is_error === true) {
      error = (typeof record.result === 'string' && record.result.trim()) || 'Claude 报告本轮执行失败'
    }
    const eventUsage = record.usage && typeof record.usage === 'object' && !Array.isArray(record.usage)
      ? record.usage as Record<string, unknown>
      : {}
    usage = {
      costUsd: numberOrNull(record.total_cost_usd),
      inputTokens: numberOrNull(eventUsage.input_tokens),
      outputTokens: numberOrNull(eventUsage.output_tokens)
    }
  }
  if (!finalText) finalText = assistantTexts.join('\n\n').trim()
  const denials = records.at(-1)?.permission_denials
  if (!error && Array.isArray(denials) && denials.length > 0 && !finalText) {
    error = 'Claude 有 ' + denials.length + ' 个工具调用未获授权'
  }
  return {
    sessionId,
    finalText,
    usage,
    error,
    producedOutput: records.length > 0
  }
}

function codexMessageText(item: Record<string, unknown>): string {
  return item.type === 'agent_message' && typeof item.text === 'string' ? item.text.trim() : ''
}

export function parseCodexStream(stdout: string): ParsedAgentOutput {
  const records = parseLines(stdout)
  if (records.length === 0) {
    return {
      sessionId: null,
      finalText: stdout.trim().slice(-20_000),
      usage: emptyUsage(),
      error: null,
      producedOutput: stdout.trim().length > 0
    }
  }
  let sessionId: string | null = null
  let usage = emptyUsage()
  const messages: string[] = []
  const fatal: string[] = []
  for (const record of records) {
    if (record.type === 'thread.started' && typeof record.thread_id === 'string') sessionId = record.thread_id
    if (record.type === 'turn.failed') {
      const errorValue = record.error
      if (errorValue && typeof errorValue === 'object' && !Array.isArray(errorValue)) {
        const message = (errorValue as Record<string, unknown>).message
        fatal.push(typeof message === 'string' ? message : 'Codex 本轮失败')
      } else {
        fatal.push('Codex 本轮失败')
      }
    }
    if (record.type === 'error' || record.type === 'stream_error') {
      const message = record.message
      if (typeof message === 'string') fatal.push(message)
    }
    if (record.item && typeof record.item === 'object' && !Array.isArray(record.item)) {
      const item = record.item as Record<string, unknown>
      if (record.type === 'item.completed') {
        const text = codexMessageText(item)
        if (text) messages.push(text)
        if (item.type === 'error' && typeof item.message === 'string'
          && !/under-development features/i.test(item.message)) {
          fatal.push(item.message)
        }
      }
    }
    if (record.type === 'turn.completed' && record.usage && typeof record.usage === 'object' && !Array.isArray(record.usage)) {
      const eventUsage = record.usage as Record<string, unknown>
      usage = {
        costUsd: null,
        inputTokens: numberOrNull(eventUsage.input_tokens),
        outputTokens: numberOrNull(eventUsage.output_tokens)
      }
    }
  }
  return {
    sessionId,
    finalText: messages.join('\n\n').trim(),
    usage,
    error: fatal.length > 0 ? [...new Set(fatal)].join('；').slice(0, 2000) : null,
    producedOutput: records.length > 0
  }
}

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[A-Za-z]', 'g')

export function progressFromLine(line: string): string | null {
  const clean = line.replace(ANSI, '').trim()
  if (!clean) return null
  if (clean.startsWith('{')) {
    try {
      const record = JSON.parse(clean) as Record<string, unknown>
      if (record.type === 'assistant' && record.message && typeof record.message === 'object') {
        const content = (record.message as Record<string, unknown>).content
        if (Array.isArray(content)) {
          for (const part of content) {
            if (!part || typeof part !== 'object') continue
            const item = part as Record<string, unknown>
            if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) return item.text.trim().slice(0, 280)
            if (item.type === 'tool_use' && typeof item.name === 'string') return '调用工具：' + item.name
          }
        }
      }
      if (record.item && typeof record.item === 'object') {
        const item = record.item as Record<string, unknown>
        if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) return item.text.trim().slice(0, 280)
        if (item.type === 'command_execution' && typeof item.command === 'string') return '运行：' + item.command.slice(0, 240)
        if (item.type === 'file_change' && Array.isArray(item.changes)) return '修改文件（' + item.changes.length + ' 处）'
      }
      if (record.type === 'result') return 'Agent 本轮结束'
      if (record.type === 'turn.completed') return 'Agent 本轮结束'
    } catch {
      // Fall through to the raw line.
    }
  }
  return clean.slice(0, 280)
}
