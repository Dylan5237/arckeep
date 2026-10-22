// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArckeepApi } from '../src/shared/types.js'

const mocks = vi.hoisted(() => ({
  waiting: vi.fn(),
  todos: vi.fn(),
  overview: vi.fn(async (host: HTMLElement) => { host.textContent = '项目总览页面' }),
  ideas: vi.fn(async (host: HTMLElement) => { host.textContent = '灵感页面' }),
  deactivateIdeas: vi.fn()
}))
vi.mock('../src/renderer/waiting-page', () => ({ renderWaiting: mocks.waiting }))
vi.mock('../src/renderer/todos-page', () => ({ renderTodos: mocks.todos }))
vi.mock('../src/renderer/overview-page', () => ({ renderOverview: mocks.overview }))
vi.mock('../src/renderer/ideas-page', () => ({ renderIdeas: mocks.ideas, deactivateIdeas: mocks.deactivateIdeas }))

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

async function mount(getState?: ArckeepApi['getState']): Promise<HTMLElement> {
  vi.resetModules()
  document.body.innerHTML = `<nav><button data-view="inbox">等我处理</button><button data-view="projects">项目总览</button><button data-view="todos">待办</button><button data-view="ideas">灵感</button></nav><main id="content"></main>`
  window.arckeep = {
    getState: getState ?? (async () => ({ hotkeyUnavailable: null })),
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

describe('ideas navigation', () => {
  it('opens both GitHub pages before a slow authentication status lookup completes', async () => {
    mocks.waiting.mockImplementation(async (host: HTMLElement) => { host.textContent = '等我处理页面' })
    const content = await mount(() => new Promise(() => {}))
    expect(content.textContent).toBe('等我处理页面')
    open('projects')
    await flush()
    expect(content.textContent).toBe('项目总览页面')
  })

  it('keeps the ideas page when a previous waiting refresh finishes late', async () => {
    let finish!: () => void
    mocks.waiting.mockImplementation((host: HTMLElement) => new Promise<void>(resolve => {
      finish = () => { host.textContent = '旧的等我处理结果'; resolve() }
    }))
    const content = await mount()
    open('ideas')
    await flush()
    expect(content.textContent).toBe('灵感页面')
    finish()
    await flush()
    expect(content.textContent).toBe('灵感页面')
    expect(document.querySelector('[data-view="ideas"]')?.classList.contains('active')).toBe(true)
  })

  it('disposes a late todo page without replacing ideas or its lifecycle', async () => {
    mocks.waiting.mockResolvedValue(undefined)
    let finish!: () => void
    const leave = vi.fn()
    mocks.todos.mockImplementation((host: HTMLElement) => new Promise<() => void>(resolve => {
      finish = () => { host.textContent = '旧的待办结果'; resolve(leave) }
    }))
    const content = await mount()
    open('todos')
    await flush()
    open('ideas')
    await flush()
    finish()
    await flush()
    expect(content.textContent).toBe('灵感页面')
    expect(leave).toHaveBeenCalledTimes(1)
  })
})
