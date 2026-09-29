// 独立验收编排入口。不是产品代码，只依次跑各个 session 场景文件，
// 每个 session 独立 try/catch（某个场景炸了不阻塞其它场景），最后把所有结论/证据落盘。
import fs from 'node:fs'
import path from 'node:path'
import * as lib from './lib.mjs'

const SESSIONS = [
  ['A-validate', () => import('./scenarios/session-a-validate.mjs')],
  ['B-open-url', () => import('./scenarios/session-b-open-url.mjs')],
  ['C-open-folder', () => import('./scenarios/session-c-open-folder.mjs')],
  ['D-run-command', () => import('./scenarios/session-d-run-command.mjs')],
  ['E-template', () => import('./scenarios/session-e-template.mjs')],
  ['F-apo-init', () => import('./scenarios/session-f-apo-init.mjs')],
  ['G-ui-review', () => import('./scenarios/session-g-ui-review.mjs')]
]

const sessionOutcomes = []

async function main() {
  console.log(`[run] ARCKEEP_EXE_PATH=${lib.EXE}`)
  console.log(`[run] evidence dir=${lib.EVIDENCE_DIR}`)
  if (!lib.EXE || !fs.existsSync(lib.EXE)) {
    throw new Error(`ARCKEEP_EXE_PATH 未设置或文件不存在：${lib.EXE}`)
  }

  // 提前编译好假 gh.exe（见 lib.mjs ensureGhStub() 注释），让每个 session 启动应用时都能立刻用上，
  // 避免真 gh.exe（如果这台跑手上有）响应慢跟我们测试脚本自己的导航形成竞态。
  const ghStubExe = lib.ensureGhStub()
  console.log(`[run] 假 gh.exe 已就绪：${ghStubExe}`)

  for (const [label, loader] of SESSIONS) {
    const startedAt = Date.now()
    console.log(`\n=== [${label}] 开始 ===`)
    try {
      const mod = await loader()
      await mod.run()
      const elapsedMs = Date.now() - startedAt
      console.log(`=== [${label}] 完成，用时 ${elapsedMs}ms ===`)
      sessionOutcomes.push({ label, ok: true, elapsedMs })
    } catch (err) {
      const elapsedMs = Date.now() - startedAt
      console.error(`=== [${label}] 异常：${err.stack || err} ===`)
      sessionOutcomes.push({ label, ok: false, elapsedMs, error: String(err.stack || err) })
      lib.killStrayArckeep()
    }
  }

  writeFinalEvidence()
  printSummaryTable()
}

function writeFinalEvidence() {
  lib.writeJson('results.json', lib.results)
  lib.writeJson('session-outcomes.json', sessionOutcomes)
  lib.writeJson('observations.json', lib.observations)
  lib.writeJson('console-observations.json', lib.consoleObservations)
  lib.writeJson('evidence-log.json', lib.evidenceLog)

  const lines = []
  lines.push('# 证据索引（evidence/index.md）')
  lines.push('')
  lines.push('每张截图都成对出现：`NN-描述.png`（窗口截图）+ `NN-描述-full.png`（全屏截图，同一时刻）。')
  lines.push('')
  lines.push('| 文件 | 说明 | 对应验收项 |')
  lines.push('| --- | --- | --- |')
  for (const item of lib.evidenceLog) {
    const ids = item.checkIds && item.checkIds.length > 0 ? item.checkIds.join(', ') : '（不计分观察项）'
    lines.push(`| \`${item.file}\` | ${item.description.replace(/\|/g, '\\|')} | ${ids} |`)
  }
  lines.push('')
  lines.push('## 按验收项反查证据文件')
  lines.push('')
  for (const id of lib.CHECK_IDS) {
    const files = lib.evidenceLog.filter(item => item.checkIds?.includes(id)).map(item => item.file)
    lines.push(`- **${id}**：${files.length > 0 ? files.map(f => `\`${f}\``).join('、') : '（无直接截图，见 results.json 里该项的 evidence 字段/notes）'}`)
  }
  lines.push('')
  lines.push('## 不计分观察项')
  lines.push('')
  for (const obs of lib.observations) {
    lines.push(`- [${obs.at}] ${obs.text}`)
  }
  lines.push('')
  lines.push('## 各 session 运行结果')
  lines.push('')
  for (const outcome of sessionOutcomes) {
    lines.push(`- ${outcome.ok ? '✅' : '❌'} ${outcome.label}（${outcome.elapsedMs}ms）${outcome.ok ? '' : ` — 异常：${outcome.error.split('\n')[0]}`}`)
  }
  lines.push('')
  lines.push('## 控制台错误 / pageerror 汇总')
  lines.push('')
  if (lib.consoleObservations.length === 0) {
    lines.push('全程没有捕获到任何控制台 error/warning 或 pageerror。')
  } else {
    for (const obs of lib.consoleObservations) {
      lines.push(`- [${obs.at}] [${obs.label}] (${obs.type}) ${obs.text}`)
    }
  }
  fs.writeFileSync(path.join(lib.EVIDENCE_DIR, 'index.md'), lines.join('\n'), 'utf8')
}

function printSummaryTable() {
  console.log('\n=== 验收结论汇总 ===')
  console.log('| 项目 | 结论 |')
  console.log('| --- | --- |')
  for (const id of lib.CHECK_IDS) {
    console.log(`| ${id} | ${lib.results[id].verdict} |`)
  }
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0 }
  for (const id of lib.CHECK_IDS) counts[lib.results[id].verdict] = (counts[lib.results[id].verdict] ?? 0) + 1
  console.log(`\nPASS=${counts.PASS} FAIL=${counts.FAIL ?? 0} BLOCKED=${counts.BLOCKED ?? 0}（共 ${lib.CHECK_IDS.length} 项）`)

  const summaryFile = process.env.GITHUB_STEP_SUMMARY
  if (summaryFile) {
    const lines = ['## Issue #5 工具架验收结论', '', '| 项目 | 结论 |', '| --- | --- |']
    for (const id of lib.CHECK_IDS) lines.push(`| ${id} | ${lib.results[id].verdict} |`)
    lines.push('', `PASS=${counts.PASS} FAIL=${counts.FAIL ?? 0} BLOCKED=${counts.BLOCKED ?? 0}（共 ${lib.CHECK_IDS.length} 项）`)
    fs.appendFileSync(summaryFile, lines.join('\n') + '\n')
  }
}

main()
  .then(() => {
    console.log('\n[run] 全部 session 跑完（个别 session 异常已如实记录为 BLOCKED，不影响其它 session）。')
    process.exit(0)
  })
  .catch(err => {
    console.error('[run] 致命错误（比如找不到可执行文件），已跑的部分结论/证据仍会尽量落盘：', err)
    try {
      writeFinalEvidence()
    } catch (writeErr) {
      console.error('[run] 落盘证据也失败了：', writeErr)
    }
    process.exit(1)
  })
