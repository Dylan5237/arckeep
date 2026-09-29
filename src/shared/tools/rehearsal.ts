import { SHELL_LABEL, type ActionPreview, type Rehearsal } from './types.js'

export const RAW_PREVIEW_LINES = 6

export interface DryRunResult {
  cwd: string
  code: number | null
  stdout: string
  stderr: string
  aborted?: boolean
  error?: string
}

export type { Rehearsal }

const CREATE_LEAD = /^(?:create(?:\s+mode\s+\d+)?|creating|created|write|writing|wrote|add|adding|added|would create|will create|creating file|create file|将创建|创建文件|创建|新增|写入)\s*[:：]?\s+(.+)$/i
const LIST_HEADER = /(将)?创建|would create|will create|files to (be )?creat|新建|写入文件|新增文件/i
const BULLET = /^(?:[-*•]|\d+[.)])\s+/

export function firstOutputLines(text: string, limit = RAW_PREVIEW_LINES): string {
  return text
    .split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .slice(0, limit)
    .join('\n')
}

function normalizeFileToken(raw: string): string | null {
  let text = raw.trim().replace(/\s+#.*$/, '').replace(/\s+\([^)]*\)$/, '')
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim()
  }
  if (!text || text.length > 240 || /[\0\r\n]/.test(text)) return null
  if (/[<>|*?]/.test(text)) return null
  if (text.split(/\s+/).length > 3) return null
  if (/^(https?:|git:)/i.test(text)) return null
  if (!/[\\/]/.test(text) && !/\.[A-Za-z0-9]{1,12}$/.test(text) && !text.startsWith('.')) return null
  return text
}

/** Pull created-file paths out of dry-run stdout. Returns [] when the text is prose. */
export function parseCreatedFiles(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const files: string[] = []
  const seen = new Set<string>()
  const push = (token: string | null) => {
    if (!token || seen.has(token)) return
    seen.add(token)
    files.push(token)
  }
  let inList = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      inList = false
      continue
    }
    const lead = CREATE_LEAD.exec(trimmed)
    if (lead) {
      push(normalizeFileToken(lead[1]))
      inList = false
      continue
    }
    if (trimmed.length < 80 && LIST_HEADER.test(trimmed) && !normalizeFileToken(trimmed)) {
      inList = true
      continue
    }
    if (inList) {
      const file = normalizeFileToken(trimmed.replace(BULLET, ''))
      if (file) push(file)
      else inList = false
    }
  }
  if (files.length === 0) {
    const nonempty = lines.map(line => line.trim()).filter(Boolean)
    const parsed = nonempty.map(line => normalizeFileToken(line.replace(BULLET, '')))
    if (nonempty.length > 0 && parsed.every((item): item is string => item !== null)) {
      for (const file of parsed) push(file)
    }
  }
  return files.slice(0, 40)
}

export function fileListSummary(cwd: string, files: readonly string[]): string {
  const shown = files.slice(0, 8)
  const names = shown.join('、')
  const tail = files.length > shown.length ? '、…' : ''
  return `将在 ${cwd} 创建 ${files.length} 个文件：${names}${tail}`
}

function failureSummary(result: DryRunResult): string {
  const reason = firstOutputLines(result.stderr)
    || firstOutputLines(result.stdout)
    || result.error?.trim()
    || (result.aborted ? '预演超时或被中止' : '没有输出')
  if (result.code === null || result.code === undefined) return `预演失败：${reason}`
  return `预演失败（退出码 ${result.code}）：${reason}`
}

export function summarizeDryRun(result: DryRunResult): Rehearsal {
  const failed = Boolean(result.aborted)
    || Boolean(result.error)
    || result.code === null
    || result.code !== 0
  if (failed) {
    return { status: 'failed', summary: failureSummary(result), canConfirm: false }
  }
  const fromOut = parseCreatedFiles(result.stdout)
  const files = fromOut.length > 0 ? fromOut : parseCreatedFiles(result.stderr)
  if (files.length > 0) {
    return {
      status: 'files',
      summary: fileListSummary(result.cwd, files),
      files,
      canConfirm: true
    }
  }
  const raw = firstOutputLines(result.stdout) || firstOutputLines(result.stderr)
  return {
    status: 'raw',
    summary: raw || '预演没有输出。',
    canConfirm: true
  }
}

export function unavailableRehearsal(cwd: string, command: string): Rehearsal {
  const line = command.split(/\r?\n/).map(item => item.trim()).find(Boolean) ?? command.trim()
  const shown = line.length > 180 ? `${line.slice(0, 180)}…` : line
  const where = cwd.trim() || '当前目录'
  return {
    status: 'unavailable',
    summary: `将在 ${where} 运行 ${shown}`,
    canConfirm: true,
    mark: '无法预演'
  }
}

export function previewNotice(rehearsal: Rehearsal): string {
  if (rehearsal.status === 'failed') return '预演没有成功，不能继续执行。'
  if (rehearsal.status === 'unavailable') return '这条命令无法预演。确认后会真的运行。'
  return '下面是预演结果。确认后才会执行，取消不会运行。'
}

/** Lines inside the collapsed「查看命令」block. The dry-run script stays out. */
export function foldedCommandLines(preview: Pick<ActionPreview, 'shell' | 'cwd' | 'text'>): string[] {
  const lines: string[] = []
  if (preview.shell) lines.push(`shell: ${SHELL_LABEL[preview.shell]}`)
  if (preview.cwd) lines.push(`工作目录: ${preview.cwd}`)
  lines.push(preview.text)
  return lines
}
