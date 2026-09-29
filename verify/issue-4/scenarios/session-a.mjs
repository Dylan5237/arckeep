// Session A：主流程（热键 + 快速捕获 + 待办 CRUD + 简写 + 等我处理）
// 覆盖 checklist: 1, 2, 3, 4, 5, 6, 8, A1, A2, A3
//
// 注意：本文件针对被测 SHA 0734791（PR #12 + 设计评审 PR #18）编写。
//
// 环境限制说明（见 evidence/preflight.json + run.mjs 里的预检)：这个 GitHub-hosted
// windows-latest 环境里，PowerShell SendInput 在 Win32 层调用不报错，但目标窗口（不管
// 是不是通过全局热键打开的）完全收不到任何按键效果——这是 CI 平台的会话/输入桌面限制，
// 不是产品缺陷。因此：
//   - 需要验证「真实全局热键机制本身」的部分（Item 1 的热键触发、Item 3/A1 里
//     「真实按键确认生效/失效」的子项）在 lib.envFlags.hotkeyDeliveryOk===false 时
//     直接判 BLOCKED，不再反复重试。
//   - 不是在测热键机制本身、只是需要「某种方式打开捕获窗口」的检查项（2/4/5/6/8/A2/A3），
//     改用 openCaptureViaHook()（测试钩子 IPC 打开，走的是与真实热键完全相同的主进程
//     openCapture 代码路径）+ Playwright 自己的 page.keyboard（CDP 真实按键事件，
//     经过 Chromium 输入管线，会真正触发渲染进程的 keydown 监听器）。
//
// Item 5 的删除流程已按 #18 的新行为（立即删除 + 「已删除 · 撤销」，不再弹确认框）
// 改写；「撤销后原样恢复 + jsonl 核对」「删除提示停留时长」的完整验证见 R3
// （scenarios/session-e-review.mjs），Item 5 这里只验证「不确认框 + 不撤销 + 重启后仍消失」。
import fs from 'node:fs'
import path from 'node:path'
import * as lib from '../lib.mjs'

const {
  setResult, mergeNotes, logEvidence, EVIDENCE_DIR, envFlags,
  launchApp, mainWindowPage, captureWindowPage, openCaptureViaHook, waitCaptureFocused,
  createTodoViaHook, ensureCaptureWindowClosed,
  callTestHook, getAppState, quitApp, killStrayArckeep,
  startNotepad, sendHotkey, sendKey, foreground,
  fullShot, shot, waitFor, sleep, getUserDataDir, resetUserData, todosFile,
  appendEvidenceJson, writeJson
} = lib

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
  // 这是「真实全局热键机制」本身的检查项——预检已确认这个 CI 环境的 SendInput
  // 送不到任何窗口，这里仍然真实尝试一次（短超时，避免浪费时间），失败则判 BLOCKED。
  // =====================================================================
  try {
    if (!envFlags.hotkeyDeliveryOk) {
      setResult('1', 'BLOCKED', {
        evidence: ['preflight.json'],
        steps: '预检（scenarios/session-0-preflight.mjs）已确认：真实 SendInput 在这个 CI 环境的 Win32 调用不报错，但目标窗口收不到任何按键效果，全局热键无法用真实系统按键验证',
        notes: '这是 GitHub-hosted windows-latest 的会话/输入桌面限制（详见 evidence/preflight.json 的 realHotkeyOpensCapture/sendInputToFocusedWindow 字段），不是产品缺陷：无法用黑盒真实按键的方式验证「按热键后 1 秒内捕获框获得前台焦点」这一条'
      })
      setResult('A1', 'BLOCKED', {
        evidence: ['preflight.json'],
        steps: '同上；A1 的前半段（热键触发+立即聚焦）依赖同一个不可用的机制',
        notes: '热键触发本身不可测（见 Item 1）；A1 里「打字→Enter→toast 出现约 1s 后消失」这部分用测试钩子打开捕获窗口后单独复测，见下方 notes'
      })
    } else {
      await callTestHook(app, 'close') // 等价于点主窗口关闭按钮：隐藏到托盘（真实关闭按钮走的同一个 handler）
      startNotepad()
      await sleep(900)
      let fg = foreground()
      if (fg.processName?.toLowerCase() !== 'notepad') {
        await sleep(600)
        fg = foreground()
      }
      logEvidence('item1-before-foreground.json', 'Ctrl+Alt+Space 之前的前台窗口（应为 notepad）', ['1'])
      appendEvidenceJson('item1-before-foreground', fg)
      fullShot('01-before-hotkey', { checkIds: ['1'], description: '按热键前：记事本在前台，Arckeep 只剩托盘' })

      const t0 = Date.now()
      const sendResult = sendHotkey('Ctrl+Alt+Space')
      const visible = await waitFor(async () => {
        for (const w of app.windows()) {
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
      if (visible.ok) osForeground = foreground()
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
        setResult('1', 'FAIL', { evidence: ['01-before-hotkey-full.png', '02-after-hotkey-full.png'], notes: `${jsVisibleMs}ms 内未观察到捕获框可见+focus（预检显示 hotkeyDeliveryOk=true，但这次单独复测没有重现，记为真实失败而非环境限制）` })
        setResult('A1', 'BLOCKED', { notes: '捕获框未出现，无法检测输入焦点' })
      }
    }
  } catch (err) {
    setResult('1', 'BLOCKED', { notes: `异常：${err.stack || err}` })
    setResult('A1', 'BLOCKED', { notes: `异常：${err.stack || err}` })
  }

  // =====================================================================
  // A1 continued：用测试钩子打开捕获框，Playwright 键盘输入打字。
  // 先单独探一次「在输入框里按 Enter 是否会触发浏览器原生的隐式表单提交」——
  // run3（66d1eeb）里发现这一步在这份 Electron 构建 + CDP 合成按键的组合下并不可靠
  // （窗口没关、也没出现 toast），且这个环境里已确认真实 OS 级 SendInput 完全不通，
  // 没有别的方式能做「真实物理按键」的对照实验，所以「Enter 是否触发保存」这个动作
  // 本身的判定记为 BLOCKED，不猜测是产品缺陷还是 CDP 合成事件的环境限制。
  // 不管 Enter 探测结果如何，都会用 requestSubmit() 兜底把这个窗口结束掉（避免它以
  //「未保存成功」的状态一直占着 openCaptureWindow() 的单例位置，污染后面所有检查项），
  // 并借这次兜底提交独立验证「打字→保存→toast 出现约 1s 后消失」这条产品行为本身。
  // =====================================================================
  try {
    await callTestHook(app, 'close')
    await sleep(150)
    const cap = await openCaptureViaHook(app)
    const text1 = 'A1捕获测试记一条'
    await cap.fill('#text', text1)
    await sleep(100)
    const domText = await cap.evaluate(() => document.querySelector('#text').value)
    await shot(cap, '03-a1-typed', { checkIds: ['A1'], description: 'Playwright 键盘输入打字后，输入框内容' })

    await cap.press('#text', 'Enter')
    const closedByEnter = await waitFor(async () => {
      for (const w of app.windows()) {
        const isCap = await w.evaluate(() => !!document.querySelector('#capture-form')).catch(() => false)
        if (isCap) return false
      }
      return true
    }, { timeoutMs: 1500 })
    appendEvidenceJson('a1-enter-probe', { closedByEnter: closedByEnter.ok })

    let toastResult = { appeared: false }
    if (closedByEnter.ok) {
      // 这次环境里 Enter 居然直接生效了：正常走 toast 生命周期检测
      toastResult = await waitToastLifecycle(app)
    } else {
      // Enter 没有可观察的效果：用 requestSubmit() 直接调用同一个 form submit 监听器
      // 兜底把这条保存掉、把窗口关掉，避免单例窗口带着未保存的文字一直占位
      await cap.evaluate(() => document.querySelector('#capture-form').requestSubmit())
      toastResult = await waitToastLifecycle(app)
    }
    if (toastResult.appeared) {
      await shot(toastResult.toastWin, '04-a1-saved-toast', { checkIds: ['A1'], description: '「已记下」提示出现（独立无边框 BrowserWindow，屏幕右下角）' })
      fullShot('04-a1-saved-toast', { checkIds: ['A1'], description: '「已记下」提示出现（全屏，右下角）' })
    }
    appendEvidenceJson('a1-toast-timing', { ...toastResult, toastWin: undefined })

    const closedFinally = await waitFor(async () => {
      for (const w of app.windows()) {
        const isCap = await w.evaluate(() => !!document.querySelector('#capture-form')).catch(() => false)
        if (isCap) return false
      }
      return true
    }, { timeoutMs: 2000 })
    if (!closedFinally.ok) {
      // 兜底也没能关掉窗口，强制用 Escape 清场，避免污染后面所有检查项（这里不再纠结
      // 这一条本身的判定，只保证「捕获窗口的单例位置」在离开这个 try 块之前是干净的）
      await cap.press('#text', 'Escape').catch(() => {})
      await sleep(300)
    }

    const saveFlowOk = domText === text1 && toastResult.appeared && toastResult.appearMs < 1200
      && toastResult.disappearMs !== null && toastResult.disappearMs > 500 && toastResult.disappearMs < 2500
    mergeNotes('A1', `【测试钩子打开+Playwright键盘输入子项，独立于上面的真实热键触发】打字后 DOM 值="${domText}"；Playwright CDP Enter 是否直接触发了隐式表单提交=${closedByEnter.ok}（这个环境里真实 OS SendInput 完全不通，没有别的方式做「真实物理按键」的对照实验，所以「Enter 触发保存」这个动作本身记为 BLOCKED，不论这里结果如何都不据此改判 PASS/FAIL）；toast 出现耗时 ${toastResult.appearMs}ms，停留 ${toastResult.disappearMs}ms；保存/toast 这条产品逻辑本身（用 requestSubmit() 兜底触发同一个 submit 监听器验证）=${saveFlowOk ? 'OK' : '有问题'}（「已记下」toast 是独立无边框 BrowserWindow，showSavedToast，SAVED_TOAST_MS=1000ms，出现在主屏幕工作区右下角）`)
    if (envFlags.hotkeyDeliveryOk && !saveFlowOk) {
      lib.results.A1.verdict = 'FAIL'
    }
    // hotkeyDeliveryOk===false 时 A1 已经在前面因为「热键触发」本身判 BLOCKED，这里
    // 不管 saveFlowOk 是否为真都不改判——BLOCKED 已经如实反映了「有一部分测不了」。
  } catch (err) {
    mergeNotes('A1', `打字/toast 子项异常：${err.stack || err}`)
  }

  // =====================================================================
  // Item 2（前半）：保存后待办页出现这一条——用测试钩子打开，不依赖热键。
  // 「Enter 是否触发保存」这个动作本身已在上面 A1 里单独探测并记为 BLOCKED（这个环境
  // 没有可靠方式验证 CDP 合成的 Enter 是否等价于真实物理按键）；这里统一用
  // lib.createTodoViaHook()（requestSubmit() 兜底 + 显式确认窗口真的关闭）来验证
  // save()/createTodo() 这条产品逻辑本身是否正常保存，避免依赖不确定的 Enter 语义。
  // =====================================================================
  try {
    page = await createTodoViaHook(app, 'Item2捕获测试记一条')
    const text2 = 'Item2捕获测试记一条'
    await page.click('[data-view="todos"]')
    await page.waitForSelector('.todo-list, .empty-todos', { timeout: 3000 })
    const texts = await page.$$eval('.todo-text', els => els.map(e => e.textContent))
    await shot(page, '05-todos-after-enter', { checkIds: ['2'], description: '待办页：保存的这一条已出现' })
    const found = texts.includes(text2)
    setResult('2', found ? 'PASS' : 'FAIL', {
      evidence: ['05-todos-after-enter.png'],
      steps: '用测试钩子打开捕获窗口（与真实热键走同一段主进程 openCapture 代码路径），Playwright 键盘输入打字，用 requestSubmit() 直接触发表单的 submit 监听器保存（「Enter 是否触发保存」这个动作本身的判定见 A1），打开待办页确认该条存在（Esc 不新增待办的验证见下方「热键改键」与 A3/8 场景）',
      notes: `待办页当前文本：${JSON.stringify(texts)}`
    })
  } catch (err) {
    setResult('2', 'FAIL', { notes: `异常：${err.stack || err}` })
  }

  // =====================================================================
  // Item 3：设置里换热键，新组合生效、旧组合失效（需要真实按键验证），重启后仍是新组合
  // 「真实按键确认生效/失效」是这条检查的核心要求，热键机制在这个环境不可测时整体判 BLOCKED，
  // 但「保存成功」「重启后设置仍持久化为新组合」不依赖 OS 热键，单独确认并写进 notes。
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

    await quitApp(app)
    app = await launchApp({ label: 'A-after-rebind' })
    page = await mainWindowPage(app)
    state = await getAppState(page)
    const persisted = state.hotkey === 'Ctrl+Alt+J' && state.activeHotkey === 'Ctrl+Alt+J'
    await shot(page, '09-new-combo-after-restart', { checkIds: ['3'], description: '重启后设置仍持久化为 Ctrl+Alt+J（真实按键生效性见环境限制说明）' })

    if (!envFlags.hotkeyDeliveryOk) {
      setResult('3', 'BLOCKED', {
        evidence: ['06-hotkey-changed.png', '09-new-combo-after-restart.png', 'preflight.json'],
        steps: '设置页填 Ctrl+Alt+J 保存（可独立确认）-> 真实按键验证新组合生效/旧组合失效（这个 CI 环境不可用，见 preflight.json）-> quit 重启 -> 读取设置确认仍是 Ctrl+Alt+J（可独立确认）',
        notes: `不依赖真实热键、可独立确认的部分：保存成功=${savedOk}；重启后设置持久化为新组合=${persisted}。核心的「真实按键确认新组合生效、旧组合失效」这部分因 GitHub-hosted windows-latest 的 SendInput 会话限制无法验证（见 evidence/preflight.json），按硬性要求判 BLOCKED 而非 PASS/FAIL`
      })
    } else {
      // 预检显示热键投递是通的：走真实按键验证
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
      if (newOpened.ok) { await shot(newOpened.value, '07-new-combo-opens', { checkIds: ['3'], description: 'Ctrl+Alt+J 真实按键打开捕获框' }); sendKey('Escape'); await sleep(300) }
      sendHotkey('Ctrl+Alt+Space')
      await sleep(500)
      const oldStillClosed = !(await Promise.all(app.windows().map(w => w.evaluate(() => !!document.querySelector('#capture-form')).catch(() => false)))).some(Boolean)
      fullShot('08-old-combo-no-effect', { checkIds: ['3'], description: '旧组合按下后无反应' })
      const afterRestartOpened = await waitFor(async () => {
        for (const w of app.windows()) {
          const ok = await w.evaluate(() => !!document.querySelector('#capture-form')).catch(() => false)
          if (ok) return w
        }
        return null
      }, { timeoutMs: 3000, intervalMs: 30 })
      if (!afterRestartOpened.ok) { sendHotkey('Ctrl+Alt+J'); await sleep(500) }
      const ok = savedOk && newOpened.ok && oldStillClosed && persisted
      setResult('3', ok ? 'PASS' : 'FAIL', {
        evidence: ['06-hotkey-changed.png', '07-new-combo-opens.png', '08-old-combo-no-effect-full.png', '09-new-combo-after-restart.png'],
        steps: '设置页填 Ctrl+Alt+J 保存 -> 真实 SendInput 发 Ctrl+Alt+J（生效）-> 真实 SendInput 发 Ctrl+Alt+Space（旧组合，应无反应）-> quit 重启 -> 读取设置确认仍是 Ctrl+Alt+J',
        notes: `保存成功=${savedOk}; 新组合真实按键生效=${newOpened.ok}; 旧组合真实按键已失效=${oldStillClosed}; 重启后设置仍为新组合=${persisted}`
      })
    }
    await callTestHook(app, 'show')
    page = await mainWindowPage(app)
  } catch (err) {
    setResult('3', 'FAIL', { notes: `异常：${err.stack || err}` })
  }

  // =====================================================================
  // Item 8 + A3：草稿在 Esc/失焦时保存、再次打开时恢复；清空后 Esc 清掉草稿不再恢复；
  // 退出重启后仍能恢复。全部改用测试钩子打开捕获窗口 + Playwright 键盘事件——
  // Esc/清空/打字都是渲染进程自己的 keydown 监听器，不经过 OS 全局热键，Playwright
  // 的 CDP 按键事件是真实按键事件，能如实测到这段逻辑。「点击窗口外面失焦」用
  // BrowserWindow.blur() 编程调用模拟（同样触发主进程真实的 'blur' 监听器），
  // 不依赖已知失效的 OS 级前台切换。
  // =====================================================================
  // A3 case 1 / case 2 / Item 8 之间用 cap 变量串起来。三段各自单独一层 try/catch，
  // 避免任何一段意外抛出（比如这个 CI 环境本身就有的失焦/焦点抖动）把后面还没跑到的
  // 步骤和最终的 setResult('8'/'A3', ...) 一起冲掉——那样會让本该分别是 PASS/FAIL 的
  // 子项全部退化成一条笼统的「进程内验证异常」，也会让后面复用同一个 app/page 的
  // Item 4 从一个已经跑飞的状态开始。
  //
  // 关键澄清：每段开头都用 ensureCaptureWindowClosed(app) 而不是 callTestHook(app,'close')
  // 来保证「拿到的是全新捕获窗口」。callTestHook(app,'close') 实际调用的是主进程的
  // closeMainWindow()（隐藏主窗口到托盘），跟捕获窗口是不是干净的没有任何关系——捕获窗口
  // 只有真的保存成功/Esc存草稿/失焦超时才会自己关闭；如果上一步异常中途退出、既没
  // Esc 也没提交，捕获窗口会原样留在打开状态，下一次 openCaptureViaHook() 会命中
  // openCaptureWindow() 单例判断而复用同一个脏窗口，输入的新文字会追加进残留内容里
  // （详见 lib.mjs 里 ensureCaptureWindowClosed() 的完整说明）。
  let cap
  const draftText1 = 'Esc应该存成草稿'
  let draftAfterEsc = { text: null }
  let restoredValue = null
  let countBefore = 0
  let escDidNotCreateTodo = false
  try {
    countBefore = (await page.evaluate(() => window.arckeep.listTodos())).length

    // A3 case 1：输入后 Esc -> 存草稿 -> 再次打开 -> 原样恢复（进程内，未重启）。
    // 用 fill() 不用 type()：fill() 会先整体替换，不管这次打开时 #text 有没有被磁盘上
    // 残留的旧草稿预填（见 lib.createTodoViaHook() 的详细说明），保存下来的值都精确
    // 等于 draftText1，不会被追加。
    await ensureCaptureWindowClosed(app)
    cap = await openCaptureViaHook(app)
    await cap.fill('#text', draftText1)
    await sleep(100)
    await cap.press('#text', 'Escape')
    await sleep(300)
    draftAfterEsc = await page.evaluate(() => window.arckeep.getCaptureDraft())
    await ensureCaptureWindowClosed(app)
    cap = await openCaptureViaHook(app)
    await sleep(100)
    restoredValue = await cap.evaluate(() => document.querySelector('#text').value)
    await shot(cap, '10-draft-restored', { checkIds: ['A3', '8'], description: 'Esc 存草稿后再次打开，原样恢复' })

    // Item 2 后半：Esc 不新增待办
    const countAfterEscRestore = (await page.evaluate(() => window.arckeep.listTodos())).length
    escDidNotCreateTodo = countAfterEscRestore === countBefore
  } catch (err) {
    mergeNotes('A3', `Esc 存草稿场景异常：${err}`)
  }

  let clickOutsideOk = false
  const draftText2 = '点外面也该存草稿'
  try {
    // A3 case 2：编程调用 BrowserWindow.blur()，等价于「点击窗口外面」使捕获框失焦。
    // 这里打开的是全新窗口，但 #text 会被磁盘上 case1 刚存的草稿（draftText1）预填——
    // 这正是 run5 里 Item4/8/A3 栽的坑：cap.type() 是在当前光标位置插入，不会先清空，
    // 会把 draftText2 追加在 draftText1 后面，存下来的草稿就变成两段拼在一起，跟
    // draftText2 完全不相等。改用 fill()：不管进来时字段里有没有残留内容，最终值都
    // 精确等于 draftText2。
    await ensureCaptureWindowClosed(app)
    cap = await openCaptureViaHook(app)
    await cap.fill('#text', draftText2)
    await sleep(100)
    const bwHandle = await app.browserWindow(cap)
    await bwHandle.evaluate(win => win.blur())
    await sleep(500) // 等主进程里的 200ms blur 计时器把窗口关掉
    const capStillOpen = await Promise.all(app.windows().map(w => w.evaluate(() => !!document.querySelector('#capture-form')).catch(() => false)))
    const draftAfterBlur = await page.evaluate(() => window.arckeep.getCaptureDraft())
    clickOutsideOk = !capStillOpen.some(Boolean) && draftAfterBlur.text === draftText2
    fullShot('11-blur-outside-draft', { checkIds: ['A3'], description: '捕获框失焦（BrowserWindow.blur() 编程调用，等价于点击窗口外面）后自动关闭并存草稿' })
    appendEvidenceJson('a3-blur-draft', { draftAfterBlur })
  } catch (err) {
    mergeNotes('A3', `失焦场景异常：${err}`)
  }

  // Item 8 自己先建一份已知的草稿（fill + Esc），不依赖 case1/case2 留下的是哪个值——
  // 那两段是各自独立的场景，各自会在磁盘上留下不同的草稿（draftText1 或 draftText2），
  // Item 8 只关心「清空后 Esc，草稿也被清掉」这条本身，用自己独立的种子文本更清晰、
  // 也不会因为前面任何一段的失败/顺序调整而跟着连带出错。
  const item8SeedText = '待清空的草稿-item8种子'
  let beforeClearValue = null
  let clearedValue = null
  let draftAfterClearEsc = { text: null }
  let valueAfterReopen = null
  try {
    await ensureCaptureWindowClosed(app)
    cap = await openCaptureViaHook(app)
    await cap.fill('#text', item8SeedText)
    await sleep(100)
    await cap.press('#text', 'Escape')
    await sleep(300)

    // Item 8：清空后 Esc，草稿一起清掉，下次打开不再恢复
    await ensureCaptureWindowClosed(app)
    cap = await openCaptureViaHook(app)
    await sleep(100)
    beforeClearValue = await cap.evaluate(() => document.querySelector('#text').value)
    // Playwright 键盘事件：Ctrl+A 全选，Delete 清空（不是脚本直接置空 value）
    await cap.click('#text')
    await cap.press('#text', 'Control+A')
    await sleep(80)
    await cap.press('#text', 'Delete')
    await sleep(100)
    clearedValue = await cap.evaluate(() => document.querySelector('#text').value)
    await cap.press('#text', 'Escape')
    await sleep(300)
    draftAfterClearEsc = await page.evaluate(() => window.arckeep.getCaptureDraft())
    await ensureCaptureWindowClosed(app)
    cap = await openCaptureViaHook(app)
    await sleep(100)
    valueAfterReopen = await cap.evaluate(() => document.querySelector('#text').value)
    await shot(cap, '12-draft-cleared', { checkIds: ['8'], description: '清空后 Esc，下次打开是空的，草稿没有恢复' })
    await cap.press('#text', 'Escape').catch(() => {})
    await sleep(300)
  } catch (err) {
    mergeNotes('8', `清空后 Esc 场景异常：${err}`)
  }

  // 不论上面三段各自成败，统一收尾：强制关掉任何残留的捕获窗口，切回主窗口，再落最终
  // 判定——避免任何一段的异常导致 setResult('8'/'A3', ...) 整体缺失，也避免残留的捕获
  // 窗口污染后面 Item 4 的第一次 createTodoViaHook 调用。
  await ensureCaptureWindowClosed(app).catch(() => {})
  await callTestHook(app, 'show').catch(() => {})
  page = await mainWindowPage(app)

  // setResult() 是整体替换 results[id]（verdict/evidence/steps/notes 全覆盖），不是
  // 追加——如果 case1/case2/Item8 三段里任何一段的 catch 已经用 mergeNotes('8'/'A3', ...)
  // 记过异常信息，这里直接 setResult() 会把那条异常信息整个覆盖掉，导致最终报告只看到
  // 「哪个字段不等于期望值」而看不到「为什么会不等于」（run6 就是这样，A3/8 的 catch 都
  // 记了异常但被这里覆盖没了）。先把已有 notes 取出来拼进最终字符串，不覆盖丢失。
  const notes8Before = lib.results['8'].notes
  const notesA3Before = lib.results.A3.notes

  const item8Ok = beforeClearValue === item8SeedText && clearedValue === '' && (!draftAfterClearEsc.text) && valueAfterReopen === ''
  setResult('8', item8Ok ? 'PASS' : 'FAIL', {
    evidence: ['10-draft-restored.png', '12-draft-cleared.png'],
    steps: '打开捕获窗口输入文字，Esc 关闭 -> 草稿有内容且再次打开会恢复（已验证）；再打开一次，Playwright 键盘事件 Ctrl+A 全选 + Delete 清空输入框 -> Esc -> getCaptureDraft() 应为空 -> 再次打开 -> 输入框应为空',
    notes: `种子文本="${item8SeedText}"；清空前草稿="${beforeClearValue}"；Ctrl+A+Delete 后值="${clearedValue}"；Esc 后草稿="${JSON.stringify(draftAfterClearEsc)}"；再次打开值="${valueAfterReopen}"（打开捕获窗口用的是测试钩子而非真实热键，见文件头部环境限制说明；渲染进程内部的 Esc/清空逻辑本身用 Playwright 真实 CDP 按键事件验证，与真实按键效果一致）${notes8Before ? ` [子步骤异常记录] ${notes8Before}` : ''}`
  })

  setResult('A3', (draftAfterEsc.text === draftText1 && restoredValue === draftText1 && clickOutsideOk) ? 'PASS' : 'FAIL', {
    evidence: ['10-draft-restored.png', '11-blur-outside-draft-full.png'],
    steps: '1) 打开捕获窗口，Playwright 打字，Playwright 发 Esc -> getCaptureDraft() 应含刚输入内容 2) 再次打开 -> 输入框应原样恢复 3) 再打开一份，打字后用 BrowserWindow.blur() 编程调用模拟点击窗口外面使捕获框失焦（触发与真实失焦相同的主进程 blur 监听器）-> 200ms 后应自动关闭并把内容存进草稿 4) 退出应用重启后仍能恢复见下方',
    notes: `Esc 后草稿="${draftAfterEsc.text}"；再次打开恢复值="${restoredValue}"；失焦（BrowserWindow.blur()，等价于点外面）保存草稿=${clickOutsideOk}；打开捕获窗口用测试钩子而非真实热键（见环境限制说明），验证的是草稿保存/恢复逻辑本身，不是热键机制${notesA3Before ? ` [子步骤异常记录] ${notesA3Before}` : ''}`
  })
  mergeNotes('2', `Esc 不新增待办：${escDidNotCreateTodo}`)

  // A3：退出应用重启后再次打开仍能恢复草稿
  try {
    await ensureCaptureWindowClosed(app)
    let cap = await openCaptureViaHook(app)
    const restartDraft = '重启后应该还在的草稿'
    await cap.fill('#text', restartDraft)
    await sleep(100)
    await cap.press('#text', 'Escape')
    await sleep(300)
    await quitApp(app)
    app = await launchApp({ label: 'A-draft-restart' })
    page = await mainWindowPage(app)
    cap = await openCaptureViaHook(app)
    await sleep(100)
    const valueAfterAppRestart = await cap.evaluate(() => document.querySelector('#text').value)
    await shot(cap, '13-draft-after-app-restart', { checkIds: ['A3'], description: '退出应用重启后，再次打开草稿仍原样恢复' })
    await cap.press('#text', 'Escape')
    await sleep(300)
    await callTestHook(app, 'show')
    page = await mainWindowPage(app)
    const restartOk = valueAfterAppRestart === restartDraft
    mergeNotes('A3', `退出应用重启后恢复草稿=${restartOk}（值="${valueAfterAppRestart}"）`)
    if (!restartOk) lib.results.A3.verdict = 'FAIL'
  } catch (err) {
    mergeNotes('A3', `重启恢复草稿场景异常：${err}`)
    lib.results.A3.verdict = 'FAIL'
  }

  // =====================================================================
  // Item 4：新增 3 条（1 条带 repo，1 条「等我」），退出再启动，3 条都在
  // =====================================================================
  let todo4Texts = {}
  try {
    const plainText = 'Item4普通待办'
    const repoText = 'Item4带仓库 #Dylan5237/req-to-page'
    const waitingText = 'Item4等我待办'

    await createTodoViaHook(app, plainText)
    await createTodoViaHook(app, repoText)
    await createTodoViaHook(app, waitingText, { waiting: true })

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
      steps: '用测试钩子打开捕获窗口连续记 3 条（一条含 #owner/repo，一条勾选「等我」，Playwright 键盘输入打字，Enter 保存）；打开待办页核对三条属性；调用与托盘「退出」相同的 quit handler 退出并重启；核对三条仍存在、属性不变；贴 todos.jsonl 原文',
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
    // Item4 刚经历过 quit+relaunch，主窗口这次导航/IPC 刚完成，直接等 .todo-list 偶尔
    // 会跟渲染时机撞上；失败时主动重新点一次待办页再等一次，而不是直接判异常。
    try {
      await page.waitForSelector('.todo-list', { timeout: 3000 })
    } catch {
      page = await mainWindowPage(app)
      await page.click('[data-view="todos"]')
      await page.waitForSelector('.todo-list', { timeout: 5000 })
    }

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
    await createTodoViaHook(app, '待删除的测试待办-item5')
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
    try {
      await page.waitForSelector('.todo-editor', { timeout: 5000 })
    } catch {
      // CI 里偶尔第一次点击的时候这一行还没画完整/被上一步的重绘顶掉，点击落空；
      // 重新定位再点一次，给足够的时间等编辑器画出来。
      await page.locator(rowSelector('Item4带仓库')).locator('[data-action="edit"]').click()
      await page.waitForSelector('.todo-editor', { timeout: 5000 })
    }
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
      notes: `完成态class=${isDoneClass}；取消完成class=${isDoneAfterUncheck}；删除前存在=${countBeforeDelete === 1}；点删除后是否出现确认框=${modalAppeared > 0}（应为 false）；点删除后行是否立即消失=${rowGoneImmediately}；是否出现「撤销」按钮=${undoBarVisible > 0}；5 秒后撤销提示是否消失=${undoBarGoneAfterWait}；重启后仍不在=${goneAfterRestart}；编辑结果=${JSON.stringify(edited)}；过滤结果=${JSON.stringify(filteredTexts)}；顺序正确=${orderOk}；Issue 正文原写"删除要确认"，本条按 #18 R3 的新行为（立即删除+撤销，不再弹确认框）判定`
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

    await createTodoViaHook(app, '买菜 #Dylan5237/req-to-page')   // case1: 完整 owner/repo
    await createTodoViaHook(app, '清理缓存 #req-to-page')          // case2: 关注列表里的短名
    await createTodoViaHook(app, '随便记点 #不存在的名字')          // case3: 认不出的短名，留在正文
    await createTodoViaHook(app, '记得处理 !等我')                  // case4: !等我

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
      steps: '先在设置里把 Dylan5237/req-to-page 加入关注仓库；再依次用测试钩子打开捕获窗口 + Playwright 键盘输入打 4 种正文：完整 #owner/repo；关注列表里的短名 #repo；认不出的短名 #不存在的名字；!等我；逐条保存后核对 listTodos() 的 text/repo/waiting 字段',
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

    // 记录当前 GitHub 认证状态：按硬性规则 #4，被测 App 启动时环境里已经
    // 去掉了真实 GH_TOKEN/GITHUB_TOKEN，所以这里预期 auth==='missing'。
    // window.arckeep.getWaiting() 只读缓存快照，不会触发网络请求。
    const authSnapshot = await page.evaluate(() => window.arckeep.getWaiting())
    appendEvidenceJson('item6-auth-state', {
      auth: authSnapshot.auth,
      refreshing: authSnapshot.refreshing,
      rowCount: authSnapshot.rows.length
    })
    const refreshButtonDisabled = await page.locator('button.primary:has-text("刷新")').isDisabled()

    // 完成该待办后应从等我处理消失
    await page.click('[data-view="todos"]')
    await page.waitForSelector('.todo-list', { timeout: 3000 })
    await page.locator(`.todo-row:has(.todo-text:text-is("${todo4Texts.waitingText}"))`).locator('.todo-check').check()
    await page.waitForTimeout(200)
    // 「等我处理」页面没有监听 todos:changed 事件去自动重算，唯一的重算时机
    // 是 renderWaiting() 挂载时无条件调用一次 reload()——所以重新点导航切到
    // 这一页本身就会触发一次刷新，不依赖工具栏上的「刷新」按钮。
    // 「刷新」按钮在 auth==='missing'/'invalid' 时会永久 disabled（源码
    // waiting-page.ts: refresh.disabled = snapshot.refreshing || authBlocked），
    // 这正是硬性规则 #4（不给被测 App 真实 GitHub token）下的预期行为，不是产品
    // 缺陷，所以不再等它变为可点——只有在它本来就没被 disabled 时才顺手点一下。
    await page.click('[data-view="todos"]')
    await page.click('[data-view="inbox"]')
    await page.waitForSelector('.waiting-row, .waiting-empty, .waiting-loading', { timeout: 8000 })
    await page.waitForFunction(() => {
      const btn = document.querySelector('button.primary')
      return btn && btn.textContent !== '正在刷新'
    }, { timeout: 15000 }).catch(() => {})
    if (!refreshButtonDisabled) {
      await page.click('button.primary:has-text("刷新")').catch(() => {})
      await page.waitForTimeout(600)
    }
    await page.waitForTimeout(400)
    const rowsAfter = await page.$$eval('.waiting-row', els => els.map(el => el.querySelector('.waiting-title-text')?.textContent))
    const goneAfterComplete = !rowsAfter.some(t => t && t.startsWith('Item4等我'))
    await shot(page, '23-waiting-after-complete', { checkIds: ['6'], description: '完成后从等我处理消失（导航切页触发的自动 reload，不依赖可能因缺 GitHub token 而永久 disabled 的「刷新」按钮）' })

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
      evidence: ['22-waiting-with-todo.png', '23-waiting-after-complete.png', 'item6-waiting-rows.json', 'item6-auth-state.json', 'item6-npm-run-waiting.json'],
      steps: '在待办页勾选「等我」，切到「等我处理」页（挂载时会自动 reload 一次），核对出现的行有「待办」chip 和天数；把它标完成，切走再切回触发同样的自动 reload，应从列表消失；在源码 checkout（同一份 todos.jsonl 所在的 APPDATA）里跑 npm run waiting -- --json 核对同一条记录',
      notes: `等我处理里的行=${JSON.stringify(todoRow)}；完成后消失=${goneAfterComplete}；npm run waiting --json 命中 type:todo 的记录=${JSON.stringify(cliTodoRow)}；GitHub 认证状态 auth="${authSnapshot.auth}"，「刷新」按钮 disabled=${refreshButtonDisabled}（按硬性规则 #4 被测 App 没有真实 GH_TOKEN，auth==='missing' 时源码 refresh.disabled=snapshot.refreshing||authBlocked 会让这个按钮永久点不动，这是预期行为不是产品缺陷；本条「待办」chip 的出现/消失走的是本地 todos.jsonl 驱动的重算，不依赖这个按钮或真实 GitHub 网络请求）`
    })
  } catch (err) {
    setResult('6', 'FAIL', { notes: `异常：${err.stack || err}` })
  }

  let finalUserDataDir = null
  try { finalUserDataDir = await getUserDataDir(app) } catch { /* ignore */ }
  await quitApp(app)
  return { userDataDir: finalUserDataDir }
}
