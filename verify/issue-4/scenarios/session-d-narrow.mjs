// Session D：窄窗口（800x600、640x600）下待办页/快速捕获/横幅不溢出、不遮挡按钮
// 覆盖 checklist: E3
import * as lib from '../lib.mjs'

const {
  setResult, launchApp, mainWindowPage, captureWindowPage, quitApp, killStrayArckeep,
  getUserDataDir, resetUserData, callTestHook, sendHotkey, sendText, sendKey, sleep,
  windowContentBounds, shot, appendEvidenceJson
} = lib

async function setMainWindowSize(app, page, width, height) {
  const handle = await app.browserWindow(page)
  await handle.evaluate((win, size) => win.setContentSize(size.width, size.height), { width, height })
  await page.waitForTimeout(200)
}

async function overflowCheck(page) {
  return page.evaluate(() => {
    const doc = document.documentElement
    const overflowX = doc.scrollWidth > doc.clientWidth + 1
    const buttons = [...document.querySelectorAll('button')]
    // 只关心横向溢出（按钮被裁到看不见/点不到）；纵向可以滚动，不算问题。
    const offscreen = buttons.filter(btn => {
      const r = btn.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && (r.right > doc.clientWidth + 1 || r.left < -1)
    }).map(btn => btn.textContent?.trim())
    return { overflowX, offscreenButtons: offscreen, scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth }
  })
}

export async function run() {
  killStrayArckeep()
  let app = await launchApp({ label: 'D-bootstrap' })
  const userDataDir = await getUserDataDir(app)
  await quitApp(app)
  resetUserData(userDataDir)

  try {
    app = await launchApp({ label: 'D-narrow' })
    let page = await mainWindowPage(app, { timeoutMs: 15000 })

    // 造一点待办数据，让待办页/等我处理不是空状态
    await callTestHook(app, 'close')
    await sleep(250)
    sendHotkey('Ctrl+Alt+Space')
    await captureWindowPage(app, { timeoutMs: 5000 })
    sendText('窄窗口测试待办 #example/demo')
    await sleep(150)
    sendKey('Return')
    await sleep(800)
    await callTestHook(app, 'show')
    page = await mainWindowPage(app)

    const sizes = [{ width: 800, height: 600 }, { width: 640, height: 600 }]
    const report = []
    for (const size of sizes) {
      await setMainWindowSize(app, page, size.width, size.height)
      const bounds = await windowContentBounds(app, page)

      await page.click('[data-view="todos"]')
      await page.waitForSelector('.todo-list, .empty-todos', { timeout: 3000 })
      const todosCheck = await overflowCheck(page)
      await shot(page, `50-narrow-${size.width}x${size.height}-todos`, { checkIds: ['E3'], description: `窄窗口 ${size.width}x${size.height}：待办页` })

      await page.click('[data-view="inbox"]')
      await page.waitForTimeout(500)
      const waitingCheck = await overflowCheck(page)
      await shot(page, `51-narrow-${size.width}x${size.height}-waiting`, { checkIds: ['E3'], description: `窄窗口 ${size.width}x${size.height}：等我处理` })

      await page.click('[data-view="settings"]')
      await page.waitForSelector('#hotkey-input', { timeout: 3000 })
      const settingsCheck = await overflowCheck(page)
      await shot(page, `52-narrow-${size.width}x${size.height}-settings`, { checkIds: ['E3'], description: `窄窗口 ${size.width}x${size.height}：设置页（含热键卡片）` })

      report.push({ size, bounds, todosCheck, waitingCheck, settingsCheck })
    }

    // 快速捕获窗口本身是固定尺寸（460x348，resizable:false），不会随主窗口变化；
    // 检查它在自身固定尺寸下没有横向溢出即可。
    await setMainWindowSize(app, page, 1120, 760)
    await callTestHook(app, 'close')
    await sleep(250)
    sendHotkey('Ctrl+Alt+Space')
    const cap = await captureWindowPage(app, { timeoutMs: 5000 })
    const captureCheck = await overflowCheck(cap)
    await shot(cap, '53-capture-fixed-size', { checkIds: ['E3'], description: '快速捕获窗口固定 460x348，本身不会因主窗口变窄而受影响' })
    sendKey('Escape')
    await sleep(300)
    await callTestHook(app, 'show')

    appendEvidenceJson('e3-narrow-report', { report, captureCheck })

    const ok = report.every(r => !r.todosCheck.overflowX && r.todosCheck.offscreenButtons.length === 0
      && !r.waitingCheck.overflowX && r.waitingCheck.offscreenButtons.length === 0
      && !r.settingsCheck.overflowX && r.settingsCheck.offscreenButtons.length === 0)
      && !captureCheck.overflowX

    setResult('E3', ok ? 'PASS' : 'FAIL', {
      evidence: sizes.flatMap(s => [`50-narrow-${s.width}x${s.height}-todos.png`, `51-narrow-${s.width}x${s.height}-waiting.png`, `52-narrow-${s.width}x${s.height}-settings.png`]).concat(['53-capture-fixed-size.png', 'e3-narrow-report.json']),
      steps: '用真实 BrowserWindow.setContentSize 把主窗口分别改成 800x600 和 640x600，逐一切到待办页/等我处理/设置页截图，并用 scrollWidth/clientWidth 和按钮 getBoundingClientRect() 核对没有横向溢出、没有按钮跑出可视区；另外确认快速捕获窗口是固定 460x348（resizable:false），不受主窗口宽度影响',
      notes: JSON.stringify(report.map(r => ({ size: r.size, todosOverflow: r.todosCheck.overflowX, todosOffscreen: r.todosCheck.offscreenButtons, waitingOverflow: r.waitingCheck.overflowX, waitingOffscreen: r.waitingCheck.offscreenButtons, settingsOverflow: r.settingsCheck.overflowX, settingsOffscreen: r.settingsCheck.offscreenButtons })))
    })
  } catch (err) {
    setResult('E3', 'FAIL', { notes: `异常：${err.stack || err}` })
  } finally {
    try { await quitApp(app) } catch { /* ignore */ }
  }
}
