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
  const env = { ...process.env }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  delete env.GH_ENTERPRISE_TOKEN
  delete env.GITHUB_ENTERPRISE_TOKEN
  env.ARCKEEP_TEST_HOOKS = '1'
  return { ...env, ...extra }
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

/** 打开工具架设置卡片，把整段 JSON 粘进文本框并点保存（真实界面操作：定位到设置、清空、输入、点按钮）。
 * 注意两个真机上观察到的细节：
 * ① 一个全新启动的 Electron 窗口，第一次切到「设置」页往往比后面几次明显慢（冷启动/JIT 预热），
 *    第一次导航给 20s，比常规操作用的 8s 更宽松；
 * ② 保存成功后的「工具架已保存」提示是 renderToolSettings 里点击处理函数自己插入的一个临时 DOM 节点，
 *    紧接着的 `await rerender()` 会整页重新渲染并把它替换掉——这个提示存在的窗口非常短，
 *    在 click() 之后必须立刻用 waitForSelector 去抓，不能先 sleep 再查，否则几乎必然错过。 */
export async function saveToolShelfJson(page, json) {
  await page.click('[data-view="settings"]')
  const editor = page.locator('#tool-shelf-json')
  try {
    // 给足够宽松的超时：第一次切到设置页（冷启动/JIT 预热）在真机上观察到明显比后面几次慢。
    await editor.waitFor({ state: 'visible', timeout: 20000 })
  } catch (err) {
    // 诊断用：这一步在真机上多次超时，先把当时到底卡在哪个画面留下证据，而不是继续瞎猜。
    try {
      const diagName = `zz-diag-settings-timeout-${Date.now()}`
      await page.screenshot({ path: path.join(EVIDENCE_DIR, `${diagName}.png`) }).catch(() => {})
      const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '<evaluate 失败>')
      const bodyHtmlHead = await page.evaluate(() => document.body.innerHTML.slice(0, 4000)).catch(() => '<evaluate 失败>')
      const title = await page.title().catch(() => '<title 失败>')
      const url = page.url()
      fs.writeFileSync(path.join(EVIDENCE_DIR, `${diagName}.json`), JSON.stringify({ title, url, bodyText, bodyHtmlHead }, null, 2), 'utf8')
      logEvidence(`${diagName}.png`, '诊断：等待设置页 JSON 编辑框超时时，实际画面是什么', [])
      console.error(`[diag] saveToolShelfJson 超时诊断已写入 ${diagName}.png/.json；title="${title}" url="${url}" bodyText(前200字)="${bodyText.slice(0, 200)}"`)
    } catch (diagErr) {
      console.error('[diag] 连诊断截图/dump都失败了：', diagErr)
    }
    throw err
  }
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
 * 所以要先点掉当前这条动作里「返回工具架」/「关闭」/「取消」之类的收尾按钮，再点导航。 */
export async function gotoTools(page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (await page.locator('.tool-search').count() > 0) return
    const backButtons = [
      page.locator('button:has-text("返回工具架")'),
      page.locator('.tool-output-card button:has-text("关闭")'),
      page.locator('.modal button:has-text("取消")'),
      page.locator('button:has-text("返回")')
    ]
    let clicked = false
    for (const btn of backButtons) {
      if (await btn.count() > 0) {
        await btn.first().click().catch(() => {})
        clicked = true
        break
      }
    }
    await page.click('[data-view="tools"]').catch(() => {})
    await sleep(120)
    if (!clicked) await sleep(120)
  }
  await page.waitForSelector('.tool-search', { timeout: 8000 })
  await sleep(80)
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
