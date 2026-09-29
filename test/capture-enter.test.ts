// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { ArckeepApi, TodoItem } from '../src/shared/types.js'

const MARKUP = `
  <form id="capture-form">
    <div>
      <input id="text" type="text" />
      <span id="caret" hidden></span>
      <span id="caret-probe"></span>
    </div>
    <input id="repo" type="text" />
    <datalist id="capture-repos"></datalist>
    <input id="waiting" type="checkbox" />
    <p id="error" hidden></p>
  </form>
`

function savedItem(text: string, repo: string | null): TodoItem {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    text,
    repo,
    waiting: false,
    waitingSince: null,
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    completed: false
  }
}

async function mount(name: string): Promise<{
  text: HTMLInputElement
  repo: HTMLInputElement
  created: Array<{ text: string, repo: string | null, waiting: boolean }>
  closed: Array<'dismiss' | 'saved' | undefined>
}> {
  document.body.innerHTML = MARKUP
  const created: Array<{ text: string, repo: string | null, waiting: boolean }> = []
  const closed: Array<'dismiss' | 'saved' | undefined> = []
  window.arckeep = {
    todoRepoOptions: async () => ['example/demo'],
    getCaptureDraft: async () => ({ text: '', repo: '', waiting: false }),
    setCaptureDraft: async draft => draft,
    createTodo: async input => {
      created.push(input)
      return { ok: true, data: savedItem(input.text, input.repo) }
    },
    closeCapture: async mode => {
      closed.push(mode)
    }
  } as ArckeepApi
  if (name === 'text') await import('../src/renderer/capture.ts?case=text')
  else if (name === 'repo') await import('../src/renderer/capture.ts?case=repo')
  else await import('../src/renderer/capture.ts?case=empty-repo')
  const text = document.querySelector<HTMLInputElement>('#text')
  const repo = document.querySelector<HTMLInputElement>('#repo')
  if (!text || !repo) throw new Error('capture fields missing')
  return { text, repo, created, closed }
}

function pressEnter(field: HTMLInputElement): void {
  field.focus()
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
}

describe('quick capture Enter', () => {
  it('saves and closes when Enter is pressed in the text field', async () => {
    const view = await mount('text')
    view.text.value = '从正文记下'
    view.repo.value = 'example/demo'
    pressEnter(view.text)
    await Promise.resolve()
    await Promise.resolve()
    expect(view.created).toEqual([{ text: '从正文记下', repo: 'example/demo', waiting: false }])
    expect(view.closed).toEqual(['saved'])
  })

  it('saves and closes when Enter is pressed in the repo field', async () => {
    const view = await mount('repo')
    view.text.value = '从仓库框记下'
    view.repo.value = 'example/demo'
    pressEnter(view.repo)
    await Promise.resolve()
    await Promise.resolve()
    expect(view.created).toEqual([{ text: '从仓库框记下', repo: 'example/demo', waiting: false }])
    expect(view.closed).toEqual(['saved'])
  })

  it('saves and closes when the repo field is empty', async () => {
    const view = await mount('empty-repo')
    view.text.value = '没有仓库也记下'
    view.repo.value = ''
    pressEnter(view.text)
    await Promise.resolve()
    await Promise.resolve()
    expect(view.created).toEqual([{ text: '没有仓库也记下', repo: null, waiting: false }])
    expect(view.closed).toEqual(['saved'])
  })
})
