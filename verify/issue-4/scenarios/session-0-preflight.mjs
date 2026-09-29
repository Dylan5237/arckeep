// 独立预检：在跑完整 5 个 Session（可能耗时接近 1 小时）之前，先快速（<30s）确认
// 「SendInput 能不能真的送达一个已知聚焦的窗口」以及「全局热键的真实按键触发能不能生效」，
// 两者分开测，方便区分「环境层 SendInput 根本没送达」还是「产品的全局热键注册/响应有问题」。
// 结果只写 evidence/preflight.json，不计入 22 项检查结论。
import * as lib from '../lib.mjs'

const {
  launchApp, mainWindowPage, captureWindowPage, callTestHook,
  sendHotkey, sendText, sendKey, foreground,
  waitFor, sleep, quitApp, killStrayArckeep, writeJson
} = lib

export async function run() {
  killStrayArckeep()
  const out = { testHookOpenCapture: null, sendInputToFocusedWindow: null, realHotkeyOpensCapture: null }

  let app = null
  try {
    app = await launchApp({ label: 'preflight' })
    await mainWindowPage(app)

    // ---- 测试 A：用测试钩子（绕开全局热键）打开捕获框，确认 SendInput 能不能送达一个明确已聚焦的窗口 ----
    try {
      await callTestHook(app, 'capture')
      const cap = await captureWindowPage(app, { timeoutMs: 5000 })
      await cap.waitForFunction(() => document.activeElement && document.activeElement.id === 'text', null, { timeout: 3000 }).catch(() => {})
      out.testHookOpenCapture = { ok: true }

      const probeText = 'preflight-探测文本'
      let sendErr = null
      try { sendText(probeText) } catch (err) { sendErr = String(err) }
      await sleep(200)
      const domValue = await cap.evaluate(() => document.querySelector('#text')?.value).catch(() => null)
      out.sendInputToFocusedWindow = {
        ok: domValue === probeText,
        domValue,
        expected: probeText,
        sendTextThrew: sendErr
      }
      try { sendKey('Escape') } catch { /* ignore cleanup errors */ }
      await sleep(300)
    } catch (err) {
      out.testHookOpenCapture = { ok: false, error: String(err.stack || err) }
    }

    await callTestHook(app, 'show').catch(() => {})
  } catch (err) {
    out.bootstrapError = String(err.stack || err)
  } finally {
    if (app) await quitApp(app).catch(() => {})
  }

  // ---- 测试 B：真实全局热键（隐藏主窗口到托盘后，真实 SendInput 发默认组合），短超时快速出结论 ----
  killStrayArckeep()
  app = null
  try {
    app = await launchApp({ label: 'preflight-hotkey' })
    await mainWindowPage(app)
    await callTestHook(app, 'close')
    await sleep(400)
    const fgBefore = foreground()
    let sendErr = null
    let sendResult = null
    try { sendResult = sendHotkey('Ctrl+Alt+Space') } catch (err) { sendErr = String(err) }
    const found = await waitFor(async () => {
      for (const w of app.windows()) {
        const ok = await w.evaluate(() => !!document.querySelector('#capture-form')).catch(() => false)
        if (ok) return w
      }
      return null
    }, { timeoutMs: 5000, intervalMs: 50 })
    const fgAfter = foreground()
    out.realHotkeyOpensCapture = {
      ok: found.ok,
      elapsedMs: found.elapsedMs,
      sendResult,
      sendHotkeyThrew: sendErr,
      fgBefore,
      fgAfter,
      windowCountAfter: app.windows().length
    }
  } catch (err) {
    out.realHotkeyOpensCapture = { ok: false, error: String(err.stack || err) }
  } finally {
    if (app) await quitApp(app).catch(() => {})
  }

  killStrayArckeep()
  writeJson('preflight.json', out)
  console.log('\n===== PREFLIGHT 结果 =====')
  console.log(JSON.stringify(out, null, 2).slice(0, 4000))
  return out
}
