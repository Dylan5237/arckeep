// 独立验收工具的共享辅助函数。不是 Arckeep 产品代码，只驱动打包好的 Arckeep.exe。
import { _electron as electron } from 'playwright-core'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const EVIDENCE_DIR = process.env.ARCKEEP_EVIDENCE_DIR || path.join(__dirname, 'evidence')
export const PS1 = path.join(__dirname, 'native', 'win.ps1')
export const EXE = process.env.ARCKEEP_EXE_PATH

fs.mkdirSync(EVIDENCE_DIR, { recursive: true })

// ---------------------------------------------------------------------------
// 结论收集
// ---------------------------------------------------------------------------
export const CHECK_IDS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'A1', 'A2', 'A3', 'A4', 'E1', 'E2', 'E3']
export const results = {}
for (const id of CHECK_IDS) {
  results[id] = { verdict: 'BLOCKED', evidence: [], steps: '尚未执行', notes: '尚未执行到这一条' }
}
export function setResult(id, verdict, { evidence = [], steps = '', notes = '' } = {}) {
  if (!CHECK_IDS.includes(id)) throw new Error(`unknown check id: ${id}`)
  results[id] = { verdict, evidence, steps, notes }
  console.log(`[RESULT] ${id} = ${verdict} :: ${notes}`.slice(0, 300))
}
export function mergeNotes(id, extra) {
  results[id].notes = `${results[id].notes} ${extra}`.trim()
}

export const evidenceLog = []
export function logEvidence(file, description, checkIds) {
  evidenceLog.push({ file, description, checkIds })
}

// ---------------------------------------------------------------------------
// 原生 Windows 输入 / 截图（win.ps1）
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

export function sendHotkey(combo) {
  return runNative(['-Action', 'SendHotkey', '-Combo', combo])
}
export function sendKey(key) {
  return runNative(['-Action', 'SendKey', '-Key', key])
}
export function sendText(text) {
  return runNative(['-Action', 'SendText', '-Text', text], { timeoutMs: 30000 })
}
export function foreground() {
  return runNative(['-Action', 'Foreground'])
}
export function clickAt(x, y) {
  return runNative(['-Action', 'ClickAt', '-X', String(Math.round(x)), '-Y', String(Math.round(y))])
}
export function fullScreenshotAbs(absPath) {
  runNative(['-Action', 'Screenshot', '-Path', absPath])
  return absPath
}
export function fullScreenshot(name) {
  const p = path.join(EVIDENCE_DIR, name)
  return fullScreenshotAbs(p)
}

let occupyProc = null
let occupyStopFile = null
export function occupyHotkey(combo, timeoutSeconds = 900) {
  occupyStopFile = path.join(EVIDENCE_DIR, `.occupy-stop-${Date.now()}.flag`)
  try { fs.rmSync(occupyStopFile) } catch {}
  return new Promise((resolve, reject) => {
    occupyProc = spawn('pwsh', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1,
      '-Action', 'Occupy', '-Combo', combo, '-StopFile', occupyStopFile, '-TimeoutSeconds', String(timeoutSeconds)
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let settled = false
    occupyProc.stdout.on('data', d => {
      out += d.toString()
      if (!settled && out.includes('\n')) {
        settled = true
        const line = out.split('\n').find(Boolean)
        try { resolve(JSON.parse(line)) } catch { resolve({ raw: out }) }
      }
    })
    occupyProc.stderr.on('data', d => { out += d.toString() })
    occupyProc.on('exit', code => {
      if (!settled) { settled = true; reject(new Error(`occupy exited early (${code}): ${out}`)) }
    })
    setTimeout(() => { if (!settled) { settled = true; reject(new Error(`occupy did not report in time: ${out}`)) } }, 10000)
  })
}
export function stopOccupy() {
  if (occupyStopFile) { try { fs.writeFileSync(occupyStopFile, 'stop') } catch {} }
  occupyProc = null
  occupyStopFile = null
}

let notepadProc = null
export function startNotepad() {
  notepadProc = spawn('notepad.exe', [], { stdio: 'ignore', detached: true })
  return notepadProc
}
export function stopNotepad() {
  try { spawnSync('taskkill', ['/IM', 'notepad.exe', '/F']) } catch {}
  notepadProc = null
}

export function killStrayArckeep() {
  try { spawnSync('taskkill', ['/IM', 'Arckeep.exe', '/F', '/T']) } catch {}
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 40 } = {}) {
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

export async function launchApp({ argv = [], envExtra = {}, label = '' } = {}) {
  if (!EXE) throw new Error('ARCKEEP_EXE_PATH is not set')
  const app = await electron.launch({
    executablePath: EXE,
    args: argv,
    env: cleanEnv(envExtra),
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

/** markerFn: 在渲染进程里跑的判定函数（真函数，不是字符串），返回真值即认领这个窗口。 */
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
export function toastWindowPage(app, opts) {
  return findWindowByMarker(app, () => !!document.querySelector('body') && document.title === '已记下', opts)
}

export async function getUserDataDir(app) {
  return app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
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

export async function getAppState(page) {
  return page.evaluate(() => window.arckeep.getState())
}

export async function quitApp(app) {
  try { await callTestHook(app, 'quit') } catch (err) { console.error('quit via test hook failed', err) }
  try {
    await waitFor(() => app.evaluate(() => true).then(() => false, () => true), { timeoutMs: 5000, intervalMs: 100 })
  } catch { /* ignore */ }
  try { await app.close() } catch { /* process likely already gone */ }
}

// ---------------------------------------------------------------------------
// 数据文件 / 截图工具
// ---------------------------------------------------------------------------
export function todosFile(userDataDir) { return path.join(userDataDir, 'todos.jsonl') }
export function settingsFile(userDataDir) { return path.join(userDataDir, 'settings.json') }
export function draftFile(userDataDir) { return path.join(userDataDir, 'capture-draft.json') }

export function resetUserData(userDataDir) {
  for (const f of [todosFile(userDataDir), settingsFile(userDataDir), draftFile(userDataDir),
    path.join(userDataDir, 'test-hook-todos.json'),
    path.join(userDataDir, 'waiting-cache.json'),
    path.join(userDataDir, 'waiting-dismissals.json')]) {
    try { fs.rmSync(f, { force: true }) } catch {}
  }
}

export async function shot(page, name, { checkIds = [], description = '' } = {}) {
  const file = path.join(EVIDENCE_DIR, `${name}.png`)
  await page.screenshot({ path: file })
  logEvidence(`${name}.png`, description || name, checkIds)
  return file
}

export function fullShot(name, { checkIds = [], description = '' } = {}) {
  const abs = fullScreenshot(`${name}-full.png`)
  logEvidence(`${name}-full.png`, description || `${name} (全屏)`, checkIds)
  return abs
}

/** BrowserWindow 的内容区屏幕坐标（不含边框/标题栏），配合 DOM rect 换算真实屏幕坐标。 */
export async function windowContentBounds(app, page) {
  const handle = await app.browserWindow(page)
  return handle.evaluate(win => win.getContentBounds())
}

/** 目标元素的 getBoundingClientRect() + 所在窗口的 innerHeight，用于证明「默认窗口大小、不滚动可见」。 */
export async function elementRect(page, selector) {
  return page.evaluate(sel => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      left: r.left, top: r.top, right: r.right, bottom: r.bottom,
      width: r.width, height: r.height,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight
    }
  }, selector)
}

/** DOM 元素中心点换算成真实屏幕坐标，供 ClickAt / 坐标证据使用。 */
export async function elementScreenCenter(app, page, selector) {
  const bounds = await windowContentBounds(app, page)
  const rect = await elementRect(page, selector)
  if (!rect) return null
  return {
    x: bounds.x + rect.left + rect.width / 2,
    y: bounds.y + rect.top + rect.height / 2,
    bounds,
    rect
  }
}

export function writeJson(name, data) {
  fs.writeFileSync(path.join(EVIDENCE_DIR, name), JSON.stringify(data, null, 2), 'utf8')
}

export function appendEvidenceJson(name, obj) {
  const file = path.join(EVIDENCE_DIR, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
  return file
}
