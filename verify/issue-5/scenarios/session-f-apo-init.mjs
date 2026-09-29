// Session F：P2（项目初始化）——预演阶段带 --dry-run，「确认执行」之后真的跑的命令
// 不应该还带 --dry-run；--dry-run 只应该出现在预演步骤。
//
// 运行环境大概率没有真的 apo 工具。产品自己的逻辑是：预演命令（previewCommand）如果
// 失败/找不到，rehearsal.canConfirm 会变成 false，界面上「确认」按钮直接不出现，
// 没法用真实点击走完「预览→确认」这条链路。为了能用真实界面操作完整测到这一条，
// 给测试进程的 PATH 头部加一个假的 apo（本目录 apo-stub/），让预演和确认都能跑通；
// 「确认后真的执行的命令有没有 --dry-run」这一核心结论完全通过操作系统层面独立验证
// （解码 PowerShell -EncodedCommand 里的真实脚本文本，跟被测应用的实现完全无关），
// 不依赖也不信任这个 stub 自己的输出。
import path from 'node:path'
import fs from 'node:fs'
import * as lib from '../lib.mjs'

const {
  setResult, mergeNotes, launchApp, mainWindowPage, quitApp, killStrayArckeep,
  shot, sleep, freshAppData, saveToolShelfJson, gotoTools, openCardByTitle,
  mkdtemp, waitFor, appendEvidenceJson, findNewPidByName, getCommandLine,
  decodePowershellEncodedCommand, __dirname
} = lib

const apoStubDir = path.join(__dirname, '..', 'apo-stub')
const cwdInit = mkdtemp('arckeep-verify-apo-init-')

const CONFIG = JSON.stringify({
  version: 1,
  actions: [
    {
      id: 'apo-init',
      title: 'apo 项目初始化',
      description: '初始化一个 apo 项目（原样照抄 schema/tool-shelf.example.json 里的内置示例动作定义）。',
      confirmLabel: '在 {{cwd}} 初始化 {{name}}',
      type: 'run-command',
      shell: 'powershell',
      cwd: '{{cwd}}',
      previewCommand: 'apo init --dry-run --name {{name}}',
      command: 'apo init --name {{name}}',
      params: [
        { key: 'cwd', label: '工作目录', required: true, input: 'directory', default: cwdInit },
        { key: 'name', label: '项目名', required: true, default: 'demo' }
      ]
    }
  ]
}, null, 2)

export async function run() {
  killStrayArckeep()
  const appData = freshAppData('apo-init')
  // 把假 apo 放到 PATH 最前面，只影响这一个测试进程，不影响其它 session、不改产品代码。
  const pathWithStub = `${apoStubDir}${path.delimiter}${process.env.PATH ?? ''}`
  const app = await launchApp({ label: 'F-apo-init', appData, envExtra: { PATH: pathWithStub } })
  const page = await mainWindowPage(app)
  await saveToolShelfJson(page, CONFIG)

  try {
    await gotoTools(page)
    await openCardByTitle(page, 'apo 项目初始化')
    await sleep(150)
    // cwd/name 参数都用 default 预填（cwd 是 directory 类型的单选组，默认值不在已知仓库列表里时
    // 会被作为一条「额外」单选项自动加进去并选中，见 tools-page.ts 的 paintParams；不需要点浏览文件夹）。
    const cwdChoiceChecked = await page.locator('.repo-choices input[type="radio"]:checked').getAttribute('value').catch(() => null)
    await shot(page, '80-p2-params', { checkIds: ['P2'], description: 'apo 项目初始化参数页：工作目录单选（默认值已预选）+ 项目名文本框' })

    await page.click('button.primary:has-text("预览")')
    await page.waitForSelector('.modal', { timeout: 8000 })
    await sleep(400)

    const rehearsalSummary = await page.locator('.rehearsal-summary').innerText().catch(() => '')
    const previewFailedAlert = await page.locator('.modal .alert.error').innerText().catch(() => '')
    const confirmButtonCount = await page.locator('.modal button.primary').count()
    const detailsOpenAttr = await page.locator('.modal details.tool-command').getAttribute('open')
    const foldedClosedByDefault = detailsOpenAttr === null
    await shot(page, '81-p2-preview-dryrun-summary', { checkIds: ['P2'], description: '预览：预演摘要（应体现 --dry-run 阶段解析出的文件列表），「查看命令」默认折叠' })

    if (confirmButtonCount === 0) {
      // 预演没有走通（例如 stub 没进到 PATH 里）：如实记录，不伪造通过。
      appendEvidenceJson('p2-blocked-detail', { rehearsalSummary, previewFailedAlert, confirmButtonCount, foldedClosedByDefault })
      setResult('P2', 'BLOCKED', {
        evidence: ['80-p2-params.png', '81-p2-preview-dryrun-summary.png', 'p2-blocked-detail.json'],
        steps: '打开「apo 项目初始化」动作，填好工作目录/项目名后点预览。',
        notes: `预演阶段没有走到「确认」按钮可用的状态（confirmButtonCount=0），预演失败提示="${previewFailedAlert}"，摘要="${rehearsalSummary}"。已确认给测试进程 PATH 加了 apo-stub 目录：${apoStubDir}，但预演命令仍未成功——如实记录为 BLOCKED，不代表产品本身有问题（很可能是本次跑手环境问题）。`
      })
      await quitApp(app)
      killStrayArckeep()
      return
    }

    await page.click('.modal details.tool-command summary')
    await sleep(120)
    const foldedCommandText = await page.locator('.modal .tool-command pre.tool-pre').innerText().catch(() => '')
    const confirmLabelText = await page.locator('.modal button.primary').innerText()
    await shot(page, '82-p2-preview-command-expanded', { checkIds: ['P2', 'C2'], description: '展开「查看命令」：预演阶段展示的真实将执行命令文本' })

    // 「点确认」前后按进程名做差集，抓住刚起的 powershell 宿主，解码它真正的 -EncodedCommand 脚本文本。
    const diff = await findNewPidByName('powershell,pwsh', async () => {
      await page.click('.modal button.primary')
    }, { settleMs: 500 })
    let decoded = null
    let decodedPid = null
    if (diff.newOnes[0]) {
      decodedPid = diff.newOnes[0].pid
      const cl = getCommandLine(decodedPid)
      decoded = cl.found ? decodePowershellEncodedCommand(cl.commandLine) : null
    }

    await waitFor(async () => /完成|失败/.test(await page.locator('.run-status').innerText().catch(() => '')), { timeoutMs: 10000, intervalMs: 100 })
    await sleep(200)
    const statusText = await page.locator('.run-status').innerText().catch(() => '')
    await shot(page, '83-p2-after-confirm', { checkIds: ['P2'], description: '确认执行后：状态 + 输出（real-init-done）' })

    const realFilesCreated = fs.existsSync(path.join(cwdInit, 'demo.json')) && fs.existsSync(path.join(cwdInit, 'demo.config'))
    const decodedHasNoDryRun = decoded !== null && !/--dry-run/i.test(decoded)
    const decodedLooksLikeApoInit = decoded !== null && /apo(\.cmd)?\s+init/i.test(decoded) && /--name\s+demo/i.test(decoded)
    const previewMentionsDryRunArtifacts = rehearsalSummary.includes('demo.json') || rehearsalSummary.includes('demo.config') || foldedCommandText.length > 0
    const confirmLabelOk = !confirmLabelText.includes('确认执行') && confirmLabelText.includes(cwdInit) && confirmLabelText.includes('demo')

    appendEvidenceJson('p2-detail', {
      cwdChoiceChecked, cwdInit, rehearsalSummary, foldedClosedByDefault, foldedCommandText, confirmLabelText,
      decodedPid, decoded, decodedHasNoDryRun, decodedLooksLikeApoInit, statusText, realFilesCreated,
      previewMentionsDryRunArtifacts, confirmLabelOk
    })

    const p2Ok = decoded !== null && decodedHasNoDryRun && decodedLooksLikeApoInit && realFilesCreated && statusText.includes('完成')

    setResult('P2', p2Ok ? 'PASS' : 'FAIL', {
      evidence: ['80-p2-params.png', '81-p2-preview-dryrun-summary.png', '82-p2-preview-command-expanded.png', '83-p2-after-confirm.png', 'p2-detail.json'],
      steps: '「apo 项目初始化」动作预演阶段命令带 --dry-run（本地用一个假 apo.cmd/apo-stub.mjs 顶替，只是让预演能跑通，不影响下面这条核心结论）。点「预览」后核对摘要/展开命令；点「确认」的同一时刻，用「点击前后按进程名做差集」找到刚起的 powershell.exe 宿主进程，用操作系统层面读它的 -EncodedCommand 参数、Base64+UTF16LE 解码成真实脚本文本（这一步完全不读被测应用源码，只是通用的 WMI 查询 + 编码转换）。核对解码出来的真实脚本里：①不包含 --dry-run；②确实是 apo init --name demo 这条命令；③磁盘上真的多出了 demo.json / demo.config（预演阶段不应该落盘，只在真实确认后才落盘）；④界面状态显示「完成」。',
      notes: `确认按钮真实执行的命令(解码自同一 powershell 进程的 -EncodedCommand)="${decoded}"；不含 --dry-run=${decodedHasNoDryRun}；像是 apo init --name demo=${decodedLooksLikeApoInit}；真的落盘=${realFilesCreated}；预演阶段摘要="${rehearsalSummary}"（应能看到 --dry-run 才有的 demo.json/demo.config 文件列表痕迹）；本次为了让预演在没装真 apo 的跑手上也能走通，给测试进程 PATH 头部加了 ${apoStubDir} 下的假 apo.cmd（调用同目录 apo-stub.mjs），已如实披露；核心结论（有没有 --dry-run）不依赖这个 stub 的行为，只依赖操作系统层面解码出的真实命令行。`
    })

    // C2：与 Session D 的建文件动作合并——只要 apo 初始化这条的确认按钮文案也写明了后果，就并入总结论。
    mergeNotes('C2', `apo 项目初始化的确认按钮文案="${confirmLabelText}"，写明后果且非笼统「确认执行」=${confirmLabelOk}`)
    if (lib.results.C2.verdict !== 'FAIL' && lib.results.C2.verdict !== 'BLOCKED') {
      setResult('C2', confirmLabelOk ? lib.results.C2.verdict : 'FAIL', {
        evidence: [...lib.results.C2.evidence, '82-p2-preview-command-expanded.png'],
        steps: lib.results.C2.steps,
        notes: lib.results.C2.notes
      })
    }
  } catch (err) {
    setResult('P2', 'BLOCKED', { notes: `P2 异常：${err.stack || err}` })
  }

  await quitApp(app)
  killStrayArckeep()
}
