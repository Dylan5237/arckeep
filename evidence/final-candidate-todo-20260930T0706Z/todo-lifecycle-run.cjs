'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')

const EVIDENCE = __dirname
const PROFILE_BASE = path.join(EVIDENCE, 'profiles-escalated-retry4')
const DELIVERY = 'D:/_projects/platform/arckeep/.worktrees/6-codex-mvp-delivery'
const ELECTRON_EXE = path.join(DELIVERY, 'node_modules/electron/dist/electron.exe')
const MAIN_ENTRY = path.join(DELIVERY, 'out/main/index.js')
const PLAYWRIGHT = 'D:/_projects/platform/arckeep/.worktrees/6-codex-mvp-readiness/evidence/harness-deps/node_modules/playwright-core'
const WRAPPER = path.join(DELIVERY, '.codex-final-candidate-todo-20260930T0706Z-elevated-retry4.cjs')
const TODO_UNDO_MS = 5000
const report = {
  runId: '2026-09-30T0706Z-elevated-retry4',
  scope: 'Three real Electron + Playwright todo scenarios using the delivery out/ build and standard sandbox launch.',
  delivery: DELIVERY,
  executable: ELECTRON_EXE,
  mainEntry: MAIN_ENTRY,
  wrapperTemporaryPath: WRAPPER,
  wrapperEvidencePath: path.join(EVIDENCE, path.basename(WRAPPER)),
  runnerLaunchOptions: { noSandbox: false, reason: 'Standard Electron sandbox launch after root applied the recorded local runtime read ACL for ALL APPLICATION PACKAGES.' },
  executionPermission: 'require_escalated',
  buildHead: '5cbfc35e08aac2462e894b5d1b258f8b3fbbf4e4',
  sourceHeadAtRunnerStart: null,
  electronVersionExpected: '43.7.6',
  testHooksEnabled: true,
  profiles: [],
  scenarios: [],
  limitations: [
    'Synthetic KeyboardEvent isComposing coverage does not test a real Windows IME.',
    'Playwright Enter coverage does not test OS global shortcuts.',
    'Tray construction is incidental startup only; tray interaction is not tested.'
  ],
  wrapperMovedToEvidence: false,
  completedAt: null
}

const wrapperSource = String.raw`'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app } = require('electron')
const profileRoot = process.env.ARCKEEP_PROFILE_ROOT
if (!profileRoot || !path.isAbsolute(profileRoot)) throw new Error('ARCKEEP_PROFILE_ROOT must be absolute')
const appData = path.join(profileRoot, 'appdata')
fs.mkdirSync(appData, { recursive: true })
app.setPath('appData', appData)
process.env.ARCKEEP_WRAPPER_APPDATA_APPLIED = '1'
import(pathToFileURL(path.join(__dirname, 'out', 'main', 'index.js')).href).catch(error => {
  console.error(error)
  app.exit(1)
})
`

function ensure(condition, message) {
  if (!condition) throw new Error(message)
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

function makeEnvironment(profileRoot) {
  const env = { ...process.env }
  const removed = []
  for (const key of Object.keys(env)) {
    if (/^ARCKEEP_/i.test(key) || /^VITE_DEV_SERVER_URL$/i.test(key) || /^NODE_OPTIONS$/i.test(key) || /^ELECTRON_RUN_AS_NODE$/i.test(key) || /^(GH|GITHUB)_.*(TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) || /^(GH|GITHUB)_(TOKEN|SECRET|PASSWORD|CREDENTIAL)$/i.test(key)) {
      delete env[key]
      removed.push(key)
    }
  }
  const local = path.join(profileRoot, 'localappdata')
  const temp = path.join(profileRoot, 'temp')
  env.APPDATA = path.join(profileRoot, 'appdata-env')
  env.LOCALAPPDATA = local
  env.TEMP = temp
  env.TMP = temp
  env.GH_CONFIG_DIR = path.join(profileRoot, 'gh-config')
  env.ARCKEEP_PROFILE_ROOT = profileRoot
  env.ARCKEEP_TEST_HOOKS = '1'
  for (const value of [env.APPDATA, env.LOCALAPPDATA, env.TEMP, env.GH_CONFIG_DIR, path.join(profileRoot, 'appdata')]) {
    fs.mkdirSync(value, { recursive: true })
  }
  return { env, removed, paths: { profileRoot, appData: path.join(profileRoot, 'appdata'), userDataExpected: path.join(profileRoot, 'appdata', 'Arckeep'), appDataEnv: env.APPDATA, localAppData: local, temp, ghConfigDir: env.GH_CONFIG_DIR } }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForPidExit(pid, timeoutMs) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await delay(100)
  }
  return false
}

function runSecondInstance(action, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON_EXE, [WRAPPER, '--arckeep-test=' + action], {
      cwd: DELIVERY,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString('utf8')).slice(-12000) })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-12000) })
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('second instance action timed out: ' + action))
    }, 15000)
    child.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      resolve({ action, pid: child.pid || null, code, signal, stdout, stderr })
    })
  })
}

async function launchApp(profileName) {
  const profileRoot = path.join(PROFILE_BASE, profileName)
  fs.mkdirSync(profileRoot, { recursive: true })
  const environment = makeEnvironment(profileRoot)
  const { _electron } = require(PLAYWRIGHT)
  const app = await _electron.launch({
    executablePath: ELECTRON_EXE,
    args: [WRAPPER],
    cwd: DELIVERY,
    env: environment.env,
    timeout: 45000
  })
  const processHandle = app.process()
  let stdout = ''
  let stderr = ''
  if (processHandle.stdout) processHandle.stdout.on('data', chunk => { stdout = (stdout + chunk.toString('utf8')).slice(-30000) })
  if (processHandle.stderr) processHandle.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-30000) })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 })
  await page.locator('button[data-view="todos"]').waitFor({ state: 'visible', timeout: 15000 })
  const runtime = await app.evaluate(({ app: electronApp }) => ({
    mainPid: process.pid,
    electronVersion: process.versions.electron,
    appData: electronApp.getPath('appData'),
    userData: electronApp.getPath('userData'),
    appPath: electronApp.getAppPath(),
    appName: electronApp.getName(),
    wrapperAppDataApplied: process.env.ARCKEEP_WRAPPER_APPDATA_APPLIED === '1'
  }))
  ensure(String(runtime.electronVersion) === report.electronVersionExpected, 'unexpected Electron version: ' + runtime.electronVersion)
  ensure(isWithin(profileRoot, runtime.appData), 'Electron appData escaped isolated profile: ' + runtime.appData)
  ensure(isWithin(profileRoot, runtime.userData), 'Electron userData escaped isolated profile: ' + runtime.userData)
  ensure(path.resolve(runtime.appPath).toLowerCase() === path.resolve(DELIVERY).toLowerCase(), 'unexpected appPath: ' + runtime.appPath)
  const profile = {
    name: profileName,
    ...environment.paths,
    runtime,
    launcherPid: processHandle.pid || null,
    removedEnvironmentKeys: environment.removed,
    ghTokenPresent: Boolean(environment.env.GH_TOKEN || environment.env.GITHUB_TOKEN),
    wrapperAppDataApplied: runtime.wrapperAppDataApplied
  }
  report.profiles.push(profile)
  return { app, page, profile, env: environment.env, processHandle, output: { stdout: () => stdout, stderr: () => stderr } }
}

async function quitApp(context) {
  const mainPid = context.profile.runtime.mainPid
  let secondary = null
  let gracefulExit = false
  let forcedClose = false
  const childClosed = once(context.processHandle, 'close').then(([code, signal]) => ({ code, signal })).catch(() => null)
  try {
    secondary = await runSecondInstance('quit', context.env)
  } catch (error) {
    secondary = { action: 'quit', error: String(error) }
  }
  gracefulExit = await waitForPidExit(mainPid, 10000)
  let processClose = null
  if (gracefulExit) {
    processClose = await Promise.race([childClosed, delay(1000).then(() => null)])
  } else {
    forcedClose = true
    try { await context.app.close() } catch {}
    gracefulExit = await waitForPidExit(mainPid, 7000)
    processClose = await Promise.race([childClosed, delay(1000).then(() => null)])
  }
  return { secondary, mainPid, launcherPid: context.processHandle.pid || null, gracefulExit, forcedClose, processClose, appProcessExitCode: context.processHandle.exitCode, stdout: context.output.stdout(), stderr: context.output.stderr() }
}

async function openTodos(page) {
  await page.locator('button[data-view="todos"]').click()
  await page.locator('[data-page="todos"]').waitFor({ state: 'visible', timeout: 10000 })
}

async function createTodo(page, data) {
  const result = await page.evaluate(input => window.arckeep.createTodo(input), data)
  ensure(result && result.ok, 'todo setup failed: ' + JSON.stringify(result))
  return result.data
}

async function listTodos(page) {
  return await page.evaluate(() => window.arckeep.listTodos())
}

async function editRow(page, id) {
  const row = page.locator('.todo-row[data-row-id="' + id + '"]')
  await row.waitFor({ state: 'visible', timeout: 10000 })
  await row.hover()
  await row.locator('button[data-action="edit"]').click()
  await row.locator('.todo-editor').waitFor({ state: 'visible', timeout: 10000 })
  return row
}

async function fillEditor(row, draft) {
  const text = row.locator('.todo-editor input[aria-label="待办内容"]')
  const repo = row.locator('.todo-editor input[aria-label="仓库标签"]')
  const waiting = row.locator('.todo-editor label.capture-wait input[type="checkbox"]')
  await text.fill(draft.text)
  await repo.fill(draft.repo)
  if (draft.waiting) await waiting.check()
  else await waiting.uncheck()
  return { text, repo, waiting }
}

async function editorFields(row) {
  return {
    text: await row.locator('.todo-editor input[aria-label="待办内容"]').inputValue(),
    repo: await row.locator('.todo-editor input[aria-label="仓库标签"]').inputValue(),
    waiting: await row.locator('.todo-editor label.capture-wait input[type="checkbox"]').isChecked()
  }
}

async function scenarioDraftSurvivesExpiry() {
  const context = await launchApp('scenario-1-draft-survives-expiry')
  const result = { id: 'delete-a-edit-b-expiry-retains-draft', status: 'running', profile: context.profile.name }
  let cleanup = null
  try {
    await openTodos(context.page)
    const a = await createTodo(context.page, { text: 'scenario 1 delete A', repo: 'evidence/delete-a', waiting: false })
    const b = await createTodo(context.page, { text: 'scenario 1 original B', repo: 'evidence/original-b', waiting: false })
    const rowA = context.page.locator('.todo-row[data-row-id="' + a.id + '"]')
    await rowA.hover()
    await rowA.locator('button[data-action="delete"]').click()
    const undo = context.page.locator('[data-action="undo-delete"]')
    await undo.waitFor({ state: 'visible', timeout: 10000 })
    result.undoButtonShownAt = await context.page.evaluate(() => Date.now())
    const rowB = await editRow(context.page, b.id)
    const targetDraft = { text: 'scenario 1 draft retained after expiry', repo: 'evidence/edited-b', waiting: true }
    await fillEditor(rowB, targetDraft)
    const beforeExpiry = await editorFields(rowB)
    await context.page.waitForFunction(() => !document.querySelector('[data-action="undo-delete"]'), null, { timeout: 8000 })
    const afterExpiry = await editorFields(rowB)
    const stored = await listTodos(context.page)
    assert.deepEqual(afterExpiry, targetDraft)
    assert(!stored.some(item => item.id === a.id), 'deleted A unexpectedly remains in store')
    assert.deepEqual(stored.find(item => item.id === b.id) && {
      text: stored.find(item => item.id === b.id).text,
      repo: stored.find(item => item.id === b.id).repo,
      waiting: stored.find(item => item.id === b.id).waiting
    }, { text: 'scenario 1 original B', repo: 'evidence/original-b', waiting: false })
    result.status = 'passed'
    result.undoExpiredAndButtonRemoved = true
    result.beforeExpiryDraft = beforeExpiry
    result.afterExpiryDraft = afterExpiry
    result.storedAfterExpiry = stored
    result.expiredAt = await context.page.evaluate(() => Date.now())
    result.screenshot = path.join(EVIDENCE, 'scenario-1-draft-after-expiry.png')
    await context.page.screenshot({ path: result.screenshot, fullPage: true })
  } finally {
    cleanup = await quitApp(context)
    result.cleanup = cleanup
  }
  return result
}

async function scenarioNavigationAndStaleUndo() {
  const context = await launchApp('scenario-2-navigation-undo-deadline')
  const result = { id: 'navigation-preserves-original-deadline-and-stale-click-rejected', status: 'running', profile: context.profile.name }
  let staleButton = null
  try {
    await openTodos(context.page)
    const target = await createTodo(context.page, { text: 'scenario 2 navigation target', repo: 'evidence/navigation', waiting: false })
    const row = context.page.locator('.todo-row[data-row-id="' + target.id + '"]')
    await row.hover()
    await row.locator('button[data-action="delete"]').click()
    const undo = context.page.locator('[data-action="undo-delete"]')
    await undo.waitFor({ state: 'visible', timeout: 10000 })
    result.undoButtonShownAt = await context.page.evaluate(() => Date.now())
    staleButton = await undo.elementHandle()
    await context.page.locator('button[data-view="settings"]').click()
    await context.page.locator('section.page.settings').waitFor({ state: 'visible', timeout: 10000 })
    await context.page.waitForTimeout(1900)
    await context.page.locator('button[data-view="todos"]').click()
    await context.page.locator('[data-page="todos"]').waitFor({ state: 'visible', timeout: 10000 })
    const returnedAt = await context.page.evaluate(() => Date.now())
    const elapsedAtReturn = returnedAt - result.undoButtonShownAt
    ensure(elapsedAtReturn < TODO_UNDO_MS, 'returned after original undo deadline: ' + elapsedAtReturn)
    await undo.waitFor({ state: 'visible', timeout: 3000 })
    result.remainingMsAtReturnApprox = TODO_UNDO_MS - elapsedAtReturn
    result.undoAvailableOnReturn = true
    const expiryObserved = await context.page.waitForFunction(() => !document.querySelector('[data-action="undo-delete"]'), null, { timeout: 5500 })
    result.expiredAt = await context.page.evaluate(() => Date.now())
    result.elapsedFromShownToExpiryObservedMs = result.expiredAt - result.undoButtonShownAt
    result.undoRemovedAfterOriginalDeadline = Boolean(expiryObserved)
    const staleIsConnected = await staleButton.evaluate(element => element.isConnected)
    await staleButton.evaluate(element => element.click())
    await context.page.waitForTimeout(300)
    const afterStaleClick = await listTodos(context.page)
    const logPath = path.join(context.profile.runtime.userData, 'todos.jsonl')
    const todoEvents = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    assert.equal(staleIsConnected, false)
    assert(!afterStaleClick.some(item => item.id === target.id), 'stale undo action restored deleted todo')
    assert(!todoEvents.some(event => event.op === 'restore' && event.record && event.record.id === target.id), 'stale undo appended restore event')
    result.status = 'passed'
    result.staleButtonWasDetached = !staleIsConnected
    result.staleButtonProgrammaticClickDidNotRestore = true
    result.todosAfterStaleClick = afterStaleClick
    result.todoEventOps = todoEvents.map(event => event.op)
    result.screenshot = path.join(EVIDENCE, 'scenario-2-expired-undo.png')
    await context.page.screenshot({ path: result.screenshot, fullPage: true })
  } finally {
    if (staleButton) await staleButton.dispose().catch(() => {})
    result.cleanup = await quitApp(context)
  }
  return result
}

async function scenarioComposingEnterAndRestart() {
  const profileName = 'scenario-3-composing-enter-restart'
  const context = await launchApp(profileName)
  const result = { id: 'composing-enter-ignored-normal-enter-saves-and-restart-persists', status: 'running', profile: profileName }
  try {
    await openTodos(context.page)
    const original = await createTodo(context.page, { text: 'scenario 3 original text', repo: 'evidence/original', waiting: false })
    const row = await editRow(context.page, original.id)
    const target = { text: 'scenario 3 saved by Enter', repo: 'evidence/saved-by-enter', waiting: true }
    const fields = await fillEditor(row, target)
    await fields.text.evaluate(element => {
      window.__todoKeyAudit = []
      element.addEventListener('keydown', event => {
        window.__todoKeyAudit.push({ key: event.key, isComposing: event.isComposing, isTrusted: event.isTrusted, defaultPrevented: event.defaultPrevented })
      }, true)
    })
    const syntheticEvent = await fields.text.evaluate(element => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, isComposing: true })
      element.dispatchEvent(event)
      return { isComposing: event.isComposing, isTrusted: event.isTrusted, defaultPrevented: event.defaultPrevented }
    })
    await context.page.waitForTimeout(200)
    const afterComposing = await listTodos(context.page)
    const composingEditorStillOpen = await row.locator('.todo-editor').count() === 1
    assert.equal(syntheticEvent.isComposing, true)
    assert.deepEqual(afterComposing.find(item => item.id === original.id) && {
      text: afterComposing.find(item => item.id === original.id).text,
      repo: afterComposing.find(item => item.id === original.id).repo,
      waiting: afterComposing.find(item => item.id === original.id).waiting
    }, { text: 'scenario 3 original text', repo: 'evidence/original', waiting: false })
    assert(composingEditorStillOpen, 'editor closed after composing Enter')
    result.composingEnterEvent = syntheticEvent
    result.composingEnterAudit = await context.page.evaluate(() => window.__todoKeyAudit)
    result.composingEnterDidNotSave = true
    result.screenshotBeforeOrdinaryEnter = path.join(EVIDENCE, 'scenario-3-after-composing-enter.png')
    await context.page.screenshot({ path: result.screenshotBeforeOrdinaryEnter, fullPage: true })
    await fields.text.press('Enter')
    await row.locator('.todo-editor').waitFor({ state: 'detached', timeout: 10000 })
    const saved = (await listTodos(context.page)).find(item => item.id === original.id)
    assert(saved)
    assert.deepEqual({ text: saved.text, repo: saved.repo, waiting: saved.waiting }, target)
    result.ordinaryEnterAudit = await context.page.evaluate(() => window.__todoKeyAudit)
    result.savedBeforeRestart = saved
    result.screenshotAfterOrdinaryEnter = path.join(EVIDENCE, 'scenario-3-saved-before-restart.png')
    await context.page.screenshot({ path: result.screenshotAfterOrdinaryEnter, fullPage: true })
    result.firstApp = await quitApp(context)

    const restarted = await launchApp(profileName)
    try {
      const restartedItem = (await listTodos(restarted.page)).find(item => item.id === original.id)
      assert(restartedItem, 'todo missing after restart')
      assert.deepEqual({ text: restartedItem.text, repo: restartedItem.repo, waiting: restartedItem.waiting }, target)
      await openTodos(restarted.page)
      const restartedRow = restarted.page.locator('.todo-row[data-row-id="' + original.id + '"]')
      await restartedRow.waitFor({ state: 'visible', timeout: 10000 })
      assert.equal(await restartedRow.locator('.todo-text').textContent(), target.text)
      assert.equal(await restartedRow.locator('.todo-repo').textContent(), target.repo)
      assert.equal(await restartedRow.locator('.chip').textContent(), '等我')
      result.restart = {
        mainPid: restarted.profile.runtime.mainPid,
        launcherPid: restarted.profile.launcherPid,
        persistedItem: restartedItem,
        uiText: await restartedRow.locator('.todo-text').textContent(),
        uiRepo: await restartedRow.locator('.todo-repo').textContent(),
        uiWaitingChip: await restartedRow.locator('.chip').textContent()
      }
      result.screenshotAfterRestart = path.join(EVIDENCE, 'scenario-3-after-restart.png')
      await restarted.page.screenshot({ path: result.screenshotAfterRestart, fullPage: true })
      result.status = 'passed'
    } finally {
      result.restartCleanup = await quitApp(restarted)
    }
  } catch (error) {
    if (!result.firstApp) result.firstApp = await quitApp(context)
    throw error
  }
  return result
}

async function main() {
  ensure(fs.existsSync(ELECTRON_EXE), 'Electron executable not found')
  ensure(fs.existsSync(MAIN_ENTRY), 'compiled main entry not found')
  ensure(fs.existsSync(PLAYWRIGHT), 'Playwright dependency not found')
  ensure(!fs.existsSync(WRAPPER), 'temporary wrapper path already exists')
  fs.mkdirSync(PROFILE_BASE, { recursive: true })
  fs.writeFileSync(WRAPPER, wrapperSource, { encoding: 'utf8', flag: 'wx' })
  report.sourceHeadAtRunnerStart = require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DELIVERY, encoding: 'utf8' }).trim()
  let failure = null
  try {
    console.log('RUN_HANDLE=' + process.pid)
    console.log('SCENARIO_1_START')
    report.scenarios.push(await scenarioDraftSurvivesExpiry())
    console.log('SCENARIO_1_PASSED mainPid=' + report.scenarios[0].cleanup.mainPid)
    console.log('SCENARIO_2_START')
    report.scenarios.push(await scenarioNavigationAndStaleUndo())
    console.log('SCENARIO_2_PASSED mainPid=' + report.scenarios[1].cleanup.mainPid)
    console.log('SCENARIO_3_START')
    report.scenarios.push(await scenarioComposingEnterAndRestart())
    console.log('SCENARIO_3_PASSED')
  } catch (error) {
    failure = error
    report.failure = { name: error && error.name, message: error && error.message, stack: error && error.stack }
  } finally {
    if (fs.existsSync(WRAPPER)) {
      try {
        fs.renameSync(WRAPPER, report.wrapperEvidencePath)
        report.wrapperMovedToEvidence = true
      } catch (error) {
        report.wrapperMoveError = String(error)
      }
    }
    report.completedAt = new Date().toISOString()
    fs.writeFileSync(path.join(EVIDENCE, 'todo-lifecycle-results.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
    console.log('RESULT_FILE=' + path.join(EVIDENCE, 'todo-lifecycle-results.json'))
    console.log('WRAPPER_EVIDENCE=' + report.wrapperEvidencePath)
  }
  if (failure) {
    console.error(failure.stack || failure)
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error(error && error.stack || error)
  process.exitCode = 1
})
