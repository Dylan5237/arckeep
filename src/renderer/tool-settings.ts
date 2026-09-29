import type { ToolFixtureInvalid } from '../shared/tools/fixture'
import { errorLine } from '../shared/tools/present'
import type { AppState } from '../shared/types'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Array<Node | string> = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value
    else node.setAttribute(key, value)
  }
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(child))
  return node
}

function messageBox(parent: HTMLElement, kind: 'info' | 'error', text: string): void {
  parent.querySelector('.alert')?.remove()
  const anchor = parent.querySelector('.json-shell') ?? parent.querySelector('textarea')
  const box = el('div', { class: kind === 'error' ? 'alert error' : 'alert', role: kind === 'error' ? 'alert' : 'status' }, [text])
  if (anchor) parent.insertBefore(box, anchor)
  else parent.append(box)
}

function paintJsonGutter(gutter: HTMLElement, text: string, line: number | null): void {
  gutter.replaceChildren()
  for (const [index] of text.split('\n').entries()) {
    const number = index + 1
    const span = el('span', { class: number === line ? 'json-gutter-line json-gutter-bad' : 'json-gutter-line' })
    span.textContent = String(number)
    gutter.append(span)
  }
}

function selectErrorLine(editor: HTMLTextAreaElement, line: number | null): void {
  if (!line) {
    editor.setSelectionRange(0, 0)
    return
  }
  const lines = editor.value.split('\n')
  const start = lines.slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0)
  const end = start + (lines[line - 1]?.length ?? 0)
  editor.setSelectionRange(start, end)
}

function mountJsonEditor(initial: string, line: number | null): {
  shell: HTMLElement
  editor: HTMLTextAreaElement
  setLine: (next: number | null) => void
} {
  const shell = el('div', { class: 'json-shell' })
  const gutter = el('div', { class: 'json-gutter', 'aria-hidden': 'true' })
  const editor = el('textarea', { id: 'tool-shelf-json', 'aria-label': '工具架 JSON', spellcheck: 'false' })
  editor.value = initial
  editor.classList.add('tool-json')
  let marked = line
  if (marked) editor.setAttribute('aria-invalid', 'true')
  const sync = () => {
    paintJsonGutter(gutter, editor.value, marked)
    gutter.scrollTop = editor.scrollTop
  }
  editor.addEventListener('scroll', () => {
    gutter.scrollTop = editor.scrollTop
  })
  editor.addEventListener('input', sync)
  sync()
  selectErrorLine(editor, marked)
  if (marked && marked > 1) editor.scrollTop = Math.max(0, (marked - 3) * 19)
  shell.append(gutter, editor)
  return {
    shell,
    editor,
    setLine(next: number | null) {
      marked = next
      if (next) editor.setAttribute('aria-invalid', 'true')
      else editor.removeAttribute('aria-invalid')
      sync()
      selectErrorLine(editor, next)
      if (next && next > 1) editor.scrollTop = Math.max(0, (next - 3) * 19)
    }
  }
}

export async function renderToolSettings(
  state: AppState,
  rerender: () => Promise<void>
): Promise<HTMLElement> {
  const fixture = await window.arckeep.getToolFixture()
  const invalid: ToolFixtureInvalid | null = fixture?.page === 'settings' ? fixture : null
  const card = el('section', { class: 'card', id: 'tool-shelf-card' }, [
    el('h2', {}, ['工具架']),
    el('p', { class: 'hint' }, [
      '动作写在 JSON 里，保存时按 schema/tool-shelf.schema.json 校验。{{参数}} 会在执行前按 shell 加引号，不能写在引号里面。示例在 schema/tool-shelf.example.json。'
    ])
  ])
  const markedLine = invalid ? (invalid.line || errorLine(invalid.error)) : null
  const { shell, editor, setLine } = mountJsonEditor(invalid?.draft ?? state.toolShelfJson, markedLine)
  if (invalid) messageBox(card, 'error', invalid.error)

  const save = el('button', { type: 'button', class: 'primary' }, ['保存'])
  const importFile = el('button', { type: 'button', class: 'ghost' }, ['导入'])
  const exportFile = el('button', { type: 'button', class: 'ghost' }, ['导出'])
  const example = el('button', { type: 'button', class: 'ghost' }, ['填入示例'])
  save.addEventListener('click', async () => {
    const result = await window.arckeep.setToolShelf(editor.value)
    if (!result.ok) {
      messageBox(card, 'error', result.error)
      setLine(errorLine(result.error))
      return
    }
    messageBox(card, 'info', '工具架已保存')
    await rerender()
  })
  importFile.addEventListener('click', async () => {
    const result = await window.arckeep.importToolShelf()
    if (!result.ok) {
      messageBox(card, 'error', result.error)
      return
    }
    if (result.data.cancelled) return
    editor.value = result.data.text
    messageBox(card, 'info', '已导入到编辑框，还没有保存')
  })
  exportFile.addEventListener('click', async () => {
    const result = await window.arckeep.exportToolShelf(editor.value)
    if (!result.ok) {
      messageBox(card, 'error', result.error)
      return
    }
    if (!result.data.cancelled) messageBox(card, 'info', '已导出')
  })
  example.addEventListener('click', async () => {
    editor.value = await window.arckeep.getToolExample()
    messageBox(card, 'info', '已填入示例，还没有保存')
  })
  card.append(shell, el('div', { class: 'actions' }, [save, importFile, exportFile, example]))
  if (invalid) requestAnimationFrame(() => card.scrollIntoView({ block: 'start' }))
  return card
}
