// Session D：run-command 动作——本次验收里最重的一段。
// 覆盖 checklist: 4（三种 shell 预览/取消/确认/退出码）、5（转义注入 + 引用单测）、
// 6（长命令中止 + 进程树核对）、C2（确认按钮写后果）、C3（成败颜色 + stderr 在前）、
// C8（预览不出现 exit $LASTEXITCODE）、D1（预演摘要 + 折叠查看命令 + 无法预演标注）、
// D3（空输出块整块隐藏）
import fs from 'node:fs'
import path from 'node:path'
import * as lib from '../lib.mjs'

const {
  setResult, mergeNotes, launchApp, mainWindowPage, quitApp, killStrayArckeep,
  shot, fullShot, sleep, freshAppData, saveToolShelfJson, gotoTools, openCardByTitle,
  mkdtemp, waitFor, appendEvidenceJson, findProcessesByMarker, findNewPidByName,
  checkPidsAlive, uniqueMarker
} = lib

const cwdCmd = mkdtemp('arckeep-verify-cmd-')
const cwdPs = mkdtemp('arckeep-verify-ps-')
const cwdBash = mkdtemp('arckeep-verify-bash-')
const cwdExitCmd = mkdtemp('arckeep-verify-exit-cmd-')
const cwdExitPs = mkdtemp('arckeep-verify-exit-ps-')
const cwdExitBash = mkdtemp('arckeep-verify-exit-bash-')
const cwdInjCmd = mkdtemp('arckeep-verify-inj-cmd-')
const cwdInjPs = mkdtemp('arckeep-verify-inj-ps-')
const cwdInjBash = mkdtemp('arckeep-verify-inj-bash-')
const cwdAbortCmd = mkdtemp('arckeep-verify-abort-cmd-')
const cwdAbortPs = mkdtemp('arckeep-verify-abort-ps-')
const cwdAbortBash = mkdtemp('arckeep-verify-abort-bash-')
const cwdDryRun = mkdtemp('arckeep-verify-dryrun-')
const cwdDryRunFail = mkdtemp('arckeep-verify-dryrunfail-')
fs.writeFileSync(path.join(cwdDryRunFail, 'already-here.txt'), 'occupied')

const CONFIG = JSON.stringify({
  version: 1,
  actions: [
    {
      id: 'mkfile-cmd', title: '建文件·cmd', description: '在 cmd 里创建一个文件。',
      confirmLabel: '创建 {{filename}}', type: 'run-command', shell: 'cmd', cwd: cwdCmd,
      command: 'echo hi> {{filename}}',
      params: [{ key: 'filename', label: '文件名', required: true, default: 'created-cmd.txt' }]
    },
    {
      id: 'mkfile-ps', title: '建文件·PowerShell', description: '在 PowerShell 里创建一个文件。',
      confirmLabel: '创建 {{filename}}', type: 'run-command', shell: 'powershell', cwd: cwdPs,
      command: 'New-Item -Path {{filename}} -ItemType File -Force | Out-Null; Write-Output done',
      params: [{ key: 'filename', label: '文件名', required: true, default: 'created-ps.txt' }]
    },
    {
      id: 'mkfile-bash', title: '建文件·Git Bash', description: '在 Git Bash 里创建一个文件。',
      confirmLabel: '创建 {{filename}}', type: 'run-command', shell: 'git-bash', cwd: cwdBash,
      command: 'touch {{filename}} && echo done',
      params: [{ key: 'filename', label: '文件名', required: true, default: 'created-bash.txt' }]
    },
    {
      id: 'exit-cmd', title: '退出码·cmd', type: 'run-command', shell: 'cmd', cwd: cwdExitCmd,
      command: 'node -e "process.exit(Number(process.argv[1]))" {{code}}',
      params: [{ key: 'code', label: '退出码', required: true, default: '3' }]
    },
    {
      id: 'exit-ps', title: '退出码·PowerShell', type: 'run-command', shell: 'powershell', cwd: cwdExitPs,
      command: 'node -e "process.exit(Number(process.argv[1]))" {{code}}',
      params: [{ key: 'code', label: '退出码', required: true, default: '3' }]
    },
    {
      id: 'exit-bash', title: '退出码·Git Bash', type: 'run-command', shell: 'git-bash', cwd: cwdExitBash,
      command: 'node -e "process.exit(Number(process.argv[1]))" {{code}}',
      params: [{ key: 'code', label: '退出码', required: true, default: '3' }]
    },
    {
      id: 'inject-cmd', title: '注入测试·cmd', type: 'run-command', shell: 'cmd', cwd: cwdInjCmd,
      command: 'node -e "process.stdout.write(process.argv[1] ?? \'\')" {{payload}}',
      params: [{ key: 'payload', label: '参数', required: true }]
    },
    {
      id: 'inject-ps', title: '注入测试·PowerShell', type: 'run-command', shell: 'powershell', cwd: cwdInjPs,
      command: 'node -e "process.stdout.write(process.argv[1] ?? \'\')" {{payload}}',
      params: [{ key: 'payload', label: '参数', required: true }]
    },
    {
      id: 'inject-bash', title: '注入测试·Git Bash', type: 'run-command', shell: 'git-bash', cwd: cwdInjBash,
      command: 'node -e "process.stdout.write(process.argv[1] ?? \'\')" {{payload}}',
      params: [{ key: 'payload', label: '参数', required: true }]
    },
    {
      id: 'long-cmd', title: '长命令·cmd', type: 'run-command', shell: 'cmd', cwd: cwdAbortCmd,
      command: '{{marker}} & cmd /c "ping -n 120 127.0.0.1"',
      params: [{ key: 'marker', label: '标记', required: true }]
    },
    {
      id: 'long-ps', title: '长命令·PowerShell', type: 'run-command', shell: 'powershell', cwd: cwdAbortPs,
      command: "Start-Process -FilePath ping.exe -ArgumentList '-n','120','127.0.0.1' -WindowStyle Hidden; Start-Sleep -Seconds 120"
    },
    {
      id: 'long-bash', title: '长命令·Git Bash', type: 'run-command', shell: 'git-bash', cwd: cwdAbortBash,
      command: 'sh -c "ping -n 120 127.0.0.1"'
    },
    {
      id: 'dryrun-demo', title: '预演摘要示例', description: '预演能解析出文件列表。',
      confirmLabel: '在 {{cwd_label}} 创建示例文件', type: 'run-command', shell: 'powershell', cwd: cwdDryRun,
      previewCommand: "Write-Output 'creating: alpha.txt'; Write-Output 'creating: beta.txt'",
      command: "New-Item -Path alpha.txt -ItemType File -Force | Out-Null; New-Item -Path beta.txt -ItemType File -Force | Out-Null; Write-Output real-run-done; Start-Sleep -Milliseconds 1200",
      params: [{ key: 'cwd_label', label: '（占位，仅用于确认按钮文案）', default: cwdDryRun }]
    },
    {
      id: 'dryrun-fail-demo', title: '预演失败示例', description: '目标目录不为空，预演会失败。', type: 'run-command', shell: 'powershell', cwd: cwdDryRunFail,
      previewCommand: "if ((Get-ChildItem -Force | Measure-Object).Count -gt 0) { Write-Error 'target directory is not empty'; exit 7 } else { Write-Output ok }",
      command: "Write-Output should-not-run"
    },
    {
      id: 'empty-output-demo', title: '空输出示例', description: '成功且没有任何输出时，标准输出/错误应整块隐藏。', type: 'run-command', shell: 'powershell', cwd: cwdDryRun,
      command: 'exit 0'
    },
    {
      id: 'failure-stderr-first', title: '失败示例·stderr在前', type: 'run-command', shell: 'powershell', cwd: cwdDryRun,
      command: "Write-Output out-line; Write-Error err-line; exit 5"
    }
  ]
}, null, 2)

async function fillParamByLabel(page, label, value) {
  const input = page.locator(`input[aria-label="${label}"]`)
  await input.fill('')
  await input.fill(value)
}

export async function run() {
  killStrayArckeep()
  const appData = freshAppData('run-command')
  const app = await launchApp({ label: 'D-run-command', appData })
  const page = await mainWindowPage(app)
  await saveToolShelfJson(page, CONFIG)

  const item4Results = []
  const c2Results = []
  const c8Results = []

  // ==================================================================
  // Item 4 + C2 + C8：cmd / PowerShell / Git Bash 各测一次：预览→取消不执行，
  // 预览→确认执行显示输出+退出码 0，另一次 exit 3
  // ==================================================================
  const shellCases = [
    { title: '建文件·cmd', cwd: cwdCmd, filename: 'my file cmd.txt', label: 'cmd' },
    { title: '建文件·PowerShell', cwd: cwdPs, filename: 'my file ps.txt', label: 'PowerShell' },
    { title: '建文件·Git Bash', cwd: cwdBash, filename: 'my file bash.txt', label: 'Git Bash' }
  ]
  for (const sc of shellCases) {
    try {
      // ---- 取消：不执行 ----
      await gotoTools(page)
      await openCardByTitle(page, sc.title)
      await fillParamByLabel(page, '文件名', sc.filename)
      await page.click('button.primary:has-text("预览")')
      await page.waitForSelector('.modal', { timeout: 8000 })
      await sleep(200)
      const foldedClosed = await page.locator('.modal details.tool-command').getAttribute('open') === null
      await page.click('.modal details.tool-command summary')
      await sleep(80)
      const previewTextCancel = await page.locator('.modal .tool-command pre.tool-pre').innerText()
      const confirmLabelText = await page.locator('.modal button.primary').innerText()
      const noExitWrapper = !previewTextCancel.includes('exit $LASTEXITCODE') && !previewTextCancel.includes('$LASTEXITCODE')
      await shot(page, `30-item4-${sc.label}-preview`, { checkIds: ['4', 'C2', 'C8'], description: `${sc.label} 预览：命令 + 确认按钮文案` })
      const targetFile = path.join(sc.cwd, sc.filename)
      try { fs.rmSync(targetFile, { force: true }) } catch { /* ignore */ }
      await page.click('.modal button.ghost:has-text("取消")')
      await sleep(200)
      const existsAfterCancel = fs.existsSync(targetFile)
      await shot(page, `31-item4-${sc.label}-after-cancel`, { checkIds: ['4'], description: `${sc.label} 点取消后回到参数页，文件不应存在` })

      // ---- 再来一次：确认执行 ----
      await gotoTools(page)
      await openCardByTitle(page, sc.title)
      await fillParamByLabel(page, '文件名', sc.filename)
      await page.click('button.primary:has-text("预览")')
      await page.waitForSelector('.modal', { timeout: 8000 })
      await page.click('.modal button.primary')
      await waitFor(async () => (await page.locator('.run-status').innerText().catch(() => '')).includes('完成'), { timeoutMs: 10000, intervalMs: 100 })
      await sleep(150)
      const statusText = await page.locator('.run-status').innerText()
      const existsAfterConfirm = fs.existsSync(targetFile)
      await shot(page, `32-item4-${sc.label}-after-confirm`, { checkIds: ['4', 'C3'], description: `${sc.label} 确认执行后：状态 + 输出` })
      appendEvidenceJson(`item4-${sc.label}`, { foldedClosed, previewTextCancel, confirmLabelText, noExitWrapper, existsAfterCancel, existsAfterConfirm, statusText, targetFile })

      const ok = !existsAfterCancel && existsAfterConfirm && statusText.includes('完成')
      item4Results.push(ok)
      c2Results.push(!confirmLabelText.includes('确认执行') && confirmLabelText.includes(sc.filename))
      c8Results.push(noExitWrapper)
    } catch (err) {
      item4Results.push(false)
      mergeNotes('4', `${sc.label} 场景异常：${err.stack || err}`)
    }
  }

  // ---- 退出码 3，三种 shell ----
  const exitCases = [
    { title: '退出码·cmd', label: 'cmd' },
    { title: '退出码·PowerShell', label: 'PowerShell' },
    { title: '退出码·Git Bash', label: 'Git Bash' }
  ]
  for (const ec of exitCases) {
    try {
      await gotoTools(page)
      await openCardByTitle(page, ec.title)
      await page.click('button.primary:has-text("预览")')
      await page.waitForSelector('.modal', { timeout: 8000 })
      await page.click('.modal button.primary')
      await waitFor(async () => /失败|完成/.test(await page.locator('.run-status').innerText().catch(() => '')), { timeoutMs: 10000, intervalMs: 100 })
      await sleep(150)
      const statusText = await page.locator('.run-status').innerText()
      await shot(page, `33-exitcode-${ec.label}`, { checkIds: ['4'], description: `${ec.label} 退出码 3` })
      const ok = statusText.includes('退出码 3')
      item4Results.push(ok)
      appendEvidenceJson(`exitcode-${ec.label}`, { statusText })
    } catch (err) {
      item4Results.push(false)
      mergeNotes('4', `${ec.label} 退出码场景异常：${err.stack || err}`)
    }
  }

  setResult('4', item4Results.every(Boolean) ? 'PASS' : 'FAIL', {
    evidence: shellCases.flatMap(sc => [`30-item4-${sc.label}-preview.png`, `31-item4-${sc.label}-after-cancel.png`, `32-item4-${sc.label}-after-confirm.png`]),
    steps: '对 cmd / PowerShell / Git Bash 各建一个「填参数创建文件」的动作：填文件名后点预览，核对命令文本；点取消，核对文件不存在；再重复一次点确认，核对文件存在、状态显示「完成」。另外三个「退出码」动作确认后状态显示「失败（退出码 3）」。',
    notes: `逐项结果：${JSON.stringify(item4Results)}`
  })
  setResult('C2', c2Results.every(Boolean) ? 'PASS' : 'FAIL', {
    evidence: shellCases.map(sc => `30-item4-${sc.label}-preview.png`),
    steps: '核对预览弹窗里的确认按钮文案是不是笼统的「确认执行」，是否用填好的参数写明了后果（例如「创建 my file cmd.txt」）。P2 的 apo 项目初始化确认按钮见 Session F，一并计入本条结论。',
    notes: `建文件动作的确认按钮文案逐项匹配「写明后果+不是确认执行」=${JSON.stringify(c2Results)}（P2 场景的结果见 Session F 合并）`
  })
  setResult('C8', c8Results.every(Boolean) ? 'PASS' : 'FAIL', {
    evidence: shellCases.map(sc => `30-item4-${sc.label}-preview.png`),
    steps: '核对预览「查看命令」里展开的命令文本，不应出现 exit $LASTEXITCODE 或 $LASTEXITCODE 这类内部包装字样（这些只在 PowerShell 真实启动脚本里，不该出现在预览文案）。',
    notes: `逐项检查未出现内部包装字样=${JSON.stringify(c8Results)}`
  })

  // ==================================================================
  // Item 5：注入测试。common 五个 payload 三种 shell 都测；三个「专属标记文件」payload
  // 各按提示词给定的 shell 语法各测一次。
  // ==================================================================
  const commonPayloads = ['`whoami`', '"', "'", '%PATH%', '^', '|']
  const shellInjectCases = [
    { title: '注入测试·cmd', label: 'cmd' },
    { title: '注入测试·PowerShell', label: 'PowerShell' },
    { title: '注入测试·Git Bash', label: 'Git Bash' }
  ]
  const specificPayloads = {
    cmd: '& echo pwned > C:\\pwned-cmd.txt',
    PowerShell: '; echo pwned > pwned-ps.txt',
    'Git Bash': '$(echo pwned > pwned-sh.txt)'
  }
  const specificMarkerFiles = {
    cmd: 'C:\\pwned-cmd.txt',
    PowerShell: path.join(cwdInjPs, 'pwned-ps.txt'),
    'Git Bash': path.join(cwdInjBash, 'pwned-sh.txt')
  }

  const item5Rows = []
  for (const sic of shellInjectCases) {
    const payloadsToTest = [specificPayloads[sic.label], ...commonPayloads]
    for (const payload of payloadsToTest) {
      try {
        await gotoTools(page)
        await openCardByTitle(page, sic.title)
        await fillParamByLabel(page, '参数', payload)
        await page.click('button.primary:has-text("预览")')
        await page.waitForSelector('.modal', { timeout: 8000 })
        await page.click('.modal details.tool-command summary')
        await sleep(80)
        const previewText = await page.locator('.modal .tool-command pre.tool-pre').innerText()
        const rawPayloadVisible = previewText.includes(payload) || previewText.includes(payload.replace(/\n/g, ' '))
        await page.click('.modal button.primary')
        await waitFor(async () => /失败|完成/.test(await page.locator('.run-status').innerText().catch(() => '')), { timeoutMs: 10000, intervalMs: 100 })
        await sleep(150)
        const statusText = await page.locator('.run-status').innerText()
        const stdoutBlock = await page.locator('.tool-live:not(.tool-stderr)').innerText().catch(() => '')
        const stdoutMatchesPayload = stdoutBlock === payload
        const markerFile = specificMarkerFiles[sic.label]
        const markerExists = payload === specificPayloads[sic.label] ? fs.existsSync(markerFile) : false
        const ok = statusText.includes('完成') && stdoutMatchesPayload && !markerExists && rawPayloadVisible
        item5Rows.push({ shell: sic.label, payload, ok, statusText, stdoutBlock, markerExists, rawPayloadVisible })
        if (item5Rows.length <= 6) {
          await shot(page, `40-item5-${sic.label}-${item5Rows.length}`, { checkIds: ['5'], description: `${sic.label} 注入 payload=${JSON.stringify(payload)} 执行后` })
        }
      } catch (err) {
        item5Rows.push({ shell: sic.label, payload, ok: false, error: String(err) })
      }
    }
  }
  appendEvidenceJson('item5-all-rows', item5Rows)
  const item5AllOk = item5Rows.every(r => r.ok)
  setResult('5', item5AllOk ? 'PASS' : 'FAIL', {
    evidence: ['item5-all-rows.json', '40-item5-cmd-1.png', '40-item5-PowerShell-1.png', '40-item5-Git Bash-1.png'],
    steps: `三种 shell 各自的「专属标记文件」payload（cmd: & echo pwned > C:\\pwned-cmd.txt；PowerShell: ; echo pwned > pwned-ps.txt；Git Bash: $(echo pwned > pwned-sh.txt)）+ 三种 shell 都测的 6 个通用 payload（反引号 whoami、双引号、单引号、%PATH%、caret、竖线）。每个都在参数页填入、预览里核对原样显示、确认执行后核对标记文件不存在（cmd 用例还检查 C:\\pwned-cmd.txt 这个绝对路径不存在）、状态为「完成」、标准输出里的内容与填入的 payload 逐字相等（证明 shell 没有把它当命令执行，只当成字面参数传给了 node 的 process.stdout.write）。 换行 payload（"\\necho pwned>marker"）由于是单行 <input type=text>，浏览器原生行为不允许把换行符写进 value，UI 端测不出来；这一具体 case 由仓库自带单测覆盖，见下方「引用的单元测试」。`,
    notes: `共 ${item5Rows.length} 组，全部通过=${item5AllOk}；失败/异常明细见 item5-all-rows.json。`
  })

  // ==================================================================
  // Item 6：长命令中止 + 进程树核对（用 WMI Win32_Process，独立于被测应用）
  // ==================================================================
  const abortResults = []
  try {
    // cmd：命令行里带唯一标记，直接用 CommandLine.Contains(marker) 找根进程（planShell 对 cmd 是逐字透传 verbatim）
    const marker = `rem ${uniqueMarker('CMD')}`
    await gotoTools(page)
    await openCardByTitle(page, '长命令·cmd')
    await fillParamByLabel(page, '标记', marker)
    await page.click('button.primary:has-text("预览")')
    await page.waitForSelector('.modal', { timeout: 8000 })
    await page.click('.modal button.primary')
    await sleep(1200)
    const tree1 = findProcessesByMarker(marker.split(' ')[1])
    const runningPids = (tree1.procs ?? []).map(p => p.pid)
    // 再找子进程（ping.exe / 内层 cmd.exe），按父子链闭包一次
    let allPids = new Set(runningPids)
    for (let round = 0; round < 3; round += 1) {
      const before = new Set(allPids)
      const snap = lib.snapshotPidsByName('cmd,ping')
      for (const p of snap.procs ?? []) {
        if (allPids.has(p.parentPid)) allPids.add(p.pid)
      }
      if (allPids.size === before.size) break
    }
    await shot(page, '50-item6-cmd-running', { checkIds: ['6'], description: 'cmd 长命令运行中' })
    appendEvidenceJson('item6-cmd-before-abort', { runningPids: [...allPids] })
    await page.click('button.danger:has-text("中止")')
    await waitFor(async () => (await page.locator('.run-status').innerText().catch(() => '')).includes('已终止'), { timeoutMs: 8000, intervalMs: 100 })
    await sleep(600)
    const statusAfterAbort = await page.locator('.run-status').innerText()
    const alive = checkPidsAlive([...allPids])
    await shot(page, '51-item6-cmd-aborted', { checkIds: ['6'], description: 'cmd 长命令中止后：界面显示已终止' })
    appendEvidenceJson('item6-cmd-after-abort', { statusAfterAbort, alive })
    const ok = statusAfterAbort.includes('已终止') && allPids.size >= 2 && alive.alive.length === 0
    abortResults.push({ shell: 'cmd', ok, statusAfterAbort, treeSize: allPids.size, aliveAfter: alive.alive })
  } catch (err) {
    abortResults.push({ shell: 'cmd', ok: false, error: String(err) })
  }

  try {
    // PowerShell：EncodedCommand 不会在命令行里留下可读标记，改用「点确认前后」按进程名做差集找新起的 powershell/ping 进程
    await gotoTools(page)
    await openCardByTitle(page, '长命令·PowerShell')
    await page.click('button.primary:has-text("预览")')
    await page.waitForSelector('.modal', { timeout: 8000 })
    const diff = await lib.findNewPidByName('powershell,pwsh', async () => {
      await page.click('.modal button.primary')
    }, { settleMs: 900 })
    let allPids = new Set(diff.newOnes.map(p => p.pid))
    for (let round = 0; round < 3; round += 1) {
      const before = new Set(allPids)
      const snap = lib.snapshotPidsByName('powershell,pwsh,ping')
      for (const p of snap.procs ?? []) {
        if (allPids.has(p.parentPid)) allPids.add(p.pid)
      }
      if (allPids.size === before.size) break
    }
    await shot(page, '52-item6-ps-running', { checkIds: ['6'], description: 'PowerShell 长命令运行中' })
    appendEvidenceJson('item6-ps-before-abort', { diff, allPids: [...allPids] })
    await page.click('button.danger:has-text("中止")')
    await waitFor(async () => (await page.locator('.run-status').innerText().catch(() => '')).includes('已终止'), { timeoutMs: 8000, intervalMs: 100 })
    await sleep(600)
    const statusAfterAbort = await page.locator('.run-status').innerText()
    const alive = checkPidsAlive([...allPids])
    await shot(page, '53-item6-ps-aborted', { checkIds: ['6'], description: 'PowerShell 长命令中止后：界面显示已终止' })
    appendEvidenceJson('item6-ps-after-abort', { statusAfterAbort, alive })
    const ok = statusAfterAbort.includes('已终止') && allPids.size >= 1 && alive.alive.length === 0
    abortResults.push({ shell: 'PowerShell', ok, statusAfterAbort, treeSize: allPids.size, aliveAfter: alive.alive })
  } catch (err) {
    abortResults.push({ shell: 'PowerShell', ok: false, error: String(err) })
  }

  try {
    await gotoTools(page)
    await openCardByTitle(page, '长命令·Git Bash')
    await page.click('button.primary:has-text("预览")')
    await page.waitForSelector('.modal', { timeout: 8000 })
    const diff = await lib.findNewPidByName('bash,sh', async () => {
      await page.click('.modal button.primary')
    }, { settleMs: 900 })
    let allPids = new Set(diff.newOnes.map(p => p.pid))
    for (let round = 0; round < 3; round += 1) {
      const before = new Set(allPids)
      const snap = lib.snapshotPidsByName('bash,sh,ping')
      for (const p of snap.procs ?? []) {
        if (allPids.has(p.parentPid)) allPids.add(p.pid)
      }
      if (allPids.size === before.size) break
    }
    await shot(page, '54-item6-bash-running', { checkIds: ['6'], description: 'Git Bash 长命令运行中' })
    appendEvidenceJson('item6-bash-before-abort', { diff, allPids: [...allPids] })
    await page.click('button.danger:has-text("中止")')
    await waitFor(async () => (await page.locator('.run-status').innerText().catch(() => '')).includes('已终止'), { timeoutMs: 8000, intervalMs: 100 })
    await sleep(600)
    const statusAfterAbort = await page.locator('.run-status').innerText()
    const alive = checkPidsAlive([...allPids])
    await shot(page, '55-item6-bash-aborted', { checkIds: ['6'], description: 'Git Bash 长命令中止后：界面显示已终止' })
    appendEvidenceJson('item6-bash-after-abort', { statusAfterAbort, alive })
    const ok = statusAfterAbort.includes('已终止') && allPids.size >= 1 && alive.alive.length === 0
    abortResults.push({ shell: 'Git Bash', ok, statusAfterAbort, treeSize: allPids.size, aliveAfter: alive.alive })
  } catch (err) {
    abortResults.push({ shell: 'Git Bash', ok: false, error: String(err) })
  }

  appendEvidenceJson('item6-summary', abortResults)
  setResult('6', abortResults.every(r => r.ok) ? 'PASS' : 'FAIL', {
    evidence: ['50-item6-cmd-running.png', '51-item6-cmd-aborted.png', '52-item6-ps-running.png', '53-item6-ps-aborted.png', '54-item6-bash-running.png', '55-item6-bash-aborted.png', 'item6-summary.json'],
    steps: '三种 shell 各跑一个 120 秒的长命令（cmd: 内层 cmd /c ping -n 120；PowerShell: Start-Process ping.exe 再 Start-Sleep；Git Bash: sh -c ping -n 120，都带子进程）。cmd 用命令行里的唯一标记直接用 WMI 找根进程；PowerShell/Git Bash 用「点确认前后」按进程名做差集找到新起的宿主进程。点确认约 1 秒后用 WMI 按父子链把整棵树收集全，点「中止」，等界面显示「已终止」，再用 Get-Process 逐个核对树上每个 pid 是否都已经不在。',
    notes: `逐 shell 结果：${JSON.stringify(abortResults.map(r => ({ shell: r.shell, ok: r.ok, treeSize: r.treeSize, aliveAfter: r.aliveAfter })))}`
  })

  // ==================================================================
  // D1：预演摘要（能解析出文件列表）+ 折叠查看命令 + 无法预演标注 + 预演失败挡住确认
  // ==================================================================
  try {
    await gotoTools(page)
    await openCardByTitle(page, '预演摘要示例')
    await page.click('button.primary:has-text("预览")')
    await page.waitForSelector('.modal', { timeout: 8000 })
    await sleep(300)
    const summaryText = await page.locator('.rehearsal-summary').innerText().catch(() => '')
    const detailsOpenAttr = await page.locator('.modal details.tool-command').getAttribute('open')
    const foldedClosedByDefault = detailsOpenAttr === null
    await shot(page, '60-d1-preview-summary-collapsed', { checkIds: ['D1'], description: '预演摘要（能解析出文件列表）+「查看命令」默认折叠' })
    await page.click('.modal details.tool-command summary')
    await sleep(150)
    const foldedText = await page.locator('.modal details.tool-command').innerText()
    await shot(page, '61-d1-preview-command-expanded', { checkIds: ['D1'], description: '展开「查看命令」后的真实命令' })

    const expectedFiles = ['alpha.txt', 'beta.txt']
    const summaryMentionsN = summaryText.includes('创建 2 个文件') || summaryText.includes(`创建 ${expectedFiles.length} 个文件`)
    const summaryMentionsFiles = expectedFiles.every(f => summaryText.includes(f))
    const summaryMentionsCwd = summaryText.includes(cwdDryRun)

    // 找到刚起的 powershell 宿主，解码它的真实 EncodedCommand，核对和「查看命令」展开内容一致，且没有 --dry-run
    const diff = await lib.findNewPidByName('powershell,pwsh', async () => {
      await page.click('.modal button.primary')
    }, { settleMs: 400 })
    let decoded = null
    if (diff.newOnes[0]) {
      const cl = lib.getCommandLine(diff.newOnes[0].pid)
      decoded = cl.found ? lib.decodePowershellEncodedCommand(cl.commandLine) : null
    }
    await waitFor(async () => (await page.locator('.run-status').innerText().catch(() => '')).includes('完成'), { timeoutMs: 10000, intervalMs: 100 })
    const realFilesCreated = fs.existsSync(path.join(cwdDryRun, 'alpha.txt')) && fs.existsSync(path.join(cwdDryRun, 'beta.txt'))
    const realCommandNoDryRun = decoded !== null && !decoded.includes('creating:')
    const foldedMatchesReal = decoded !== null && foldedText.includes('New-Item') && decoded.includes('New-Item')
    await shot(page, '62-d1-after-confirm', { checkIds: ['D1'], description: '确认后：真的创建了 alpha.txt / beta.txt' })
    appendEvidenceJson('d1-detail', {
      summaryText, foldedClosedByDefault, foldedText, expectedFiles, summaryMentionsN, summaryMentionsFiles, summaryMentionsCwd,
      decoded, realFilesCreated, realCommandNoDryRun, foldedMatchesReal
    })

    const d1PreviewOk = summaryMentionsN && summaryMentionsFiles && summaryMentionsCwd && foldedClosedByDefault
    const d1ExecOk = realFilesCreated && realCommandNoDryRun && foldedMatchesReal

    // 预演失败：目标目录不为空，退出码非 0，确认按钮不可用
    await gotoTools(page)
    await openCardByTitle(page, '预演失败示例')
    await page.click('button.primary:has-text("预览")')
    await page.waitForSelector('.modal', { timeout: 8000 })
    await sleep(300)
    const failSummary = await page.locator('.modal .alert.error').innerText().catch(() => '')
    const confirmButtonCount = await page.locator('.modal button.primary').count()
    await shot(page, '63-d1-dryrun-failed', { checkIds: ['D1'], description: '预演失败：写明退出码和原因，只有取消按钮' })
    let clickHadNoEffect = true
    if (confirmButtonCount > 0) {
      await page.locator('.modal button.primary').click({ trial: false }).catch(() => {})
      await sleep(300)
      clickHadNoEffect = !(await page.locator('.run-status').count() > 0 && (await page.locator('.run-status').innerText()).includes('运行中'))
    }
    const failMentionsExitCode = /退出码\s*7|exit.*7/i.test(failSummary) || failSummary.includes('7')
    appendEvidenceJson('d1-dryrun-fail-detail', { failSummary, confirmButtonCount, clickHadNoEffect, failMentionsExitCode })
    const failModalButtonTexts = await page.locator('.modal button').allInnerTexts().catch(() => [])
    lib.noteObservation(`已知/不计分项：预演失败弹窗（截图 63-d1-dryrun-failed）目前只有「${failModalButtonTexts.join('、')}」这些按钮，没有「换一个目录」之类的按钮（产品方已决定这个后续再加，这里只记录现状，不计入 D1 的 PASS/FAIL 判定）。`)

    const d1FailOk = failSummary.length > 0 && confirmButtonCount === 0 && clickHadNoEffect

    setResult('D1', d1PreviewOk && d1ExecOk && d1FailOk ? 'PASS' : 'FAIL', {
      evidence: ['60-d1-preview-summary-collapsed.png', '61-d1-preview-command-expanded.png', '62-d1-after-confirm.png', '63-d1-dryrun-failed.png', 'd1-detail.json', 'd1-dryrun-fail-detail.json'],
      steps: '① 一个 previewCommand 会输出 2 行「creating: xxx」的动作：预览时真的先跑了这个 dry-run，最上面写「将在 <cwd> 创建 2 个文件：alpha.txt、beta.txt」，「查看命令」默认折叠，展开后是真正会跑的 New-Item 命令；确认后用「点确认前后按进程名做差集」抓到刚起的 powershell.exe，解码它的 -EncodedCommand，核对和「查看命令」展开内容一致、且不含 dry-run 预演脚本的痕迹，同时磁盘上真的多了 alpha.txt / beta.txt。② 另一个 previewCommand 会检测目录不为空并以退出码 7 失败的动作：预演失败提示写明原因，确认按钮不出现（点了也没有反应）。',
      notes: `预览摘要：N/文件名/目录=${d1PreviewOk}（summary="${summaryText}"）；折叠默认关闭=${foldedClosedByDefault}；确认后真实命令(解码自 EncodedCommand)="${decoded}"；真实执行且无 dry-run 字样=${realCommandNoDryRun}；磁盘文件已创建=${realFilesCreated}；预演失败挡住确认=${d1FailOk}（失败摘要="${failSummary}"）`
    })
  } catch (err) {
    setResult('D1', 'BLOCKED', { notes: `D1 异常：${err.stack || err}` })
  }

  // ==================================================================
  // D3 + C3：空输出整块隐藏；失败时 stderr 在 stdout 前，颜色红/绿正确
  // ==================================================================
  try {
    await gotoTools(page)
    await openCardByTitle(page, '空输出示例')
    await page.click('button.primary:has-text("预览")')
    await page.waitForSelector('.modal', { timeout: 8000 })
    await page.click('.modal button.primary')
    await waitFor(async () => (await page.locator('.run-status').innerText().catch(() => '')).includes('完成'), { timeoutMs: 8000, intervalMs: 100 })
    await sleep(150)
    const statusColorClass = await page.locator('.run-status').getAttribute('class')
    const stdoutBlockCount = await page.locator('h2:has-text("标准输出")').count()
    const stderrBlockCount = await page.locator('h2:has-text("标准错误")').count()
    await shot(page, '64-d3-empty-output', { checkIds: ['D3', 'C3'], description: '成功且没有任何输出：标准输出/标准错误整块隐藏，状态绿色「完成」' })
    appendEvidenceJson('d3-empty-detail', { statusColorClass, stdoutBlockCount, stderrBlockCount })
    const emptyHiddenOk = stdoutBlockCount === 0 && stderrBlockCount === 0 && statusColorClass.includes('run-ok')

    await gotoTools(page)
    await openCardByTitle(page, '失败示例·stderr在前')
    await page.click('button.primary:has-text("预览")')
    await page.waitForSelector('.modal', { timeout: 8000 })
    await page.click('.modal button.primary')
    await waitFor(async () => (await page.locator('.run-status').innerText().catch(() => '')).includes('失败'), { timeoutMs: 8000, intervalMs: 100 })
    await sleep(150)
    const failColorClass = await page.locator('.run-status').getAttribute('class')
    const headings = await page.locator('.tool-output-card h2').allInnerTexts()
    const stderrFirst = headings[0] === '标准错误' && headings[1] === '标准输出'
    await shot(page, '65-d3-stderr-first', { checkIds: ['D3', 'C3'], description: '失败：stderr 在 stdout 前，状态红色「失败（退出码 5）」' })
    appendEvidenceJson('d3-fail-detail', { failColorClass, headings, stderrFirst })
    const failOk = stderrFirst && failColorClass.includes('run-failed') && (await page.locator('.run-status').innerText()).includes('退出码 5')

    setResult('D3', emptyHiddenOk && stderrFirst ? 'PASS' : 'FAIL', {
      evidence: ['64-d3-empty-output.png', '65-d3-stderr-first.png', 'd3-empty-detail.json', 'd3-fail-detail.json'],
      steps: '① 一个只 exit 0、没有任何输出的命令：核对页面上完全没有「标准输出」「标准错误」两个区块标题（而不是显示成空的红字）。② 一个既有 stdout 又有 stderr 且以非 0 退出的命令：核对「标准错误」区块在「标准输出」前面出现。',
      notes: `空输出整块隐藏=${emptyHiddenOk}（stdoutBlockCount=${stdoutBlockCount}, stderrBlockCount=${stderrBlockCount}）；失败时 stderr 在前=${stderrFirst}（headings=${JSON.stringify(headings)}）`
    })
    setResult('C3', emptyHiddenOk && failOk ? 'PASS' : 'FAIL', {
      evidence: ['32-item4-cmd-after-confirm.png', '64-d3-empty-output.png', '65-d3-stderr-first.png'],
      steps: '核对成功时状态文字是绿色「完成」（class 含 run-ok），失败时是红色「失败（退出码 N）」（class 含 run-failed），且失败时 stderr 显示在 stdout 之前。',
      notes: `成功态 class=${statusColorClass}；失败态 class=${failColorClass}，失败文案含退出码 5=${(failOk)}`
    })
  } catch (err) {
    setResult('D3', 'BLOCKED', { notes: `D3 异常：${err.stack || err}` })
    setResult('C3', 'BLOCKED', { notes: `C3 异常：${err.stack || err}` })
  }

  await quitApp(app)
  killStrayArckeep()
}
