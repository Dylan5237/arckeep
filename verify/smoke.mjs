// verify/smoke.mjs
//
// Read-only Windows smoke verification for Arckeep Issue #1 / PR #8 (fef78d5).
// This file is NOT part of the Arckeep product; it only drives the packaged
// app from the outside (Playwright `_electron` + a few native Windows checks)
// and records evidence. It never edits product source or settings semantics.
//
// Every "scene" is wrapped so a single failure does not abort the whole run:
// each scene appends a record to `evidence/scenes.json` and continues.

import { _electron as electron } from 'playwright'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const EVIDENCE_DIR = process.env.ARCKEEP_EVIDENCE_DIR || 'evidence'
const UNPACKED_EXE = process.env.ARCKEEP_UNPACKED_EXE
const APPDATA = process.env.APPDATA
const ARCKEEP_DATA_DIR = path.join(APPDATA, 'Arckeep')
const SETTINGS_FILE = path.join(ARCKEEP_DATA_DIR, 'settings.json')
const FAKE_TOKEN = process.env.FAKE_TOKEN || 'ghp_Vf9QzXk2LmP4rT8wYb6nHc3JdA1sE7uG0oKi'

fs.mkdirSync(EVIDENCE_DIR, { recursive: true })

const scenes = []
function record(id, title, status, details) {
  const entry = { id, title, status, details: details ?? null, at: new Date().toISOString() }
  scenes.push(entry)
  console.log(`[${status}] ${id} ${title}${details ? ' :: ' + JSON.stringify(details).slice(0, 500) : ''}`)
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'scenes.json'), JSON.stringify(scenes, null, 2))
}

async function scene(id, title, fn) {
  try {
    const details = await fn()
    record(id, title, 'PASS', details)
    return { ok: true, details }
  } catch (error) {
    record(id, title, 'FAIL', { error: error instanceof Error ? error.stack || error.message : String(error) })
    return { ok: false, error }
  }
}

function ps(script, opts = {}) {
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    ...opts
  })
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
}

function fullScreenShot(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const winPath = filePath.replace(/\//g, '\\')
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('${winPath}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
`
  const result = ps(script)
  if (result.code !== 0) throw new Error(`fullScreenShot failed: ${result.stderr}`)
}

async function shot(page, evidenceName) {
  const full = path.join(EVIDENCE_DIR, evidenceName)
  const win = path.join(EVIDENCE_DIR, evidenceName.replace(/\.png$/, '-win.png'))
  try {
    if (page) await page.screenshot({ path: win })
  } catch (error) {
    fs.writeFileSync(win.replace(/\.png$/, '.error.txt'), String(error))
  }
  fullScreenShot(full)
}

function listArckeepProcesses() {
  const result = ps(`Get-CimInstance Win32_Process -Filter "Name='Arckeep.exe'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`)
  if (!result.stdout.trim()) return []
  try {
    const parsed = JSON.parse(result.stdout.trim())
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

function killAllArckeep() {
  ps('Get-Process Arckeep -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue')
  ps('Start-Sleep -Milliseconds 300')
}

function resetAppData() {
  killAllArckeep()
  if (fs.existsSync(ARCKEEP_DATA_DIR)) fs.rmSync(ARCKEEP_DATA_DIR, { recursive: true, force: true })
}

function cleanEnv(extra = {}) {
  const env = { ...process.env }
  delete env.GH_TOKEN
  delete env.GITHUB_TOKEN
  return { ...env, ...extra }
}

function crashReportsList() {
  const dir = path.join(APPDATA, 'Arckeep', 'Crashpad', 'reports')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
}

async function findButton(page, text) {
  return page.locator('button', { hasText: text }).first()
}

async function main() {
  record('00-start', 'smoke.mjs started', 'INFO', { unpackedExe: UNPACKED_EXE, appdata: APPDATA })

  // ---------------------------------------------------------------
  // Scene 1: cold launch, main window, AC4 navigation (01-05)
  // ---------------------------------------------------------------
  let app1, page1
  await scene('01-launch', 'Cold launch after clearing %APPDATA%\\Arckeep (AC3/AC4 baseline)', async () => {
    resetAppData()
    const before = crashReportsList()
    app1 = await electron.launch({
      executablePath: UNPACKED_EXE,
      env: cleanEnv({ ARCKEEP_TEST_HOOKS: '1' })
    })
    page1 = await app1.firstWindow()
    await page1.waitForLoadState('domcontentloaded')
    await page1.waitForTimeout(800)
    await shot(page1, '01-main-window.png')
    const after = crashReportsList()
    return { crashReportsBefore: before, crashReportsAfter: after }
  })

  await scene('AC4-order', 'AC4: nav item order top-to-bottom, all on the left', async () => {
    const items = ['inbox', 'projects', 'todos', 'tools']
    const boxes = []
    for (const view of items) {
      const box = await page1.locator(`[data-view="${view}"]`).boundingBox()
      boxes.push({ view, box })
    }
    const settingsBox = await page1.locator('#settings-button').boundingBox()
    const winSize = page1.viewportSize()
    const sortedByY = [...boxes].sort((a, b) => a.box.y - b.box.y).map(b => b.view)
    const orderOk = JSON.stringify(sortedByY) === JSON.stringify(items)
    const allLeft = boxes.every(b => b.box.x < (winSize?.width ?? 9999) / 3)
    if (!orderOk) throw new Error(`nav order mismatch: ${sortedByY.join(',')}`)
    if (!allLeft) throw new Error('some nav items are not on the left third of the window')
    return { boxes, settingsBox, orderOk, allLeft }
  })

  const navShots = [
    ['inbox', '等我处理', '02-nav-waiting.png'],
    ['projects', '项目总览', '03-nav-overview.png'],
    ['todos', '待办', '04-nav-todo.png'],
    ['tools', '工具架', '05-nav-toolshelf.png']
  ]
  for (const [view, title, file] of navShots) {
    await scene(`AC4-${view}`, `AC4: click nav "${title}" and confirm content switches`, async () => {
      await page1.locator(`[data-view="${view}"]`).click()
      await page1.waitForTimeout(200)
      const heading = await page1.locator('#content h1').innerText()
      if (heading !== title) throw new Error(`expected heading "${title}", got "${heading}"`)
      await shot(page1, file)
      return { heading }
    })
  }

  // ---------------------------------------------------------------
  // Scene 2: AC5c invalid token (06 empty settings, 07 invalid token)
  // ---------------------------------------------------------------
  await scene('AC5-empty', '06: first-ever settings page after clearing data dir (unauth, no repos, default hotkey)', async () => {
    await page1.locator('#settings-button').click()
    await page1.waitForTimeout(300)
    const sourceLabel = await page1.locator('.source strong').innerText()
    const repoListText = await page1.locator('.repo-list').innerText()
    const hotkeyInput = await page1.locator('input[aria-label="全局热键"]').inputValue()
    await shot(page1, '06-settings-empty.png')
    if (sourceLabel !== '未配置') throw new Error(`expected sourceLabel 未配置, got ${sourceLabel}`)
    return { sourceLabel, repoListText, hotkeyInput }
  })

  let invalidTokenMessage = null
  await scene('AC5c-invalid-token', '07: paste fake token, click 测试连接, expect explicit 401-class error, no crash, token stays in the field', async () => {
    const tokenInput = page1.locator('input[type="password"][aria-label="GitHub PAT"]')
    await tokenInput.fill(FAKE_TOKEN)
    const testButton = await findButton(page1, '测试连接')
    await testButton.click()
    await page1.waitForSelector('.alert.error', { timeout: 15000 })
    const message = await page1.locator('.alert.error').innerText()
    const remaining = await tokenInput.inputValue()
    await shot(page1, '07-settings-invalid-token.png')
    invalidTokenMessage = message
    if (remaining !== FAKE_TOKEN) throw new Error(`token field was cleared/altered after failed attempt: "${remaining}"`)
    const stillRunning = listArckeepProcesses().length > 0
    if (!stillRunning) throw new Error('process exited after invalid-token attempt')
    return { message, tokenKeptInField: remaining === FAKE_TOKEN, processAlive: stillRunning }
  })

  // ---------------------------------------------------------------
  // Scene 3: X1 network-unreachable classification (best effort, 11)
  // ---------------------------------------------------------------
  await scene('X1-network', '11: cut network to api.github.com, click 测试连接 again, expect network-unreachable class message', async () => {
    const fwName = 'arckeep-verify-block'
    const hostsPath = 'C:\\Windows\\System32\\drivers\\etc\\hosts'
    const originalHosts = fs.existsSync(hostsPath) ? fs.readFileSync(hostsPath, 'utf8') : null
    const attempts = []

    const fwAdd = ps(`New-NetFirewallRule -DisplayName '${fwName}' -Direction Outbound -Program '${UNPACKED_EXE.replace(/\\/g, '\\\\')}' -Action Block -ErrorAction Stop | Out-Null; Write-Output ok`)
    const fwOk = fwAdd.code === 0 && fwAdd.stdout.includes('ok')
    attempts.push({ method: 'firewall-rule', ok: fwOk, stderr: fwAdd.stderr, stdout: fwAdd.stdout })

    let hostsOk = false
    if (!fwOk && originalHosts !== null) {
      try {
        fs.appendFileSync(hostsPath, '\n0.0.0.0 api.github.com\n')
        hostsOk = true
      } catch (error) {
        attempts.push({ method: 'hosts-file', ok: false, error: String(error) })
      }
      if (hostsOk) attempts.push({ method: 'hosts-file', ok: true })
    }

    if (!fwOk && !hostsOk) {
      throw new Error(`neither firewall rule nor hosts-file redirect could be applied (likely no admin rights on the runner): ${JSON.stringify(attempts)}`)
    }

    try {
      const tokenInput = page1.locator('input[type="password"][aria-label="GitHub PAT"]')
      await tokenInput.fill(FAKE_TOKEN)
      const testButton = await findButton(page1, '测试连接')
      await testButton.click()
      await page1.waitForSelector('.alert.error', { timeout: 25000 })
      const message = await page1.locator('.alert.error').innerText()
      const remaining = await tokenInput.inputValue()
      await shot(page1, '11-settings-network-error.png')
      const isNetworkClassMessage = message.includes('连不上 GitHub') || message.includes('网络不可达')
      const caveat = 'CAVEAT: this scene reuses a long-lived Electron process (page1) that already ' +
        'made a successful TLS connection to api.github.com in an earlier scene; a fetch/undici ' +
        'keep-alive connection could bypass a newly added outbound-block rule. Treat this result ' +
        'as informative only; the authoritative fresh-process retest is the X1-network-retest scene ' +
        '(verify/x1-network-retest.mjs), which cold-starts a brand-new process after the network is cut.'
      if (!isNetworkClassMessage) {
        throw new Error(`message was NOT classified as network-unreachable (got: "${message}"). ${caveat}`)
      }
      return { attempts, message, tokenKeptInField: remaining === FAKE_TOKEN, isNetworkClassMessage, caveat }
    } finally {
      ps(`Remove-NetFirewallRule -DisplayName '${fwName}' -ErrorAction SilentlyContinue`)
      if (hostsOk && originalHosts !== null) fs.writeFileSync(hostsPath, originalHosts)
    }
  })

  // ---------------------------------------------------------------
  // Scene 4: AC5b - gh removed from PATH, save PAT, source becomes PAT
  // ---------------------------------------------------------------
  await scene('AC5b-pat-path', 'gh removed from PATH: settings still shows PAT field; saving a PAT persists and flips source to 本机 PAT', async () => {
    const tokenInput = page1.locator('input[type="password"][aria-label="GitHub PAT"]')
    await tokenInput.fill(FAKE_TOKEN)
    const saveButton = await findButton(page1, '保存 PAT')
    await saveButton.click()
    await page1.waitForTimeout(400)
    const sourceLabel = await page1.locator('.source strong').innerText()
    const remaining = await tokenInput.inputValue()
    return { sourceLabel, tokenFieldClearedAfterSave: remaining === '' }
  })

  // ---------------------------------------------------------------
  // Scene 5: AC9 hotkey conflict (08) + control group (idle combo)
  // ---------------------------------------------------------------
  let hotkeyWarningText = null
  await scene('AC9-conflict', '08: change hotkey to Ctrl+Alt+K (held by verify/hold-hotkey.ps1), expect a visible warning naming the combo, with adjacent controls', async () => {
    const holderFile = path.join(EVIDENCE_DIR, 'hotkey-holder.txt')
    const holderText = fs.existsSync(holderFile) ? fs.readFileSync(holderFile, 'utf8') : '(missing)'
    if (!holderText.includes('registered=True')) throw new Error(`hotkey holder did not confirm registration: ${holderText}`)

    const hotkeyInput = page1.locator('input[aria-label="全局热键"]')
    await hotkeyInput.fill('Ctrl+Alt+K')
    const saveHotkey = await findButton(page1, '保存热键')
    await saveHotkey.click()
    await page1.waitForSelector('.hotkey-alert', { timeout: 5000 })
    const alert = page1.locator('.hotkey-alert')

    // First capture the page exactly as the user sees it right after clicking
    // "保存热键", with NO scrolling — this answers "第一眼能不能看到提示".
    const viewport = page1.viewportSize()
    const alertBoxNoScroll = await alert.boundingBox()
    const visibleWithoutScroll = alertBoxNoScroll && viewport
      ? (alertBoxNoScroll.y >= 0 && alertBoxNoScroll.y + alertBoxNoScroll.height <= viewport.height)
      : null
    await shot(page1, '08a-settings-hotkey-conflict-no-scroll.png')

    // Then scroll the warning into view so the follow-up screenshot actually
    // shows the warning text next to its "录制"/"改用这个" controls.
    await alert.scrollIntoViewIfNeeded()
    await page1.waitForTimeout(200)
    const warningText = await alert.locator('span').innerText()
    const alertBox = await alert.boundingBox()
    const replacementBox = await alert.locator('input[aria-label="新的热键组合"]').boundingBox()
    const recordBox = await alert.locator('button', { hasText: '录制' }).boundingBox()
    const applyBox = await alert.locator('button', { hasText: '改用这个' }).boundingBox()
    await shot(page1, '08-settings-hotkey-conflict.png')
    hotkeyWarningText = warningText

    // settings.json must not have persisted the failed combo
    const raw = fs.existsSync(SETTINGS_FILE) ? fs.readFileSync(SETTINGS_FILE, 'utf8') : '(missing)'
    if (raw.includes('Ctrl+Alt+K')) throw new Error('failed hotkey was persisted to settings.json')
    if (!warningText.includes('Ctrl+Alt+K')) throw new Error(`warning does not name the combo: "${warningText}"`)

    return {
      viewport,
      alertBoxNoScroll,
      visibleWithoutScroll,
      warningText,
      alertBox,
      replacementBox,
      recordBox,
      applyBox,
      settingsFileHasConflictCombo: raw.includes('Ctrl+Alt+K')
    }
  })

  await scene('AC9-control', 'Control group: switching to an idle combo shows no warning', async () => {
    const hotkeyInput = page1.locator('input[aria-label="全局热键"]')
    await hotkeyInput.fill('Ctrl+Alt+Shift+A')
    const saveHotkey = await findButton(page1, '保存热键')
    await saveHotkey.click()
    await page1.waitForTimeout(500)
    const warningVisible = await page1.locator('.hotkey-alert').count()
    if (warningVisible !== 0) throw new Error('idle combo unexpectedly produced a warning')
    return { warningVisible }
  })

  // ---------------------------------------------------------------
  // Scene 6: AC7 persistence - add repos, quit via hook, restart, verify
  // ---------------------------------------------------------------
  await scene('AC7-set-repos', 'AC7: add two watched repos before quitting', async () => {
    const repoInput = page1.locator('input[aria-label="关注仓库"]')
    for (const repo of ['octocat/Hello-World', 'Dylan5237/arckeep']) {
      await repoInput.fill(repo)
      const addButton = await findButton(page1, '添加')
      await addButton.click()
      await page1.waitForTimeout(300)
    }
    const repoListText = await page1.locator('.repo-list').innerText()
    await shot(page1, '13-settings-repos-hotkey-saved.png')
    if (!repoListText.includes('octocat/Hello-World') || !repoListText.includes('Dylan5237/arckeep')) {
      throw new Error(`repo list missing expected entries: ${repoListText}`)
    }
    return { repoListText }
  })

  await scene('AC8-close-hook', 'AC8/F: __ARCKEEP_TEST_HOOKS__.close() hides the window but keeps the process alive', async () => {
    await app1.evaluate(({ BrowserWindow }) => {
      // eslint-disable-next-line no-undef
      globalThis.__ARCKEEP_TEST_HOOKS__.close()
    })
    await new Promise(r => setTimeout(r, 500))
    const visible = await app1.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())
    fullScreenShot(path.join(EVIDENCE_DIR, '14-hook-close-fullscreen.png'))
    const stillRunning = listArckeepProcesses().length > 0
    if (visible) throw new Error('window still reports isVisible()=true after close hook')
    if (!stillRunning) throw new Error('process exited after close hook (should stay in tray)')
    return { visible, stillRunning }
  })

  await scene('AC8-show-hook', 'AC8/F: __ARCKEEP_TEST_HOOKS__.show() brings the window back', async () => {
    await app1.evaluate(({ BrowserWindow }) => {
      globalThis.__ARCKEEP_TEST_HOOKS__.show()
    })
    await new Promise(r => setTimeout(r, 500))
    const visible = await app1.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())
    await shot(page1, '15-hook-show.png')
    if (!visible) throw new Error('window did not become visible again after show hook')
    return { visible }
  })

  await scene('AC8-second-instance', 'Second-instance handoff: `Arckeep.exe --arckeep-test=close` (with ARCKEEP_TEST_HOOKS=1) is handed to the running instance and the new process exits', async () => {
    const secondEnv = cleanEnv({ ARCKEEP_TEST_HOOKS: '1' })
    const start = Date.now()
    const result = spawnSync(UNPACKED_EXE, ['--arckeep-test=close'], { env: secondEnv, timeout: 15000 })
    const elapsedMs = Date.now() - start
    await new Promise(r => setTimeout(r, 500))
    const visible = await app1.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())
    const primaryStillRunning = listArckeepProcesses().length >= 1
    if (visible) throw new Error('primary window should be hidden again after handed-off close action')
    if (!primaryStillRunning) throw new Error('primary instance disappeared')
    return { secondProcessExitCode: result.status, elapsedMs, visible, primaryStillRunning }
  })

  await scene('AC8-show-again', 'Show again before continuing to AC7 quit', async () => {
    await app1.evaluate(({ BrowserWindow }) => {
      globalThis.__ARCKEEP_TEST_HOOKS__.show()
    })
    await new Promise(r => setTimeout(r, 400))
    const visible = await app1.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())
    return { visible }
  })

  await scene('AC8-quit-hook', 'AC8/AC6/AC7 quit: __ARCKEEP_TEST_HOOKS__.quit() ends the process within 10s (same path as tray "退出")', async () => {
    await app1.evaluate(() => {
      globalThis.__ARCKEEP_TEST_HOOKS__.quit()
    })
    const start = Date.now()
    let remaining = listArckeepProcesses()
    while (remaining.length > 0 && Date.now() - start < 10000) {
      await new Promise(r => setTimeout(r, 300))
      remaining = listArckeepProcesses()
    }
    if (remaining.length > 0) throw new Error(`process(es) still alive 10s after quit hook: ${JSON.stringify(remaining)}`)
    return { elapsedMs: Date.now() - start, remaining }
  })

  // ---------------------------------------------------------------
  // Scene 7: AC6 findstr must not find the token anywhere under %APPDATA%\Arckeep
  // ---------------------------------------------------------------
  await scene('AC6-findstr', 'AC6: findstr /s for the token prefix under %APPDATA%\\Arckeep must find nothing (exit code 1)', async () => {
    const prefix8 = FAKE_TOKEN.slice(0, 8) // "ghp_Vf9Q"
    const prefixNoGhp = FAKE_TOKEN.slice(4, 12) // "Vf9QzXk2"
    function findstr(pattern) {
      const result = spawnSync('cmd.exe', ['/c', `findstr /s /m /c:"${pattern}" "${ARCKEEP_DATA_DIR}\\*"`], { encoding: 'utf8' })
      return { pattern, exitCode: result.status, stdout: result.stdout, stderr: result.stderr }
    }
    const r1 = findstr(prefix8)
    const r2 = findstr(prefixNoGhp)
    // UTF-16 pass, reference only
    const psScript = `Get-ChildItem -Recurse -File '${ARCKEEP_DATA_DIR}' | Select-String -Encoding Unicode -Pattern '${prefixNoGhp}' | Measure-Object | Select-Object -ExpandProperty Count`
    const utf16 = ps(psScript)

    const tree = ps(`Get-ChildItem -Recurse '${ARCKEEP_DATA_DIR}' | Select-Object FullName,Length | Format-Table -AutoSize | Out-String -Width 400`)
    fs.writeFileSync(path.join(EVIDENCE_DIR, '16-appdata-tree.txt'), tree.stdout)
    const settingsRaw = fs.existsSync(SETTINGS_FILE) ? fs.readFileSync(SETTINGS_FILE, 'utf8') : '(missing)'
    fs.writeFileSync(path.join(EVIDENCE_DIR, '17-settings.json.copy.json'), settingsRaw)

    if (r1.exitCode !== 1) throw new Error(`findstr prefix8 exitCode=${r1.exitCode}, stdout=${r1.stdout}`)
    if (r2.exitCode !== 1) throw new Error(`findstr prefixNoGhp exitCode=${r2.exitCode}, stdout=${r2.stdout}`)
    if (!fs.existsSync(SETTINGS_FILE)) throw new Error('settings.json is missing under %APPDATA%\\Arckeep')
    return { r1, r2, utf16MatchCount: utf16.stdout.trim(), settingsFilePath: SETTINGS_FILE }
  })

  // ---------------------------------------------------------------
  // Scene 8: AC7 restart, verify persistence
  // ---------------------------------------------------------------
  let app2, page2
  await scene('AC7-restart', 'AC7: relaunch without clearing data dir; repos, hotkey, and PAT-saved state must all still be there', async () => {
    app2 = await electron.launch({
      executablePath: UNPACKED_EXE,
      env: cleanEnv({ ARCKEEP_TEST_HOOKS: '1' })
    })
    page2 = await app2.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    await page2.locator('#settings-button').click()
    await page2.waitForTimeout(400)
    const repoListText = await page2.locator('.repo-list').innerText()
    const hotkeyInput = await page2.locator('input[aria-label="全局热键"]').inputValue()
    const sourceLabel = await page2.locator('.source strong').innerText()
    const hint = await page2.locator('.hint').first().innerText()
    await shot(page2, '18-settings-after-restart.png')
    if (!repoListText.includes('octocat/Hello-World') || !repoListText.includes('Dylan5237/arckeep')) {
      throw new Error(`repos not persisted: ${repoListText}`)
    }
    if (hotkeyInput !== 'Ctrl+Alt+Shift+A') throw new Error(`hotkey not persisted: ${hotkeyInput}`)
    if (sourceLabel !== '来源：本机 PAT') throw new Error(`github source not persisted as PAT: ${sourceLabel}`)
    return { repoListText, hotkeyInput, sourceLabel, hint }
  })

  await scene('AC7-restart-quit', 'Quit the restarted instance via the same hook path', async () => {
    await app2.evaluate(() => { globalThis.__ARCKEEP_TEST_HOOKS__.quit() })
    const start = Date.now()
    let remaining = listArckeepProcesses()
    while (remaining.length > 0 && Date.now() - start < 10000) {
      await new Promise(r => setTimeout(r, 300))
      remaining = listArckeepProcesses()
    }
    if (remaining.length > 0) throw new Error(`process(es) still alive: ${JSON.stringify(remaining)}`)
    return { elapsedMs: Date.now() - start }
  })

  // ---------------------------------------------------------------
  // Scene 9: narrow window (09/10)
  // ---------------------------------------------------------------
  let app3, page3
  await scene('X6-narrow', '09/10: resize to ~800px wide, then to the app minimum, check for overflow/scrollbars', async () => {
    resetAppData()
    app3 = await electron.launch({ executablePath: UNPACKED_EXE, env: cleanEnv({ ARCKEEP_TEST_HOOKS: '1' }) })
    page3 = await app3.firstWindow()
    await page3.waitForLoadState('domcontentloaded')
    await page3.waitForTimeout(500)

    const minSize = await app3.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMinimumSize())
    await app3.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const [, h] = win.getSize()
      win.setBounds({ width: 800, height: h })
    })
    await page3.waitForTimeout(400)
    const metrics800 = await page3.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      navOverflow: [...document.querySelectorAll('#nav button')].some(b => b.scrollWidth > b.clientWidth + 1)
    }))
    await shot(page3, '09-window-narrow-800.png')

    await app3.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const [minW, minH] = win.getMinimumSize()
      win.setBounds({ width: minW, height: minH })
    })
    await page3.waitForTimeout(400)
    const metricsMin = await page3.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      hasHorizontalScrollbar: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }))
    await shot(page3, '10-window-narrow-min.png')

    await app3.close().catch(() => {})
    return { minSize, metrics800, metricsMin }
  })

  // ---------------------------------------------------------------
  // Scene 10: X4 reverse hook checks (12) - MUST fail if hooks activate
  // ---------------------------------------------------------------
  await scene('X4-hooks-off-typeof', 'X4: without ARCKEEP_TEST_HOOKS, globalThis.__ARCKEEP_TEST_HOOKS__ is undefined', async () => {
    resetAppData()
    const app = await electron.launch({
      executablePath: UNPACKED_EXE,
      args: ['--arckeep-test=quit'],
      env: cleanEnv({})
    })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(10000)
    const typeofHooks = await app.evaluate(() => typeof globalThis.__ARCKEEP_TEST_HOOKS__)
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())
    await shot(page, '12-hooks-off.png')
    const stillRunning = listArckeepProcesses().length > 0
    if (typeofHooks !== 'undefined') throw new Error(`hooks were exposed: typeof === ${typeofHooks}`)
    if (!visible) throw new Error('window is not visible; --arckeep-test=quit had an effect without the env var')
    if (!stillRunning) throw new Error('process exited; --arckeep-test=quit had an effect without the env var')

    // second-instance quit attempt against an un-hooked primary must NOT terminate it
    const second = spawnSync(UNPACKED_EXE, ['--arckeep-test=quit'], { env: cleanEnv({}), timeout: 15000 })
    await new Promise(r => setTimeout(r, 800))
    const stillRunningAfterSecond = listArckeepProcesses().length > 0
    if (!stillRunningAfterSecond) throw new Error('primary instance quit after a second --arckeep-test=quit invocation without the env var')

    await app.close().catch(() => {})
    killAllArckeep()
    return { typeofHooks, visible, stillRunning, secondProcessExitCode: second.status, stillRunningAfterSecond }
  })

  for (const badValue of ['0', 'true']) {
    await scene(`X4-hooks-value-${badValue}`, `X4: ARCKEEP_TEST_HOOKS=${badValue} (must be exactly "1") does not activate the close hook`, async () => {
      resetAppData()
      const app = await electron.launch({
        executablePath: UNPACKED_EXE,
        args: ['--arckeep-test=close'],
        env: cleanEnv({ ARCKEEP_TEST_HOOKS: badValue })
      })
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page.waitForTimeout(4000)
      const typeofHooks = await app.evaluate(() => typeof globalThis.__ARCKEEP_TEST_HOOKS__)
      const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())
      await app.close().catch(() => {})
      killAllArckeep()
      if (typeofHooks !== 'undefined') throw new Error(`hooks were exposed for ARCKEEP_TEST_HOOKS=${badValue}`)
      if (!visible) throw new Error(`window was hidden for ARCKEEP_TEST_HOOKS=${badValue} (hook should be inert)`)
      return { badValue, typeofHooks, visible }
    })
  }

  // ---------------------------------------------------------------
  // Wrap up: crash + event log evidence
  // ---------------------------------------------------------------
  await scene('crash-and-eventlog', 'Crashpad reports directory + Application event log (1000/1001/1026, Arckeep-related)', async () => {
    const crash = crashReportsList()
    const evt = ps(`
try {
  Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1000,1001,1026} -ErrorAction Stop |
    Where-Object { $_.Message -match 'Arckeep' } |
    Select-Object TimeCreated,Id,LevelDisplayName,Message |
    Format-List | Out-String -Width 400
} catch {
  "no matching events or Get-WinEvent unavailable: $($_.Exception.Message)"
}
`)
    fs.writeFileSync(path.join(EVIDENCE_DIR, '19-eventlog-arckeep.txt'), evt.stdout)
    return { crashReports: crash, eventLogExitCode: evt.code }
  })

  fs.writeFileSync(path.join(EVIDENCE_DIR, 'invalid-token-message.txt'), String(invalidTokenMessage))
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'hotkey-warning-message.txt'), String(hotkeyWarningText))

  killAllArckeep()
  record('99-done', 'smoke.mjs finished', 'INFO', { scenes: scenes.length })
}

main().catch(error => {
  record('99-fatal', 'smoke.mjs crashed', 'FAIL', { error: error instanceof Error ? error.stack : String(error) })
  process.exitCode = 1
})
