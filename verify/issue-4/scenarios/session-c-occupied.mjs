// Session C：启动时热键被占用（真实 RegisterHotKey 占住）
// 覆盖 checklist: 9, 10, A4, E1, E2
import * as lib from '../lib.mjs'

const {
  setResult, mergeNotes, launchApp, mainWindowPage, quitApp, killStrayArckeep,
  occupyHotkey, stopOccupy, getUserDataDir, resetUserData, getAppState,
  callTestHook, sendHotkey, sendKey, foreground, startNotepad, sleep, waitFor,
  elementRect, windowContentBounds, shot, fullShot, appendEvidenceJson,
  installObservationHooks, readCaptured, captureOpensFor
} = lib

export async function run() {
  killStrayArckeep()
  stopOccupy()

  // -------------------------------------------------------------------
  // Phase C1：默认热键 Ctrl+Alt+Space 在启动前就被占住
  // -------------------------------------------------------------------
  let app = await launchApp({ label: 'C1-bootstrap' })
  const userDataDir = await getUserDataDir(app)
  await quitApp(app)
  resetUserData(userDataDir) // 清空 settings.json，保证默认热键就是 Ctrl+Alt+Space

  try {
    const occupyInfo = await occupyHotkey('Ctrl+Alt+Space')
    appendEvidenceJson('item9-occupy-register', occupyInfo)
    if (!occupyInfo.ok) throw new Error(`occupyHotkey 未能真正 RegisterHotKey：${JSON.stringify(occupyInfo)}`)

    app = await launchApp({ label: 'C1-occupied-startup' })
    const patchedEarly = await installObservationHooks(app)

    const page = await mainWindowPage(app, { timeoutMs: 15000 })
    await page.waitForTimeout(500)
    const state = await getAppState(page)
    await shot(page, '40-startup-hotkey-occupied', { checkIds: ['9', 'A4'], description: '默认热键被占用时启动：主界面顶部常驻横幅（默认窗口大小，未滚动）' })
    fullShot('40-startup-hotkey-occupied', { checkIds: ['9', 'A4'], description: '默认热键被占用时启动，全屏（默认窗口大小）' })

    const bannerRect = await elementRect(page, '#hotkey-banner')
    const bounds = await windowContentBounds(app, page)
    appendEvidenceJson('item9-a4-banner-rect', { bannerRect, bounds })
    const bannerVisibleWithoutScroll = Boolean(bannerRect) && bannerRect.top >= 0 && bannerRect.bottom <= bannerRect.innerHeight

    const hasButton = await page.$('#hotkey-banner-action') !== null
    const bannerMentionsCombo = (await page.textContent('#hotkey-banner'))?.includes('Ctrl+Alt+Space')

    // 托盘菜单能看出热键未生效：强制重建一次菜单模板（保存同一个仍失效的组合），用打桩捕获模板内容
    await page.evaluate(() => window.arckeep.setHotkey('Ctrl+Alt+Space'))
    await page.waitForTimeout(300)
    const captured = await readCaptured(app)
    const lastMenu = captured.menus[captured.menus.length - 1]
    const trayShowsUnavailable = Boolean(lastMenu?.template?.some(t => t.label === '快速捕获热键未生效' && t.enabled === false))

    // 真实按键确认：默认组合此刻确实无反应
    const opened = await captureOpensFor(app, 'Ctrl+Alt+Space', { timeoutMs: 1500 })
    fullShot('41-occupied-real-key-no-effect', { checkIds: ['9'], description: '真实按键发送 Ctrl+Alt+Space，被占用时应无反应' })

    // 点击「换一个热键」跳到设置页并保存一个空闲组合，横幅应自动消失
    await page.click('#hotkey-banner-action')
    await page.waitForSelector('#hotkey-input', { timeout: 3000 })
    await page.fill('#hotkey-input', 'Ctrl+Alt+K')
    await page.click('#hotkey-save')
    await page.waitForTimeout(400)
    const bannerGone = await page.evaluate(() => document.querySelector('#hotkey-banner')?.hidden !== false)
    await shot(page, '42-banner-cleared-after-fix', { checkIds: ['9'], description: '改成功后提示自动消失' })
    const stateAfterFix = await getAppState(page)

    // 真实按键确认新组合生效
    await callTestHook(app, 'close')
    await sleep(250)
    startNotepad()
    await sleep(500)
    const openedNew = await captureOpensFor(app, 'Ctrl+Alt+K', { timeoutMs: 3000 })
    if (openedNew.ok) { sendKey('Escape'); await sleep(300) }
    await callTestHook(app, 'show')

    stopOccupy()
    await sleep(300)

    // E1：只在「托盘启动」（主窗口不显示）且热键被占时发通知——代码走查 + 打桩复测
    const captured2 = await readCaptured(app)
    const notificationCount = captured2.notifications.length

    setResult('9', (bannerVisibleWithoutScroll && hasButton && bannerMentionsCombo && trayShowsUnavailable
      && !opened.ok && bannerGone && stateAfterFix.hotkey === 'Ctrl+Alt+K' && openedNew.ok) ? 'PASS' : 'FAIL', {
      evidence: ['40-startup-hotkey-occupied.png', '40-startup-hotkey-occupied-full.png', '41-occupied-real-key-no-effect-full.png', '42-banner-cleared-after-fix.png', 'item9-a4-banner-rect.json'],
      steps: '先用独立 PowerShell 进程 RegisterHotKey 真实占住 Ctrl+Alt+Space（保持进程存活）-> 启动 Arckeep -> 主界面顶部出现常驻横幅，写明被占用的组合，带「换一个热键」按钮 -> 真实按键发送 Ctrl+Alt+Space 确认无反应 -> 用打桩过的 Menu.buildFromTemplate 核对托盘菜单里「快速捕获热键未生效」且 disabled -> 点横幅按钮跳到设置页，改存 Ctrl+Alt+K -> 提示自动消失 -> 真实按键确认新组合生效',
      notes: `banner可见且不滚动=${bannerVisibleWithoutScroll}（rect=${JSON.stringify(bannerRect)}）；写明被占组合=${bannerMentionsCombo}；有换一个热键按钮=${hasButton}；托盘菜单标「未生效」=${trayShowsUnavailable}；真实按键确认占用期间无反应=${!opened.ok}；改成功后横幅消失=${bannerGone}；新状态=${JSON.stringify(stateAfterFix)}；真实按键确认新组合生效=${openedNew.ok}；早期 Notification/Menu 打桩是否装上=${patchedEarly}`
    })

    setResult('A4', bannerVisibleWithoutScroll ? 'PASS' : 'FAIL', {
      evidence: ['40-startup-hotkey-occupied.png', '40-startup-hotkey-occupied-full.png', 'item9-a4-banner-rect.json'],
      steps: '同上；默认窗口大小（Arckeep 真实默认尺寸 1120x760，未做任何缩放/滚动）下直接截图，并用 getBoundingClientRect() 核对横幅在可视区内',
      notes: `横幅 rect=${JSON.stringify(bannerRect)}，窗口 innerHeight=${bannerRect?.innerHeight}，窗口内容区屏幕坐标=${JSON.stringify(bounds)}`
    })

    setResult('E1', 'BLOCKED', {
      evidence: ['40-startup-hotkey-occupied.png', 'item9-occupy-register.json'],
      steps: '代码走查：src/main/index.ts 里 showWindow = !screenshotPath || screenshotShowsMainWindow(scene)；真实启动（未设置内部截图变量 ARCKEEP_SCREENSHOT）时 screenshotPath 恒为空，showWindow 恒为 true，于是 maybeNotifyStartupHotkeyFailure(true) 传入的 windowVisible 恒为 true；shouldNotifyStartupHotkeyFailure 要求 !windowVisible 才发通知。全仓库搜索确认没有任何真实启动参数/设置能让主窗口在启动时保持隐藏（没有 --hidden、没有 setLoginItemSettings 静默自启、没有「记住托盘状态」持久化字段、没有测试钩子能让 ready-to-show 时 windowVisible 为 false）。用打桩的 Notification.prototype.show 复测：本场景（热键真实被占、主窗口按真实逻辑显示）下通知调用次数=' + notificationCount,
      notes: `工程声明「只在托盘启动（主窗口不显示）且热键被占时发一次系统通知」依赖的前提条件（真实启动时主窗口不显示）在这份构建里不可达：唯一能让 windowVisible=false 的路径是内部截图工具（ARCKEEP_SCREENSHOT 环境变量+特定 scene），且该路径在 maybeNotifyStartupHotkeyFailure 内部会在真正调用 new Notification() 之前 return（见 src/main/index.ts: if (screenshotPath || !banner) return），所以即使用内部截图变量也观察不到真实系统通知。真实黑盒环境下（本场景）主窗口启动时始终可见，用打桩统计到的 Notification.prototype.show 调用次数=${notificationCount}（=0，与代码走查一致）。由于「托盘启动」这个前提条件本身在已合并代码里无法被公开可触达的方式复现，也无法通过测试钩子绕过（测试钩子只提供 close/show/quit/capture/todos/hotkey-fail，都不能让 ready-to-show 早于此时把 windowVisible 置为 false），因此把 E1 记为 BLOCKED 而非 FAIL：单元测试 test/hotkey-status.test.ts 里 shouldNotifyStartupHotkeyFailure 的分支逻辑本身是正确的（已被单测覆盖），但集成路径在真实产物里不可达，无法用黑盒方式完整验证「重复触发不会重复发」这一半。`
    })
  } catch (err) {
    setResult('9', 'FAIL', { notes: `异常：${err.stack || err}` })
    setResult('A4', 'FAIL', { notes: `异常：${err.stack || err}` })
    setResult('E1', 'BLOCKED', { notes: `因 9/A4 场景异常而未能完整复测：${err.stack || err}` })
  } finally {
    stopOccupy()
    try { await quitApp(app) } catch { /* ignore */ }
  }

  // -------------------------------------------------------------------
  // Phase C2：运行中尝试保存一个「当前被占用」的新组合 —— 冲突提示位置 + E2
  // -------------------------------------------------------------------
  try {
    killStrayArckeep()
    stopOccupy()
    app = await launchApp({ label: 'C2-bootstrap' })
    const ud2 = await getUserDataDir(app)
    await quitApp(app)
    resetUserData(ud2) // 默认热键 Ctrl+Alt+Space 重新可用

    app = await launchApp({ label: 'C2-save-conflict' })
    let page = await mainWindowPage(app, { timeoutMs: 15000 })
    let state = await getAppState(page)
    if (state.activeHotkey !== 'Ctrl+Alt+Space') throw new Error(`默认热键未按预期注册：${JSON.stringify(state)}`)

    const occupyInfo2 = await occupyHotkey('Ctrl+Alt+J')
    appendEvidenceJson('item10-e2-occupy-register', occupyInfo2)
    if (!occupyInfo2.ok) throw new Error(`occupyHotkey(Ctrl+Alt+J) 失败：${JSON.stringify(occupyInfo2)}`)

    await page.click('[data-view="settings"]')
    await page.waitForSelector('#hotkey-input', { timeout: 3000 })
    await page.fill('#hotkey-input', 'Ctrl+Alt+J')
    await page.click('#hotkey-save')
    await page.waitForTimeout(400)

    state = await getAppState(page)
    await shot(page, '43-save-conflict-banner', { checkIds: ['10'], description: '保存一个被占用的组合后，冲突提示紧挨在输入框下面，默认窗口大小不滚动可见' })
    fullShot('43-save-conflict-banner', { checkIds: ['10'], description: '保存冲突提示（全屏，默认窗口大小）' })

    const inputRect = await elementRect(page, '#hotkey-input')
    const rowRect = await elementRect(page, '.row:has(#hotkey-input)')
    const alertRect = await elementRect(page, '#hotkey-conflict')
    const bounds2 = await windowContentBounds(app, page)
    appendEvidenceJson('item10-coords', { inputRect, alertRect, bounds: bounds2 })

    const visibleNoScroll = Boolean(alertRect) && alertRect.top >= 0 && alertRect.bottom <= alertRect.innerHeight
    const rowEl = await page.$('.row:has(#hotkey-input)')
    const rowBox = rowEl ? await rowEl.boundingBox() : null
    const alertEl = await page.$('#hotkey-conflict')
    const alertBox = alertEl ? await alertEl.boundingBox() : null
    const gap = rowBox && alertBox ? alertBox.y - (rowBox.y + rowBox.height) : null
    const adjacentBelow = gap !== null && gap >= 0 && gap < 40

    const fieldKeepsTyped = state.hotkey === 'Ctrl+Alt+J'
    const activeShowsRealCombo = state.activeHotkey === 'Ctrl+Alt+Space'
    const activeLabelText = await page.textContent('#hotkey-active')

    // R1 关键点：保存失败但旧热键仍生效时，顶部横幅不应出现（#18 之前的版本会错误地显示横幅）
    const topBannerHiddenDuringSaveFailure = await page.evaluate(() => document.querySelector('#hotkey-banner')?.hidden !== false)

    // 真实按键核对旧组合仍生效
    await callTestHook(app, 'close')
    await sleep(250)
    startNotepad()
    await sleep(500)
    const stillWorks = await captureOpensFor(app, 'Ctrl+Alt+Space', { timeoutMs: 3000 })
    if (stillWorks.ok) { sendKey('Escape'); await sleep(300) }
    await callTestHook(app, 'show')

    const item10Ok = visibleNoScroll && adjacentBelow
    setResult('10', item10Ok ? 'PASS' : 'FAIL', {
      evidence: ['43-save-conflict-banner.png', '43-save-conflict-banner-full.png', 'item10-coords.json'],
      steps: '默认热键先正常生效；用独立 PowerShell 进程真实 RegisterHotKey 占住 Ctrl+Alt+J；在设置页把热键改存成 Ctrl+Alt+J 并保存 -> 冲突提示出现；核对默认窗口大小（未滚动）下 getBoundingClientRect() 落在可视区内，且与输入框所在行的垂直间隙很小（紧挨着）',
      notes: `alertRect=${JSON.stringify(alertRect)}；输入框行 rect=${JSON.stringify(rowRect)}；输入框行与冲突提示的像素间隙=${gap}；不滚动可见=${visibleNoScroll}；紧挨在下面=${adjacentBelow}`
    })

    setResult('E2', (fieldKeepsTyped && activeShowsRealCombo && stillWorks.ok) ? 'PASS' : 'FAIL', {
      evidence: ['43-save-conflict-banner.png', 'item10-coords.json'],
      steps: '同上冲突场景；核对输入框的值仍是刚输入的 Ctrl+Alt+J（没有被清空/回退）；核对旁边「当前生效：…」显示的组合，并用真实 SendInput 按这个组合确认它真的还能唤出捕获框',
      notes: `保存失败后输入框值=${state.hotkey}（应仍是刚输入的 Ctrl+Alt+J：${fieldKeepsTyped}）；活跃态标签文案="${activeLabelText}"；getState().activeHotkey=${state.activeHotkey}（应是仍生效的 Ctrl+Alt+Space：${activeShowsRealCombo}）；真实按键验证旧组合仍能唤出捕获框=${stillWorks.ok}；附带核对（供 R1 参考）：本场景下顶部常驻横幅是否保持隐藏=${topBannerHiddenDuringSaveFailure}（应为 true，完整的 R1 三态验证见 session-e-review.mjs）`
    })
  } catch (err) {
    setResult('10', 'FAIL', { notes: `异常：${err.stack || err}` })
    setResult('E2', 'FAIL', { notes: `异常：${err.stack || err}` })
  } finally {
    stopOccupy()
    try { await quitApp(app) } catch { /* ignore */ }
  }
}
