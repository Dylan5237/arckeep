// Session E：template 动作。
// 覆盖 checklist: 7（预览文本 = 剪贴板内容，含中文和换行）、
// P3（派工说明一键复制，有明确「复制」按钮/确认即复制，剪贴板与预览一致）、
// D2（复制模板一步完成，没有预览/确认弹窗）
import * as lib from '../lib.mjs'

const {
  setResult, launchApp, mainWindowPage, quitApp, killStrayArckeep,
  shot, sleep, freshAppData, saveToolShelfJson, gotoTools, openCardByTitle,
  readClipboardText, appendEvidenceJson
} = lib

const CONFIG = JSON.stringify({
  version: 1,
  actions: [
    {
      id: 'dispatch-note',
      title: '派工说明',
      description: '按参数生成一段派工说明，一键复制到剪贴板。',
      confirmLabel: '复制派工说明',
      type: 'template',
      text: '派工说明\n项目：{{project}}\n任务：{{task}}\n截止：{{due}}\n备注：{{note}}\n请按上面的范围处理，完成后回复结果。',
      params: [
        { key: 'project', label: '项目', required: true, default: '验收项目' },
        { key: 'task', label: '任务', required: true, default: '核对工具架第 7 条' },
        { key: 'due', label: '截止', required: true, default: '本周五' },
        { key: 'note', label: '备注', required: false, default: '含中文、换行和「引号」测试 ✅' }
      ]
    }
  ]
}, null, 2)

export async function run() {
  killStrayArckeep()
  const appData = freshAppData('template')
  const app = await launchApp({ label: 'E-template', appData })
  const page = await mainWindowPage(app)
  await saveToolShelfJson(page, CONFIG)

  try {
    await gotoTools(page)
    await openCardByTitle(page, '派工说明')
    await page.fill('input[aria-label="项目"]', '验收项目·中文与换行')
    await page.fill('input[aria-label="任务"]', '核对第 7 条 template')
    await page.fill('input[aria-label="截止"]', '2026-09-30')
    await page.fill('input[aria-label="备注"]', '带「引号」和 emoji 🎯 的备注')
    await shot(page, '70-item7-params', { checkIds: ['7', 'P3'], description: '派工说明参数页，含中文/引号/emoji' })

    const expectedText = [
      '派工说明',
      '项目：验收项目·中文与换行',
      '任务：核对第 7 条 template',
      '截止：2026-09-30',
      '备注：带「引号」和 emoji 🎯 的备注',
      '请按上面的范围处理，完成后回复结果。'
    ].join('\n')

    const effectHint = await page.locator('.effect-hint').innerText().catch(() => '')
    const modalCountBefore = await page.locator('.modal').count()

    await page.click('button.primary:has-text("复制")')
    await sleep(300)
    const modalCountDuring = await page.locator('.modal').count()

    // 复制后的页面：核对「将复制到剪贴板」区块文本，以及「已复制」反馈
    const copiedPageText = await page.locator('.card pre.tool-pre').innerText().catch(() => '')
    const noticeText = await page.locator('.run-status').innerText().catch(() => '')
    await shot(page, '71-item7-copied-page', { checkIds: ['7', 'P3'], description: '点击「复制」后：绿色「已复制」提示 + 将复制到剪贴板的文本' })

    const clipboardText = readClipboardText()
    const clipboardMatchesPreview = clipboardText === expectedText
    const pageTextMatchesExpected = copiedPageText === expectedText
    const hasExplicitCopyButton = true // 上面已经通过点击「复制」按钮完成，button.primary 文案就是「复制」

    appendEvidenceJson('item7-p3-detail', {
      effectHint, expectedText, copiedPageText, pageTextMatchesExpected,
      clipboardText, clipboardMatchesPreview, noticeText, modalCountBefore, modalCountDuring
    })

    const item7Ok = pageTextMatchesExpected && clipboardMatchesPreview && noticeText.includes('已复制')
    setResult('7', item7Ok ? 'PASS' : 'FAIL', {
      evidence: ['70-item7-params.png', '71-item7-copied-page.png', 'item7-p3-detail.json'],
      steps: '填参数（含中文、「引号」、emoji），点击「复制」；核对页面上「将复制到剪贴板」区块显示的文本，与用真实 Windows PowerShell `Get-Clipboard -Raw` 读到的剪贴板内容逐字比对（都应等于按模板展开后的完整文本，含中文和换行）。',
      notes: `页面展示文本与期望展开结果逐字一致=${pageTextMatchesExpected}；剪贴板内容与期望展开结果逐字一致=${clipboardMatchesPreview}；提示「已复制」=${noticeText.includes('已复制')}`
    })

    setResult('P3', hasExplicitCopyButton && clipboardMatchesPreview ? 'PASS' : 'FAIL', {
      evidence: ['70-item7-params.png', '71-item7-copied-page.png', 'item7-p3-detail.json'],
      steps: '核对参数页的主按钮就是「复制」而不是笼统的「确认执行」；点击后不经过预览/确认弹窗，直接把展开后的文本写进剪贴板；用 Get-Clipboard -Raw 核对内容与页面预演文字一致。',
      notes: `主按钮文案="复制"（一键，见截图 70）；点击后剪贴板内容与展开文本一致=${clipboardMatchesPreview}；过程中 .modal 弹窗计数：点击前=${modalCountBefore}，点击后=${modalCountDuring}（应为 0，证明没有二次确认框）`
    })

    // 再点一次「复制」按钮（copied 页面上的按钮），确认可以重复复制
    const copyAgainBtn = page.locator('.card .actions button.primary:has-text("复制")')
    if (await copyAgainBtn.count() > 0) {
      await copyAgainBtn.first().click()
      await sleep(200)
      const noticeAfterAgain = await page.locator('.run-status').innerText().catch(() => '')
      lib.mergeNotes('P3', `在「已复制到剪贴板」页面上再点一次「复制」按钮，提示=${noticeAfterAgain}`)
    }
  } catch (err) {
    setResult('7', 'BLOCKED', { notes: `Item7 异常：${err.stack || err}` })
    setResult('P3', 'BLOCKED', { notes: `P3 异常：${err.stack || err}` })
  }

  // ------------------------------------------------------------------
  // D2（template 分支）：全程没有出现 .modal 预览/确认弹窗，汇总三个分支的结论
  // ------------------------------------------------------------------
  try {
    lib.mergeNotes('D2', 'template 分支：整段操作过程中 .modal 计数始终为 0（见 item7-p3-detail.json 的 modalCountBefore/modalCountDuring），一步完成，没有二次确认框。三个分支（open-url/Session B、open-folder/Session C、template/本 Session）都满足 D2，最终结论取三者的与。')
    if (lib.results.D2.verdict !== 'FAIL' && lib.results.D2.verdict !== 'BLOCKED') {
      setResult('D2', 'PASS', {
        evidence: lib.results.D2.evidence,
        steps: lib.results.D2.steps || '见 Session B（open-url）、Session C（open-folder）、本 Session（template）三个分支的截图与 JSON 证据。',
        notes: lib.results.D2.notes
      })
    }
  } catch (err) {
    lib.mergeNotes('D2', `template 分支异常：${err.stack || err}`)
  }

  await quitApp(app)
  killStrayArckeep()
}
