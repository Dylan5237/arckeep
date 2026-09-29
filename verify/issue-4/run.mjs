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
  // 真实全局热键能不能被真实 SendInput 触发。上一轮完整跑了 ~1 小时后发现几乎所有
  // 依赖真实热键的检查项都失败在同一个根因上；这次先用预检确认根因是否已修复，
  // 避免在还没修复之前又浪费一次完整 60 分钟的 Actions 时间。
  const { run: runPreflight } = await import('./scenarios/session-0-preflight.mjs')
  const preflight = await runPreflight()
  killStrayArckeep()

  const hotkeyDeliveryOk = preflight?.realHotkeyOpensCapture?.ok === true
  const sendInputToWindowOk = preflight?.sendInputToFocusedWindow?.ok === true
  console.log(`[run.mjs] preflight: sendInputToFocusedWindow.ok=${sendInputToWindowOk} realHotkeyOpensCapture.ok=${hotkeyDeliveryOk}`)

  if (!hotkeyDeliveryOk) {
    const reason = `预检发现真实全局热键（真实 SendInput 触发 RegisterHotKey/globalShortcut）在本次运行环境里没有生效，` +
      `详情见 evidence/preflight.json 的 realHotkeyOpensCapture 字段（sendInputToFocusedWindow.ok=${sendInputToWindowOk} 用于区分是` +
      `「SendInput 完全没送达任何窗口」还是「送达了已聚焦窗口，但全局热键本身没被触发」）。` +
      `为避免在根因未修复前重复消耗一次完整 60 分钟的 Actions 时间，本次运行到这里为止，未执行完整的 5 个 Session。`
    console.error(`\n===== 中止：真实热键预检未通过 =====\n${reason}`)
    for (const id of CHECK_IDS) {
      results[id] = { verdict: 'BLOCKED', evidence: ['preflight.json'], steps: '', notes: reason }
    }
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'results.json'), JSON.stringify(results, null, 2), 'utf8')
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'console-observations.json'), JSON.stringify(consoleObservations, null, 2), 'utf8')
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'index.md'), '# 证据索引\n\n| 文件 | 说明 | 对应检查项 |\n| --- | --- | --- |\n| `preflight.json` | 真实热键预检结果（详见其中字段） | 全部 |\n', 'utf8')
    return
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
