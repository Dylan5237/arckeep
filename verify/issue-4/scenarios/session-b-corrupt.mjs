// Session B：手工在 todos.jsonl 里插入坏数据，验证 App 正常启动、坏行被跳过、文件不被截断
// 覆盖 checklist: 7
import fs from 'node:fs'
import path from 'node:path'
import * as lib from '../lib.mjs'

const {
  setResult, EVIDENCE_DIR, launchApp, mainWindowPage, quitApp, killStrayArckeep,
  getUserDataDir, resetUserData, todosFile, shot, appendEvidenceJson, createTodoViaHook
} = lib

function buildCorruptJsonl() {
  const good1 = { op: 'create', record: { id: '00000000-0000-4000-8000-000000000101', text: '损坏测试-好条目1', repo: null, waiting: false, createdAt: '2026-01-01T00:00:00.000Z' } }
  const good2 = { op: 'create', record: { id: '00000000-0000-4000-8000-000000000102', text: '损坏测试-好条目2', repo: 'example/demo', waiting: true, createdAt: '2026-01-02T00:00:00.000Z' } }
  const nonJson = '这不是 JSON，纯文本坏行 {{{'
  const halfJson = '{"op":"create","record":{"id":"00000000-0000-4000-8000-99999999999'
  const wrongType = JSON.stringify({ op: 'create', record: { id: '00000000-0000-4000-8000-000000000103', text: 12345, repo: null, waiting: false, createdAt: '2026-01-03T00:00:00.000Z' } })
  const lines = [
    JSON.stringify(good1),
    nonJson,
    JSON.stringify(good2),
    halfJson,
    wrongType
  ]
  return `${lines.join('\n')}\n`
}

export async function run() {
  killStrayArckeep()

  let app = await launchApp({ label: 'B-bootstrap' })
  const userDataDir = await getUserDataDir(app)
  await quitApp(app)
  resetUserData(userDataDir)

  const file = todosFile(userDataDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const content = buildCorruptJsonl()
  fs.writeFileSync(file, content, 'utf8')
  const beforeBytes = Buffer.byteLength(content, 'utf8')
  const beforeLines = content.split('\n').filter(Boolean).length
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'item7-todos-before.jsonl.txt'), content, 'utf8')

  try {
    app = await launchApp({ label: 'B-corrupt' })
    let page = await mainWindowPage(app, { timeoutMs: 15000 })
    // #nav 出现只代表这次导航完成，不代表 click handler 都已经挂好；给一点缓冲，
    // 失败时重新点一次再等一次，避免把渲染时机问题误判成产品缺陷。
    await page.waitForTimeout(300)
    await page.click('[data-view="todos"]')
    try {
      await page.waitForSelector('.todo-list, .empty-todos', { timeout: 5000 })
    } catch {
      await page.click('[data-view="todos"]')
      await page.waitForSelector('.todo-list, .empty-todos', { timeout: 5000 })
    }
    await shot(page, '30-corrupt-jsonl-loaded', { checkIds: ['7'], description: 'App 手工插入坏数据后照常启动，其它条目完整' })
    const items = await page.evaluate(() => window.arckeep.listTodos())
    const texts = items.map(i => i.text)

    const afterLoadContent = fs.readFileSync(file, 'utf8')
    const afterLoadBytes = Buffer.byteLength(afterLoadContent, 'utf8')
    const unchangedAfterLoad = afterLoadContent === content

    // 追加一条新待办，确认追加写不会破坏坏行、且坏行原样还在。这里不是在测「真实全局热键
    // 能不能触发」（那是 Item 1/A1 的职责，这个 CI 环境已确认 SendInput 投递不通，见
    // evidence/preflight.json），只是需要某种方式打开捕获窗口写一条新待办去触发一次追加写，
    // 改用 lib.createTodoViaHook()（测试钩子打开 + Playwright 键盘输入 + requestSubmit()
    // 直接触发 submit 监听器，不依赖不确定的 CDP Enter 隐式提交语义，见 session-a.mjs
    // 文件头部 A1 部分的详细说明）。
    page = await createTodoViaHook(app, '损坏测试-新增条目')

    const afterAppendContent = fs.readFileSync(file, 'utf8')
    const afterAppendBytes = Buffer.byteLength(afterAppendContent, 'utf8')
    const prefixPreserved = afterAppendContent.startsWith(content)
    const grew = afterAppendBytes > beforeBytes

    fs.writeFileSync(path.join(EVIDENCE_DIR, 'item7-todos-after.jsonl.txt'), afterAppendContent, 'utf8')

    appendEvidenceJson('item7-byte-line-compare', {
      beforeBytes, beforeLines,
      afterLoadBytes, unchangedAfterLoad,
      afterAppendBytes, prefixPreserved, grew,
      todosVisibleAfterLoad: texts
    })

    const goodPresent = texts.includes('损坏测试-好条目1') && texts.includes('损坏测试-好条目2')
    const finalItems = await page.evaluate(() => window.arckeep.listTodos())
    const newOnePresent = finalItems.some(i => i.text === '损坏测试-新增条目')
    const ok = goodPresent && unchangedAfterLoad && prefixPreserved && grew && newOnePresent

    setResult('7', ok ? 'PASS' : 'FAIL', {
      evidence: ['30-corrupt-jsonl-loaded.png', 'item7-todos-before.jsonl.txt', 'item7-todos-after.jsonl.txt', 'item7-byte-line-compare.json'],
      steps: '手工写入 5 行 todos.jsonl：1 行非 JSON 纯文本、1 行半截 JSON、1 行字段类型错（text 是数字）、夹着 2 行合法的 create 事件；启动 App，核对两条合法条目都在、坏行没有让其它内容丢失；启动后文件字节完全不变（只读不写）；再新建一条待办触发一次追加写，核对追加后的文件前缀与之前完全一致（旧内容一字节没改），只是在尾部多了新事件；对照单元测试 test/todos.test.ts',
      notes: `好条目都在=${goodPresent}；启动后文件字节数不变=${unchangedAfterLoad}（前=${beforeBytes} 后=${afterLoadBytes}）；追加写后前缀保持不变=${prefixPreserved}，文件变大=${grew}（追加后=${afterAppendBytes}）；新增条目已写入=${newOnePresent}；单元测试引用：test/todos.test.ts 中 describe('todo jsonl fold') 的两个用例（'skips a corrupt line and does not truncate or rewrite the file' / 'keeps events that follow a corrupt line in the middle of the log'），实际运行结果见 evidence/unit-tests-todos.txt`
    })
  } catch (err) {
    setResult('7', 'FAIL', { notes: `异常：${err.stack || err}` })
  } finally {
    try { await quitApp(app) } catch { /* ignore */ }
  }
}
