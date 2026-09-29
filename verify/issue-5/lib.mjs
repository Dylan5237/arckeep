// 独立验收工具的共享辅助函数。不是 Arckeep 产品代码，只驱动打包好的 Arckeep.exe。
import { _electron as electron } from 'playwright-core'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const EVIDENCE_DIR = process.env.ARCKEEP_EVIDENCE_DIR || path.join(__dirname, 'evidence')
export const PS1 = path.join(__dirname, 'native', 'win.ps1')
export const EXE = process.env.ARCKEEP_EXE_PATH
export const WRITE_ARGS_EXE = process.env.ARCKEEP_WRITE_ARGS_EXE || path.join(__dirname, 'generated', 'write-args.exe')

fs.mkdirSync(EVIDENCE_DIR, { recursive: true })

// ---------------------------------------------------------------------------
// 结论收集
// ---------------------------------------------------------------------------
export const CHECK_IDS = [
  '1', '2', '3', '4', '5', '6', '7', '8',
  'P1', 'P2', 'P3',
  'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8',
  'D1', 'D2', 'D3'
]
export const results = {}
for (const id of CHECK_IDS) {
  results[id] = { verdict: 'BLOCKED', evidence: [], steps: '尚未执行', notes: '尚未执行到这一条' }
}
export function setResult(id, verdict, { evidence = [], steps = '', notes = '' } = {}) {
  if (!CHECK_IDS.includes(id)) throw new Error(`unknown check id: ${id}`)
  results[id] = { verdict, evidence, steps, notes }
  console.log(`[RESULT] ${id} = ${verdict} :: ${notes}`.slice(0, 400))
}
export function mergeNotes(id, extra) {
  results[id].notes = `${results[id].notes} ${extra}`.trim()
}

export const evidenceLog = []
export function logEvidence(file, description, checkIds) {
  evidenceLog.push({ file, description, checkIds })
}

export const observations = []
export function noteObservation(text) {
  observations.push({ at: new Date().toISOString(), text })
  console.log(`[OBSERVATION] ${text}`)
}

// ---------------------------------------------------------------------------
// 原生 Windows 辅助（win.ps1）
// ---------------------------------------------------------------------------
function runNative(args, { timeoutMs = 20000 } = {}) {
  const res = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs
  })
  if (res.status !== 0) {
    throw new Error(`native helper failed (${args.join(' ')}): status=${res.status}\nSTDOUT:${res.stdout}\nSTDERR:${res.stderr}`)
  }
  const lines = res.stdout.trim().split('\n').map(l => l.trim()).filter(Boolean)
  const last = lines[lines.length - 1] ?? ''
  try {
    return JSON.parse(last)
  } catch {
    return { raw: res.stdout, stderr: res.stderr }
  }
}

export function fullScreenshotAbs(absPath) {
  runNative(['-Action', 'Screenshot', '-Path', absPath])
  return absPath
}
export function fullScreenshot(name) {
  const p = path.join(EVIDENCE_DIR, name)
  return fullScreenshotAbs(p)
}
export function fullShot(name, { checkIds = [], description = '' } = {}) {
  const abs = fullScreenshot(`${name}-full.png`)
  logEvidence(`${name}-full.png`, description || `${name} (全屏)`, checkIds)
  return abs
}

/** 读取真实 Windows 剪贴板文本（Get-Clipboard -Raw），走 base64 往返避免换行/编码在管道里丢失。 */
export function readClipboardText() {
  const result = runNative(['-Action', 'ReadClipboard'])
  if (!result.base64) return ''
  return Buffer.from(result.base64, 'base64').toString('utf8')
}

/** 用 WMI 按命令行里的唯一标记查子进程树，验证中止后整棵树都没了。 */
export function findProcessesByMarker(marker) {
  return runNative(['-Action', 'ProcessTree', '-Marker', marker])
}
export function findProcessByName(name) {
  return runNative(['-Action', 'FindProcess', '-Name', name])
}
/** name 支持逗号分隔多个进程名（不带 .exe 和带 .exe 都能匹配）。 */
export function snapshotPidsByName(name) {
  return runNative(['-Action', 'SnapshotPids', '-Name', name])
}
export function checkPidsAlive(pids) {
  if (pids.length === 0) return { ok: true, alive: [], checked: [] }
  return runNative(['-Action', 'CheckPidsAlive', '-Pids', pids.join(',')])
}
export function getCommandLine(pid) {
  return runNative(['-Action', 'GetCommandLine', '-Pid1', String(pid)])
}

/** 独立解码 -EncodedCommand（Base64 → UTF-16LE），只是通用编码转换，不引用被测源码。 */
export function decodePowershellEncodedCommand(commandLine) {
  const match = /-EncodedCommand\s+([A-Za-z0-9+/=]+)/i.exec(commandLine)
  if (!match) return null
  return Buffer.from(match[1], 'base64').toString('utf16le')
}

/** 在「点确认」前后各拍一次同名进程快照，差集就是这次新起的进程（用于抓住短命令运行时的真实 OS 命令行）。 */
export async function findNewPidByName(name, action, { settleMs = 150 } = {}) {
  const before = snapshotPidsByName(name)
  const beforePids = new Set((before.procs ?? []).map(p => p.pid))
  await action()
  await sleep(settleMs)
  const after = snapshotPidsByName(name)
  const newOnes = (after.procs ?? []).filter(p => !beforePids.has(p.pid))
  return { before, after, newOnes }
}

/** 用 csc.exe 编译一个只把收到的 argv 写进同目录 editor-received.txt 的可执行文件，
 * 用来观察性验证「打开文件夹」把编辑器当 argv 启动、参数就是目录本身（不经过 shell）。 */
export function compileWriteArgsExe() {
  fs.mkdirSync(path.dirname(WRITE_ARGS_EXE), { recursive: true })
  return runNative(['-Action', 'CompileWriteArgsExe', '-OutExe', WRITE_ARGS_EXE], { timeoutMs: 60000 })
}

// 真机上观察到：被测应用每个需要判断 GitHub 登录态的 IPC（getState/refreshWaiting 等）都会各自
// 现场 spawn 一次 `gh auth token`，如果这台跑手上的真 gh.exe 响应慢（哪怕只是偶尔），就会跟我们
// 测试脚本自己触发的界面导航形成竞态：初始「等我处理」页自己的异步刷新链条如果比我们导航到
// 「设置」页的那一次 getState() 更晚落地，就会把已经切换过去的设置页整页换回「等我处理」。
// 造一个瞬间以非 0 退出码返回、不碰网络的假 gh.exe，塞进测试进程 PATH 最前面，让这个状态在所有
// session 里都是确定的、毫秒级返回——顺带也更贴近硬性规则第 4 条「不使用真实 token」的精神。
export const GH_STUB_DIR = path.join(__dirname, 'generated', 'gh-stub')
export const GH_STUB_EXE = path.join(GH_STUB_DIR, 'gh.exe')
export function ensureGhStub() {
  if (!fs.existsSync(GH_STUB_EXE)) {
    runNative(['-Action', 'CompileGhStubExe', '-OutExe', GH_STUB_EXE], { timeoutMs: 60000 })
  }
  return GH_STUB_EXE
}
export function writeArgsReceivedFile() {
  return path.join(path.dirname(WRITE_ARGS_EXE), 'editor-received.txt')
}
export function clearWriteArgsReceived() {
  try { fs.rmSync(writeArgsReceivedFile(), { force: true }) } catch { /* ignore */ }
}
export async function readWriteArgsReceived({ timeoutMs = 5000 } = {}) {
  const file = writeArgsReceivedFile()
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8')
      return raw.split('\u0001')
    }
    await sleep(60)
  }
  return null
}

export function killStrayArckeep() {
  try { spawnSync('taskkill', ['/IM', 'Arckeep.exe', '/F', '/T']) } catch { /* ignore */ }
}
export function killStrayByMarker(marker) {
  const found = findProcessesByMarker(marker)
  for (const p of found.procs ?? []) {
    try { spawnSync('taskkill', ['/PID', String(p.pid), '/F', '/T']) } catch { /* ignore */ }
  }
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now()
  let lastErr = null
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn()
      if (value) return { ok: true, value, elapsedMs: Date.now() - start }
    } catch (err) { lastErr = err }
    await sleep(intervalMs)
  }
  return { ok: false, elapsedMs: Date.now() - start, error: lastErr }
}

// ---------------------------------------------------------------------------
// Electron 启动 / 窗口寻址
// ---------------------------------------------------------------------------
export function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  delete env.GH_ENTERPRISE_TOKEN
  delete env.GITHUB_ENTERPRISE_TOKEN
  env.ARCKEEP_TEST_HOOKS = '1'
  // 无论调用方是否自定义了 PATH（例如 Session F 给 apo-stub 加的 PATH），假 gh.exe 目录始终
  // 加在最前面，确保「gh 未登录」这个状态又快又稳定，见 ensureGhStub() 处的详细注释。
  env.PATH = `${GH_STUB_DIR}${path.delimiter}${env.PATH ?? ''}`
  return env
}

export const consoleObservations = []

/** 每次调用给一个独立的 APPDATA 临时目录，保证各场景配置互不污染，同时可控地测「重启后还在」。 */
export function freshAppData(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `arckeep-appdata-${label}-`))
}

export async function launchApp({ argv = [], envExtra = {}, label = '', appData } = {}) {
  if (!EXE) throw new Error('ARCKEEP_EXE_PATH is not set')
  const env = cleanEnv(appData ? { ...envExtra, APPDATA: appData } : envExtra)
  const app = await electron.launch({
    executablePath: EXE,
    args: argv,
    env,
    timeout: 60000
  })
  app.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      consoleObservations.push({ label, type: msg.type(), text: msg.text(), at: new Date().toISOString() })
    }
  })
  app.on('window', page => {
    page.on('pageerror', err => {
      consoleObservations.push({ label, type: 'pageerror', text: String(err), at: new Date().toISOString() })
    })
  })
  return app
}

export async function findWindowByMarker(app, markerFn, { timeoutMs = 8000 } = {}) {
  const check = await waitFor(async () => {
    for (const w of app.windows()) {
      try {
        const ok = await w.evaluate(markerFn)
        if (ok) return w
      } catch { /* window may be mid-navigation / detached */ }
    }
    return null
  }, { timeoutMs, intervalMs: 60 })
  if (!check.ok) throw new Error(`window matching marker not found within ${timeoutMs}ms`)
  return check.value
}

export function mainWindowPage(app, opts) {
  return findWindowByMarker(app, () => !!document.querySelector('#nav'), opts)
}
export function captureWindowPage(app, opts) {
  return findWindowByMarker(app, () => !!document.querySelector('#capture-form'), opts)
}

export async function callTestHook(app, action) {
  return app.evaluate(({ }, act) => {
    const hooks = globalThis.__ARCKEEP_TEST_HOOKS__
    if (!hooks) throw new Error('test hooks not installed (ARCKEEP_TEST_HOOKS!=1?)')
    if (act === 'close') return hooks.close()
    if (act === 'show') return hooks.show()
    if (act === 'quit') return hooks.quit()
    if (act === 'capture') return hooks.openCapture()
    if (act === 'todos') return hooks.readTodos()
    if (act === 'hotkey-fail') return hooks.failHotkey()
    throw new Error(`unknown test hook action: ${act}`)
  }, action)
}

export async function getUserDataDir(app) {
  return app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
}

export async function quitApp(app) {
  try { await callTestHook(app, 'quit') } catch (err) { console.error('quit via test hook failed', err) }
  try {
    await waitFor(() => app.evaluate(() => true).then(() => false, () => true), { timeoutMs: 5000, intervalMs: 100 })
  } catch { /* ignore */ }
  try { await app.close() } catch { /* process likely already gone */ }
}

// ---------------------------------------------------------------------------
// 观察性打桩：包一层 shell.openExternal，记录参数但仍调用原函数。
// 仅用在「默认浏览器是否被真的调用」这类界面无法直接观察的地方。
// ---------------------------------------------------------------------------
export async function installOpenExternalSpy(app) {
  await app.evaluate(({ shell }) => {
    const store = (globalThis.__VERIFY_OPEN_EXTERNAL__ = globalThis.__VERIFY_OPEN_EXTERNAL__ || [])
    if (!shell.openExternal.__verifyPatched) {
      const original = shell.openExternal.bind(shell)
      const patched = function patchedOpenExternal(url, options) {
        store.push({ url, at: Date.now() })
        // 观察性打桩：仍然调用原函数，只是这个沙箱环境没有默认浏览器，
        // openExternal 在 Linux CI / 无 GUI 浏览器环境下可能是 no-op 或抛错，都不影响记录到的 url。
        return original(url, options).catch(() => {})
      }
      patched.__verifyPatched = true
      shell.openExternal = patched
    }
    return true
  })
}
export async function readOpenExternalCalls(app) {
  try {
    return await app.evaluate(() => globalThis.__VERIFY_OPEN_EXTERNAL__ || [])
  } catch {
    return []
  }
}

/** 每个检查点都要求「窗口截图 + 全屏截图」两张齐全（硬性规则），所以这里一次调用两张都拍：
 * `<name>.png` 是 page.screenshot() 拍的窗口范围；`<name>-full.png` 是走 win.ps1 CopyFromScreen
 * 拍的整台机器屏幕（能看出窗口是否被其它东西遮挡、窗口实际大小/位置等窗口截图看不出的信息）。 */
export async function shot(page, name, { checkIds = [], description = '' } = {}) {
  const file = path.join(EVIDENCE_DIR, `${name}.png`)
  await page.screenshot({ path: file })
  logEvidence(`${name}.png`, description || name, checkIds)
  try {
    const fullFile = fullScreenshot(`${name}-full.png`)
    logEvidence(`${name}-full.png`, `${description || name}（全屏）`, checkIds)
  } catch (err) {
    console.error(`[shot] 全屏截图失败（不影响窗口截图）：${name}`, err)
  }
  return file
}

export function writeJson(name, data) {
  fs.writeFileSync(path.join(EVIDENCE_DIR, name), JSON.stringify(data, null, 2), 'utf8')
}
export function appendEvidenceJson(name, obj) {
  const file = path.join(EVIDENCE_DIR, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
  return file
}

export async function windowContentBounds(app, page) {
  const handle = await app.browserWindow(page)
  return handle.evaluate(win => win.getContentBounds())
}
export async function elementRect(page, selector) {
  return page.evaluate(sel => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, innerWidth: window.innerWidth, innerHeight: window.innerHeight }
  }, selector)
}

/** 导航到「设置」页并等到 #tool-shelf-json 出现。
 * 真机上观察到的竞态（已用 gh-stub 修掉根因，这里保留重试作为兜底，见 ensureGhStub() 注释）：
 * 应用刚启动时的初始视图（等我处理）自己有一段异步刷新链路（refreshHotkeyBanner→getState，
 * 再到 renderWaiting 自己的 reload），如果它比我们点「设置」触发的那次 renderSettings 更晚
 * 把结果画到同一个 #content 节点上，就会把已经切换过去的设置页整页换回「等我处理」。
 * 由于两条链路都是 `void show(...)`（没人 await），单纯等一次是等不到「不会再被换回去」这个
 * 保证的——所以这里在超时预算内允许重新点一次导航（每次判定用短窗口），命中竞态时重新点击
 * 触发的 renderSettings 几乎总能在下一轮赢过（此时早先那条初始链路早已跑完）。 */
export async function gotoSettingsAndWaitEditor(page, { timeoutMs = 20000, sliceMs = 4000 } = {}) {
  const editor = page.locator('#tool-shelf-json')
  const start = Date.now()
  let attempts = 0
  while (Date.now() - start < timeoutMs) {
    attempts += 1
    await page.click('[data-view="settings"]')
    const remaining = timeoutMs - (Date.now() - start)
    const thisWait = Math.max(300, Math.min(sliceMs, remaining))
    const ok = await editor.waitFor({ state: 'visible', timeout: thisWait }).then(() => true).catch(() => false)
    if (ok) return { editor, attempts }
  }
  // 诊断用：反复重试后仍然没等到，先把当时到底卡在哪个画面留下证据，而不是继续瞎猜。
  try {
    const diagName = `zz-diag-settings-timeout-${Date.now()}`
    await page.screenshot({ path: path.join(EVIDENCE_DIR, `${diagName}.png`) }).catch(() => {})
    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '<evaluate 失败>')
    const bodyHtmlHead = await page.evaluate(() => document.body.innerHTML.slice(0, 4000)).catch(() => '<evaluate 失败>')
    const title = await page.title().catch(() => '<title 失败>')
    const url = page.url()
    fs.writeFileSync(path.join(EVIDENCE_DIR, `${diagName}.json`), JSON.stringify({ title, url, bodyText, bodyHtmlHead, attempts }, null, 2), 'utf8')
    logEvidence(`${diagName}.png`, '诊断：反复重试仍等不到设置页 JSON 编辑框时，实际画面是什么', [])
    console.error(`[diag] gotoSettingsAndWaitEditor 超时诊断已写入 ${diagName}.png/.json；attempts=${attempts} title="${title}" url="${url}" bodyText(前200字)="${bodyText.slice(0, 200)}"`)
  } catch (diagErr) {
    console.error('[diag] 连诊断截图/dump都失败了：', diagErr)
  }
  throw new Error(`等待设置页 #tool-shelf-json 超时（重试 ${attempts} 次，共 ${timeoutMs}ms）`)
}

/** 打开工具架设置卡片，把整段 JSON 粘进文本框并点保存（真实界面操作：定位到设置、清空、输入、点按钮）。
 * 保存成功后的「工具架已保存」提示是 renderToolSettings 里点击处理函数自己插入的一个临时 DOM 节点，
 * 紧接着的 `await rerender()` 会整页重新渲染并把它替换掉——这个提示存在的窗口非常短，
 * 在 click() 之后必须立刻用 waitForSelector 去抓，不能先 sleep 再查，否则几乎必然错过。 */
export async function saveToolShelfJson(page, json) {
  const { editor } = await gotoSettingsAndWaitEditor(page)
  await editor.click()
  await editor.fill('')
  await editor.fill(json)
  const saveButtons = page.locator('#tool-shelf-card button.primary')
  await saveButtons.first().click()
  const savedMessageSeen = await page.waitForSelector('#tool-shelf-card .alert:not(.error)', { timeout: 2000 })
    .then(() => true).catch(() => false)
  await sleep(150)
  return { savedMessageSeen }
}

/** 回到工具架的动作列表页。renderTools() 只有 session 停在 loading/shelf/empty/problem 时才会重新拉取
 * 列表，其它状态（running/copied/quiet/params/preview 的残留）单纯点导航栏不会回到列表——
 * 所以要先点掉当前这条动作里「返回工具架」/「关闭」/「取消」之类的收尾按钮，再点导航。
 *
 * 真机上观察到两类会卡住的情况：
 * ① 上一条 run-command 动作真的还在跑（.run-status 显示「运行中」），这时候唯一能点的按钮
 *   是「中止」，不在上面这组收尾按钮里；
 * ② 即使收尾按钮（比如「返回工具架」）确实存在也点了，回到列表也可能迟迟不生效。
 * 早期版本在同一轮里「点完收尾按钮又紧接着点一次导航栏」，怀疑这种连续戳两次会让
 * renderTools() 排起一串互相打断的异步渲染，反而让刚点掉的收尾按钮效果被冲掉——
 * 所以这里改成每轮只做一个动作（收尾按钮 优先，其次中止，最后才点导航栏），
 * 点完之后专心等一等再重新检查，不在等待期间再去戳别的按钮。 */
export async function gotoTools(page, { timeoutMs = 15000 } = {}) {
  const start = Date.now()
  let lastAbortAttemptAt = 0
  while (Date.now() - start < timeoutMs) {
    if (await page.locator('.tool-search').count() > 0) return
    const backButtons = [
      page.locator('button:has-text("返回工具架")'),
      page.locator('.tool-output-card button:has-text("关闭")'),
      page.locator('.modal button:has-text("取消")'),
      page.locator('button:has-text("返回")')
    ]
    let acted = false
    for (const btn of backButtons) {
      if (await btn.count() > 0) {
        await btn.first().click().catch(() => {})
        acted = true
        break
      }
    }
    if (!acted) {
      const stillRunning = await page.locator('.run-status').innerText().catch(() => '')
      const abortBtn = page.locator('button.danger:has-text("中止")')
      if (stillRunning.includes('运行中') && await abortBtn.count() > 0 && Date.now() - lastAbortAttemptAt > 3000) {
        lastAbortAttemptAt = Date.now()
        await abortBtn.first().click().catch(() => {})
        acted = true
        await sleep(1500) // 中止真正生效可能要点时间，给它一点安顿空间再继续检查
      }
    }
    if (!acted) {
      await page.click('[data-view="tools"]').catch(() => {})
    }
    await sleep(500)
  }
  try {
    await page.waitForSelector('.tool-search', { timeout: 5000 })
    await sleep(80)
  } catch (err) {
    // 兜底诊断：把最后的界面状态记下来，方便不必再等一整轮 CI 才能看出卡在哪。
    const diagName = `gototools-timeout-${Date.now()}`
    try { await page.screenshot({ path: path.join(EVIDENCE_DIR, `${diagName}.png`) }) } catch { /* ignore */ }
    const domText = await pageText(page).catch(() => '<读取失败>')
    const runStatusText = await page.locator('.run-status').innerText().catch(() => '<无 .run-status>')
    appendEvidenceJson(diagName, { domText, runStatusText })
    throw err
  }
}

/** gotoTools() 的兜底版本：如果连着上面这些手段都回不去（真机上出现过：点了「返回工具架」，
 * 界面文字也没变过，怀疑是这一个应用进程本身卡住了，不只是这一条动作卡住），就把这个应用进程
 * 整个关掉、杀掉残留进程，重开一个全新的应用进程（重新存一遍工具架配置），让后面互相独立的
 * 检查项能在一个干净的进程里继续跑，而不是被这一个真机异常连环拖累到全部失败。
 * 用法：`;({ app, page } = await gotoToolsOrRelaunch({ app, page, label, config }))`，
 * 调用方的 app/page 要声明成 let 才能被这样重新赋值。 */
export async function gotoToolsOrRelaunch({ app, page, label, config, envExtra }, { timeoutMs = 15000 } = {}) {
  try {
    await gotoTools(page, { timeoutMs })
    return { app, page }
  } catch (err) {
    noteObservation(`${label ?? ''} 会话里有个动作导致点导航栏/收尾按钮都回不到工具架列表（怀疑是这一个应用进程本身异常卡住，不只是这一条动作的问题），已如实记录该动作的检查结果为异常；为了不让后面互相独立的检查项被这一个真机异常连环拖累，重开了一个全新的应用进程继续测。原始异常：${err.message || err}`)
    try { await app.close() } catch { /* ignore */ }
    killStrayArckeep()
    const freshData = freshAppData(`${label ?? 'recover'}-relaunch-${Date.now()}`)
    const newApp = await launchApp({ label: `${label ?? ''}(重开)`, appData: freshData, envExtra })
    const newPage = await mainWindowPage(newApp)
    if (config) await saveToolShelfJson(newPage, config)
    return { app: newApp, page: newPage }
  }
}

export async function openCardByTitle(page, title) {
  const card = page.locator('.tool-card', { hasText: title })
  await card.first().waitFor({ state: 'visible', timeout: 8000 })
  await card.first().click()
  await sleep(120)
}

export function pageText(page) {
  return page.evaluate(() => document.body.innerText)
}

// ---------------------------------------------------------------------------
// 独立复核：JSON 语法错误的行/列。完全不引用被测源码，只用 Node 自带 JSON.parse
// 抛出的 "position N" 自己数一遍换行，用来核对应用报出来的「第 X 行，第 Y 列」是否准确。
// ---------------------------------------------------------------------------
export function independentSyntaxLocation(text) {
  try {
    JSON.parse(text)
    return null
  } catch (error) {
    const match = /position (\d+)/.exec(error.message)
    if (!match) return null
    const index = Number(match[1])
    let line = 1
    let column = 1
    for (let i = 0; i < Math.min(index, text.length); i += 1) {
      if (text[i] === '\n') { line += 1; column = 1 } else { column += 1 }
    }
    return { line, column, rawMessage: error.message }
  }
}

export function lineOf(text, lineNumber) {
  return text.split('\n')[lineNumber - 1] ?? ''
}

export function uniqueMarker(label) {
  return `ARCKEEP-VERIFY-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

export function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}
