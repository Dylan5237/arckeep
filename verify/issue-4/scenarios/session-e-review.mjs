// Session E：PR #18 设计评审的五处改动（R1-R5）
// 覆盖 checklist: R1, R2, R3, R4, R5
//
// 环境限制说明（详见 evidence/preflight.json + scenarios/session-0-preflight.mjs、
// session-a.mjs 文件头部）：这个 GitHub-hosted windows-latest 环境里 PowerShell
// SendInput 在 Win32 层调用不报错，但目标窗口完全收不到任何按键效果——这是 CI 平台的
// 会话/输入桌面限制，不是产品缺陷。因此本文件里：
//   - 需要「打开捕获窗口」但不是在测热键机制本身的地方（R3/R4/R5 的 makeTodo），
//     改用 openCaptureViaHook()（测试钩子 IPC 打开，与真实热键走同一段主进程
//     openCapture 代码路径）+ Playwright 自己的 page.keyboard（CDP 真实按键事件，
//     经过 Chromium 输入管线，会真正触发渲染进程的 keydown 监听器）。
//   - R2「录制热键」：产品代码里 record 按钮监听的是 #hotkey-input 上一个普通的
//     window/DOM keydown 事件（见 src/renderer/main.ts 的 acceleratorFromEvent），
//     完全不经过 Electron 的 globalShortcut/OS 层，所以用 Playwright 自己的按键组合
//     模拟（pressAcceleratorViaPlaywright）就是这段逻辑的真实测试，不受环境限制影响。
//   - R1「顶部横幅只反映当前生效的热键」核心断言（各状态下 getState()/DOM 横幅可见性）
//     同样不依赖 SendInput；「真实按键确认新/旧组合是否生效」这个确认性子步骤在这个
//     环境不可用，改为尝试性证据（不纳入判定），与 session-c-occupied.mjs 里 9/E2 的处理一致。
import fs from 'node:fs'
import path from 'node:path'
import * as lib from '../lib.mjs'

const {
  setResult, mergeNotes, EVIDENCE_DIR, envFlags,
  launchApp, mainWindowPage, openCaptureViaHook, createTodoViaHook, refocusCapture, quitApp, killStrayArckeep,
  occupyHotkey, stopOccupy, getUserDataDir, resetUserData, getAppState,
  callTestHook, sendHotkey, sendKey, startNotepad, sleep, waitFor,
  shot, fullShot, appendEvidenceJson, todosFile, captureOpensFor,
  pressAcceleratorViaPlaywright
} = lib

// R3/R5 建待办统一用 lib.createTodoViaHook()（requestSubmit() 兜底 + 显式确认窗口
// 真的关闭）——见 session-a.mjs 文件头部 A1 部分的详细说明：这个环境里 Playwright 的
// CDP Enter 不一定能可靠触发浏览器原生的隐式表单提交，改用 requestSubmit() 直接调用
// 同一个 submit 监听器更确定，也不会把未保存成功的单例捕获窗口残留给下一次调用。
const makeTodo = createTodoViaHook

export async function run() {
  killStrayArckeep()
  stopOccupy()

  // =====================================================================
  // R1：热键横幅只反映「当前生效」的热键（三态：占用->出现；改到空闲组合成功->消失；
  // 再改到另一个被占的组合但保存失败、旧组合仍生效->横幅保持不出现，只在设置页内联提示）
  // =====================================================================
  let app = null
  try {
    app = await launchApp({ label: 'R1-bootstrap' })
    const userDataDir = await getUserDataDir(app)
    await quitApp(app)
    resetUserData(userDataDir)

    const occupySpace = await occupyHotkey('Ctrl+Alt+Space')
    appendEvidenceJson('r1-occupy-space', occupySpace)
    if (!occupySpace.ok) throw new Error(`未能占住 Ctrl+Alt+Space: ${JSON.stringify(occupySpace)}`)

    app = await launchApp({ label: 'R1-state-a' })
    let page = await mainWindowPage(app, { timeoutMs: 15000 })
    await page.waitForTimeout(500)
    const stateA = await getAppState(page)
    await shot(page, '60-r1-state-a-banner', { checkIds: ['R1'], description: 'R1 状态 A：默认热键被占，顶部横幅出现且提到 Ctrl+Alt+Space' })
    const bannerAVisible = stateA.hotkeyUnavailable === 'Ctrl+Alt+Space'

    // 状态 B：改存到一个当前空闲的组合，保存应成功，横幅应消失
    await page.click('[data-view="settings"]')
    await page.waitForSelector('#hotkey-input', { timeout: 3000 })
    await page.fill('#hotkey-input', 'Ctrl+Alt+L')
    await page.click('#hotkey-save')
    await page.waitForTimeout(400)
    const stateB = await getAppState(page)
    const bannerBGone = stateB.hotkeyUnavailable === null && stateB.activeHotkey === 'Ctrl+Alt+L'
    const topBannerHiddenB = await page.evaluate(() => document.querySelector('#hotkey-banner')?.hidden !== false)
    await shot(page, '61-r1-state-b-banner-gone', { checkIds: ['R1'], description: 'R1 状态 B：改存到空闲组合 Ctrl+Alt+L 并保存成功，横幅消失，不再提旧热键' })

    // 尝试性证据（不纳入判定）：真实按键确认 Ctrl+Alt+L 生效——这个 CI 环境 SendInput 投递不通
    // （见 evidence/preflight.json），这里仍然尝试一次，结果只记录在 notes 里，不作为判定依据
    await callTestHook(app, 'close')
    await sleep(250)
    startNotepad()
    await sleep(400)
    const bWorks = await captureOpensFor(app, 'Ctrl+Alt+L', { timeoutMs: 3000 })
    if (bWorks.ok) { sendKey('Escape'); await sleep(300) }
    await callTestHook(app, 'show')
    page = await mainWindowPage(app)

    stopOccupy() // 释放 Ctrl+Alt+Space
    await sleep(300)

    // 状态 C：占住另一个组合 Ctrl+Alt+M，尝试改存过去（应失败），Ctrl+Alt+L 应仍生效，
    // 顶部横幅不应出现（只在设置页内联提示这个新的冲突组合）
    const occupyM = await occupyHotkey('Ctrl+Alt+M')
    appendEvidenceJson('r1-occupy-m', occupyM)
    if (!occupyM.ok) throw new Error(`未能占住 Ctrl+Alt+M: ${JSON.stringify(occupyM)}`)

    await page.click('[data-view="settings"]')
    await page.waitForSelector('#hotkey-input', { timeout: 3000 })
    await page.fill('#hotkey-input', 'Ctrl+Alt+M')
    await page.click('#hotkey-save')
    await page.waitForTimeout(400)
    const stateC = await getAppState(page)
    const topBannerHiddenC = await page.evaluate(() => document.querySelector('#hotkey-banner')?.hidden !== false)
    const inlineConflictText = await page.textContent('#hotkey-conflict').catch(() => null)
    await shot(page, '62-r1-state-c-inline-only', { checkIds: ['R1'], description: 'R1 状态 C：再改到被占的 Ctrl+Alt+M，保存失败但 Ctrl+Alt+L 仍生效——横幅仍应保持不出现，只提这个新组合' })
    fullShot('62-r1-state-c-inline-only', { checkIds: ['R1'], description: 'R1 状态 C 全屏' })

    // 切到待办页/等我处理页也确认顶部横幅在别的页面同样不出现
    await page.click('[data-view="todos"]')
    await page.waitForTimeout(200)
    const bannerHiddenOnTodos = await page.evaluate(() => document.querySelector('#hotkey-banner')?.hidden !== false)

    // 尝试性证据（不纳入判定）：真实按键确认 Ctrl+Alt+L 仍生效、Ctrl+Alt+M 无反应
    await callTestHook(app, 'close')
    await sleep(250)
    startNotepad()
    await sleep(400)
    const lStillWorks = await captureOpensFor(app, 'Ctrl+Alt+L', { timeoutMs: 3000 })
    if (lStillWorks.ok) { sendKey('Escape'); await sleep(300) }
    const mNoEffect = await captureOpensFor(app, 'Ctrl+Alt+M', { timeoutMs: 1200 })
    await callTestHook(app, 'show')
    stopOccupy()

    appendEvidenceJson('r1-states', {
      stateA, stateB, stateC,
      bannerAVisible, bannerBGone, topBannerHiddenB, topBannerHiddenC, bannerHiddenOnTodos,
      inlineConflictText, bWorks: bWorks.ok, lStillWorks: lStillWorks.ok, mNoEffect: mNoEffect.ok
    })

    // 核心判定：三态下横幅可见性与 getState() 都只读 IPC/DOM 状态，不依赖 SendInput。
    // 「真实按键确认新/旧组合此刻是否生效」这几个确认性子步骤在这个 CI 环境 SendInput 投递
    // 不通（见 evidence/preflight.json），不纳入判定，只作为尝试性证据记录在 notes 里。
    const coreOk = bannerAVisible && bannerBGone && topBannerHiddenB
      && stateC.hotkeyUnavailable === null && topBannerHiddenC && bannerHiddenOnTodos
      && Boolean(inlineConflictText?.includes('Ctrl+Alt+M'))

    setResult('R1', coreOk ? 'PASS' : 'FAIL', {
      evidence: ['60-r1-state-a-banner.png', '61-r1-state-b-banner-gone.png', '62-r1-state-c-inline-only.png', '62-r1-state-c-inline-only-full.png', 'r1-states.json'],
      steps: '状态A：真实 RegisterHotKey 占住默认 Ctrl+Alt+Space，启动 -> 顶部横幅出现且写明 Ctrl+Alt+Space。状态B：设置页改存到当前空闲的 Ctrl+Alt+L 并保存成功 -> 横幅消失。释放 Ctrl+Alt+Space，占住 Ctrl+Alt+M。状态C：设置页改存到被占的 Ctrl+Alt+M，保存失败（Ctrl+Alt+L 仍生效）-> 核对顶部横幅在设置页和其它页面都不出现，只在设置页内联提示新的冲突组合 Ctrl+Alt+M。另尝试性验证真实按键此刻新/旧组合是否生效，但这个环境的 SendInput 投递不通，不纳入判定',
      notes: `[判定用] 状态A横幅出现且指向 Ctrl+Alt+Space=${bannerAVisible}；状态B保存成功后横幅消失=${bannerBGone}（顶部横幅隐藏=${topBannerHiddenB}）；状态C保存失败但顶部横幅仍不出现=${topBannerHiddenC}（getState().hotkeyUnavailable=${stateC.hotkeyUnavailable}，待办页同样隐藏=${bannerHiddenOnTodos}），内联提示文案="${inlineConflictText}"。[不纳入判定，仅供参考，环境 hotkeyDeliveryOk=${envFlags.hotkeyDeliveryOk}] 真实按键确认状态B新组合生效=${bWorks.ok}；状态C下 Ctrl+Alt+L 仍生效=${lStillWorks.ok}，Ctrl+Alt+M 无反应=${!mNoEffect.ok}（这个 CI 环境 SendInput 投递不通，预期均为 false/未生效；见 evidence/preflight.json）`
    })
  } catch (err) {
    setResult('R1', 'FAIL', { notes: `异常：${err.stack || err}` })
  } finally {
    stopOccupy()
    try { await quitApp(app) } catch { /* ignore */ }
  }

  // =====================================================================
  // R2：设置里只有一个热键输入框 + 「录制」按钮；真实按键录制新组合并验证
  // =====================================================================
  try {
    killStrayArckeep()
    stopOccupy()
    app = await launchApp({ label: 'R2-bootstrap' })
    const ud = await getUserDataDir(app)
    await quitApp(app)
    resetUserData(ud)

    app = await launchApp({ label: 'R2-record' })
    let page = await mainWindowPage(app, { timeoutMs: 15000 })
    // #nav 出现只代表主窗口这次导航完成，不代表渲染进程已经把 click handler 都挂好；
    // 之前有一次运行在这里刚点完 [data-view="settings"] 就等 #hotkey-input 超时
    // （3000ms），换成更宽裕的等待 + 失败时重试一次点击，避免误判成产品缺陷。
    await page.waitForTimeout(300)
    await page.click('[data-view="settings"]')
    try {
      await page.waitForSelector('#hotkey-input', { timeout: 5000 })
    } catch {
      await page.click('[data-view="settings"]')
      await page.waitForSelector('#hotkey-input', { timeout: 5000 })
    }

    const inputCount = await page.locator('.card:has(#hotkey-input) input[type="text"]').count()
    const recordButtonText = await page.textContent('#hotkey-record')
    const hasSeparateApplyButton = await page.locator('.card:has(#hotkey-input) button:has-text("改用这个")').count()
    await shot(page, '63-r2-single-input', { checkIds: ['R2'], description: 'R2：设置页热键卡片只有一个输入框 + 录制按钮（无第二个输入框/改用这个按钮）' })

    // 录制：点「录制」（点击处理里会把焦点放到输入框上），再用 Playwright 自己的 CDP 按键组合
    // 模拟按下 Ctrl+Alt+R——产品代码里 record 按钮监听的是 #hotkey-input 上一个普通的
    // window/DOM keydown 事件（见 src/renderer/main.ts 的 acceleratorFromEvent），完全不经过
    // Electron 的 globalShortcut/OS 层，所以 Playwright 的 CDP 按键事件就是这段逻辑真实、
    // 如实的测试，不受这个 CI 环境 SendInput 投递限制的影响。
    await page.click('#hotkey-record')
    await page.waitForTimeout(150)
    const recordingLabel = await page.textContent('#hotkey-record')
    const focusedIsHotkeyInput = await page.evaluate(() => document.activeElement?.id === 'hotkey-input')
    await pressAcceleratorViaPlaywright(page, ['Control', 'Alt'], 'R')
    await sleep(200)
    const inputValueAfterRecord = await page.inputValue('#hotkey-input')
    await shot(page, '64-r2-after-record', { checkIds: ['R2'], description: 'R2：Playwright 按键 Ctrl+Alt+R 录制后，输入框显示该组合' })

    await page.click('#hotkey-save')
    await page.waitForTimeout(400)
    const state = await getAppState(page)

    // 尝试性证据（不纳入判定）：真实按键验证新组合生效、旧组合（默认 Ctrl+Alt+Space）失效——
    // 这个 CI 环境的 SendInput 投递不通（见 evidence/preflight.json），这里仍然尝试一次，
    // 结果只记录在 notes 里，不作为判定依据
    await callTestHook(app, 'close')
    await sleep(250)
    startNotepad()
    await sleep(400)
    const newWorks = await captureOpensFor(app, 'Ctrl+Alt+R', { timeoutMs: 3000 })
    if (newWorks.ok) { sendKey('Escape'); await sleep(300) }
    const oldNoEffect = await captureOpensFor(app, 'Ctrl+Alt+Space', { timeoutMs: 1200 })
    await callTestHook(app, 'show')
    page = await mainWindowPage(app)

    appendEvidenceJson('r2-record', {
      inputCount, recordButtonText, hasSeparateApplyButton, recordingLabel, focusedIsHotkeyInput,
      inputValueAfterRecord, state, newWorks: newWorks.ok, oldNoEffect: oldNoEffect.ok
    })

    // 核心判定：录制卡片结构 + Playwright 真实按键组合能被 acceleratorFromEvent 正确识别并写入
    // 输入框 + 保存后 activeHotkey 生效——这些都是 DOM 结构/IPC 状态，不依赖 OS SendInput。
    // 「真实按键确认新组合生效、旧组合失效」这个确认性子步骤在这个环境不可用，不纳入判定。
    const coreOk = inputCount === 1 && recordButtonText === '录制' && hasSeparateApplyButton === 0
      && recordingLabel === '请按键…' && inputValueAfterRecord === 'Ctrl+Alt+R'
      && state.activeHotkey === 'Ctrl+Alt+R'

    setResult('R2', coreOk ? 'PASS' : 'FAIL', {
      evidence: ['63-r2-single-input.png', '64-r2-after-record.png', 'r2-record.json'],
      steps: '设置页热键卡片：核对只有一个 #hotkey-input 输入框、没有「改用这个」这类第二个按钮；点击「录制」（文案变「请按键…」）后用 Playwright 自己的 CDP 按键组合模拟按下 Ctrl+Alt+R（这段逻辑是产品代码里的 DOM keydown 监听器，不经过 OS 全局热键层，Playwright 按键是真实、如实的测试），输入框应显示该组合；点「保存热键」。另尝试性验证真实按键此刻新组合是否生效、旧组合是否失效，但这个环境的 SendInput 投递不通，不纳入判定',
      notes: `[判定用] 输入框数量=${inputCount}（应为1）；录制按钮文案=${recordButtonText}；是否存在第二个「改用这个」按钮=${hasSeparateApplyButton > 0}（应为false）；点击录制后按钮文案=${recordingLabel}；Playwright 按键录制后输入框值=${inputValueAfterRecord}；保存后 activeHotkey=${state.activeHotkey}。[不纳入判定，仅供参考，环境 hotkeyDeliveryOk=${envFlags.hotkeyDeliveryOk}] 真实按键确认新组合生效=${newWorks.ok}，旧组合已失效=${!oldNoEffect.ok}（这个 CI 环境 SendInput 投递不通，预期分别为 false/true；见 evidence/preflight.json）`
    })
  } catch (err) {
    setResult('R2', 'FAIL', { notes: `异常：${err.stack || err}` })
  } finally {
    stopOccupy()
    try { await quitApp(app) } catch { /* ignore */ }
  }

  // =====================================================================
  // R3：删除立即生效 + 「已删除 · 撤销」；撤销后原样恢复（文字/repo/等我/完成状态/位置 + jsonl）；
  // 不撤销则提示消失后保持删除；记录提示停留时长
  // =====================================================================
  try {
    killStrayArckeep()
    stopOccupy()
    app = await launchApp({ label: 'R3-bootstrap' })
    const ud = await getUserDataDir(app)
    await quitApp(app)
    resetUserData(ud)

    app = await launchApp({ label: 'R3-delete-undo' })
    let page = await mainWindowPage(app)

    page = await makeTodo(app, 'R3-第一条')
    page = await makeTodo(app, 'R3-第二条-带仓库 #example/demo')
    page = await makeTodo(app, 'R3-第三条-等我', { waiting: true })

    page = await mainWindowPage(app)
    await page.click('[data-view="todos"]')
    try {
      await page.waitForSelector('.todo-list', { timeout: 3000 })
    } catch {
      page = await mainWindowPage(app)
      await page.click('[data-view="todos"]')
      await page.waitForSelector('.todo-list', { timeout: 5000 })
    }

    const before = await page.evaluate(() => window.arckeep.listTodos())
    const target = before.find(i => i.text === 'R3-第二条-带仓库')
    const targetIndexBefore = before.findIndex(i => i.id === target.id)
    appendEvidenceJson('r3-before', { before, targetIndexBefore })

    const rowSelector = (text) => `.todo-row:has(.todo-text:text-is("${text}"))`
    const deleteAt = Date.now()
    await page.locator(rowSelector('R3-第二条-带仓库')).locator('[data-action="delete"]').click()
    await page.waitForTimeout(100)
    const modalCount = await page.locator('.modal-backdrop').count()
    const undoBarText = await page.textContent('.todo-undo').catch(() => null)
    await shot(page, '65-r3-deleted-undo-bar', { checkIds: ['R3'], description: 'R3：点删除立即生效，无确认框，底部出现「已删除 · 撤销」' })

    const userDataDir = await getUserDataDir(app)
    const jsonlAfterDelete = fs.readFileSync(todosFile(userDataDir), 'utf8')
    const opsAfterDelete = jsonlAfterDelete.trim().split('\n').map(l => JSON.parse(l).op)

    // 点撤销：应原样恢复（文字、repo、等我、完成状态、列表位置），jsonl 应新增一条 restore
    await page.click('[data-action="undo-delete"]')
    const undoClickAt = Date.now()
    await page.waitForTimeout(200)
    const undoBarGoneImmediately = (await page.locator('[data-action="undo-delete"]').count()) === 0
    const after = await page.evaluate(() => window.arckeep.listTodos())
    const restored = after.find(i => i.id === target.id)
    const restoredIndex = after.findIndex(i => i.id === target.id)
    await shot(page, '66-r3-after-undo', { checkIds: ['R3'], description: 'R3：点撤销后该条原样恢复' })

    const jsonlAfterUndo = fs.readFileSync(todosFile(userDataDir), 'utf8')
    const opsAfterUndo = jsonlAfterUndo.trim().split('\n').map(l => JSON.parse(l).op)
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'r3-todos.jsonl.txt'), jsonlAfterUndo, 'utf8')

    const restoredMatches = Boolean(restored) && restored.text === target.text && restored.repo === target.repo
      && restored.waiting === target.waiting && restored.completed === target.completed
      && restored.createdAt === target.createdAt && restoredIndex === targetIndexBefore

    // 不撤销场景：另建一条，删除后不点撤销，测提示停留时长，过期后保持删除、重启后也不再出现。
    // 这条提示消失靠的是渲染进程里的 window.setTimeout(..., 5000)（见 src/renderer/todos-page.ts
    // 的 onDeleted），Electron 默认 backgroundThrottling=true，如果主窗口在这个 CI 环境本身
    // 就有的焦点/可见性抖动下被 Chromium 判定成「不可见」，这个定时器可能被节流延迟触发。
    // 用 bringToFront() 尽量让窗口保持前台/可见，并把轮询超时放宽到远大于 5000ms 的安全边际，
    // 避免把「定时器被节流延迟」误判成「提示没有消失」的产品问题。
    await page.bringToFront().catch(() => {})
    page = await makeTodo(app, 'R3-不撤销的这条')
    page = await mainWindowPage(app)
    await page.bringToFront().catch(() => {})
    await page.click('[data-view="todos"]')
    await page.waitForSelector('.todo-list', { timeout: 3000 })
    const t2 = Date.now()
    await page.locator(rowSelector('R3-不撤销的这条')).locator('[data-action="delete"]').click()
    const barAppearedAt = Date.now()
    let barGoneAt = null
    const barGone = await waitFor(async () => {
      const count = await page.locator('[data-action="undo-delete"]').count()
      if (count === 0) { barGoneAt = Date.now(); return true }
      return false
    }, { timeoutMs: 20000, intervalMs: 100 })
    const undoBarDurationMs = barGone.ok ? (barGoneAt - barAppearedAt) : null
    await shot(page, '67-r3-undo-bar-expired', { checkIds: ['R3'], description: 'R3：不点撤销，提示消失后这条保持已删除' })

    await quitApp(app)
    app = await launchApp({ label: 'R3-after-restart' })
    page = await mainWindowPage(app)
    await page.click('[data-view="todos"]')
    await page.waitForSelector('.todo-list', { timeout: 3000 })
    const goneAfterRestart = (await page.locator(rowSelector('R3-不撤销的这条')).count()) === 0
    const restoredStillThereAfterRestart = (await page.locator(rowSelector('R3-第二条-带仓库')).count()) === 1

    appendEvidenceJson('r3-summary', {
      target, restored, targetIndexBefore, restoredIndex,
      opsAfterDelete, opsAfterUndo, undoBarText, modalCount,
      undoBarDurationMs, goneAfterRestart, restoredStillThereAfterRestart
    })

    const ok = modalCount === 0 && Boolean(undoBarText?.includes('已删除')) && undoBarText?.includes('撤销')
      && opsAfterDelete[opsAfterDelete.length - 1] === 'delete'
      && opsAfterUndo[opsAfterUndo.length - 1] === 'restore'
      && restoredMatches && undoBarGoneImmediately
      && undoBarDurationMs !== null && undoBarDurationMs > 4000 && undoBarDurationMs < 10000
      && goneAfterRestart && restoredStillThereAfterRestart

    setResult('R3', ok ? 'PASS' : 'FAIL', {
      evidence: ['65-r3-deleted-undo-bar.png', '66-r3-after-undo.png', '67-r3-undo-bar-expired.png', 'r3-summary.json', 'r3-todos.jsonl.txt'],
      steps: '新建 3 条（含 repo/等我）；删除中间那条 -> 核对无 .modal-backdrop、底部出现「已删除 · 撤销」、jsonl 立即多一条 delete 事件；点撤销 -> 核对文字/repo/等我/完成状态/createdAt/列表位置与删除前完全一致，jsonl 多一条 restore 事件；另建一条，删除后不点撤销，计时提示自然消失所需时长，过期后仍保持删除，重启后也不再出现，同时确认前面撤销恢复的那条重启后仍在',
      notes: `无确认框=${modalCount === 0}；提示文案="${undoBarText}"；jsonl 删除后末尾操作=${opsAfterDelete[opsAfterDelete.length - 1]}；撤销后末尾操作=${opsAfterUndo[opsAfterUndo.length - 1]}；撤销恢复是否完全一致（文字/repo/等我/完成态/createdAt/位置）=${restoredMatches}（删除前=${JSON.stringify(target)}，恢复后=${JSON.stringify(restored)}，位置 before=${targetIndexBefore} after=${restoredIndex}）；点撤销后提示是否立即消失=${undoBarGoneImmediately}；不撤销时提示停留时长=${undoBarDurationMs}ms（TODO_DELETE_UNDO_MS 常量=5000ms）；过期后重启仍不在=${goneAfterRestart}；撤销恢复的那条重启后仍在=${restoredStillThereAfterRestart}`
    })
  } catch (err) {
    setResult('R3', 'FAIL', { notes: `异常：${err.stack || err}` })
  } finally {
    try { await quitApp(app) } catch { /* ignore */ }
  }

  // =====================================================================
  // R4：待办的 repo 字段填了值时用正常文字颜色（不是占位符灰色）—— 快速捕获 #repo 输入框
  // =====================================================================
  try {
    killStrayArckeep()
    app = await launchApp({ label: 'R4-repo-color' })
    const ud = await getUserDataDir(app)
    await quitApp(app)
    resetUserData(ud)

    app = await launchApp({ label: 'R4-color' })
    let page = await mainWindowPage(app)
    await callTestHook(app, 'close')
    await sleep(150)
    const cap = await openCaptureViaHook(app)

    const colorsEmpty = await cap.evaluate(() => {
      const el = document.querySelector('#repo')
      const typed = getComputedStyle(el).color
      const ph = getComputedStyle(el, '::placeholder').color
      return { typed, placeholder: ph, value: el.value }
    })
    await shot(cap, '68-r4-repo-empty', { checkIds: ['R4'], description: 'R4：仓库输入框为空时（显示占位符 owner/repo，可选）' })

    await cap.click('#repo')
    await cap.type('#repo', 'example/demo')
    await sleep(100)
    const colorsFilled = await cap.evaluate(() => {
      const el = document.querySelector('#repo')
      return { typed: getComputedStyle(el).color, value: el.value }
    })
    await shot(cap, '69-r4-repo-filled', { checkIds: ['R4'], description: 'R4：仓库输入框填了值后（应为正文颜色，不是占位符灰色）' })
    await refocusCapture(app, cap)
    await cap.press('#repo', 'Escape')
    await sleep(300)
    await callTestHook(app, 'show')

    appendEvidenceJson('r4-colors', { colorsEmpty, colorsFilled })

    // 「填值时用正文颜色」= 有值时的文字颜色应与占位符颜色不同（更深/更实），且与设计里正文色一致
    const differsFromPlaceholder = colorsEmpty.typed !== colorsEmpty.placeholder
    const filledMatchesTypedColor = colorsFilled.typed === colorsEmpty.typed // color 属性对输入内容始终生效，只有 ::placeholder 是另一套颜色
    const ok = differsFromPlaceholder && filledMatchesTypedColor && colorsFilled.value === 'example/demo'

    setResult('R4', ok ? 'PASS' : 'FAIL', {
      evidence: ['68-r4-repo-empty.png', '69-r4-repo-filled.png', 'r4-colors.json'],
      steps: '用测试钩子打开快速捕获窗口（与真实热键走同一段主进程 openCapture 代码路径），仓库输入框为空时用 getComputedStyle(el).color 读正文色、getComputedStyle(el, "::placeholder").color 读占位符色；用 Playwright 键盘输入打入 example/demo 后再次读正文色，核对填值前后文字颜色一致（都是正文色），且与占位符颜色不同（颜色比较逻辑本身不依赖打开窗口的方式或按键投递机制）',
      notes: `空白时正文色(CSS color 属性)=${colorsEmpty.typed}，占位符色=${colorsEmpty.placeholder}（两者不同=${differsFromPlaceholder}）；填值后正文色=${colorsFilled.typed}（与空白时的正文色一致=${filledMatchesTypedColor}，说明填值用的不是占位符灰色）；源码 src/renderer/capture.css 的 .capture-repo input { color: var(--arckeep-deep-charcoal) } 与 .capture-repo input::placeholder { color: var(--arckeep-muted-graphite) } 印证`
    })
  } catch (err) {
    setResult('R4', 'FAIL', { notes: `异常：${err.stack || err}` })
  } finally {
    try { await quitApp(app) } catch { /* ignore */ }
  }

  // =====================================================================
  // R5：已完成待办默认折叠进「已完成 · N」分组，N 与实际一致；展开/折叠可用；
  // 取消完成后回到未完成列表，N 随之变化
  // =====================================================================
  try {
    killStrayArckeep()
    app = await launchApp({ label: 'R5-bootstrap' })
    const ud = await getUserDataDir(app)
    await quitApp(app)
    resetUserData(ud)

    app = await launchApp({ label: 'R5-completed-group' })
    let page = await mainWindowPage(app)

    page = await makeTodo(app, 'R5-未完成-1')
    page = await makeTodo(app, 'R5-未完成-2')
    page = await makeTodo(app, 'R5-待完成-A')
    page = await makeTodo(app, 'R5-待完成-B')

    page = await mainWindowPage(app)
    await page.click('[data-view="todos"]')
    await page.waitForSelector('.todo-list', { timeout: 3000 })

    const rowSelector = (text) => `.todo-row:has(.todo-text:text-is("${text}"))`
    await page.locator(rowSelector('R5-待完成-A')).locator('.todo-check').check()
    await page.waitForTimeout(150)
    await page.locator(rowSelector('R5-待完成-B')).locator('.todo-check').check()
    await page.waitForTimeout(150)

    // 重新加载待办页（模拟重新进入），核对默认是折叠的
    await page.click('[data-view="settings"]')
    await page.click('[data-view="todos"]')
    await page.waitForSelector('[data-action="completed-group"]', { timeout: 3000 })
    const detailsOpenDefault = await page.locator('[data-action="completed-group"]').evaluate(el => el.open)
    const summaryText = await page.textContent('[data-action="completed-group"] summary')
    const completedCountInDom = await page.locator('[data-action="completed-group"] .todo-row').count()
    const allItems = await page.evaluate(() => window.arckeep.listTodos())
    const actualCompletedCount = allItems.filter(i => i.completed).length
    await shot(page, '70-r5-collapsed-default', { checkIds: ['R5'], description: 'R5：已完成默认折叠，标题「已完成 · N」' })

    // <details> 的 toggle 事件是异步派发的，run7 撞到过点击后立刻（150ms）读 el.open
    // 读到点击生效前的旧值；把点击后的等待从 150ms 放宽到 500ms 再读，给 toggle 事件+
    // localStorage 写回+可能的重绘留够时间（不改变判定逻辑本身，只是给异步状态更多
    // 时间落地，跟 R2/R3 之前放宽超时是同一类调整）。
    await page.click('[data-action="completed-group"] summary')
    await page.waitForTimeout(500)
    const detailsOpenAfterClick = await page.locator('[data-action="completed-group"]').evaluate(el => el.open)
    const visibleAfterExpand = await page.locator('[data-action="completed-group"] .todo-row').count()
    await shot(page, '71-r5-expanded', { checkIds: ['R5'], description: 'R5：点击后展开，能看到已完成的两条' })

    // 折叠回去
    await page.click('[data-action="completed-group"] summary')
    await page.waitForTimeout(500)
    const detailsOpenAfterSecondClick = await page.locator('[data-action="completed-group"]').evaluate(el => el.open)
    await shot(page, '72-r5-collapsed-again', { checkIds: ['R5'], description: 'R5：再次点击折叠回去' })

    // 取消完成一条，应回到未完成列表，N 减少
    // 分组渲染逻辑（todos-page.ts）每次重绘都用 group.open = storedCompletedOpen()
    // 从 localStorage 读值；而 <details> 的 toggle 事件是异步派发的，如果点击之后、
    // toggle 事件把新状态写回 localStorage 之前，正好来了一次跟本次点击无关的重绘
    // （比如 onTodosChanged 广播触发的 draw()），新画出来的 <details> 就会用旧值把
    // 刚才这次点击「视觉上顶开了、状态上又合上」。所以这里不是点一次就假设一定展开，
    // 而是轮询校验 el.open === true，没展开就再点一次，直到真的展开或者放弃重试。
    let openRetries = 0
    let reopened = false
    for (let i = 0; i < 8; i++) {
      const isOpen = await page.locator('[data-action="completed-group"]').evaluate(el => el.open).catch(() => false)
      if (isOpen) { reopened = true; break }
      await page.click('[data-action="completed-group"] summary').catch(() => {})
      openRetries = i + 1
      await page.waitForTimeout(250)
    }
    appendEvidenceJson('r5-reopen-before-uncheck', { reopened, openRetries })
    await page.waitForSelector(`${rowSelector('R5-待完成-A')} .todo-check`, { state: 'visible', timeout: 5000 })
    await page.locator(rowSelector('R5-待完成-A')).locator('.todo-check').uncheck()
    await page.waitForTimeout(200)
    const summaryTextAfterUncheck = await page.textContent('[data-action="completed-group"] summary').catch(() => null)
    const backInOpenList = await page.locator('.todo-list').first().locator(rowSelector('R5-待完成-A')).count()
    await shot(page, '73-r5-uncheck-moves-back', { checkIds: ['R5'], description: 'R5：取消完成后该条回到未完成列表，N 随之变化' })

    appendEvidenceJson('r5-summary', {
      detailsOpenDefault, summaryText, completedCountInDom, actualCompletedCount,
      detailsOpenAfterClick, visibleAfterExpand, detailsOpenAfterSecondClick,
      summaryTextAfterUncheck, backInOpenList
    })

    const ok = detailsOpenDefault === false && summaryText === `已完成 · ${actualCompletedCount}`
      && completedCountInDom === actualCompletedCount && actualCompletedCount === 2
      && detailsOpenAfterClick === true && visibleAfterExpand === 2
      && detailsOpenAfterSecondClick === false
      && summaryTextAfterUncheck === `已完成 · ${actualCompletedCount - 1}`
      && backInOpenList === 1

    setResult('R5', ok ? 'PASS' : 'FAIL', {
      evidence: ['70-r5-collapsed-default.png', '71-r5-expanded.png', '72-r5-collapsed-again.png', '73-r5-uncheck-moves-back.png', 'r5-summary.json', 'r5-reopen-before-uncheck.json'],
      steps: '新建 4 条待办，完成其中 2 条；重新进入待办页，核对「已完成」分组默认折叠（<details open===false>）、标题「已完成 · N」与实际完成数一致；点击标题展开能看到这些行；再点击折叠回去；取消其中一条完成状态，核对它回到未完成列表、N 相应减一',
      notes: `默认折叠=${!detailsOpenDefault}；标题="${summaryText}"（实际完成数=${actualCompletedCount}）；DOM 内可见行数与实际一致=${completedCountInDom === actualCompletedCount}；点击展开后 open=${detailsOpenAfterClick}，可见行数=${visibleAfterExpand}；再次点击折叠后 open=${detailsOpenAfterSecondClick}（应为false）；取消完成前重新展开是否需要多次点击=${reopened ? `是，重试 ${openRetries} 次后才真正展开` : '未能展开（放弃重试）'}（若>0 次说明碰到了 <details> toggle 事件异步写 localStorage 与后台重绘的时序竞争，见代码注释，这不是本条要测的行为，只是为了绕开测试环境里的时序竞争，产品本身「点了却没展开」这个现象本身值得关注）；取消完成后标题="${summaryTextAfterUncheck}"；该条是否回到未完成列表=${backInOpenList === 1}`
    })
  } catch (err) {
    setResult('R5', 'FAIL', { notes: `异常：${err.stack || err}` })
  } finally {
    try { await quitApp(app) } catch { /* ignore */ }
  }
}
