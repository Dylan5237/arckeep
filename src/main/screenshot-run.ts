import { execFileSync } from 'node:child_process'
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

function moveOsPointer(screenX: number, screenY: number): void {
  try {
    execFileSync('xdotool', ['mousemove', '--sync', String(screenX), String(screenY)], { stdio: 'ignore' })
  } catch {
    // Screenshot hosts without xdotool still get the synthetic move below.
  }
}

function movePointer(window: BrowserWindow, x: number, y: number): void {
  if (!window.isVisible()) window.show()
  window.focus()
  window.webContents.focus()
  const bounds = window.getContentBounds()
  moveOsPointer(bounds.x + x, bounds.y + y)
  window.webContents.sendInputEvent({ type: 'mouseMove', x, y })
}

async function pointAtWaitingRow(window: BrowserWindow, index: number, openIgnore: boolean): Promise<void> {
  const place = async (): Promise<{ x: number, y: number }> => window.webContents.executeJavaScript(`
    (() => {
      const rows = [...document.querySelectorAll('.waiting-row')]
      for (const row of rows) row.classList.remove('show-actions')
      const row = rows[${index}]
      if (!row) throw new Error('waiting row was not rendered')
      const box = row.getBoundingClientRect()
      if (${openIgnore ? 'true' : 'false'}) {
        const menu = row.querySelector('details.ignore')
        if (!(menu instanceof HTMLDetailsElement)) throw new Error('ignore menu was not rendered')
        menu.open = true
        const label = [...menu.querySelectorAll('button')].map(button => button.textContent ?? '').join('\\n')
        if (!label.includes('忽略这一条') || !label.includes('这个仓库')) throw new Error('ignore menu items missing')
        const wide = [...menu.querySelectorAll('button')].find(button => (button.textContent ?? '').includes('这个仓库'))
        if (!wide || wide.getClientRects().length !== 1 || wide.scrollWidth > wide.clientWidth + 1) {
          throw new Error('ignore menu item wrapped')
        }
      }
      return { x: Math.round(box.x + Math.min(160, box.width / 3)), y: Math.round(box.y + box.height / 2) }
    })()
  `)
  await window.webContents.executeJavaScript(`document.querySelectorAll('.waiting-row')[${index}]?.scrollIntoView({ block: 'center' })`)
  const point = await place()
  movePointer(window, point.x, point.y)
  await new Promise(resolve => setTimeout(resolve, 60))
  const moved = await place()
  movePointer(window, moved.x, moved.y)
  await new Promise(resolve => setTimeout(resolve, 60))
  const visible = await window.webContents.executeJavaScript(`
    [...document.querySelectorAll('.waiting-row')].filter(row => {
      if (row.classList.contains('is-ignored')) return false
      const actions = row.querySelector('.row-actions')
      return Boolean(actions) && getComputedStyle(actions).opacity !== '0'
    }).length
  `)
  if (visible !== 1) throw new Error(`expected one row of actions, saw ${visible}`)
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
    await waitUntil(contents, includesText('共 40 条'), '共 40 条')
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
        && banner.hidden === false
        && banner.innerText.includes('快速捕获热键 Ctrl+Alt+K 被其他程序占用，现在按它不会有反应'))
    })()`, 'inline hotkey conflict')
  } else if (scene === 'todos-delete') {
    await waitUntil(contents, includesText('共 40 条'), '共 40 条')
    await contents.executeJavaScript(`
      document.querySelector('[data-action="delete"]').click()
      true
    `)
    await waitUntil(contents, includesText('删除这条待办？'), '删除这条待办？')
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
    if (scene === 'overview-settings') {
      await contents.executeJavaScript(`
        document.querySelector('#overview-settings')?.scrollIntoView({ block: 'start' })
        true
      `)
      await waitUntil(contents, `(() => {
        const card = document.querySelector('#overview-settings')
        if (!card) return false
        const text = card.innerText
        const rect = card.getBoundingClientRect()
        return text.includes('默认 7 天')
          && text.includes('默认 30 天')
          && text.includes('没有单独的最近推送窗口')
          && !text.includes('推送窗口天数')
          && !card.querySelector('[aria-label*="推送"]')
          && rect.top >= -2
          && rect.top < 120
          && rect.bottom > 400
          && rect.bottom <= window.innerHeight
      })()`, 'overview settings')
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
    const leaked = await contents.executeJavaScript(`document.body.innerText.includes('LASTEXITCODE')`)
    if (leaked) throw new Error(`screenshot scene ${scene} showed a shell exit wrapper`)
  } else if (scene === 'waiting-hover' || scene === 'waiting-ignore') {
    await waitUntil(contents, includesText('验收北区截图'), '验收北区截图')
    await pointAtWaitingRow(main, scene === 'waiting-hover' ? 8 : 0, scene === 'waiting-ignore')
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
        ? '指派给你的那一条'
        : scene === 'waiting-hidden'
          ? '另有 4 条已延后或已忽略'
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
    movePointer(main, 24, 80)
    await new Promise(resolve => setTimeout(resolve, 120))
    if (scene !== 'waiting-empty' && scene !== 'waiting-no-token' && scene !== 'waiting-invalid-token' && scene !== 'waiting-loading') {
      const stray = async (): Promise<number> => contents.executeJavaScript(`
        [...document.querySelectorAll('.waiting-row')].filter(row => {
          if (row.classList.contains('is-ignored')) return false
          const actions = row.querySelector('.row-actions')
          return Boolean(actions) && getComputedStyle(actions).opacity !== '0'
        }).length
      `)
      if (await stray() !== 0) {
        moveOsPointer(0, 0)
        await new Promise(resolve => setTimeout(resolve, 120))
      }
      const still = await stray()
      if (still !== 0) throw new Error(`actions visible without hover: ${still}`)
    }
    if (scene === 'waiting-hidden') {
      const matched = await contents.executeJavaScript(`
        (() => {
          const hint = document.body.innerText.match(/另有 (\\d+) 条已延后或已忽略/)
          const count = hint ? Number(hint[1]) : -1
          const faded = document.querySelectorAll('.waiting-row.is-ignored').length
          const restores = [...document.querySelectorAll('.waiting-row.is-ignored button')].filter(button => button.textContent === '恢复').length
          const todo = [...document.querySelectorAll('.waiting-row.is-ignored')].some(row => row.textContent.includes('待办') && row.textContent.includes('恢复'))
          return count === faded && restores === count && count > 0 && todo
        })()
      `)
      if (!matched) throw new Error('ignored rows did not match the hidden count')
    }
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
