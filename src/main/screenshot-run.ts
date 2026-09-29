import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { BrowserWindow, WebContents } from 'electron'
import type { ScreenshotScene } from './screenshot-scene.js'
import { MOCK_GITHUB_LOGIN, screenshotReadyText } from './screenshot-scene.js'
import { toolScreenshotExpectation } from './screenshot-tools.js'

async function waitUntil(contents: WebContents, predicateSource: string, label: string): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < 5000) {
    const seen = await contents.executeJavaScript(predicateSource)
    if (seen) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`screenshot scene did not reach ${label}`)
}

function includesText(expected: string): string {
  return `document.body.innerText.includes(${JSON.stringify(expected)})`
}

export async function presentScreenshot(options: {
  scene: ScreenshotScene
  main: BrowserWindow
  openCapture: () => BrowserWindow
  savedToast?: () => BrowserWindow | null
  file: string
  prepareMain?: (contents: WebContents) => Promise<void>
}): Promise<void> {
  const { scene, main, file } = options
  if (scene === 'invalid-token' || scene === 'connected') {
    await options.prepareMain?.(main.webContents)
  }

  let contents = main.webContents
  if (scene === 'capture-empty' || scene === 'capture-opened' || scene === 'capture-filled' || scene === 'capture-draft') {
    const capture = options.openCapture()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('capture window did not load')), 5000)
      capture.webContents.once('did-finish-load', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    contents = capture.webContents
    const focused = `document.activeElement === document.querySelector('#text')
      && document.querySelector('#caret')?.hidden === false`
    const expected = scene === 'capture-filled'
      ? `document.querySelector('#text').value === '记一条带仓库的待办'
        && document.querySelector('#repo').value === 'example/demo'
        && document.querySelector('#waiting').checked === true
        && ${focused}`
      : scene === 'capture-draft'
        ? `document.querySelector('#text').value === '把没写完的这半句留在'
          && document.querySelector('#repo').value === 'example/demo'
          && document.querySelector('#waiting').checked === true
          && document.querySelector('#text').selectionStart === document.querySelector('#text').value.length
          && ${focused}`
        : `document.body.innerText.includes('快速捕获')
          && document.querySelector('#text').value === ''
          && document.querySelector('#text').selectionStart === 0
          && ${focused}`
    await waitUntil(contents, expected, scene)
  } else if (scene === 'capture-saved') {
    const capture = options.openCapture()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('capture window did not load')), 5000)
      capture.webContents.once('did-finish-load', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    await capture.webContents.executeJavaScript(`
      document.querySelector('#text').value = '记一条待办'
      document.querySelector('#capture-form').requestSubmit()
      true
    `)
    const start = Date.now()
    let toast: BrowserWindow | null = null
    while (Date.now() - start < 5000) {
      toast = options.savedToast?.() ?? null
      if (toast && !toast.isDestroyed()) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (!toast || toast.isDestroyed()) throw new Error('已记下 toast did not open')
    contents = toast.webContents
    await waitUntil(contents, includesText('已记下'), '已记下')
  } else if (scene === 'todos' || scene === 'todos-narrow') {
    await waitUntil(contents, `
      document.body.innerText.includes('共 40 条')
      && document.body.innerText.includes('已完成 · 28')
      && document.querySelector('[data-action="completed-group"]')?.open === false
    `, '已完成分组')
    await contents.executeJavaScript(`
      document.querySelector('.todo-row')?.classList.add('is-hover')
      true
    `)
  } else if (scene === 'todos-empty') {
    await waitUntil(contents, includesText('还没有待办'), '还没有待办')
  } else if (scene === 'todos-filter') {
    await waitUntil(contents, includesText('共 40 条'), '共 40 条')
    await contents.executeJavaScript(`
      const select = document.querySelector('[data-action="repo-filter"]')
      select.value = 'example/demo'
      select.dispatchEvent(new Event('change'))
      true
    `)
    await waitUntil(contents, `
      document.body.innerText.includes('示例仓库待办')
      && document.body.innerText.includes('显示 8 条')
      && !document.body.innerText.includes('未标仓库的待办')
    `, 'repo filter')
  } else if (scene === 'hotkey-banner') {
    await waitUntil(contents, `
      document.body.innerText.includes('快速捕获热键 Ctrl+Alt+Space 被其他程序占用，现在按它不会有反应')
      && document.querySelector('#hotkey-banner-action')?.textContent === '换一个热键'
      && document.querySelector('#hotkey-banner')?.hidden === false
      && document.body.innerText.includes('等我处理')
    `, 'hotkey banner')
  } else if (scene === 'hotkey-save-conflict') {
    await waitUntil(contents, `document.querySelector('#hotkey-save') !== null`, 'hotkey save')
    const saved = await contents.executeJavaScript(`
      (() => {
        const input = document.querySelector('#hotkey-input')
        const save = document.querySelector('#hotkey-save')
        if (!(input instanceof HTMLInputElement) || !(save instanceof HTMLButtonElement)) {
          return 'missing input=' + (input && input.outerHTML) + ' save=' + (save && save.outerHTML)
        }
        input.value = 'Ctrl+Alt+K'
        save.click()
        return 'clicked'
      })()
    `)
    if (saved !== 'clicked') throw new Error(String(saved))
    await waitUntil(contents, `(() => {
      const conflict = document.querySelector('#hotkey-conflict')
      const scroller = document.querySelector('main')
      const input = document.querySelector('#hotkey-input')
      const rect = conflict && conflict.getBoundingClientRect()
      const banner = document.querySelector('#hotkey-banner')
      return Boolean(conflict && scroller && input instanceof HTMLInputElement && rect && banner
        && scroller.scrollTop === 0
        && rect.top >= 0
        && rect.bottom <= window.innerHeight
        && input.value === 'Ctrl+Alt+K'
        && document.querySelector('#hotkey-active')?.textContent === '当前生效：Ctrl+Alt+Space'
        && conflict.innerText.includes('Ctrl+Alt+K 已被其他程序占用')
        && document.querySelector('#hotkey-record')?.textContent === '录制'
        && document.querySelectorAll('#hotkey-conflict input').length === 0
        && !document.body.innerText.includes('改用这个')
        && banner.hidden === true
        && !document.body.innerText.includes('现在按它不会有反应'))
    })()`, 'inline hotkey conflict')
  } else if (scene === 'todos-delete') {
    await waitUntil(contents, includesText('共 40 条'), '共 40 条')
    await contents.executeJavaScript(`
      document.querySelector('[data-action="delete"]').click()
      true
    `)
    await waitUntil(contents, `
      document.body.innerText.includes('已删除')
      && document.querySelector('[data-action="undo-delete"]')?.textContent === '撤销'
      && document.querySelector('.modal-backdrop') === null
      && !document.body.innerText.includes('删除这条待办')
    `, '已删除 · 撤销')
  } else if (scene.startsWith('overview')) {
    await waitUntil(contents, includesText(screenshotReadyText(scene)), scene)
    if (scene === 'overview-archived') {
      await contents.executeJavaScript(`
        const details = document.querySelector('details.archived-group')
        if (details) details.open = true
        true
      `)
    }
    if (scene === 'overview' || scene === 'overview-narrow') {
      await contents.executeJavaScript(`
        const details = document.querySelector('details.stale-group')
        if (details) details.open = true
        true
      `)
    }
    if (scene === 'overview-chip-hover') {
      await contents.executeJavaScript(`
        const chip = document.querySelector('a.chip-link')
        if (!chip) throw new Error('warning chip was not rendered')
        chip.classList.add('is-hover')
        chip.focus()
        true
      `)
    }
  } else if (toolScreenshotExpectation(scene)) {
    await waitUntil(contents, includesText(toolScreenshotExpectation(scene) ?? ''), scene)
  } else if (scene === 'waiting-hover') {
    await waitUntil(contents, includesText('验收北区截图'), '验收北区截图')
    await contents.executeJavaScript(`
      const row = document.querySelector('.waiting-row')
      if (!row) throw new Error('waiting row was not rendered')
      row.classList.add('show-actions')
      const details = row.querySelector('details')
      if (details) details.open = true
      true
    `)
  } else if (
    scene === 'waiting'
    || scene === 'waiting-narrow'
    || scene === 'waiting-watch'
    || scene === 'waiting-hidden'
    || scene === 'waiting-family'
    || scene === 'waiting-empty'
    || scene === 'waiting-no-token'
    || scene === 'waiting-invalid-token'
    || scene === 'waiting-loading'
    || scene === 'waiting-rate-limit'
  ) {
    const expected = scene === 'waiting' || scene === 'waiting-narrow'
      ? '验收北区截图'
      : scene === 'waiting-watch'
        ? '不会把别人的 open PR'
        : scene === 'waiting-hidden'
          ? '已忽略的仓库'
          : scene === 'waiting-family'
            ? '含 2 个子项'
            : scene === 'waiting-empty'
              ? '没有等你处理的事项'
              : scene === 'waiting-no-token'
                ? '未配置 GitHub 认证'
                : scene === 'waiting-invalid-token'
                  ? 'GitHub 认证无效或已过期'
                  : scene === 'waiting-loading'
                    ? '正在刷新'
                    : '速率限制'
    await waitUntil(contents, includesText(expected), expected)
  } else {
    const expected = scene === 'connected'
      ? MOCK_GITHUB_LOGIN
      : scene === 'invalid-token'
        ? 'HTTP 401'
        : scene === 'signed-out'
          ? '未配置'
          : scene === 'hotkey-conflict'
            ? '已被其他程序占用'
            : '等我处理'
    await waitUntil(contents, includesText(expected), expected)
  }

  await new Promise(resolve => setTimeout(resolve, 150))
  const image = await contents.capturePage()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, image.toPNG())
}
