// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArckeepApi } from '../src/shared/types.js'
import type { ActionPreview, ToolAction } from '../src/shared/tools/types.js'

const action: ToolAction = {
  id: 'deferred-preview',
  title: '异步预演',
  type: 'run-command',
  shell: 'powershell',
  command: 'Write-Output {{value}}',
  previewCommand: 'Write-Output {{value}}',
  params: [{ key: 'value', label: '参数', default: '原始参数' }]
}

type PreviewResult = Awaited<ReturnType<ArckeepApi['previewTool']>>
let leave: (() => void) | undefined

async function flush(): Promise<void> {
  for (let count = 0; count < 8; count += 1) await Promise.resolve()
}

function button(content: HTMLElement, label: string): HTMLButtonElement {
  const found = [...content.querySelectorAll('button')].find(node => node.textContent === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}

async function setup(selectedAction: ToolAction = action) {
  const pending: Array<{ id: string, resolve: (result: PreviewResult) => void }> = []
  const cancelToolPreview = vi.fn(async () => ({ ok: true }))
  const api = {
    getToolFixture: vi.fn(async () => null),
    getToolCatalog: vi.fn(async () => ({ ok: true, actions: [selectedAction] })),
    onToolEvent: vi.fn(() => () => {}),
    previewTool: vi.fn((_id: string, _params: Record<string, string>, requestId: string) =>
      new Promise<PreviewResult>(resolve => { pending.push({ id: requestId, resolve }) })),
    cancelToolPreview
  } as unknown as ArckeepApi
  window.arckeep = api
  const content = document.createElement('main')
  document.body.replaceChildren(content)
  const page = await import('../src/renderer/tools-page.js')
  leave = page.deactivateTools
  await page.renderTools(content, () => {})
  content.querySelector<HTMLButtonElement>('.tool-card')!.click()
  await flush()
  if (selectedAction.params?.length) {
    button(content, '预览').click()
    await flush()
    expect(button(content, '正在预演').disabled).toBe(true)
  }
  return { content, pending, cancelToolPreview }
}

function success(text = 'Write-Output original'): PreviewResult {
  const data: ActionPreview = {
    actionId: action.id,
    title: action.title,
    type: 'run-command',
    text,
    confirmationId: `confirmation-${text}`,
    rehearsal: { status: 'raw', summary: text, canConfirm: true }
  }
  return { ok: true, data }
}

beforeEach(() => { vi.resetModules() })
afterEach(() => {
  leave?.()
  leave = undefined
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('returning while a tool preview is pending', () => {
  it('cancels a replaced no-parameter rehearsal when its card is clicked again', async () => {
    const { content, pending, cancelToolPreview } = await setup({ ...action, params: [] })
    content.querySelector<HTMLButtonElement>('.tool-card')!.click()
    await flush()
    expect(cancelToolPreview).toHaveBeenCalledWith(pending[0].id)
    pending[0].resolve(success('superseded-preview'))
    await flush()
    expect(content.querySelector('[role="dialog"]')).toBeNull()
    pending[1].resolve(success('latest-preview'))
    await flush()
    expect(content.querySelector('[role="dialog"]')?.textContent).toContain('latest-preview')
    expect(content.querySelector('[role="dialog"]')?.textContent).not.toContain('superseded-preview')
  })
  it.each([
    ['success', success()],
    ['failure', { ok: false, error: '延迟失败' } as PreviewResult]
  ])('cancels the request and ignores a late %s result', async (_kind, result) => {
    const { content, pending, cancelToolPreview } = await setup()
    button(content, '返回').click()
    expect(cancelToolPreview).toHaveBeenCalledWith(pending[0].id)
    expect(content.querySelector('.tool-list')).not.toBeNull()
    pending[0].resolve(result)
    await flush()
    expect(content.querySelector('.tool-list')).not.toBeNull()
    expect(content.querySelector('[role="dialog"]')).toBeNull()
    expect(content.textContent).not.toContain('延迟失败')
  })

  it('does not let the cancelled request replace a newly requested preview', async () => {
    const { content, pending, cancelToolPreview } = await setup()
    button(content, '返回').click()
    content.querySelector<HTMLButtonElement>('.tool-card')!.click()
    await flush()
    button(content, '预览').click()
    await flush()
    expect(pending[1].id).not.toBe(pending[0].id)
    pending[0].resolve(success('old-preview'))
    await flush()
    expect(content.querySelector('[role="dialog"]')).toBeNull()
    expect(button(content, '正在预演').disabled).toBe(true)
    pending[1].resolve(success('current-preview'))
    await flush()
    expect(content.querySelector('[role="dialog"]')?.textContent).toContain('current-preview')
    expect(content.querySelector('[role="dialog"]')?.textContent).not.toContain('old-preview')
    expect(cancelToolPreview.mock.calls[0]).toEqual([pending[0].id])
  })
})
