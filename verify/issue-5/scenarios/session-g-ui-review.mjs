// Session G：Critiquito UI 复核里跟布局/控件相关的几条 + 「额外观察项」。
// 覆盖 checklist: C1（卡片标题不再有「（演练）」「确认前不会运行」）、
// C4（工作目录只能从已知仓库选或用文件夹选择框浏览，不能手动打字）、
// C5（其它参数是单行文本输入）、C6（列表紧凑带搜索框 + 点击卡片整体就能进入）。
// 另外记录若干「不计分但要如实记录」的观察项：默认窗口大小下按钮/输出区是否需要滚动、
// 侧边栏 logo 是图标还是文字版、错误信息是否在视口内。
import * as lib from '../lib.mjs'

const {
  setResult, launchApp, mainWindowPage, quitApp, killStrayArckeep,
  shot, sleep, freshAppData, saveToolShelfJson, gotoTools, openCardByTitle,
  appendEvidenceJson, noteObservation, elementRect, windowContentBounds
} = lib

const CONFIG = JSON.stringify({
  version: 1,
  actions: [
    {
      id: 'ui-review-mixed',
      title: 'UI 复核·混合参数',
      description: '同时包含目录型参数和普通单行参数，用来核对参数控件类型（C4/C5）。',
      confirmLabel: '处理 {{plainParam}}',
      type: 'run-command',
      shell: 'powershell',
      cwd: '{{cwd}}',
      command: 'Write-Output {{plainParam}}',
      params: [
        { key: 'cwd', label: '工作目录', required: true, input: 'directory' },
        { key: 'plainParam', label: '普通参数', required: true, default: '默认单行值' }
      ]
    }
  ]
}, null, 2)

export async function run() {
  killStrayArckeep()

  // ------------------------------------------------------------------
  // C1：不改任何配置，直接用全新 APPDATA 下的默认目录（settings-store 的默认值就是
  // schema/tool-shelf.example.json 的内容），核对内置四个卡片的标题/描述里
  // 没有「（演练）」「确认前不会运行」这类字样——这是产品实际会先展示给新用户看到的文案。
  // ------------------------------------------------------------------
  const appDataDefault = freshAppData('ui-review-default')
  const appDefault = await launchApp({ label: 'G-default-catalog', appData: appDataDefault })
  try {
    const pageDefault = await mainWindowPage(appDefault)
    await gotoTools(pageDefault)
    await sleep(200)
    const cardTexts = await pageDefault.locator('.tool-card').allInnerTexts()
    await shot(pageDefault, '90-c1-default-shelf', { checkIds: ['C1', 'C6'], description: '全新用户看到的默认工具架（内置示例目录），核对卡片文案' })
    const forbidden = ['（演练）', '确认前不会运行']
    const offendingCards = cardTexts.filter(text => forbidden.some(word => text.includes(word)))
    appendEvidenceJson('c1-detail', { cardTexts, forbidden, offendingCards })
    setResult('C1', offendingCards.length === 0 && cardTexts.length > 0 ? 'PASS' : 'FAIL', {
      evidence: ['90-c1-default-shelf.png', 'c1-detail.json'],
      steps: '全新 APPDATA（相当于第一次打开应用），不做任何设置改动，直接进工具架列表，读出全部卡片的完整文本（标题+描述），核对逐张卡片里都没有「（演练）」或「确认前不会运行」这两个字样。',
      notes: `内置卡片数=${cardTexts.length}；命中禁用字样的卡片=${JSON.stringify(offendingCards)}`
    })

    // 顺带记录：默认窗口下，侧边栏 logo 是文字版（.brand-word）还是图标版（.brand-symbol）。
    const brandWordVisible = await pageDefault.evaluate(() => {
      const el = document.querySelector('.brand-word')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'
    })
    const brandSymbolVisible = await pageDefault.evaluate(() => {
      const el = document.querySelector('.brand-symbol')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'
    })
    await shot(pageDefault, '91-observation-sidebar-logo', { checkIds: [], description: '不计分观察项：侧边栏 logo（默认窗口宽度下是文字版还是图标版）' })
    appendEvidenceJson('observation-sidebar-logo', { brandWordVisible, brandSymbolVisible })
    noteObservation(`不计分观察项：默认窗口宽度下，侧边栏 logo 是${brandWordVisible ? '文字版（.brand-word 可见）' : (brandSymbolVisible ? '图标版（.brand-symbol 可见）' : '未知/都不可见')}，见截图 91-observation-sidebar-logo。`)

    // 不计分观察项：默认窗口大小下，工具架列表本身要不要滚动才能看全。
    const shelfFitsWithoutScroll = await pageDefault.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 2)
    const winBounds = await windowContentBounds(appDefault, pageDefault)
    noteObservation(`不计分观察项：默认窗口内容区大小=${JSON.stringify(winBounds)}；工具架列表页在默认窗口大小下${shelfFitsWithoutScroll ? '不需要滚动即可看全' : '需要滚动才能看全（documentElement.scrollHeight > window.innerHeight）'}。`)
  } catch (err) {
    setResult('C1', 'BLOCKED', { notes: `C1 异常：${err.stack || err}` })
  } finally {
    await quitApp(appDefault)
    killStrayArckeep()
  }

  // ------------------------------------------------------------------
  // C4 / C5 / C6：自定义一个同时有目录参数和普通参数的动作。
  // ------------------------------------------------------------------
  const appData = freshAppData('ui-review-mixed')
  const app = await launchApp({ label: 'G-ui-review', appData })
  const page = await mainWindowPage(app)
  await saveToolShelfJson(page, CONFIG)

  try {
    await gotoTools(page)
    await openCardByTitle(page, 'UI 复核·混合参数')
    await sleep(150)

    // C4：工作目录字段——不应该有 <input type=text>，只应该有已知仓库单选组 + 浏览文件夹按钮。
    const workdirTextInputCount = await page.locator('input[aria-label="工作目录"]').count()
    const repoChoicesCount = await page.locator('.repo-choices').count()
    const browseButtonCount = await page.locator('button:has-text("浏览文件夹")').count()
    const emptyRepoHint = await page.locator('.hint', { hasText: '还没有已知的本地路径' }).count()

    // C5：普通参数——应该是单行 <input type=text>，不是 <textarea>。
    const plainParamInput = page.locator('input[aria-label="普通参数"]')
    const plainParamInputCount = await plainParamInput.count()
    const plainParamIsTextInput = plainParamInputCount > 0 ? await plainParamInput.evaluate(el => el.tagName === 'INPUT' && el.getAttribute('type') === 'text') : false
    const plainParamTextareaCount = await page.locator('textarea[aria-label="普通参数"]').count()

    await shot(page, '92-c4-c5-params-page', { checkIds: ['C4', 'C5'], description: '混合参数页：工作目录（单选+浏览按钮，没有文本框）+ 普通参数（单行文本框）' })
    appendEvidenceJson('c4-c5-detail', {
      workdirTextInputCount, repoChoicesCount, browseButtonCount, emptyRepoHint,
      plainParamInputCount, plainParamIsTextInput, plainParamTextareaCount
    })

    const c4Ok = workdirTextInputCount === 0 && repoChoicesCount >= 1 && browseButtonCount >= 1
    setResult('C4', c4Ok ? 'PASS' : 'FAIL', {
      evidence: ['92-c4-c5-params-page.png', 'c4-c5-detail.json'],
      steps: '打开一个带「工作目录」参数的动作参数页：核对页面上工作目录字段没有可手动打字的文本框（input[aria-label="工作目录"] 数量应为 0），只有已知仓库单选组（这个全新环境下是空的，显示提示文字）和「浏览文件夹」按钮。P1 场景（Session B）里已经验证过当已知仓库非空时，单选组里会列出关注列表/GitHub/待办来源的仓库，可以直接选，同样不需要手动打字。',
      notes: `工作目录文本框数量=${workdirTextInputCount}（应为0）；单选组个数=${repoChoicesCount}；浏览文件夹按钮个数=${browseButtonCount}；空列表提示是否出现=${emptyRepoHint > 0}`
    })

    const c5Ok = plainParamInputCount === 1 && plainParamIsTextInput && plainParamTextareaCount === 0
    setResult('C5', c5Ok ? 'PASS' : 'FAIL', {
      evidence: ['92-c4-c5-params-page.png', 'c4-c5-detail.json'],
      steps: '同一个参数页上的「普通参数」字段（既不是工作目录，也没有专门要求多行）：核对渲染出来的是单行 input[type=text]，不是 textarea。',
      notes: `input[type=text] 数量=${plainParamInputCount}，是文本单行输入=${plainParamIsTextInput}，textarea 数量=${plainParamTextareaCount}（应为0）`
    })

    // ------------------------------------------------------------------
    // C6：① 搜索框能按关键字过滤；② 点击卡片整体（不点标题/描述文字本身，点卡片内偏右下角的空白处）
    // 也能进入，不是只有某个小按钮才能点。
    // ------------------------------------------------------------------
    await gotoTools(page)
    const totalCardsBefore = await page.locator('.tool-card').count()
    const search = page.locator('.tool-search')
    await search.fill('UI 复核')
    await sleep(200)
    const matchedAfterSearch = await page.locator('.tool-card').count()
    await shot(page, '93-c6-search-filter', { checkIds: ['C6'], description: '搜索框输入关键字后，列表按关键字过滤' })
    const searchFilterOk = matchedAfterSearch >= 1 && matchedAfterSearch <= totalCardsBefore

    await search.fill('')
    await sleep(150)
    const card = page.locator('.tool-card', { hasText: 'UI 复核·混合参数' }).first()
    const rect = await card.boundingBox()
    if (!rect) throw new Error('tool-card 没有可见的 boundingBox')
    // 故意点卡片右下角附近的空白区域（不是标题文字、不是类型 chip），验证「点卡片整体」而不是「点某个小按钮」。
    const clickX = rect.x + rect.width - 12
    const clickY = rect.y + rect.height - 10
    await page.mouse.click(clickX, clickY)
    await sleep(250)
    const enteredParamsPage = await page.locator('h1', { hasText: 'UI 复核·混合参数' }).count() > 0
    await shot(page, '94-c6-whole-card-click', { checkIds: ['C6'], description: `点击卡片右下角空白处（${Math.round(clickX)},${Math.round(clickY)}，不是标题/chip 文字上）后是否进入了参数页` })
    appendEvidenceJson('c6-detail', {
      totalCardsBefore, matchedAfterSearch, searchFilterOk,
      cardRect: rect, clickPoint: { x: clickX, y: clickY }, enteredParamsPage
    })

    const c6Ok = searchFilterOk && enteredParamsPage
    setResult('C6', c6Ok ? 'PASS' : 'FAIL', {
      evidence: ['90-c1-default-shelf.png', '93-c6-search-filter.png', '94-c6-whole-card-click.png', 'c6-detail.json'],
      steps: '① 在工具架搜索框里输入部分标题关键字，核对列表收窄到匹配的卡片（不多于过滤前的总数、且至少留下一张能匹配的）。② 清空搜索框后，故意把鼠标点在卡片矩形范围内偏右下角、明显不是标题文字/类型标签上的空白区域（而不是点某个小按钮），核对同样能进入这个动作的参数页——证明整张卡片都是可点击区域，不是只有小按钮才能点。列表本身的紧凑程度见截图 90/93（每张卡片只有标题+类型标签+一行描述，没有多余空白）。',
      notes: `过滤前卡片数=${totalCardsBefore}，输入"UI 复核"后剩余=${matchedAfterSearch}；点击卡片右下角空白处(${Math.round(clickX)},${Math.round(clickY)})后是否进入参数页=${enteredParamsPage}`
    })
  } catch (err) {
    setResult('C4', 'BLOCKED', { notes: `C4 异常：${err.stack || err}` })
    setResult('C5', 'BLOCKED', { notes: `C5 异常：${err.stack || err}` })
    setResult('C6', 'BLOCKED', { notes: `C6 异常：${err.stack || err}` })
  }

  // ------------------------------------------------------------------
  // 不计分观察项：默认窗口大小下，预览弹窗/确认按钮/输出区域是否需要滚动；报错信息是否在视口内。
  // ------------------------------------------------------------------
  try {
    await gotoTools(page)
    await openCardByTitle(page, 'UI 复核·混合参数')
    await page.fill('input[aria-label="普通参数"]', '滚动检查')
    await page.click('button.primary:has-text("预览")')
    await page.waitForSelector('.modal', { timeout: 8000 })
    await sleep(200)
    const modalRect = await elementRect(page, '.modal')
    const confirmRect = await elementRect(page, '.modal button.primary')
    const previewFitsWithoutScroll = modalRect && confirmRect
      ? modalRect.bottom <= modalRect.innerHeight + 2 && confirmRect.bottom <= confirmRect.innerHeight + 2
      : null
    await shot(page, '95-observation-preview-fits', { checkIds: [], description: '不计分观察项：默认窗口大小下预览弹窗+确认按钮是否需要滚动才能看到' })
    await page.click('.modal button.primary')
    await lib.waitFor(async () => (await page.locator('.run-status').innerText().catch(() => '')).includes('完成'), { timeoutMs: 8000, intervalMs: 100 })
    await sleep(150)
    const outputRect = await elementRect(page, '.tool-output-card')
    const outputFitsWithoutScroll = outputRect ? outputRect.bottom <= outputRect.innerHeight + 2 : null
    await shot(page, '96-observation-output-fits', { checkIds: [], description: '不计分观察项：默认窗口大小下运行输出区域是否需要滚动才能看到' })
    appendEvidenceJson('observation-fits-without-scroll', { modalRect, confirmRect, previewFitsWithoutScroll, outputRect, outputFitsWithoutScroll })
    noteObservation(`不计分观察项：默认窗口大小下，预览弹窗+确认按钮${previewFitsWithoutScroll ? '完全在视口内，不需要滚动' : '超出视口，需要滚动才能看到（或未能测出，见 observation-fits-without-scroll.json）'}；运行完成后的输出区域${outputFitsWithoutScroll ? '完全在视口内，不需要滚动' : '超出视口，需要滚动才能看到（或未能测出）'}。`)
  } catch (err) {
    noteObservation(`不计分观察项：检查「默认窗口是否需要滚动」时异常：${err.stack || err}`)
  }

  try {
    await lib.saveToolShelfJson(page, '{ invalid json for scroll check ')
    await sleep(150)
    const errorBox = page.locator('#tool-shelf-card .alert.error')
    const errorRect = await elementRect(page, '#tool-shelf-card .alert.error')
    const errorWithinViewport = errorRect ? (errorRect.top >= -2 && errorRect.bottom <= errorRect.innerHeight + 2) : null
    await shot(page, '97-observation-error-in-view', { checkIds: [], description: '不计分观察项：设置页报错信息是否在默认窗口视口内（不需要滚动就能看到）' })
    appendEvidenceJson('observation-error-in-view', { errorRect, errorWithinViewport })
    noteObservation(`不计分观察项：设置页 JSON 报错提示${errorWithinViewport ? '在默认窗口视口内，不需要滚动就能看到' : '可能超出视口（或未能测出），见 observation-error-in-view.json'}。`)
  } catch (err) {
    noteObservation(`不计分观察项：检查「报错信息是否在视口内」时异常：${err.stack || err}`)
  }

  // 汇总一次这个 session 期间是否出现了白屏/崩溃/控制台报错（跨全部 session 的完整汇总由 run.mjs 在最后统一写出）。
  const sessionConsoleErrors = lib.consoleObservations.filter(o => o.label === 'G-ui-review' || o.label === 'G-default-catalog')
  if (sessionConsoleErrors.length > 0) {
    noteObservation(`本 session 期间捕获到 ${sessionConsoleErrors.length} 条控制台 error/warning/pageerror，逐条原文见最终汇总的 console-observations.json：${JSON.stringify(sessionConsoleErrors).slice(0, 500)}`)
  } else {
    noteObservation('本 session 期间没有捕获到任何控制台 error/warning/pageerror，也没有出现白屏/崩溃。')
  }

  await quitApp(app)
  killStrayArckeep()
}
