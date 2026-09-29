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
export const CHECK_IDS = [
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10',
  'A1', 'A2', 'A3', 'A4',
  'E1', 'E2', 'E3',
  'R1', 'R2', 'R3', 'R4', 'R5'
]
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

/** 跑完预检后由 run.mjs 写入，各 scenario 用来判断「这次运行环境里真实全局热键 SendInput 到底通不通」，
 * 从而决定是否还要浪费时间去反复尝试一个已知会失败的真实按键确认，还是直接跳过并在 notes 里说明。 */
export const envFlags = { hotkeyDeliveryOk: null, sendInputToWindowOk: null, checkedAt: null }

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

/** 等一个已经打开的捕获窗口拿到 #text 的输入焦点（不关心它是怎么打开的：热键还是测试钩子）。 */
export async function waitCaptureFocused(app, opts) {
  const cap = await captureWindowPage(app, opts)
  await cap.waitForFunction(() => document.activeElement && document.activeElement.id === 'text', null, { timeout: 3000 }).catch(() => {})
  return cap
}

/**
 * 用测试钩子（IPC，不经过全局热键/SendInput）打开捕获窗口。这份构建的 CI 环境已经证实真实全局热键的
 * SendInput 投递不通（见 evidence/preflight.json），本函数只是为了让「不是在测热键机制本身」的检查项
 * （比如草稿保存、简写解析、待办 CRUD）仍然能测到 Arckeep 真实的捕获窗口 + 真实渲染进程逻辑：打开捕获窗口
 * 走的是与真实热键完全相同的主进程 openCapture 代码路径（同一个 createCaptureWindow /
 * focusCaptureInput），唯一不同的只是「谁触发了这次打开」，不影响捕获窗口内部任何行为。
 * 需要专门验证「真实全局热键本身能不能生效」的检查项（1/3/9/A1/A4 相关/R1/R2 的真实按键子项）
 * 不能用这个函数代替，必须仍然走 sendHotkey。
 */
export async function openCaptureViaHook(app, opts) {
  await callTestHook(app, 'capture')
  return waitCaptureFocused(app, opts)
}

/**
 * 用测试钩子打开捕获窗口，Playwright 打字，然后用 `#capture-form` 的 requestSubmit()
 * 直接提交表单（不依赖「在输入框里按 Enter 会不会触发浏览器原生的隐式表单提交」这件事）。
 *
 * 背景：run3（66d1eeb）里发现，`cap.press('#text', 'Enter')` 在这份 Electron 构建里
 * 没有像在普通网页里那样可靠地触发表单的隐式提交——捕获窗口既没有关闭也没有出现
 * 「已记下」toast（见 evidence/a1-toast-timing.json 里 appeared:false 且窗口未关闭）。
 * 而 `document.querySelector('#capture-form').requestSubmit()` 是直接调用 DOM 标准
 * API 触发同一个 `form.addEventListener('submit', ...)` 监听器（src/renderer/capture.ts），
 * 走的是完全相同的 save() 逻辑，只是不依赖「按键事件能不能被浏览器识别成隐式提交」这个
 * 额外环节，更少不确定性。Esc/失焦等走 window 级 keydown/blur 监听器的场景不受影响，
 * 仍然用 Playwright 真实按键（见 session-a.mjs 的 A3/Item 8）。
 *
 * 另外这里会显式等待捕获窗口真正关闭（而不是只等 toast），如果没关闭就直接抛出异常，
 * 避免像 openCaptureWindow() 那样的单例窗口在「上一次没能成功保存」时被后续调用误判
 * 成一个全新的空白窗口，导致后面的输入全部追加进同一个残留窗口、层层错误传导下去。
 */
export async function createTodoViaHook(app, text, { waiting = false, timeoutMs = 4000 } = {}) {
  await ensureCaptureWindowClosed(app)
  await sleep(150)
  const cap = await openCaptureViaHook(app)
  await cap.type('#text', text)
  await sleep(80)
  const domTextBeforeSubmit = await cap.evaluate(() => document.querySelector('#text').value).catch(() => null)
  if (waiting) {
    await cap.click('#waiting')
    await sleep(80)
  }
  await cap.evaluate(() => document.querySelector('#capture-form').requestSubmit())
  const closed = await waitFor(async () => {
    for (const w of app.windows()) {
      const isCap = await w.evaluate(() => !!document.querySelector('#capture-form')).catch(() => false)
      if (isCap) return false
    }
    return true
  }, { timeoutMs, intervalMs: 30 })
  if (!closed.ok) {
    const errorText = await cap.evaluate(() => document.querySelector('#error')?.textContent).catch(() => null)
    throw new Error(`createTodoViaHook("${text}") 提交后 ${timeoutMs}ms 内捕获窗口没有关闭（可能是残留了上一次没保存成功的单例窗口，或这次保存本身失败）：输入框提交前的值="${domTextBeforeSubmit}"，页面上的错误提示="${errorText}"`)
  }
  await sleep(150)
  await callTestHook(app, 'show')
  return mainWindowPage(app)
}

/**
 * 强制关闭当前打开的捕获窗口（如果有），确保下一次 openCaptureViaHook() 拿到的
 * 是真正全新的窗口，而不是产品代码里 openCaptureWindow() 单例复用的一个还带着
 * 上一步残留内容的旧窗口。
 *
 * 重要澄清（这份 harness 里之前一直有个误解，见 git log）：测试钩子的 'close' 动作
 * （callTestHook(app,'close')）实际调用的是 src/main/index.ts 里的 closeMainWindow()
 * -> mainWindow?.close()，而 mainWindow 有 `window.on('close', ...)` 监听器在没有
 * isQuitting 时会 preventDefault() 只是把主窗口隐藏到托盘——这跟捕获窗口完全是两个
 * 不同的 BrowserWindow 实例，对捕获窗口是否打开/关闭没有任何影响。产品代码里也没有
 * 任何测试钩子动作是专门用来关闭捕获窗口的：捕获窗口只会在真正保存成功
 * （closeCapture('saved')）、Esc 存草稿、或失焦 200ms 计时器到期时才会自己关闭。
 * 之前 harness 里很多地方在「重新打开捕获窗口」前调用 callTestHook(app,'close')，
 * 本意是想「关掉上一个捕获窗口拿到干净状态」，但实际上只是误关/复原了主窗口（无害，
 * 但也没有达到清空捕获窗口的效果）——如果上一步因为异常没有走到 Esc/提交/失焦，
 * 捕获窗口会真的原样留在打开状态，下一次 openCaptureViaHook() 会命中 openCaptureWindow()
 * 单例判断（captureWindow 存在且没被销毁）而复用同一个脏窗口，导致新输入的文字追加
 * 进残留内容里。这个函数直接拿到捕获窗口对应的 BrowserWindow 句柄调用真正的 close()
 * （捕获窗口本身没有拦截 'close' 事件，见 src/main/capture-window.ts，所以这一步
 * 是真实、无副作用的关闭），是唯一能可靠保证「下一次拿到的是全新捕获窗口」的办法。
 */
export async function ensureCaptureWindowClosed(app, { timeoutMs = 2000 } = {}) {
  for (const w of app.windows()) {
    const isCap = await w.evaluate(() => !!document.querySelector('#capture-form')).catch(() => false)
    if (!isCap) continue
    try {
      const bw = await app.browserWindow(w)
      await bw.evaluate(win => { if (!win.isDestroyed()) win.close() })
    } catch { /* 拿句柄/关闭这一刻窗口可能已经自己关掉了，不算错误 */ }
  }
  const closed = await waitFor(async () => {
    for (const w of app.windows()) {
      const isCap = await w.evaluate(() => !!document.querySelector('#capture-form')).catch(() => false)
      if (isCap) return false
    }
    return true
  }, { timeoutMs, intervalMs: 30 })
  return closed.ok
}

/**
 * 用 Playwright 自己的 CDP 按键（不经过 OS SendInput）在聚焦的输入框里模拟一次「组合键」，
 * 用于 R2「录制热键」场景——产品代码里 record 按钮监听的是 #hotkey-input 上一个普通的
 * window/DOM keydown 事件（见 src/renderer/main.ts 的 acceleratorFromEvent），完全不经过
 * Electron 的 globalShortcut/OS 层，所以哪怕 OS 级 SendInput 在这个 CI 环境不通，
 * Playwright 自己的键盘事件仍然是「真的」按键事件（走 CDP Input.dispatchKeyEvent，
 * 会真正触发 keydown 监听器），能如实测到这段渲染进程逻辑本身对不对。
 */
export async function pressAcceleratorViaPlaywright(page, modifiers, key) {
  for (const m of modifiers) await page.keyboard.down(m)
  await page.keyboard.press(key)
  for (const m of [...modifiers].reverse()) await page.keyboard.up(m)
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

/** 在主进程里包一层 Notification.show / Menu.buildFromTemplate，记录参数但仍调用原函数（观察性打桩）。 */
export async function installObservationHooks(app) {
  try {
    await app.evaluate(({ Notification, Menu }) => {
      const store = (globalThis.__VERIFY_CAPTURED__ = globalThis.__VERIFY_CAPTURED__ || { notifications: [], menus: [] })
      if (!Notification.prototype.__verifyPatched) {
        const originalShow = Notification.prototype.show
        Notification.prototype.show = function patchedShow(...args) {
          store.notifications.push({ title: this.title, body: this.body, at: Date.now() })
          return originalShow.apply(this, args)
        }
        Notification.prototype.__verifyPatched = true
      }
      if (!Menu.__verifyPatchedBuild) {
        const originalBuild = Menu.buildFromTemplate
        Menu.buildFromTemplate = function patchedBuild(template) {
          store.menus.push({ template: template.map(t => ({ label: t.label, enabled: t.enabled })), at: Date.now() })
          return originalBuild(template)
        }
        Menu.__verifyPatchedBuild = true
      }
      return true
    })
    return true
  } catch (err) {
    console.error('installObservationHooks failed', err)
    return false
  }
}

export async function readCaptured(app) {
  try {
    return await app.evaluate(() => globalThis.__VERIFY_CAPTURED__ || { notifications: [], menus: [] })
  } catch {
    return { notifications: [], menus: [] }
  }
}

export async function captureOpensFor(app, combo, { timeoutMs = 3000 } = {}) {
  sendHotkey(combo)
  return waitFor(async () => {
    for (const w of app.windows()) {
      const ok = await w.evaluate(() => !!document.querySelector('#capture-form')).catch(() => false)
      if (ok) return w
    }
    return null
  }, { timeoutMs, intervalMs: 30 })
}
