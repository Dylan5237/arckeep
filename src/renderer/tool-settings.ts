import type { ToolFixtureInvalid } from '../shared/tools/fixture'
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
  parent.insertBefore(
    el('div', { class: kind === 'error' ? 'alert error' : 'alert', role: kind === 'error' ? 'alert' : 'status' }, [text]),
    parent.querySelector('textarea')
  )
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
  const editor = el('textarea', { id: 'tool-shelf-json', 'aria-label': '工具架 JSON', spellcheck: 'false' })
  editor.value = invalid?.draft ?? state.toolShelfJson
  editor.classList.add('tool-json')
  if (invalid) messageBox(card, 'error', invalid.error)

  const save = el('button', { type: 'button', class: 'primary' }, ['保存'])
  const importFile = el('button', { type: 'button', class: 'ghost' }, ['导入'])
  const exportFile = el('button', { type: 'button', class: 'ghost' }, ['导出'])
  const example = el('button', { type: 'button', class: 'ghost' }, ['填入示例'])
  save.addEventListener('click', async () => {
    const result = await window.arckeep.setToolShelf(editor.value)
    if (!result.ok) {
      messageBox(card, 'error', result.error)
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
  card.append(editor, el('div', { class: 'actions' }, [save, importFile, exportFile, example]))
  if (invalid) requestAnimationFrame(() => card.scrollIntoView({ block: 'start' }))
  return card
}
