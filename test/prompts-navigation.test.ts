// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArckeepApi } from '../src/shared/types.js'

const mocks = vi.hoisted(() => ({
  waiting: vi.fn(),
  prompts: vi.fn(async (host: HTMLElement) => { host.textContent = '提示词库页面' }),
  deactivatePrompts: vi.fn()
}))
vi.mock('../src/renderer/waiting-page', () => ({ renderWaiting: mocks.waiting }))
vi.mock('../src/renderer/prompts-page', () => ({ renderPrompts: mocks.prompts, deactivatePrompts: mocks.deactivatePrompts }))

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}

async function mount(): Promise<HTMLElement> {
  vi.resetModules()
  document.body.innerHTML = '<nav><button data-view="inbox">等我处理</button><button data-view="prompts">提示词库</button></nav><main id="content"></main>'
  window.arckeep = {
    getState: () => new Promise(() => {}),
    onHotkeyStatus: () => () => {},
    onFocusHotkey: () => () => {}
  } as unknown as ArckeepApi
  await import('../src/renderer/main.ts')
  await flush()
  return document.querySelector<HTMLElement>('#content')!
}

function open(view: string): void {
  document.querySelector<HTMLButtonElement>(`[data-view="${view}"]`)!.click()
}

afterEach(() => {
  document.body.replaceChildren()
  vi.clearAllMocks()
})

describe('prompt library navigation', () => {
  it('opens immediately while GitHub authentication and a previous page request are pending', async () => {
    let finishWaiting!: () => void
    mocks.waiting.mockImplementation((host: HTMLElement) => new Promise<void>(resolve => {
      finishWaiting = () => { host.textContent = '旧的网络结果'; resolve() }
    }))
    const content = await mount()
    open('prompts')
    await flush()
    expect(content.textContent).toBe('提示词库页面')
    finishWaiting()
    await flush()
    expect(content.textContent).toBe('提示词库页面')
    expect(document.querySelector('[data-view="prompts"]')?.classList.contains('active')).toBe(true)
  })

  it('deactivates prompt listeners on navigation to another module', async () => {
    mocks.waiting.mockImplementation(async (host: HTMLElement) => { host.textContent = '等我处理页面' })
    const content = await mount()
    open('prompts')
    await flush()
    mocks.deactivatePrompts.mockClear()
    open('inbox')
    await flush()
    expect(mocks.deactivatePrompts).toHaveBeenCalledOnce()
    expect(content.textContent).toBe('等我处理页面')
  })
})
