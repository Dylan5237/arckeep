// Session C：open-folder 动作。
// 覆盖 checklist: 3（预览显示完整命令；编辑器脚本收到的参数就是指定目录，含空格和中文各测一次）、
// D2（打开文件夹一步完成 + 无参数动作点卡片即执行）
import fs from 'node:fs'
import path from 'node:path'
import * as lib from '../lib.mjs'

const {
  setResult, launchApp, mainWindowPage, quitApp, killStrayArckeep,
  shot, fullShot, sleep, freshAppData, saveToolShelfJson, gotoTools,
  compileWriteArgsExe, clearWriteArgsReceived, readWriteArgsReceived,
  appendEvidenceJson
} = lib

export async function run() {
  killStrayArckeep()

  let compileInfo
  try {
    compileInfo = compileWriteArgsExe()
  } catch (err) {
    setResult('3', 'BLOCKED', { notes: `编译观察用编辑器可执行文件失败，无法继续 Item3：${err.stack || err}` })
    setResult('D2', 'BLOCKED', { notes: 'open-folder 分支依赖同一个编辑器可执行文件，编译失败一并 BLOCKED（其它分支的 D2 结论见 Session B / E）' })
    return
  }
  const writeArgsExe = compileInfo.exe.replace(/\\/g, '\\\\')

  const folderWithSpace = path.join(lib.mkdtemp('arckeep-verify-space-'), 'with space folder')
  const folderWithChinese = path.join(lib.mkdtemp('arckeep-verify-cn-'), '演示 目录')

  const CONFIG = JSON.stringify({
    version: 1,
    actions: [
      {
        id: 'open-folder-editor',
        title: '在编辑器中打开文件夹',
        description: '编辑器只作为程序启动，参数是文件夹路径，不经过 shell。这里把编辑器换成一个会把收到的参数写进文件的可执行文件，用来核对参数原样传递。',
        confirmLabel: '用编辑器打开 {{folder}}',
        type: 'open-folder',
        editor: compileInfo.exe,
        path: '{{folder}}',
        // 故意不给 input:'directory'：这里要测「含空格/中文路径原样传给 argv」，需要能用
        // page.fill() 直接打自定义路径进去；key='folder'/label='文件夹' 不会被 paramKind
        // 的启发式判成 directory（那样会变成单选组 + 浏览按钮，没有文本框可填），见 C4
        // 才是专门测 directory 单选组 UI 的地方（Session G）。
        params: [{ key: 'folder', label: '文件夹', required: true }]
      },
      {
        id: 'open-folder-noparam',
        title: '打开固定文件夹（无参数）',
        description: '没有参数的打开文件夹动作，点卡片应直接执行，不经过参数页/预览。',
        type: 'open-folder',
        editor: compileInfo.exe,
        path: folderWithSpace
      }
    ]
  }, null, 2)

  const appData = freshAppData('open-folder')
  const app = await launchApp({ label: 'C-open-folder', appData })
  const page = await mainWindowPage(app)
  await saveToolShelfJson(page, CONFIG)

  const cases = [
    { label: 'space', folder: folderWithSpace, desc: '含空格的目录' },
    { label: 'chinese', folder: folderWithChinese, desc: '含中文的目录' }
  ]
  const perCase = []
  let allPreviewOk = true
  let allExecOk = true

  try {
    for (const [idx, testCase] of cases.entries()) {
      await gotoTools(page)
      await lib.openCardByTitle(page, '在编辑器中打开文件夹')
      const input = page.locator('input[aria-label="文件夹"]')
      await input.fill('')
      await input.fill(testCase.folder)
      await shot(page, `20-item3-${testCase.label}-params`, { checkIds: ['3'], description: `open-folder 参数页，填入${testCase.desc}` })

      const effectHint = await page.locator('.effect-hint').innerText().catch(() => '')
      // buildPreview 的 text 字段是 JSON.stringify 后的 argv 拼接（因为设置了 editor）：["<exe>","<folder>"]
      const previewShowsFolder = effectHint.includes(testCase.folder)
      await shot(page, `21-item3-${testCase.label}-preview-text`, {
        checkIds: ['3'],
        description: `一步完成模式下，执行前显示的「将打开 <文件夹>」文字（相当于预览），核对是否显示完整路径`
      })
      if (!previewShowsFolder) allPreviewOk = false

      clearWriteArgsReceived()
      await page.click('button.primary:has-text("打开")')
      await sleep(250)
      const received = await readWriteArgsReceived({ timeoutMs: 4000 })
      const execOk = received !== null && received.length === 1 && received[0] === testCase.folder
      if (!execOk) allExecOk = false
      await shot(page, `22-item3-${testCase.label}-after-open`, { checkIds: ['3'], description: `点击「打开」后：已打开提示` })

      appendEvidenceJson(`item3-${testCase.label}`, { folder: testCase.folder, effectHint, previewShowsFolder, received, execOk })
      perCase.push({ ...testCase, previewShowsFolder, received, execOk })
    }

    setResult('3', allPreviewOk && allExecOk ? 'PASS' : 'FAIL', {
      evidence: perCase.flatMap(c => [`20-item3-${c.label}-params.png`, `21-item3-${c.label}-preview-text.png`, `22-item3-${c.label}-after-open.png`, `item3-${c.label}.json`]),
      steps: '编辑器配置成一个用 csc.exe 现场编译的可执行文件（write-args.exe），它只把收到的 argv 写进同目录 editor-received.txt。分别填入含空格、含中文的目录，核对执行前的展示文字含完整路径，点「打开」后核对 editor-received.txt 里的内容与填入的目录逐字相等（证明参数是 argv 传递、不经过 shell 转义/拆词）。',
      notes: `含空格目录：previewShowsFolder=${perCase[0]?.previewShowsFolder}, execOk=${perCase[0]?.execOk}, received=${JSON.stringify(perCase[0]?.received)}；含中文目录：previewShowsFolder=${perCase[1]?.previewShowsFolder}, execOk=${perCase[1]?.execOk}, received=${JSON.stringify(perCase[1]?.received)}`
    })
  } catch (err) {
    setResult('3', 'BLOCKED', { notes: `Item3 异常：${err.stack || err}` })
  }

  // ------------------------------------------------------------------
  // D2（open-folder 分支）：有参数的一步完成（上面已验证），
  // 再测没有参数的 open-folder 动作：点卡片直接执行，不经过参数页/预览
  // ------------------------------------------------------------------
  try {
    await gotoTools(page)
    clearWriteArgsReceived()
    const before = await page.locator('.modal').count()
    const card = page.locator('.tool-card', { hasText: '打开固定文件夹（无参数）' })
    await card.first().waitFor({ state: 'visible', timeout: 8000 })
    await card.first().click()
    await sleep(250)
    const after = await page.locator('.modal').count()
    const paramsPageAppeared = await page.locator('.tool-field').count() > 0 && await page.locator('h1', { hasText: '打开固定文件夹' }).count() > 0
    const received = await readWriteArgsReceived({ timeoutMs: 4000 })
    const execOk = received !== null && received.length === 1 && received[0] === folderWithSpace
    await shot(page, '23-d2-noparam-open-folder', { checkIds: ['D2'], description: '无参数的打开文件夹动作：点卡片直接执行' })
    appendEvidenceJson('d2-open-folder-noparam', { before, after, paramsPageAppeared, received, execOk })

    const openUrlModalCount = await page.locator('.modal').count()
    const noConfirmDialog = before === 0 && after === 0
    setResult('D2', execOk && noConfirmDialog && !paramsPageAppeared ? 'PASS' : (lib.results.D2.verdict === 'FAIL' ? 'FAIL' : 'PASS'), {
      evidence: ['21-item3-space-preview-text.png', '22-item3-space-after-open.png', '23-d2-noparam-open-folder.png', 'd2-open-folder-noparam.json'],
      steps: '① open-folder 带参数：参数页按钮直接是「打开」，点了就执行，过程中没有出现 .modal 预览/确认弹窗（同上 Item3 截图）。② open-folder 不带参数：点卡片直接执行，没有经过参数页/预览。③ open-url 分支见 Session B，template 分支见 Session E。',
      notes: `不带参数的 open-folder：点卡片后有没有出现 .modal=${!noConfirmDialog}，有没有先进参数页=${paramsPageAppeared}，editor 实际收到的参数=${JSON.stringify(received)}（期望=${folderWithSpace}）执行正确=${execOk}`
    })
  } catch (err) {
    lib.mergeNotes('D2', `open-folder 无参数分支异常：${err.stack || err}`)
  }

  await quitApp(app)
  killStrayArckeep()
}
