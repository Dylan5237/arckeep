// 验收编排入口。只驱动打包好的 Arckeep.exe（Playwright + 真实 SendInput），
// 不修改、不引用任何 Arckeep 产品源码运行时逻辑，只读它对外暴露的 IPC / DOM / 文件。
import fs from 'node:fs'
import path from 'node:path'
import * as lib from './lib.mjs'

const { CHECK_IDS, results, evidenceLog, EVIDENCE_DIR, consoleObservations, killStrayArckeep } = lib

function markUnrun(ids, reason) {
  for (const id of ids) {
    if (results[id].verdict === 'BLOCKED' && results[id].notes === '尚未执行到这一条') {
      results[id] = { verdict: 'BLOCKED', evidence: [], steps: '', notes: reason }
    }
  }
}

async function runSession(name, ids, fn) {
  console.log(`\n===== ${name} 开始 =====`)
  try {
    await fn()
    console.log(`===== ${name} 结束 =====`)
  } catch (err) {
    console.error(`===== ${name} 整体异常 =====`, err)
    markUnrun(ids, `${name} 整体抛出异常，未能执行到这一条：${err.stack || err}`)
  } finally {
    killStrayArckeep()
  }
}

async function main() {
  if (!process.env.ARCKEEP_EXE_PATH) throw new Error('ARCKEEP_EXE_PATH env is required')
  console.log('[run.mjs] ARCKEEP_EXE_PATH =', process.env.ARCKEEP_EXE_PATH)
  console.log('[run.mjs] EVIDENCE_DIR =', EVIDENCE_DIR)

  // 先跑一个很快（<1 分钟）的预检：SendInput 能不能送达一个已知聚焦的窗口、
  // 真实全局热键能不能被真实 SendInput 触发。第一轮完整跑了 ~1 小时后发现几乎所有
  // 依赖真实热键的检查项都卡在同一个根因上：这个 GitHub-hosted windows-latest 环境里，
  // SendInput 在 Win32 层面调用成功（不报错、不是 0 个事件），但目标窗口（不管是不是
  // 通过热键打开的）完全收不到任何按键效果——这是这个 CI 平台本身的会话/输入桌面限制，
  // 不是产品缺陷，也不是脚本 bug（真正的 $pid/$PID 变量冲突 bug 已经在上一版修了）。
  // 预检结果写进 evidence/preflight.json，并存进 lib.envFlags 供各 scenario 参考：
  // 需要验证「真实全局热键机制本身」的检查项据此直接判 BLOCKED（不再反复重试一个
  // 已知会卡满 8000ms/30000ms 超时的动作，节省 Actions 时间）；其它检查项改用测试钩子
  // 打开捕获窗口 + Playwright 自己的 CDP 键盘事件（不经过 OS，走 Chromium 真实输入管线，
  // 能如实测到渲染进程/主进程里除「OS 全局热键投递」之外的全部真实逻辑）。
  const { run: runPreflight } = await import('./scenarios/session-0-preflight.mjs')
  const preflight = await runPreflight()
  killStrayArckeep()

  lib.envFlags.hotkeyDeliveryOk = preflight?.realHotkeyOpensCapture?.ok === true
  lib.envFlags.sendInputToWindowOk = preflight?.sendInputToFocusedWindow?.ok === true
  lib.envFlags.checkedAt = new Date().toISOString()
  console.log(`[run.mjs] preflight: sendInputToFocusedWindow.ok=${lib.envFlags.sendInputToWindowOk} realHotkeyOpensCapture.ok=${lib.envFlags.hotkeyDeliveryOk}`)
  if (!lib.envFlags.hotkeyDeliveryOk) {
    console.warn('\n[run.mjs] 警告：真实全局热键预检未通过，见 evidence/preflight.json。' +
      '涉及「真实全局热键机制本身」的检查项会据此直接判 BLOCKED；其它检查项改用测试钩子+Playwright 键盘事件继续正常测试。')
  }

  const { run: runSessionA } = await import('./scenarios/session-a.mjs')
  const { run: runSessionB } = await import('./scenarios/session-b-corrupt.mjs')
  const { run: runSessionC } = await import('./scenarios/session-c-occupied.mjs')
  const { run: runSessionD } = await import('./scenarios/session-d-narrow.mjs')
  const { run: runSessionE } = await import('./scenarios/session-e-review.mjs')

  await runSession('Session A（热键/捕获/待办/简写/等我处理）', ['1', '2', '3', '4', '5', '6', '8', 'A1', 'A2', 'A3'], runSessionA)
  await runSession('Session B（jsonl 坏数据）', ['7'], runSessionB)
  await runSession('Session C（热键被占用：启动/保存冲突）', ['9', '10', 'A4', 'E1', 'E2'], runSessionC)
  await runSession('Session D（窄窗口）', ['E3'], runSessionD)
  await runSession('Session E（#18 设计评审 R1-R5）', ['R1', 'R2', 'R3', 'R4', 'R5'], runSessionE)

  fs.writeFileSync(path.join(EVIDENCE_DIR, 'results.json'), JSON.stringify(results, null, 2), 'utf8')
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'console-observations.json'), JSON.stringify(consoleObservations, null, 2), 'utf8')

  const lines = ['# 证据索引\n', '| 文件 | 说明 | 对应检查项 |', '| --- | --- | --- |']
  for (const item of evidenceLog) {
    lines.push(`| \`${item.file}\` | ${item.description} | ${item.checkIds.join(', ')} |`)
  }
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'index.md'), lines.join('\n') + '\n', 'utf8')

  console.log('\n===== 结论汇总 =====')
  for (const id of CHECK_IDS) {
    console.log(`${id}\t${results[id].verdict}\t${results[id].notes}`.slice(0, 400))
  }

  const summaryCounts = CHECK_IDS.reduce((acc, id) => {
    acc[results[id].verdict] = (acc[results[id].verdict] || 0) + 1
    return acc
  }, {})
  console.log('\n统计：', summaryCounts)

  if (consoleObservations.length > 0) {
    console.log(`\n观察到 ${consoleObservations.length} 条控制台 error/warning/pageerror，见 evidence/console-observations.json`)
  }
}

main().catch(err => {
  console.error('[run.mjs] 致命错误，验收脚本本身异常终止：', err)
  process.exitCode = 1
})
