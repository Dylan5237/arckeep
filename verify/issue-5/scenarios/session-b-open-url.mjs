// Session B：open-url 动作。
// 覆盖 checklist: 2（预览=确认后 openExternal 收到的 URL 逐字比对）、
// D2（打开链接一步完成，没有预览/确认弹窗）、
// P1（打开仓库能从已知仓库里选：关注列表 + 待办关联，用 Dylan5237/req-to-page 实测）
import * as lib from '../lib.mjs'

const {
  setResult, launchApp, mainWindowPage, captureWindowPage, quitApp, killStrayArckeep,
  fullShot, shot, sleep, freshAppData, saveToolShelfJson, gotoTools,
  installOpenExternalSpy, readOpenExternalCalls, callTestHook, appendEvidenceJson
} = lib

const CONFIG = JSON.stringify({
  version: 1,
  actions: [
    {
      id: 'open-url-plain',
      title: '打开链接示例',
      description: '展开后打开的 URL 带 {{repo}} 参数（普通单行输入，不是已知仓库选择器）。',
      confirmLabel: '打开 {{repo}}',
      type: 'open-url',
      url: 'https://example.com/repos/{{repo}}?tag={{repo}}',
      params: [{ key: 'repo', label: '仓库标识', required: true }]
    },
    {
      id: 'open-repo',
      title: '打开仓库',
      description: '从已知仓库里选一个打开。有 GitHub 名时打开仓库页面，只有本地路径时打开文件夹。',
      confirmLabel: '打开 {{repo}}',
      type: 'open-url',
      url: 'https://github.com/{{repo}}',
      params: [{ key: 'repo', label: '仓库', required: true, input: 'repo' }]
    }
  ]
}, null, 2)

export async function run() {
  killStrayArckeep()
  const appData = freshAppData('open-url')
  const app = await launchApp({ label: 'B-open-url', appData })
  const page = await mainWindowPage(app)
  await installOpenExternalSpy(app)

  await saveToolShelfJson(page, CONFIG)

  // ------------------------------------------------------------------
  // Item 2：预览显示展开后的 URL，确认后 openExternal 收到的 URL 与预览逐字一致
  // ------------------------------------------------------------------
  try {
    await gotoTools(page)
    await lib.openCardByTitle(page, '打开链接示例')
    // 有参数 → 参数页
    await page.fill('input[aria-label="仓库标识"]', 'octocat/Hello-World')
    await shot(page, '10-item2-params', { checkIds: ['2'], description: 'open-url 参数页，填入 repo=octocat/Hello-World' })
    const effectHint = await page.locator('.effect-hint').innerText().catch(() => '')
    const expectedUrl = 'https://example.com/repos/octocat%2FHello-World?tag=octocat%2FHello-World'
    const previewMatchesBeforeClick = effectHint.includes(expectedUrl)
    await shot(page, '11-item2-effect-hint', { checkIds: ['2', 'D2'], description: '一步完成模式下，参数页直接显示「将打开 <展开后 URL>」的预演文字（相当于旧交互的预览）' })

    const before = await readOpenExternalCalls(app)
    await page.click('button.primary:has-text("打开")')
    await sleep(200)
    const after = await readOpenExternalCalls(app)
    const newCall = after.slice(before.length)
    await shot(page, '12-item2-after-open', { checkIds: ['2'], description: '点击「打开」后，页面回到「已打开」提示（不再有确认弹窗）' })

    const gotUrl = newCall[0]?.url ?? null
    const matches = gotUrl === expectedUrl
    appendEvidenceJson('item2-url-compare', { effectHint, expectedUrl, gotUrl, newCall })

    setResult('2', previewMatchesBeforeClick && matches ? 'PASS' : 'FAIL', {
      evidence: ['10-item2-params.png', '11-item2-effect-hint.png', '12-item2-after-open.png', 'item2-url-compare.json'],
      steps: '按 #22 后的一步完成交互：参数页填 repo=octocat/Hello-World，执行前显示的「将打开 …」文字视为预览（含 {{repo}} 展开+URL 编码），核对逐字等于展开后的完整 URL；点击「打开」（相当于确认）后，读主进程里打了观察性桩的 shell.openExternal 实际收到的参数，与预演文字里的 URL 逐字比对。',
      notes: `预演文字="${effectHint}"；期望 URL="${expectedUrl}"；openExternal 实际收到="${gotUrl}"；两者一致=${matches}`
    })
  } catch (err) {
    setResult('2', 'BLOCKED', { notes: `Item2 异常：${err.stack || err}` })
  }

  // ------------------------------------------------------------------
  // D2（open-url 分支）：整个流程没有出现「预览 → 确认」弹窗（.modal）
  // ------------------------------------------------------------------
  try {
    const modalCount = await page.locator('.modal').count()
    setResult('D2', modalCount === 0 ? 'PASS' : 'PENDING', {
      evidence: ['10-item2-params.png', '12-item2-after-open.png'],
      steps: '在上面 Item2 的操作过程中全程检查 DOM 里是否出现 .modal（预览/确认弹窗）。open-url 分支应该没有。',
      notes: `open-url 分支操作全程 .modal 计数=${modalCount}（0 表示确认没有出现确认框）。open-folder / template 分支的核对见各自 Session。`
    })
  } catch (err) {
    lib.mergeNotes('D2', `open-url 分支异常：${err.stack || err}`)
  }

  // ------------------------------------------------------------------
  // P1：打开仓库——从已知仓库里选（关注列表 + 待办关联），用 Dylan5237/req-to-page 实测
  // ------------------------------------------------------------------
  try {
    // 1) 关注列表加入 Dylan5237/req-to-page
    await page.click('[data-view="settings"]')
    await page.fill('#watched-repo', 'Dylan5237/req-to-page')
    await page.click('#watched-repo + button, button:has-text("添加")')
    await sleep(150)
    await shot(page, '13-p1-watched-added', { checkIds: ['P1'], description: '设置 → 关注仓库 添加 Dylan5237/req-to-page' })

    // 2) 用快速捕获创建一条关联 Dylan5237/term-lens 的待办
    await callTestHook(app, 'capture')
    const cap = await captureWindowPage(app)
    await cap.fill('#text', '验收：核对已知仓库列表 #Dylan5237/term-lens')
    await shot(cap, '14-p1-capture-todo', { checkIds: ['P1'], description: '快速捕获里写一条关联 Dylan5237/term-lens 的待办' })
    await cap.press('#text', 'Enter')
    // 给保存 IPC 往返足够时间；顺手记一下捕获窗口是否显示了报错（诊断用，不参与判定）。
    await sleep(1200)
    const captureErrorText = await cap.locator('#error').innerText().catch(() => '<读取失败>')
    const captureStillOpen = await cap.isClosed().then(() => false).catch(() => true)
    const todosAfterCapture = await callTestHook(app, 'todos').catch(err => ({ error: String(err) }))
    appendEvidenceJson('p1-capture-diagnostic', { captureErrorText, captureStillOpen, todosAfterCapture })

    // 3) 打开仓库 → 参数页应能看到两个来源都在列表里
    await gotoTools(page)
    await lib.openCardByTitle(page, '打开仓库')
    await sleep(200)
    const choiceLabels = await page.locator('.repo-choice-label').allInnerTexts()
    const choiceSources = await page.locator('.repo-choice-source').allInnerTexts()
    await shot(page, '15-p1-known-repo-list', { checkIds: ['P1'], description: '「打开仓库」参数页：已知仓库单选列表，应包含关注列表和待办来源' })

    const hasWatched = choiceLabels.some(l => l.includes('Dylan5237/req-to-page'))
    const hasTodo = choiceLabels.some(l => l.includes('Dylan5237/term-lens'))
    const watchedIdx = choiceLabels.findIndex(l => l.includes('Dylan5237/req-to-page'))
    const todoIdx = choiceLabels.findIndex(l => l.includes('Dylan5237/term-lens'))
    const watchedSourceLabel = watchedIdx >= 0 ? choiceSources[watchedIdx] : null
    const todoSourceLabel = todoIdx >= 0 ? choiceSources[todoIdx] : null

    // 4) 选中 Dylan5237/req-to-page，点「打开」，核对 openExternal 收到的 URL
    const before = await readOpenExternalCalls(app)
    if (watchedIdx >= 0) {
      await page.locator('.repo-choice').nth(watchedIdx).locator('input[type=radio]').check()
    }
    await shot(page, '16-p1-selected-req-to-page', { checkIds: ['P1'], description: '选中 Dylan5237/req-to-page 后的参数页' })
    await page.click('button.primary:has-text("打开")')
    await sleep(200)
    const after = await readOpenExternalCalls(app)
    const newCall = after.slice(before.length)
    const gotUrl = newCall[0]?.url ?? null
    const expectedUrl = 'https://github.com/Dylan5237/req-to-page'
    const urlMatches = gotUrl === expectedUrl

    appendEvidenceJson('p1-detail', {
      choiceLabels, choiceSources, hasWatched, hasTodo, watchedSourceLabel, todoSourceLabel, gotUrl, expectedUrl
    })

    setResult('P1', hasWatched && hasTodo && todoSourceLabel === '待办' && urlMatches ? 'PASS' : 'FAIL', {
      evidence: ['13-p1-watched-added.png', '14-p1-capture-todo.png', '15-p1-known-repo-list.png', '15-p1-known-repo-list-full.png', '16-p1-selected-req-to-page.png', 'p1-detail.json'],
      steps: '① 设置里把 Dylan5237/req-to-page 加入关注列表；② 快速捕获新建一条待办，正文里带 #Dylan5237/term-lens；③ 打开「打开仓库」动作的参数页，核对已知仓库单选列表里两个来源都出现，且待办来源标成「待办」；④ 选中 Dylan5237/req-to-page 后点「打开」，核对 shell.openExternal 实际收到的 URL。',
      notes: `列表包含关注列表来源(Dylan5237/req-to-page)=${hasWatched}；列表包含待办来源(Dylan5237/term-lens)=${hasTodo}，来源标签="${todoSourceLabel}"；选中后 openExternal 收到="${gotUrl}"（期望 "${expectedUrl}"）一致=${urlMatches}。不能验证「等我处理/项目总览观察到的仓库」这一来源，因为需要真实 GitHub token 才能触发 GitHub API 拉取，按硬性规则第 4 条未使用真实 token，因此这部分未覆盖，只覆盖了不需要 GitHub 认证的关注列表 + 待办两个来源。`
    })
  } catch (err) {
    setResult('P1', 'BLOCKED', { notes: `P1 异常：${err.stack || err}` })
  }

  await quitApp(app)
  killStrayArckeep()
}
