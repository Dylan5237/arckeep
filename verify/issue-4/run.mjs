// 验收编排入口。只驱动打包好的 Arckeep.exe（Playwright + 真实 SendInput），
// 不修改、不引用任何 Arckeep 产品源码运行时逻辑，只读它对外暴露的 IPC / DOM / 文件。
import fs from 'node:fs'
import path from 'node:path'
import * as lib from './lib.mjs'

const { CHECK_IDS, results, evidenceLog, EVIDENCE_DIR, consoleObservations, killStrayArckeep, __dirname } = lib

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

  const { run: runSessionA } = await import('./scenarios/session-a.mjs')
  const { run: runSessionB } = await import('./scenarios/session-b-corrupt.mjs')
  const { run: runSessionC } = await import('./scenarios/session-c-occupied.mjs')
  const { run: runSessionD } = await import('./scenarios/session-d-narrow.mjs')

  await runSession('Session A（热键/捕获/待办/简写/等我处理）', ['1', '2', '3', '4', '5', '6', '8', 'A1', 'A2', 'A3'], runSessionA)
  await runSession('Session B（jsonl 坏数据）', ['7'], runSessionB)
  await runSession('Session C（热键被占用：启动/保存冲突）', ['9', '10', 'A4', 'E1', 'E2'], runSessionC)
  await runSession('Session D（窄窗口）', ['E3'], runSessionD)

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
