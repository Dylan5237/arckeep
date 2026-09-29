// Session A：主流程（热键 + 快速捕获 + 待办 CRUD + 简写 + 等我处理）
// 覆盖 checklist: 1, 2, 3, 4, 5, 6, 8, A1, A2, A3
//
// 注意：本文件针对被测 SHA 0734791（PR #12 + 设计评审 PR #18）编写。
// Item 5 的删除流程已按 #18 的新行为（立即删除 + 「已删除 · 撤销」，不再弹确认框）
// 改写；「撤销后原样恢复 + jsonl 核对」「删除提示停留时长」的完整验证见 R3
// （scenarios/session-e-review.mjs），Item 5 这里只验证「不确认框 + 不撤销 + 重启后仍消失」。
import fs from 'node:fs'
import path from 'node:path'
import * as lib from '../lib.mjs'

const {
  setResult, mergeNotes, logEvidence, EVIDENCE_DIR,
  launchApp, mainWindowPage, captureWindowPage,
  callTestHook, getAppState, quitApp, killStrayArckeep,
  startNotepad, sendHotkey, sendKey, sendText, foreground,
  fullShot, shot, waitFor, sleep, getUserDataDir, resetUserData, todosFile,
  appendEvidenceJson, writeJson
} = lib

async function ensureCaptureFocusedText(app) {
  const cap = await captureWindowPage(app)
  await cap.waitForFunction(() => document.activeElement && document.activeElement.id === 'text', null, { timeout: 3000 })
  return cap
}

async function waitToastLifecycle(app, { timeoutMs = 4000 } = {}) {
  const appearStart = Date.now()
  const appeared = await waitFor(async () => {
    for (const w of app.windows()) {
      const isToast = await w.evaluate(() => document.title === '已记下').catch(() => false)
      if (isToast) return w
    }
    return null
  }, { timeoutMs, intervalMs: 20 })
  if (!appeared.ok) return { appeared: false }
  const appearMs = Date.now() - appearStart
  const toastWin = appeared.value
  const disappearStart = Date.now()
  const disappeared = await waitFor(async () => {
    try { await toastWin.evaluate(() => document.title) } catch { return true }
    return toastWin.isClosed?.() ?? false
  }, { timeoutMs: 3000, intervalMs: 20 })
  const disappearMs = disappeared.ok ? Date.now() - disappearStart : null
  return { appeared: true, appearMs, disappearMs, toastWin }
}

export async function run() {
  killStrayArckeep()

  // ---- bootstrap: 探测 userData 目录并清空，保证是干净现场 ----
  let app = await launchApp({ label: 'A-bootstrap' })
  const userDataDir = await getUserDataDir(app)
  console.log('[session-a] userDataDir =', userDataDir)
  await quitApp(app)
  resetUserData(userDataDir)
  writeJson('session-a-userdata-path.json', { userDataDir })

  app = await launchApp({ label: 'A-main' })
  let page = await mainWindowPage(app)

  // =====================================================================
  // Item 1 + A1：托盘中按热键，记事本在前台，捕获框 1 秒内出现并获得焦点
  // =====================================================================
  try {
    await callTestHook(app, 'close') // 等价于点主窗口关闭按钮：隐藏到托盘（真实关闭按钮走的同一个 handler）
    startNotepad()
    await sleep(900)
    let fg = foreground()
    if (fg.processName?.toLowerCase() !== 'notepad') {
      // 兜底：再等一会儿，记事本窗口有时需要时间创建
      await sleep(600)
      fg = foreground()
    }
    logEvidence('item1-before-foreground.json', 'Ctrl+Alt+Space 之前的前台窗口（应为 notepad）', ['1'])
    appendEvidenceJson('item1-before-foreground', fg)
    fullShot('01-before-hotkey', { checkIds: ['1'], description: '按热键前：记事本在前台，Arckeep 只剩托盘' })

    const t0 = Date.now()
    const sendResult = sendHotkey('Ctrl+Alt+Space')
    const visible = await waitFor(async () => {
      const wins = app.windows()
      for (const w of wins) {
        const ok = await w.evaluate(() => {
          const hasForm = !!document.querySelector('#capture-form')
          const focused = document.hasFocus && document.hasFocus()
          return hasForm && focused
        }).catch(() => false)
        if (ok) return w
      }
      return null
    }, { timeoutMs: 3000, intervalMs: 15 })
    const jsVisibleMs = Date.now() - t0

    let osForeground = null
    if (visible.ok) {
      osForeground = foreground()
    }
    const withinOneSecond = visible.ok && jsVisibleMs <= 1000 && osForeground?.processName?.toLowerCase() === 'arckeep'

    fullShot('02-after-hotkey', { checkIds: ['1', 'A1'], description: `按 Ctrl+Alt+Space 后 ${jsVisibleMs}ms：捕获框应已在前台并获得焦点` })
    if (visible.ok) await shot(visible.value, '02-capture-window', { checkIds: ['1', 'A1'], description: '捕获框窗口截图（focus 检测通过后）' })

    appendEvidenceJson('item1-timing', { jsVisibleMs, sendResult, osForeground })

    if (visible.ok) {
      const cap = visible.value
      const hasTextFocus = await cap.evaluate(() => document.activeElement?.id === 'text').catch(() => false)
      setResult('1', withinOneSecond ? 'PASS' : 'FAIL', {
        evidence: ['01-before-hotkey-full.png', '02-after-hotkey-full.png', '02-capture-window.png', 'item1-timing.json', 'item1-before-foreground.json'],
        steps: '1) test-hook close 隐藏主窗口到托盘 2) 启动记事本并确认前台 3) PowerShell SendInput 真实发送 Ctrl+Alt+Space 4) 轮询 DOM+GetForegroundWindow 确认捕获框成为前台并有焦点',
        notes: `捕获框在 ${jsVisibleMs}ms 内${visible.ok ? '' : '未'}可见且获得焦点；GetForegroundWindow 进程=${osForeground?.processName}，标题=${osForeground?.title}`
      })
      setResult('A1', hasTextFocus ? 'PASS' : 'FAIL', {
        evidence: ['02-capture-window.png'],
        steps: '同上；随后直接检查 document.activeElement 是否为 #text 输入框',
        notes: `按热键后 document.activeElement.id === 'text' : ${hasTextFocus}（尚未点击，直接检测焦点）`
      })
    } else {
      setResult('1', 'FAIL', { evidence: ['01-before-hotkey-full.png', '02-after-hotkey-full.png'], notes: `${jsVisibleMs}ms 内未观察到捕获框可见+focus` })
      setResult('A1', 'BLOCKED', { notes: '捕获框未出现，无法检测输入焦点' })
    }
  } catch (err) {
    setResult('1', 'BLOCKED', { notes: `异常：${err.stack || err}` })
    setResult('A1', 'BLOCKED', { notes: `异常：${err.stack || err}` })
  }

  // =====================================================================
  // A1 continued：直接打字（真实 SendInput），Enter 保存并关闭，出现「已记下」约 1s 后消失
  // =====================================================================
  try {
    const cap = await captureWindowPage(app)
    const text1 = 'A1真实按键记一条'
    sendText(text1)
    await sleep(150)
    const domText = await cap.evaluate(() => document.querySelector('#text').value)
    await shot(cap, '03-a1-typed', { checkIds: ['A1'], description: 'SendInput 真实按键打字后，输入框内容' })

    const enterAt = Date.now()
    sendKey('Return')
    const toastResult = await waitToastLifecycle(app)
    if (toastResult.appeared) {
      await shot(toastResult.toastWin, '04-a1-saved-toast', { checkIds: ['A1'], description: '「已记下」提示出现（独立无边框 BrowserWindow，屏幕右下角）' })
      fullShot('04-a1-saved-toast', { checkIds: ['A1'], description: '「已记下」提示出现（全屏，右下角）' })
    }
    appendEvidenceJson('a1-toast-timing', { enterAt, ...toastResult, toastWin: undefined })

    const closed = await waitFor(async () => {
      for (const w of app.windows()) {
        const isCap = await w.evaluate(() => !!document.querySelector('#capture-form')).catch(() => false)
        if (isCap) return false
      }
      return true
    }, { timeoutMs: 2000 })

    const ok = domText === text1 && toastResult.appeared && toastResult.appearMs < 1200
      && toastResult.disappearMs !== null && toastResult.disappearMs > 500 && toastResult.disappearMs < 2500
      && closed.ok
    setResult('A1', ok ? 'PASS' : 'FAIL', {
      evidence: ['02-capture-window.png', '03-a1-typed.png', '04-a1-saved-toast.png', '04-a1-saved-toast-full.png', 'a1-toast-timing.json'],
      steps: '热键打开后不点击，直接 SendInput 输入真实字符 -> DOM 显示一致 -> SendInput 发 Enter -> 捕获窗口关闭 -> 出现「已记下」toast -> 约 1s 后自动消失',
      notes: `打字后 DOM 值="${domText}"；toast 出现耗时 ${toastResult.appearMs}ms，停留 ${toastResult.disappearMs}ms；窗口是否已关闭=${closed.ok}；「已记下」toast 是一个独立无边框 BrowserWindow（showSavedToast，SAVED_TOAST_MS=1000ms），出现在主屏幕工作区右下角`
    })
  } catch (err) {
    setResult('A1', 'FAIL', { notes: `A1 后半段异常：${err.stack || err}` })
  }

  // =====================================================================
  // Item 2（前半）：Enter 保存后待办页出现这一条
  // =====================================================================
  try {
    await callTestHook(app, 'show')
    page = await mainWindowPage(app)
    await page.click('[data-view="todos"]')
    await page.waitForSelector('.todo-list, .empty-todos', { timeout: 3000 })
    const texts = await page.$$eval('.todo-text', els => els.map(e => e.textContent))
    await shot(page, '05-todos-after-enter', { checkIds: ['2'], description: '待办页：Enter 保存的这一条已出现' })
    const found = texts.includes('A1真实按键记一条')
    setResult('2', found ? 'PASS' : 'FAIL', {
      evidence: ['05-todos-after-enter.png'],
      steps: '在快速捕获里 Enter 保存后，打开待办页确认该条存在（Esc 不新增待办的验证见下方「热键改键」与 A3/8 场景）',
      notes: `待办页当前文本：${JSON.stringify(texts)}`
    })
  } catch (err) {
    setResult('2', 'FAIL', { notes: `异常：${err.stack || err}` })
  }

  // =====================================================================
  // Item 3：设置里换热键，新组合生效、旧组合失效（真实按键测两个组合），重启后仍是新组合
  // =====================================================================
  try {
    await page.click('[data-view="settings"]')
    await page.waitForSelector('#hotkey-input', { timeout: 3000 })
    await page.fill('#hotkey-input', 'Ctrl+Alt+J')
    await page.click('#hotkey-save')
    await page.waitForTimeout(300)
    let state = await getAppState(page)
    const savedOk = state.activeHotkey === 'Ctrl+Alt+J' && !state.hotkeyWarning
    await shot(page, '06-hotkey-changed', { checkIds: ['3'], description: '设置页：热键已改为 Ctrl+Alt+J' })

    // 新组合：真按键应生效
    await callTestHook(app, 'close')
    await sleep(300)
    sendHotkey('Ctrl+Alt+J')
    const newOpened = await waitFor(async () => {
      for (const w of app.windows()) {
        const ok = await w.evaluate(() => !!document.querySelector('#capture-form')).catch(() => false)
        if (ok) return w
      }
      return null
    }, { timeoutMs: 3000, intervalMs: 30 })
    if (newOpened.ok) {
      await shot(newOpened.value, '07-new-combo-opens', { checkIds: ['3'], description: 'Ctrl+Alt+J 真实按键打开捕获框' })
      sendKey('Escape')
      await sleep(300)
    }

    // 旧组合：真按键应失效
    sendHotkey('Ctrl+Alt+Space')
    await sleep(500)
    const oldStillClosed = !(await Promise.all(app.windows().map(w => w.evaluate(() => !!document.querySelector('#capture-form')).catch(() => false)))).some(Boolean)
    fullShot('08-old-combo-no-effect', { checkIds: ['3'], description: '旧组合 Ctrl+Alt+Space 按下后无反应（截图时应仍是记事本前台，没有捕获框弹出）' })

    // 重启后仍是新组合
    await quitApp(app)
    app = await launchApp({ label: 'A-after-rebind' })
    page = await mainWindowPage(app)
    state = await getAppState(page)
    const persisted = state.hotkey === 'Ctrl+Alt+J' && state.activeHotkey === 'Ctrl+Alt+J'

    await callTestHook(app, 'close')
    await sleep(300)
    sendHotkey('Ctrl+Alt+J')
    const afterRestartOpened = await waitFor(async () => {
      for (const w of app.windows()) {
        const ok = await w.evaluate(() => !!document.querySelector('#capture-form')).catch(() => false)
        if (ok) return w
      }
      return null
    }, { timeoutMs: 3000, intervalMs: 30 })
    if (afterRestartOpened.ok) {
      await shot(afterRestartOpened.value, '09-new-combo-after-restart', { checkIds: ['3'], description: '重启后 Ctrl+Alt+J 仍能真实唤出捕获框' })
      sendKey('Escape')
      await sleep(300)
    }
    await callTestHook(app, 'show')
    page = await mainWindowPage(app)

    const ok = savedOk && newOpened.ok && oldStillClosed && persisted && afterRestartOpened.ok
    setResult('3', ok ? 'PASS' : 'FAIL', {
      evidence: ['06-hotkey-changed.png', '07-new-combo-opens.png', '08-old-combo-no-effect-full.png', '09-new-combo-after-restart.png'],
      steps: '设置页填 Ctrl+Alt+J 保存 -> 真实 SendInput 发 Ctrl+Alt+J（生效）-> 真实 SendInput 发 Ctrl+Alt+Space（旧组合，应无反应）-> quit 重启 -> 读取设置确认仍是 Ctrl+Alt+J -> 再次真实按键确认仍生效',
      notes: `保存成功=${savedOk}; 新组合真实按键生效=${newOpened.ok}; 旧组合真实按键已失效=${oldStillClosed}; 重启后设置仍为新组合=${persisted}; 重启后新组合仍生效=${afterRestartOpened.ok}`
    })
  } catch (err) {
    setResult('3', 'FAIL', { notes: `异常：${err.stack || err}` })
  }

  // =====================================================================
  // Item 8 + A3：草稿在 Esc/点外面 时保存、热键恢复；清空后 Esc 清掉草稿不再恢复；退出重启后仍能恢复
  // =====================================================================
  try {
    const countBefore = (await page.evaluate(() => window.arckeep.listTodos())).length

    // A3 case 1：输入后 Esc -> 存草稿 -> 再次热键 -> 原样恢复（进程内，未重启）
    await callTestHook(app, 'close')
    await sleep(250)
    sendHotkey('Ctrl+Alt+J')
    let cap = await ensureCaptureFocusedText(app)
    const draftText1 = 'Esc应该存成草稿'
    sendText(draftText1)
    await sleep(150)
    sendKey('Escape')
    await sleep(300)
    const draftAfterEsc = await page.evaluate(() => window.arckeep.getCaptureDraft())
    await callTestHook(app, 'close')
    await sleep(250)
    sendHotkey('Ctrl+Alt+J')
    cap = await ensureCaptureFocusedText(app)
    await sleep(150)
    const restoredValue = await cap.evaluate(() => document.querySelector('#text').value)
    await shot(cap, '10-draft-restored', { checkIds: ['A3', '8'], description: 'Esc 存草稿后再次按热键，原样恢复' })

    // Item 2 后半：Esc 不新增待办
    const countAfterEscRestore = (await page.evaluate(() => window.arckeep.listTodos())).length
    const escDidNotCreateTodo = countAfterEscRestore === countBefore

    // A3 case 2：点窗口外面（记事本）失焦 -> 也应存草稿
    let clickOutsideOk = false
    try {
      sendKey('Escape') // 先清掉这一份，重新开一份用于点外面测试，避免重复解释
      await sleep(300)
      sendHotkey('Ctrl+Alt+J')
      cap = await ensureCaptureFocusedText(app)
      const draftText2 = '点外面也该存草稿'
      sendText(draftText2)
      await sleep(150)
      // 把记事本切回前台，等价于「点到窗口外面」，捕获框失焦
      startNotepad()
      await sleep(500)
      let fg = foreground()
      if (fg.processName?.toLowerCase() !== 'notepad') { await sleep(600); fg = foreground() }
      await sleep(500) // 等主进程里的 200ms blur 计时器把窗口关掉
      const capStillOpen = await Promise.all(app.windows().map(w => w.evaluate(() => !!document.querySelector('#capture-form')).catch(() => false)))
      const draftAfterBlur = await page.evaluate(() => window.arckeep.getCaptureDraft())
      clickOutsideOk = !capStillOpen.some(Boolean) && draftAfterBlur.text === draftText2
      fullShot('11-blur-outside-draft', { checkIds: ['A3'], description: '捕获框失焦（记事本前台）后自动关闭并存草稿' })
      appendEvidenceJson('a3-blur-draft', { fg, draftAfterBlur })
    } catch (err) {
      mergeNotes('A3', `点外面场景异常：${err}`)
    }

    // Item 8：清空后 Esc，草稿一起清掉，下次热键不再恢复
    await callTestHook(app, 'close')
    await sleep(250)
    sendHotkey('Ctrl+Alt+J')
    cap = await ensureCaptureFocusedText(app)
    await sleep(150)
    const beforeClearValue = await cap.evaluate(() => document.querySelector('#text').value)
    // 真实按键：Ctrl+A 全选，Delete 清空（不是脚本直接置空 value）
    sendHotkey('Ctrl+A')
    await sleep(120)
    sendKey('Delete')
    await sleep(150)
    const clearedValue = await cap.evaluate(() => document.querySelector('#text').value)
    sendKey('Escape')
    await sleep(300)
    const draftAfterClearEsc = await page.evaluate(() => window.arckeep.getCaptureDraft())
    await callTestHook(app, 'close')
    await sleep(250)
    sendHotkey('Ctrl+Alt+J')
    cap = await ensureCaptureFocusedText(app)
    await sleep(150)
    const valueAfterReopen = await cap.evaluate(() => document.querySelector('#text').value)
    await shot(cap, '12-draft-cleared', { checkIds: ['8'], description: '清空后 Esc，下次热键打开是空的，草稿没有恢复' })
    sendKey('Escape')
    await sleep(300)
    await callTestHook(app, 'show')
    page = await mainWindowPage(app)

    const item8Ok = beforeClearValue === draftText1 && clearedValue === '' && (!draftAfterClearEsc.text) && valueAfterReopen === ''
    setResult('8', item8Ok ? 'PASS' : 'FAIL', {
      evidence: ['10-draft-restored.png', '12-draft-cleared.png'],
      steps: '按热键输入文字，Esc 关闭 -> 草稿有内容且再次按热键会恢复（已验证）；再打开一次，Ctrl+A 全选 + Delete 真实按键清空输入框 -> Esc -> getCaptureDraft() 应为空 -> 再次按热键 -> 输入框应为空',
      notes: `清空前草稿="${beforeClearValue}"；Ctrl+A+Delete 后值="${clearedValue}"；Esc 后草稿="${JSON.stringify(draftAfterClearEsc)}"；再次热键打开值="${valueAfterReopen}"`
    })

    setResult('A3', (draftAfterEsc.text === draftText1 && restoredValue === draftText1 && clickOutsideOk) ? 'PASS' : 'FAIL', {
      evidence: ['10-draft-restored.png', '11-blur-outside-draft-full.png'],
      steps: '1) 热键打开，SendInput 打字，SendInput 发 Esc -> getCaptureDraft() 应含刚输入内容 2) 再次热键 -> 输入框应原样恢复 3) 再打开一份，打字后把记事本切回前台使捕获框失焦（点窗口外面的等价操作）-> 200ms 后应自动关闭并把内容存进草稿 4) 退出应用重启后仍能恢复见下方',
      notes: `Esc 后草稿="${draftAfterEsc.text}"；再次热键恢复值="${restoredValue}"；失焦（点外面）保存草稿=${clickOutsideOk}`
    })
    mergeNotes('2', `Esc 不新增待办：${escDidNotCreateTodo}`)
  } catch (err) {
    setResult('8', 'FAIL', { notes: `异常：${err.stack || err}` })
    mergeNotes('A3', `进程内验证异常：${err}`)
  }

  // A3：退出应用重启后按热键仍能恢复草稿
  try {
    await callTestHook(app, 'close')
    await sleep(250)
    sendHotkey('Ctrl+Alt+J')
    let cap = await ensureCaptureFocusedText(app)
    const restartDraft = '重启后应该还在的草稿'
    sendText(restartDraft)
    await sleep(150)
    sendKey('Escape')
    await sleep(300)
    await quitApp(app)
    app = await launchApp({ label: 'A-draft-restart' })
    page = await mainWindowPage(app)
    await callTestHook(app, 'close')
    await sleep(250)
    sendHotkey('Ctrl+Alt+J')
    cap = await ensureCaptureFocusedText(app)
    await sleep(150)
    const valueAfterAppRestart = await cap.evaluate(() => document.querySelector('#text').value)
    await shot(cap, '13-draft-after-app-restart', { checkIds: ['A3'], description: '退出应用重启后，按热键草稿仍原样恢复' })
    sendKey('Escape')
    await sleep(300)
    await callTestHook(app, 'show')
    page = await mainWindowPage(app)
    const restartOk = valueAfterAppRestart === restartDraft
    mergeNotes('A3', `退出应用重启后按热键恢复草稿=${restartOk}（值="${valueAfterAppRestart}"）`)
    if (!restartOk) {
      lib.results.A3.verdict = 'FAIL'
    }
    lib.results.A3.evidence.push('13-draft-after-app-restart.png')
  } catch (err) {
    mergeNotes('A3', `重启恢复草稿场景异常：${err}`)
    lib.results.A3.verdict = 'FAIL'
  }

  // =====================================================================
  // Item 4：新增 3 条（1 条带 repo，1 条「等我」），退出再启动，3 条都在
  // =====================================================================
  let todo4Texts = {}
  try {
    const mk = async (text) => {
      await callTestHook(app, 'close')
      await sleep(250)
      sendHotkey('Ctrl+Alt+J')
      const cap = await ensureCaptureFocusedText(app)
      sendText(text)
      await sleep(150)
      sendKey('Return')
      await waitToastLifecycle(app, { timeoutMs: 3000 })
      await sleep(200)
    }

    const plainText = 'Item4普通待办'
    const repoText = 'Item4带仓库 #Dylan5237/req-to-page'
    const waitingText = 'Item4等我待办'

    await mk(plainText)
    await mk(repoText)

    // 第三条需要勾「等我」复选框：热键打开后先用真实按键把内容打进 #text，再点击 #waiting（不是打字，用点击）
    await callTestHook(app, 'close')
    await sleep(250)
    sendHotkey('Ctrl+Alt+J')
    let cap = await ensureCaptureFocusedText(app)
    sendText(waitingText)
    await sleep(150)
    await cap.click('#waiting')
    await sleep(100)
    await cap.evaluate(() => document.querySelector('#capture-form').requestSubmit())
    await waitToastLifecycle(app, { timeoutMs: 3000 })
    await sleep(200)

    await callTestHook(app, 'show')
    page = await mainWindowPage(app)
    await page.click('[data-view="todos"]')
    await page.waitForSelector('.todo-list', { timeout: 3000 })
    let items = await page.evaluate(() => window.arckeep.listTodos())
    const findByPrefix = (p) => items.find(i => i.text.startsWith(p))
    const plain = findByPrefix('Item4普通')
    const withRepo = findByPrefix('Item4带仓库')
    const waiting = findByPrefix('Item4等我')
    await shot(page, '14-todos-3-items', { checkIds: ['4'], description: '待办页：新增的 3 条都在，属性各自正确' })

    const userDataDir2 = await getUserDataDir(app)

    await quitApp(app) // 走的是 tray「退出」同一个 handler（test-hook quit === trayActions().quit）
    app = await launchApp({ label: 'A-after-4-todos' })
    page = await mainWindowPage(app)
    await page.click('[data-view="todos"]')
    await page.waitForSelector('.todo-list', { timeout: 3000 })
    items = await page.evaluate(() => window.arckeep.listTodos())
    const plain2 = items.find(i => i.text.startsWith('Item4普通'))
    const withRepo2 = items.find(i => i.text.startsWith('Item4带仓库'))
    const waiting2 = items.find(i => i.text.startsWith('Item4等我'))
    await shot(page, '15-todos-after-restart', { checkIds: ['4'], description: '退出再启动后，3 条仍在' })

    const jsonlAfter = fs.readFileSync(todosFile(userDataDir2), 'utf8')
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'item4-todos.jsonl.txt'), jsonlAfter, 'utf8')
    logEvidence('item4-todos.jsonl.txt', 'Item 4 三条待办对应的 todos.jsonl 原文', ['4'])

    const ok = Boolean(plain && withRepo && withRepo.repo === 'Dylan5237/req-to-page' && waiting && waiting.waiting === true
      && plain2 && withRepo2 && withRepo2.repo === 'Dylan5237/req-to-page' && waiting2 && waiting2.waiting === true)
    todo4Texts = { plainId: plain2?.id, repoId: withRepo2?.id, waitingId: waiting2?.id, waitingText }
    setResult('4', ok ? 'PASS' : 'FAIL', {
      evidence: ['14-todos-3-items.png', '15-todos-after-restart.png', 'item4-todos.jsonl.txt'],
      steps: '真实按键在快速捕获里连续记 3 条（一条含 #owner/repo，一条勾选「等我」），Enter 保存；打开待办页核对三条属性；调用与托盘「退出」相同的 quit handler 退出并重启；核对三条仍存在、属性不变；贴 todos.jsonl 原文',
      notes: `重启前：plain=${JSON.stringify(plain)} withRepo=${JSON.stringify(withRepo)} waiting=${JSON.stringify(waiting)}\n重启后：plain=${JSON.stringify(plain2)} withRepo=${JSON.stringify(withRepo2)} waiting=${JSON.stringify(waiting2)}`
    })
  } catch (err) {
    setResult('4', 'FAIL', { notes: `异常：${err.stack || err}` })
  }

  // =====================================================================
  // Item 5：完成/取消完成；删除按 #18 新行为（立即删除 + 已删除·撤销，无确认框）；
  //         编辑文字/仓库/等我，按 repo 过滤，列表顺序
  // 「撤销后原样恢复 + jsonl 核对 + 提示停留时长」见 R3（session-e-review.mjs）
  // =====================================================================
  try {
    await page.waitForSelector('.todo-list', { timeout: 3000 })

    // 完成 / 取消完成（对 plain 那条操作，避免影响 item6 依赖的「等我」那条）
    const rowSelector = (text) => `.todo-row:has(.todo-text:text-is("${text}"))`
    await page.locator(rowSelector('Item4普通待办')).locator('.todo-check').check()
    await page.waitForTimeout(200)
    // #18 之后已完成的行会折进默认折叠的「已完成」分组，需要先展开才能读到 class
    const completedGroup = page.locator('[data-action="completed-group"]')
    if (await completedGroup.count() > 0 && !(await completedGroup.evaluate(el => el.open))) {
      await completedGroup.evaluate(el => { el.open = true })
    }
    const isDoneClass = await page.locator(rowSelector('Item4普通待办')).getAttribute('class')
    await shot(page, '16-todo-completed', { checkIds: ['5'], description: '完成一条后显示为已完成（在「已完成」分组里）' })
    await page.locator(rowSelector('Item4普通待办')).locator('.todo-check').uncheck()
    await page.waitForTimeout(200)
    const isDoneAfterUncheck = await page.locator(rowSelector('Item4普通待办')).getAttribute('class')

    // 删除：新建一条专用于删除流程 —— 点删除立即生效，不弹确认框，出现「已删除 · 撤销」
    await callTestHook(app, 'close')
    await sleep(250)
    sendHotkey('Ctrl+Alt+J')
    const cap = await ensureCaptureFocusedText(app)
    sendText('待删除的测试待办-item5')
    await sleep(150)
    sendKey('Return')
    await waitToastLifecycle(app, { timeoutMs: 3000 })
    await sleep(200)
    await callTestHook(app, 'show')
    page = await mainWindowPage(app)
    await page.click('[data-view="todos"]')
    await page.waitForSelector('.todo-list', { timeout: 3000 })

    const countBeforeDelete = await page.locator(rowSelector('待删除的测试待办-item5')).count()
    await page.locator(rowSelector('待删除的测试待办-item5')).locator('[data-action="delete"]').click()
    // 立即生效：不应出现任何 modal/确认框
    await page.waitForTimeout(150)
    const modalAppeared = await page.locator('.modal-backdrop').count()
    const rowGoneImmediately = (await page.locator(rowSelector('待删除的测试待办-item5')).count()) === 0
    const undoBarVisible = await page.locator('[data-action="undo-delete"]').count()
    await shot(page, '17-delete-no-confirm-undo-bar', { checkIds: ['5'], description: '点删除立即生效：无确认框，底部出现「已删除 · 撤销」' })

    // 不点撤销：等提示消失后仍应保持已删除，重启后也不再出现
    await page.waitForTimeout(5300) // TODO_DELETE_UNDO_MS = 5000ms
    const undoBarGoneAfterWait = (await page.locator('[data-action="undo-delete"]').count()) === 0
    await shot(page, '18-after-delete-undo-expired', { checkIds: ['5'], description: '5 秒撤销窗口过后，提示消失，这条保持已删除' })

    await quitApp(app)
    app = await launchApp({ label: 'A-after-delete-restart' })
    page = await mainWindowPage(app)
    await page.click('[data-view="todos"]')
    await page.waitForSelector('.todo-list', { timeout: 3000 })
    const goneAfterRestart = (await page.locator(rowSelector('待删除的测试待办-item5')).count()) === 0

    // 编辑：文字 / 仓库 / 等我
    await page.locator(rowSelector('Item4带仓库')).locator('[data-action="edit"]').click()
    await page.waitForSelector('.todo-editor', { timeout: 2000 })
    const editor = page.locator('.todo-editor')
    await editor.locator('input[type="text"]').first().fill('Item4带仓库-已编辑')
    await editor.locator('input[aria-label="仓库标签"]').fill('example/edited-repo')
    const waitingCheckbox = editor.locator('input[type="checkbox"]')
    await waitingCheckbox.check()
    await editor.locator('button.primary').click()
    await page.waitForTimeout(300)
    await shot(page, '19-todo-edited', { checkIds: ['5'], description: '编辑文字/仓库/等我标记后' })
    const editedItems = await page.evaluate(() => window.arckeep.listTodos())
    const edited = editedItems.find(i => i.text === 'Item4带仓库-已编辑')

    // 按 repo 过滤
    await page.selectOption('select[data-action="repo-filter"]', 'example/edited-repo')
    await page.waitForTimeout(150)
    const filteredTexts = await page.$$eval('.todo-text', els => els.map(e => e.textContent))
    await shot(page, '20-todo-filtered', { checkIds: ['5'], description: '按仓库过滤后只显示这个仓库的待办' })
    await page.selectOption('select[data-action="repo-filter"]', 'all')

    // 列表顺序：未完成在前，按创建时间（含已完成分组内部顺序也按 compareTodos 排序）
    const orderItems = await page.evaluate(() => window.arckeep.listTodos())
    let orderOk = true
    for (let i = 1; i < orderItems.length; i++) {
      const prev = orderItems[i - 1]
      const cur = orderItems[i]
      if (prev.completed !== cur.completed) {
        if (prev.completed) { orderOk = false; break } // 完成的不应排在未完成前面
        continue
      }
      if (prev.createdAt > cur.createdAt) { orderOk = false; break }
    }

    const ok = isDoneClass.includes('is-done') && !isDoneAfterUncheck.includes('is-done')
      && countBeforeDelete === 1 && modalAppeared === 0 && rowGoneImmediately && undoBarVisible > 0
      && undoBarGoneAfterWait && goneAfterRestart
      && Boolean(edited) && edited.repo === 'example/edited-repo' && edited.waiting === true
      && filteredTexts.every(t => t.includes('已编辑')) && orderOk
    setResult('5', ok ? 'PASS' : 'FAIL', {
      evidence: ['16-todo-completed.png', '17-delete-no-confirm-undo-bar.png', '18-after-delete-undo-expired.png', '19-todo-edited.png', '20-todo-filtered.png'],
      steps: '勾选/取消勾选完成状态（已完成的行折进默认折叠的「已完成」分组）；新建一条专门测删除：点删除 -> 立即生效，无 .modal-backdrop 确认框，底部出现「已删除 · 撤销」-> 5 秒不点撤销，提示消失，条目保持已删除，重启仍不在；编辑文字/仓库/等我并保存；按仓库过滤只显示对应条目；核对 listTodos() 顺序（未完成在前，按创建时间）',
      notes: `完成态class=${isDoneClass}；取消完成class=${isDoneAfterUncheck}；删除前存在=${countBeforeDelete === 1}；点删除后是否出现确认框=${modalAppeared > 0}（应为 false）；点删除后行是否立即消失=${rowGoneImmediately}；是否出现「撤销」按钮=${undoBarVisible > 0}；5 秒后撤销提示是否消失=${undoBarGoneAfterWait}；重启后仍不在=${goneAfterRestart}；编辑结果=${JSON.stringify(edited)}；过滤结果=${JSON.stringify(filteredTexts)}；顺序正确=${orderOk}；Issue 正文原写“删除要确认”，本条按 #18 R3 的新行为（立即删除+撤销，不再弹确认框）判定`
    })
  } catch (err) {
    setResult('5', 'FAIL', { notes: `异常：${err.stack || err}` })
  }

  // =====================================================================
  // A2：简写解析 —— #owner/repo、#仓库名（关注列表命中/未命中）、!等我
  // =====================================================================
  try {
    await page.click('[data-view="settings"]')
    await page.waitForSelector('input[aria-label="关注仓库"]', { timeout: 3000 })
    await page.fill('input[aria-label="关注仓库"]', 'Dylan5237/req-to-page')
    await page.click('.card:has(input[aria-label="关注仓库"]) button.primary')
    await page.waitForTimeout(200)

    const mkA2 = async (text) => {
      await callTestHook(app, 'close')
      await sleep(250)
      sendHotkey('Ctrl+Alt+J')
      const cap = await ensureCaptureFocusedText(app)
      sendText(text)
      await sleep(150)
      sendKey('Return')
      await waitToastLifecycle(app, { timeoutMs: 3000 })
      await sleep(200)
    }

    await mkA2('买菜 #Dylan5237/req-to-page')       // case1: 完整 owner/repo
    await mkA2('清理缓存 #req-to-page')              // case2: 关注列表里的短名
    await mkA2('随便记点 #不存在的名字')               // case3: 认不出的短名，留在正文
    await mkA2('记得处理 !等我')                      // case4: !等我

    await callTestHook(app, 'show')
    page = await mainWindowPage(app)
    await page.click('[data-view="todos"]')
    await page.waitForSelector('.todo-list', { timeout: 3000 })
    const items = await page.evaluate(() => window.arckeep.listTodos())
    const case1 = items.find(i => i.text.startsWith('买菜'))
    const case2 = items.find(i => i.text.startsWith('清理缓存'))
    const case3 = items.find(i => i.text.startsWith('随便记点'))
    const case4 = items.find(i => i.text.startsWith('记得处理'))
    await shot(page, '21-a2-shorthand', { checkIds: ['A2'], description: 'A2 四种简写解析结果' })

    const ok = case1 && case1.repo === 'Dylan5237/req-to-page' && case1.text === '买菜'
      && case2 && case2.repo === 'Dylan5237/req-to-page' && case2.text === '清理缓存'
      && case3 && case3.repo === null && case3.text.includes('#不存在的名字')
      && case4 && case4.waiting === true && case4.text === '记得处理'
    setResult('A2', ok ? 'PASS' : 'FAIL', {
      evidence: ['21-a2-shorthand.png'],
      steps: '先在设置里把 Dylan5237/req-to-page 加入关注仓库；再依次用真实 SendInput 在捕获框打 4 种正文：完整 #owner/repo；关注列表里的短名 #repo；认不出的短名 #不存在的名字；!等我；逐条保存后核对 listTodos() 的 text/repo/waiting 字段',
      notes: `case1(#owner/repo，与关注列表无关，源码里全 owner/repo 形式始终解析)=${JSON.stringify(case1)}\ncase2(#repo 命中关注列表)=${JSON.stringify(case2)}\ncase3(#repo 未命中，留在正文)=${JSON.stringify(case3)}\ncase4(!等我)=${JSON.stringify(case4)}`
    })
  } catch (err) {
    setResult('A2', 'FAIL', { notes: `异常：${err.stack || err}` })
  }

  // =====================================================================
  // Item 6：等我处理里出现「待办」chip，天数从勾选起算；完成后消失；npm run waiting --json 交叉核对
  // =====================================================================
  try {
    await page.click('[data-view="inbox"]')
    await page.waitForSelector('.waiting-row, .waiting-empty, .waiting-loading', { timeout: 5000 })
    await page.waitForTimeout(600)
    await shot(page, '22-waiting-with-todo', { checkIds: ['6'], description: '等我处理：出现「待办」chip' })
    const rows = await page.$$eval('.waiting-row', els => els.map(el => ({
      chip: el.querySelector('.chip')?.textContent,
      chipClass: el.querySelector('.chip')?.className,
      days: el.querySelector('.days')?.textContent,
      title: el.querySelector('.waiting-title-text')?.textContent
    })))
    const todoRow = rows.find(r => r.title && r.title.startsWith('Item4等我'))

    const userDataDir3 = await getUserDataDir(app)
    appendEvidenceJson('item6-waiting-rows', rows)

    // 完成该待办后应从等我处理消失
    await page.click('[data-view="todos"]')
    await page.waitForSelector('.todo-list', { timeout: 3000 })
    await page.locator(`.todo-row:has(.todo-text:text-is("${todo4Texts.waitingText}"))`).locator('.todo-check').check()
    await page.waitForTimeout(200)
    await page.click('[data-view="inbox"]')
    await page.click('button.primary:has-text("刷新")')
    await page.waitForTimeout(600)
    const rowsAfter = await page.$$eval('.waiting-row', els => els.map(el => el.querySelector('.waiting-title-text')?.textContent))
    const goneAfterComplete = !rowsAfter.some(t => t && t.startsWith('Item4等我'))
    await shot(page, '23-waiting-after-complete', { checkIds: ['6'], description: '完成后从等我处理消失' })

    // 交叉核对：npm run waiting -- --json（源码 checkout 里跑，APPDATA 指向与本次 userData 相同的父目录）
    let cliResult = null
    try {
      const { execFileSync } = await import('node:child_process')
      const sourceDir = process.env.ARCKEEP_SOURCE_DIR
      if (sourceDir) {
        const appDataParent = path.dirname(userDataDir3)
        const out = execFileSync('npm', ['run', 'waiting', '--', '--json'], {
          cwd: sourceDir,
          env: { ...lib.cleanEnv(), APPDATA: appDataParent },
          encoding: 'utf8',
          timeout: 60000
        })
        fs.writeFileSync(path.join(EVIDENCE_DIR, 'item6-npm-run-waiting.json'), out, 'utf8')
        logEvidence('item6-npm-run-waiting.json', 'npm run waiting -- --json 的原始输出', ['6'])
        cliResult = JSON.parse(out)
      }
    } catch (err) {
      appendEvidenceJson('item6-cli-error', { message: String(err), stdout: err.stdout?.toString?.(), stderr: err.stderr?.toString?.() })
    }
    const cliTodoRow = cliResult?.find?.(r => r.type === 'todo') ?? (cliResult?.rows ?? []).find?.(r => r.type === 'todo')

    const ok = Boolean(todoRow && todoRow.chip === '待办' && todoRow.chipClass?.includes('act-todo')
      && /\d+/.test(todoRow.days || '') && goneAfterComplete)
    setResult('6', ok ? 'PASS' : 'FAIL', {
      evidence: ['22-waiting-with-todo.png', '23-waiting-after-complete.png', 'item6-waiting-rows.json', 'item6-npm-run-waiting.json'],
      steps: '在待办页勾选「等我」，切到「等我处理」页刷新，核对出现的行有「待办」chip 和天数；把它标完成，再刷新，应从列表消失；在源码 checkout（同一份 todos.jsonl 所在的 APPDATA）里跑 npm run waiting -- --json 核对同一条记录',
      notes: `等我处理里的行=${JSON.stringify(todoRow)}；完成后消失=${goneAfterComplete}；npm run waiting --json 命中 type:todo 的记录=${JSON.stringify(cliTodoRow)}`
    })
  } catch (err) {
    setResult('6', 'FAIL', { notes: `异常：${err.stack || err}` })
  }

  let finalUserDataDir = null
  try { finalUserDataDir = await getUserDataDir(app) } catch { /* ignore */ }
  await quitApp(app)
  return { userDataDir: finalUserDataDir }
}
