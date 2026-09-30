import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const runDirectory = path.dirname(fileURLToPath(import.meta.url))
const evidenceRoot = path.resolve(runDirectory, '..')
const preparedPath = path.join(runDirectory, 'prepared.json')
const resultsPath = path.resolve(runDirectory, getOption('--results-out', 'results.json'))
const logPath = path.join(runDirectory, 'runner.log')
const defaultDeliveryRoot = path.resolve(evidenceRoot, '..', '..', '6-codex-mvp-delivery')
const playwrightModulePath = 'D:/_projects/platform/arckeep/.worktrees/6-codex-mvp-readiness/evidence/harness-deps/node_modules/playwright-core/index.mjs'
const powershellPath = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const testOnlyUnsavedPat = 'UNSAVED_TEST_INPUT_NOT_A_CREDENTIAL'
let electronApi = null
let results = null

function getOption(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function hasFlag(name) {
  return process.argv.includes(name)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function hashFile(file) {
  return sha256(fs.readFileSync(file))
}

function walkFiles(directory) {
  if (!fs.existsSync(directory)) return []
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(target))
    else if (entry.isFile()) files.push(target)
  }
  return files.sort((a, b) => a.localeCompare(b))
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
}

function collectDeliverySnapshot(deliveryRoot) {
  const packagePath = path.join(deliveryRoot, 'package.json')
  const electronPath = path.join(deliveryRoot, 'node_modules/electron/dist/electron.exe')
  const sourceFiles = [
    'src/main/index.ts',
    'src/main/tool-ipc.ts',
    'src/main/tool-actions.ts',
    'src/main/tool-request.ts',
    'src/main/tool-launch.ts',
    'src/main/tool-runner.ts',
    'src/main/tool-rehearse.ts',
    'src/renderer/main.ts',
    'src/renderer/tools-page.ts',
    'src/preload/index.ts'
  ]
  const sourceHashes = Object.fromEntries(sourceFiles.map(relative => {
    const fullPath = path.join(deliveryRoot, relative)
    if (!fs.existsSync(fullPath)) throw new Error('required source file missing: ' + relative)
    return [relative.replaceAll('\\', '/'), hashFile(fullPath)]
  }))
  const outputDirectories = ['out/main', 'out/preload', 'out/renderer']
  const outputFiles = outputDirectories.flatMap(relative => walkFiles(path.join(deliveryRoot, relative)))
  if (outputFiles.length === 0) throw new Error('compiled output is missing')
  const outputHashes = Object.fromEntries(outputFiles.map(fullPath => [
    path.relative(deliveryRoot, fullPath).replaceAll('\\', '/'),
    hashFile(fullPath)
  ]))
  for (const relative of ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html']) {
    if (!Object.hasOwn(outputHashes, relative)) throw new Error('required compiled file missing: ' + relative)
  }
  if (!fs.existsSync(packagePath)) throw new Error('package.json is missing')
  if (!fs.existsSync(electronPath)) throw new Error('Electron executable is missing')
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
  const sourceManifestSha256 = sha256(Buffer.from(JSON.stringify(sourceHashes)))
  const outputManifestSha256 = sha256(Buffer.from(JSON.stringify(outputHashes)))
  return {
    root: deliveryRoot,
    branch: git(deliveryRoot, ['branch', '--show-current']),
    sourceHead: git(deliveryRoot, ['rev-parse', 'HEAD']),
    worktreeStatus: git(deliveryRoot, ['status', '--short']),
    productVersion: packageJson.version,
    expectedElectronVersion: packageJson.devDependencies?.electron ?? null,
    sourceFiles: sourceHashes,
    sourceManifestSha256,
    compiledFiles: outputHashes,
    compiledManifestSha256: outputManifestSha256,
    electronExecutableSha256: hashFile(electronPath),
    buildProvenance: 'NOT_AUTOMATICALLY_VERIFIED; source revision and compiled-file hashes are recorded separately'
  }
}

function preparation(deliveryRoot) {
  const playwrightExists = fs.existsSync(playwrightModulePath)
  return {
    state: 'PREPARED_WAITING_FOR_SERIAL_GUI_WINDOW',
    preparedAt: new Date().toISOString(),
    evidenceDirectory: runDirectory,
    delivery: collectDeliverySnapshot(deliveryRoot),
    dependencies: {
      playwrightCoreModule: playwrightModulePath,
      playwrightCoreExists: playwrightExists,
      electronExecutableWillBeReadFromDelivery: path.join(deliveryRoot, 'node_modules/electron/dist/electron.exe')
    },
    execution: {
      electronLaunches: 0,
      guiStarted: false,
      note: 'Preparation only; no Electron command, preflight, or GUI has been launched.'
    },
    plannedScenarios: [
      'template-stale-params-page-same-id-command',
      'configuration-drift-rejects-confirmation',
      'parameter-drift-rejects-confirmation',
      'background-output-preserves-unsaved-settings-inputs',
      'fast-completion-and-startup-failure-terminal-events',
      'leave-page-during-rehearsal-observation',
      'quit-during-rehearsal-observation'
    ]
  }
}

function log(message) {
  const line = new Date().toISOString() + ' ' + message
  fs.appendFileSync(logPath, line + '\n', 'utf8')
  process.stdout.write(line + '\n')
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function psQuote(value) {
  return "'" + value.replaceAll("'", "''") + "'"
}

function cleanEnvironment(profile, customComSpec = null) {
  const env = { ...process.env }
  const denied = new Set([
    'GH_TOKEN', 'GITHUB_TOKEN', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS',
    'ARCKEEP_SCREENSHOT', 'ARCKEEP_SCREENSHOT_SCENE', 'ARCKEEP_SCREENSHOT_DIR',
    'ARCKEEP_DEV', 'VITE_DEV_SERVER_URL', 'GH_CONFIG_DIR', 'ARCKEEP_POWERSHELL', 'ARCKEEP_GIT_BASH',
    'ARCKEEP_TEST_HOOKS', 'ARCKEEP_EVIDENCE_APPDATA', 'ARCKEEP_EVIDENCE_USERDATA',
    'ARCKEEP_EVIDENCE_ENTRY', 'ARCKEEP_EVIDENCE_PROBE_RESULT', 'ARCKEEP_EVIDENCE_WRAPPER_APPDATA'
  ])
  for (const key of Object.keys(env)) {
    if (denied.has(key.toUpperCase())) delete env[key]
  }
  if (customComSpec) {
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'COMSPEC') delete env[key]
    }
  }
  const appData = path.join(profile, 'appdata')
  const localAppData = path.join(profile, 'local-appdata')
  const temp = path.join(profile, 'temp')
  const ghConfigDir = path.join(profile, 'gh-config')
  for (const directory of [appData, localAppData, temp, ghConfigDir]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  Object.assign(env, {
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
    GH_CONFIG_DIR: ghConfigDir,
    ARCKEEP_TEST_HOOKS: '1',
    ARCKEEP_POWERSHELL: powershellPath,
    ARCKEEP_EVIDENCE_APPDATA: appData,
    ARCKEEP_EVIDENCE_USERDATA: path.join(profile, 'user-data')
  })
  if (customComSpec) env.ComSpec = customComSpec
  return { env, appData, localAppData, temp, ghConfigDir }
}

function wrapperSource() {
  return [
    "const { app } = require('electron')",
    "const fs = require('node:fs')",
    "const { pathToFileURL } = require('node:url')",
    'const appData = process.env.ARCKEEP_EVIDENCE_APPDATA',
    'const userData = process.env.ARCKEEP_EVIDENCE_USERDATA',
    'const entry = process.env.ARCKEEP_EVIDENCE_ENTRY',
    "if (!appData || !userData || !entry) throw new Error('Isolated wrapper paths required')",
    'fs.mkdirSync(appData, { recursive: true })',
    "app.setPath('appData', appData)",
    "if (app.getPath('appData') !== appData) throw new Error('appData isolation failed')",
    "process.env.ARCKEEP_EVIDENCE_WRAPPER_APPDATA = '1'",
    'if (process.env.ARCKEEP_EVIDENCE_PROBE_RESULT) {',
    "  app.setPath('userData', userData)",
    '  app.whenReady().then(() => {',
    "    const result = { appPath: app.getAppPath(), appData: app.getPath('appData'), userData: app.getPath('userData') }",
    '    fs.writeFileSync(process.env.ARCKEEP_EVIDENCE_PROBE_RESULT, JSON.stringify(result, null, 2))',
    '    app.quit()',
    "  }).catch(error => { console.error(error); app.exit(2) })",
    '} else {',
    '  import(pathToFileURL(entry).href).catch(error => { console.error(error); app.exit(1) })',
    '}'
  ].join('\n')
}

async function runWrapperPreflight(profile, setup, deliveryRoot, electronPath, wrapperPath) {
  fs.writeFileSync(wrapperPath, wrapperSource(), 'utf8')
  const resultFile = path.join(profile, 'wrapper-preflight.json')
  const env = {
    ...setup.env,
    ARCKEEP_EVIDENCE_ENTRY: path.join(deliveryRoot, 'out/main/index.js'),
    ARCKEEP_EVIDENCE_PROBE_RESULT: resultFile
  }
  const child = spawn(electronPath, [wrapperPath], {
    cwd: deliveryRoot,
    env,
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true
  })
  let timedOut = false
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 15000)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      let probe = null
      try {
        if (fs.existsSync(resultFile)) probe = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
      } catch {
        probe = null
      }
      resolve({ code, signal, timedOut, result: probe })
    })
  })
}

function processQuery(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'process PID must be a positive integer')
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '$items = @(Get-CimInstance Win32_Process -Filter ' + psQuote('ProcessId=' + pid) + ')',
    "if ($items.Count -eq 0) { @{kind='absent'} | ConvertTo-Json -Compress } else {",
    "$item = $items[0]; @{kind='alive';pid=[int]$item.ProcessId;parentPid=[int]$item.ParentProcessId;created=$item.CreationDate.ToUniversalTime().ToString('o');executablePath=$item.ExecutablePath;commandLine=$item.CommandLine} | ConvertTo-Json -Compress",
    '}'
  ].join('\n')
  try {
    const output = execFileSync(powershellPath, [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
    ], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    return JSON.parse(output.replace(/^\uFEFF/, '').trim())
  } catch (error) {
    return { kind: 'query-error', pid, error: String(error?.message ?? error) }
  }
}

function decodedCommandLine(commandLine) {
  if (!commandLine) return ''
  const encoded = /-EncodedCommand\s+(\S+)/i.exec(commandLine)?.[1]
  return encoded ? Buffer.from(encoded, 'base64').toString('utf16le') : commandLine
}

function safeProcess(processInfo, wrapperPath = null, scriptPath = null) {
  if (!processInfo || processInfo.kind !== 'alive') return processInfo
  const commandLine = processInfo.commandLine ?? ''
  const decoded = decodedCommandLine(commandLine)
  return {
    kind: 'alive',
    pid: processInfo.pid,
    parentPid: processInfo.parentPid,
    created: processInfo.created,
    executablePath: processInfo.executablePath,
    executableName: processInfo.executablePath ? path.basename(processInfo.executablePath) : null,
    wrapperArgumentPresent: wrapperPath ? decoded.toLowerCase().includes(wrapperPath.toLowerCase()) : undefined,
    scriptArgumentPresent: scriptPath ? decoded.toLowerCase().includes(scriptPath.toLowerCase()) : undefined
  }
}

function processChain(pid, wrapperPath = null) {
  const chain = []
  let nextPid = pid
  const seen = new Set()
  for (let depth = 0; depth < 8 && nextPid && !seen.has(nextPid); depth += 1) {
    seen.add(nextPid)
    const item = processQuery(nextPid)
    chain.push(safeProcess(item, wrapperPath))
    if (item.kind !== 'alive' || !item.parentPid || item.parentPid === nextPid) break
    nextPid = item.parentPid
  }
  return chain
}

function readJson(file) {
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

function pathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

async function launchProduct(profile, deliveryRoot, setup, wrapperPath) {
  const electronPath = path.join(deliveryRoot, 'node_modules/electron/dist/electron.exe')
  const env = {
    ...setup.env,
    ARCKEEP_EVIDENCE_ENTRY: path.join(deliveryRoot, 'out/main/index.js')
  }
  const artifactsDir = path.join(profile, 'playwright-artifacts')
  fs.mkdirSync(artifactsDir, { recursive: true })
  const app = await electronApi.launch({
    artifactsDir,
    executablePath: electronPath,
    args: [wrapperPath],
    cwd: deliveryRoot,
    env,
    timeout: 30000
  })
  const process = app.process()
  const exitRecord = { value: null }
  const exited = new Promise(resolve => {
    process.once('exit', (code, signal) => {
      exitRecord.value = { code, signal, at: new Date().toISOString() }
      resolve(exitRecord.value)
    })
    if (process.exitCode !== null || process.signalCode !== null) {
      exitRecord.value = { code: process.exitCode, signal: process.signalCode, at: new Date().toISOString() }
      resolve(exitRecord.value)
    }
  })
  const page = await app.firstWindow()
  await page.waitForFunction(() => Boolean(window.arckeep), null, { timeout: 20000 })
  const runtime = await app.evaluate(({ app: electronApp }) => ({
    mainPid: process.pid,
    electronVersion: process.versions.electron,
    appData: electronApp.getPath('appData'),
    userData: electronApp.getPath('userData'),
    appPath: electronApp.getAppPath(),
    envAppData: process.env.APPDATA,
    ghConfigDir: process.env.GH_CONFIG_DIR,
    ghTokenPresent: Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN),
    testHooks: process.env.ARCKEEP_TEST_HOOKS,
    wrapperAppDataApplied: process.env.ARCKEEP_EVIDENCE_WRAPPER_APPDATA ?? null,
    devServerConfigured: Boolean(process.env.ARCKEEP_DEV || process.env.VITE_DEV_SERVER_URL),
    screenshotPresent: Boolean(process.env.ARCKEEP_SCREENSHOT || process.env.ARCKEEP_SCREENSHOT_SCENE)
  }))
  const rendererUrl = page.url()
  const expectedUserData = path.join(setup.appData, 'Arckeep')
  assert.equal(path.resolve(runtime.appPath), path.resolve(deliveryRoot), 'Electron appPath must be the built delivery worktree')
  assert.equal(path.resolve(runtime.appData), path.resolve(setup.appData), 'Electron appData must be isolated')
  assert.equal(path.resolve(runtime.userData), path.resolve(expectedUserData), 'product userData must be inside isolated appData')
  assert.equal(path.resolve(runtime.envAppData), path.resolve(setup.appData))
  assert.equal(path.resolve(runtime.ghConfigDir), path.resolve(setup.ghConfigDir))
  assert.equal(pathInside(profile, runtime.userData), true)
  assert.equal(runtime.ghTokenPresent, false)
  assert.equal(runtime.testHooks, '1')
  assert.equal(runtime.wrapperAppDataApplied, '1')
  assert.equal(runtime.devServerConfigured, false)
  assert.equal(runtime.screenshotPresent, false)
  assert.equal(new URL(rendererUrl).protocol, 'file:')
  assert.ok(rendererUrl.toLowerCase().includes('/out/renderer/'), 'renderer must come from compiled local output')
  await page.evaluate(() => {
    globalThis.__finalCandidateCommandEvents = []
    window.arckeep.onToolEvent(event => {
      globalThis.__finalCandidateCommandEvents.push({ ...event, observedAt: new Date().toISOString() })
    })
  })
  return { app, process, exited, exitRecord, page, runtime, rendererUrl, artifactsDir }
}

function processState(process, exitRecord) {
  return {
    alive: process.exitCode === null && process.signalCode === null,
    exitCode: process.exitCode,
    signal: process.signalCode,
    observedExit: exitRecord.value
  }
}

function writeProbeScript(profile, scenario, name, { sleepMs = 0, output = null } = {}) {
  const script = path.join(profile, name + '.ps1')
  const started = path.join(profile, name + '-started.json')
  const completed = path.join(profile, name + '-completed.json')
  const marker = file => "@{pid=$PID;at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress | Set-Content -LiteralPath " + psQuote(file) + ' -Encoding UTF8'
  const lines = ["$ErrorActionPreference = 'Stop'", marker(started)]
  if (output) lines.push('Write-Output ' + psQuote(output))
  if (sleepMs) lines.push('Start-Sleep -Milliseconds ' + sleepMs)
  lines.push(marker(completed))
  if (output) lines.push('Write-Output ' + psQuote(output + '_DONE'))
  lines.push('exit 0')
  fs.writeFileSync(script, lines.join('\n'), 'utf8')
  const item = { script, started, completed, sleepMs, output }
  scenario.candidates.push(item)
  return item
}

function writeFormalProbeWithChild(profile, scenario, sleepMs = 60000) {
  const child = writeProbeScript(profile, scenario, 'long-formal-child', {
    sleepMs,
    output: 'LONG_FORMAL_CHILD_RUNNING'
  })
  const script = path.join(profile, 'long-formal-parent.ps1')
  const started = path.join(profile, 'long-formal-parent-started.json')
  const completed = path.join(profile, 'long-formal-parent-completed.json')
  const marker = file => "@{pid=$PID;at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress | Set-Content -LiteralPath " + psQuote(file) + ' -Encoding UTF8'
  const childArgumentList = '-NoProfile -NonInteractive -File "' + child.script + '"'
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    '$child = Start-Process -FilePath ' + psQuote(powershellPath) + ' -ArgumentList ' + psQuote(childArgumentList) + ' -PassThru -WindowStyle Hidden',
    "@{pid=$PID;childPid=[int]$child.Id;at=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Compress | Set-Content -LiteralPath " + psQuote(started) + ' -Encoding UTF8',
    'Wait-Process -Id $child.Id',
    marker(completed),
    'exit 0'
  ]
  fs.writeFileSync(script, lines.join('\n'), 'utf8')
  const formal = { script, started, completed, sleepMs, output: null }
  scenario.candidates.push(formal)
  return { formal, child }
}

function commandAction(profile, id, title, formal, dry, options = {}) {
  const action = {
    id,
    title,
    type: 'run-command',
    shell: options.shell ?? 'powershell',
    cwd: options.cwd ?? profile,
    command: options.command ?? ('& ' + psQuote(formal.script)),
    previewCommand: options.previewCommand ?? ('& ' + psQuote(dry.script)),
    confirmLabel: '执行验证命令'
  }
  if (options.params) action.params = options.params
  return action
}

function shelfJson(actions) {
  return JSON.stringify({ version: 1, actions }, null, 2)
}

async function navigate(page, view) {
  await page.locator('[data-view="' + view + '"]').click()
  if (view === 'settings') await page.locator('#tool-shelf-json').waitFor({ timeout: 12000 })
  if (view === 'tools') await page.locator('.page.tools').waitFor({ timeout: 12000 })
}

async function saveConfigAndOpen(page, json, title) {
  await navigate(page, 'settings')
  await page.locator('#tool-shelf-json').fill(json)
  await page.locator('#tool-shelf-card').getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(async expected => (await window.arckeep.getState()).toolShelfJson === expected, json, { timeout: 12000 })
  await navigate(page, 'tools')
  await page.locator('.tool-card').filter({ hasText: title }).first().click()
  await page.locator('.page.tools h1').filter({ hasText: title }).waitFor({ timeout: 12000 })
}

async function previewFromCurrentPage(page, { parameterLabel = null, parameterValue = null, waitForConfirmation = true } = {}) {
  if (parameterLabel) {
    await page.getByLabel(parameterLabel, { exact: true }).fill(parameterValue)
    await page.getByRole('button', { name: '预览', exact: true }).click()
  }
  if (waitForConfirmation) {
    await page.getByRole('dialog', { name: '即将执行', exact: true }).waitFor({ timeout: 15000 })
    await page.getByRole('button', { name: '执行验证命令', exact: true }).waitFor({ timeout: 10000 })
  }
}

async function eventList(page) {
  return page.evaluate(() => globalThis.__finalCandidateCommandEvents ?? [])
}

async function waitForDone(page, startIndex = 0, timeout = 15000) {
  await page.waitForFunction(index => (globalThis.__finalCandidateCommandEvents ?? []).slice(index).some(event => event.type === 'done'), startIndex, { timeout })
  return eventList(page)
}

function recordProcessIdentity(scenario, pid, scriptPath, wrapperPath, mainPid, expectedParentPid = mainPid) {
  const current = processQuery(pid)
  const safe = safeProcess(current, wrapperPath, scriptPath)
  assert.equal(current.kind, 'alive', 'marker PID must be live when its process identity is first recorded')
  assert.equal(safe.scriptArgumentPresent, true, 'PowerShell process must identify the unique rehearsal script')
  assert.equal(path.resolve(current.executablePath).toLowerCase(), path.resolve(powershellPath).toLowerCase())
  assert.equal(current.parentPid, expectedParentPid, 'PowerShell process must be a direct child of its recorded owner')
  const identity = {
    pid,
    created: current.created,
    parentPid: current.parentPid,
    scriptPath,
    initial: safe,
    initialParentChain: processChain(pid, wrapperPath)
  }
  scenario.ownedProcesses.push(identity)
  return identity
}

function observeIdentity(identity, wrapperPath) {
  const current = processQuery(identity.pid)
  if (current.kind !== 'alive') return current
  if (current.created !== identity.created || safeProcess(current, wrapperPath, identity.scriptPath).scriptArgumentPresent !== true) {
    return { kind: 'pid-reused-or-identity-mismatch', pid: identity.pid, observedAt: new Date().toISOString() }
  }
  return safeProcess(current, wrapperPath, identity.scriptPath)
}

function markerSummary(candidate) {
  const started = readJson(candidate.started)
  const completed = readJson(candidate.completed)
  return {
    script: candidate.script,
    started: started ? { pid: started.pid, at: started.at } : null,
    completed: completed ? { pid: completed.pid, at: completed.at } : null
  }
}

async function requestQuit(run, scenario) {
  scenario.quitRequestedAt = new Date().toISOString()
  await run.app.evaluate(() => globalThis.__ARCKEEP_TEST_HOOKS__?.quit()).catch(error => {
    scenario.quitRequestError = String(error?.message ?? error)
  })
  await Promise.race([run.exited, sleep(6000)])
  scenario.playwrightChildAfterQuit = processState(run.process, run.exitRecord)
  scenario.mainAfterQuit = safeProcess(processQuery(run.runtime.mainPid))
  assert.equal(scenario.playwrightChildAfterQuit.alive, false, 'Playwright child must exit after explicit app quit')
  assert.equal(scenario.playwrightChildAfterQuit.exitCode, 0)
  assert.equal(scenario.mainAfterQuit.kind, 'absent', 'actual Electron main PID must be absent after app quit')
}

function createCustomCmd(profile) {
  const source = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/cmd.exe')
  const directory = path.join(profile, 'custom-shell')
  fs.mkdirSync(directory, { recursive: true })
  const target = path.join(directory, 'cmd.exe')
  fs.copyFileSync(source, target)
  return { source, target, sha256: hashFile(target) }
}

function maybeReadCandidate(candidate) {
  try {
    return markerSummary(candidate)
  } catch (error) {
    return { script: candidate.script, readError: String(error?.message ?? error) }
  }
}

async function cleanOwnedProcesses(scenario, wrapperPath) {
  scenario.cleanup ??= {}
  scenario.cleanup.ownedProcesses = []
  for (const identity of scenario.ownedProcesses ?? []) {
    const before = processQuery(identity.pid)
    const beforeObservedAt = new Date().toISOString()
    const beforeSafe = safeProcess(before, wrapperPath, identity.scriptPath)
    const beforeChain = processChain(identity.pid, wrapperPath)
    const record = {
      pid: identity.pid,
      preCleanupObservedAt: beforeObservedAt,
      preCleanup: beforeSafe,
      preCleanupParentChain: beforeChain,
      killRequested: false
    }
    if (before.kind === 'alive') {
      const sameProcess = before.created === identity.created
        && before.parentPid === identity.parentPid
        && beforeSafe.scriptArgumentPresent === true
        && beforeSafe.executablePath?.toLowerCase() === powershellPath.toLowerCase()
      if (sameProcess) {
        record.killRequested = true
        try {
          const taskkill = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe')
          execFileSync(taskkill, ['/PID', String(identity.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 8000 })
        } catch (error) {
          record.killError = String(error?.message ?? error)
        }
      } else {
        record.identityMismatch = true
      }
    }
    record.afterCleanup = observeIdentity(identity, wrapperPath)
    scenario.cleanup.ownedProcesses.push(record)
    if (['alive', 'query-error', 'pid-reused-or-identity-mismatch'].includes(record.afterCleanup.kind)) {
      scenario.verdict = 'PROBE_ERROR'
      process.exitCode = 1
    }
  }
}

async function finishApplication(run, scenario, wrapperPath) {
  if (!run) return
  scenario.cleanup ??= {}
  scenario.cleanup.mainPid = run.runtime.mainPid
  scenario.cleanup.playwrightChildPid = run.process.pid
  if (run.process.exitCode === null && run.process.signalCode === null) {
    try {
      await requestQuit(run, scenario)
    } catch (error) {
      scenario.cleanup.quitError = String(error?.message ?? error)
      scenario.verdict = 'PROBE_ERROR'
      process.exitCode = 1
    }
  }
  if (run.process.exitCode === null && run.process.signalCode === null) {
    try {
      await run.app.close()
      scenario.cleanup.playwrightCloseRequested = true
      await Promise.race([run.exited, sleep(5000)])
    } catch (error) {
      scenario.cleanup.playwrightCloseError = String(error?.message ?? error)
    }
  }
  scenario.cleanup.playwrightChildFinal = processState(run.process, run.exitRecord)
  const mainBeforeKill = processQuery(run.runtime.mainPid)
  scenario.cleanup.mainFinalBeforePotentialCleanup = safeProcess(mainBeforeKill, wrapperPath)
  if (mainBeforeKill.kind === 'alive') {
    const mainChain = processChain(run.runtime.mainPid, wrapperPath)
    scenario.cleanup.mainParentChainBeforePotentialCleanup = mainChain
    const initial = scenario.mainAtLaunch
    const stillSameMain = mainBeforeKill.created === initial?.created
      && safeProcess(mainBeforeKill, wrapperPath).wrapperArgumentPresent === true
      && path.resolve(mainBeforeKill.executablePath).toLowerCase() === path.resolve(run.runtime.electronPath).toLowerCase()
    if (stillSameMain) {
      scenario.cleanup.mainKillRequested = true
      try {
        const taskkill = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe')
        execFileSync(taskkill, ['/PID', String(run.runtime.mainPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 8000 })
      } catch (error) {
        scenario.cleanup.mainKillError = String(error?.message ?? error)
      }
    } else {
      scenario.cleanup.mainIdentityMismatch = true
      scenario.verdict = 'PROBE_ERROR'
      process.exitCode = 1
    }
  }
  scenario.cleanup.mainFinal = safeProcess(processQuery(run.runtime.mainPid), wrapperPath)
  if (scenario.cleanup.mainFinal.kind !== 'absent' || scenario.cleanup.playwrightChildFinal.alive) {
    scenario.verdict = 'PROBE_ERROR'
    process.exitCode = 1
  }
}

async function runScenario(id, action, options = {}) {
  const deliveryRoot = options.deliveryRoot
  const runStamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')
  const profile = fs.mkdtempSync(path.join(runDirectory, 'profile-' + id + '-'))
  const wrapperPath = path.join(deliveryRoot, '.final-candidate-command-root-wrapper-' + runStamp + '-' + id + '.cjs')
  const scenario = {
    id,
    profile,
    wrapperPath,
    ownedProcesses: [],
    candidates: [],
    verdict: 'INCOMPLETE'
  }
  results.scenarios.push(scenario)
  let run = null
  let setup = null
  let customCmd = null
  try {
    if (options.customCmd) {
      customCmd = createCustomCmd(profile)
      scenario.customShell = { relativeCopyPath: path.relative(profile, customCmd.target), sha256: customCmd.sha256 }
    }
    setup = cleanEnvironment(profile, customCmd?.target ?? null)
    scenario.isolation = {
      appData: setup.appData,
      localAppData: setup.localAppData,
      temp: setup.temp,
      ghConfigDir: setup.ghConfigDir,
      ghTokenPresent: Boolean(setup.env.GH_TOKEN || setup.env.GITHUB_TOKEN),
      testHooks: setup.env.ARCKEEP_TEST_HOOKS === '1'
    }
    const electronPath = path.join(deliveryRoot, 'node_modules/electron/dist/electron.exe')
    const preflight = await runWrapperPreflight(profile, setup, deliveryRoot, electronPath, wrapperPath)
    scenario.wrapperPreflight = {
      code: preflight.code,
      signal: preflight.signal,
      timedOut: preflight.timedOut,
      result: preflight.result
        ? {
            appPath: preflight.result.appPath,
            appDataInsideProfile: pathInside(profile, preflight.result.appData),
            userDataInsideProfile: pathInside(profile, preflight.result.userData),
            appData: preflight.result.appData,
            userData: preflight.result.userData
          }
        : null
    }
    assert.equal(preflight.code, 0)
    assert.equal(preflight.timedOut, false)
    assert.ok(preflight.result)
    assert.equal(path.resolve(preflight.result.appPath), path.resolve(deliveryRoot))
    assert.equal(pathInside(profile, preflight.result.appData), true)
    assert.equal(pathInside(profile, preflight.result.userData), true)
    run = await launchProduct(profile, deliveryRoot, setup, wrapperPath)
    run.runtime.electronPath = electronPath
    scenario.runtime = run.runtime
    scenario.rendererUrl = run.rendererUrl
    scenario.artifactsDir = run.artifactsDir
    scenario.playwrightChildPid = run.process.pid
    scenario.mainPid = run.runtime.mainPid
    scenario.mainAtLaunch = safeProcess(processQuery(run.runtime.mainPid), wrapperPath)
    scenario.mainParentChainAtLaunch = processChain(run.runtime.mainPid, wrapperPath)
    assert.equal(scenario.mainAtLaunch.kind, 'alive')
    assert.equal(scenario.mainAtLaunch.wrapperArgumentPresent, true)
    assert.equal(path.resolve(scenario.mainAtLaunch.executablePath).toLowerCase(), path.resolve(electronPath).toLowerCase())
    assert.equal(scenario.mainAtLaunch.parentPid, run.process.pid)
    assert.equal(run.runtime.electronVersion, results.source.expectedElectronVersion)
    await action(run, scenario, profile, customCmd)
    if (scenario.verdict === 'INCOMPLETE') scenario.verdict = 'OBSERVED_WITH_RECORDED_SCOPE'
  } catch (error) {
    scenario.error = String(error?.message ?? error).replaceAll(testOnlyUnsavedPat, '[REDACTED_TEST_INPUT]')
    scenario.verdict = 'PROBE_ERROR'
    process.exitCode = 1
  } finally {
    if (run) await finishApplication(run, scenario, wrapperPath)
    await cleanOwnedProcesses(scenario, wrapperPath)
    scenario.markerObservations = scenario.candidates.map(maybeReadCandidate)
    if (fs.existsSync(wrapperPath)) {
      const archive = path.join(profile, 'command-root-wrapper.cjs')
      try {
        fs.renameSync(wrapperPath, archive)
        scenario.wrapperArchive = archive
        scenario.wrapperArchiveSha256 = hashFile(archive)
      } catch (error) {
        scenario.wrapperArchiveError = String(error?.message ?? error)
        scenario.verdict = 'PROBE_ERROR'
        process.exitCode = 1
      }
    }
    scenario.finishedAt = new Date().toISOString()
    saveResults()
    log(id + ': ' + scenario.verdict)
  }
}

function saveResults() {
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2), 'utf8')
}

async function waitForMarker(file, timeoutMs = 12000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const marker = readJson(file)
    if (marker) return marker
    await sleep(75)
  }
  throw new Error('bounded wait expired for a scenario marker')
}

async function testStaleTemplatePage(run, scenario, profile) {
  const formal = writeProbeScript(profile, scenario, 'legacy-formal-sentinel', { output: 'LEGACY_FORMAL_SENTINEL' })
  const dry = writeProbeScript(profile, scenario, 'legacy-dry-check', { output: 'LEGACY_DRY_CHECK' })
  const id = 'same-template-command-id'
  const params = [{ key: 'probe', label: '旧参数', default: 'old-value' }]
  const legacy = {
    id,
    title: '同 ID 模板旧参数页',
    type: 'template',
    text: 'legacy {{probe}}',
    params
  }
  await saveConfigAndOpen(run.page, shelfJson([legacy]), legacy.title)
  await run.page.getByLabel('旧参数', { exact: true }).waitFor()
  scenario.oldPageBeforeMutation = {
    headingVisible: await run.page.getByRole('heading', { name: legacy.title, exact: true }).isVisible(),
    directButton: await run.page.locator('.page.tools .actions button.primary').innerText()
  }
  const changed = commandAction(profile, id, legacy.title, formal, dry, { params })
  const changedJson = shelfJson([changed])
  const saveResult = await run.page.evaluate(json => window.arckeep.setToolShelf(json), changedJson)
  assert.equal(saveResult.ok, true, 'same-ID run-command configuration must be accepted')
  await run.page.getByRole('button', { name: '复制', exact: true }).click()
  const alert = run.page.locator('.page.tools .alert.error[role="alert"]')
  await alert.waitFor({ timeout: 10000 })
  await sleep(250)
  scenario.mainRejection = await alert.innerText()
  scenario.legacyFormalStarted = readJson(formal.started)
  scenario.legacyFormalCompleted = readJson(formal.completed)
  assert.equal(scenario.oldPageBeforeMutation.directButton.trim(), '复制')
  assert.equal(scenario.legacyFormalStarted, null, 'stale template page must not start the command sentinel')
  assert.equal(scenario.legacyFormalCompleted, null)
  scenario.finding = 'STALE_TEMPLATE_PAGE_REJECTED_AFTER_SAME_ID_TYPE_CHANGE'
}

async function testConfigurationDrift(run, scenario, profile) {
  const formal = writeProbeScript(profile, scenario, 'config-formal-sentinel', { output: 'CONFIG_FORMAL_SENTINEL' })
  const dry = writeProbeScript(profile, scenario, 'config-dry-check', { output: 'CONFIG_DRY_CHECK' })
  const original = commandAction(profile, 'config-drift-check', '配置变更确认检查', formal, dry)
  await saveConfigAndOpen(run.page, shelfJson([original]), original.title)
  await previewFromCurrentPage(run.page)
  const altCwd = path.join(profile, 'alternate-cwd')
  fs.mkdirSync(altCwd, { recursive: true })
  const mutated = {
    ...original,
    shell: 'cmd',
    cwd: altCwd,
    command: 'echo CONFIG_MUTATION_SENTINEL',
    previewCommand: 'echo CONFIG_MUTATION_DRY'
  }
  const saveResult = await run.page.evaluate(json => window.arckeep.setToolShelf(json), shelfJson([mutated]))
  scenario.mutatedFields = ['shell', 'cwd', 'command', 'previewCommand']
  assert.equal(saveResult.ok, true)
  await run.page.getByRole('button', { name: '执行验证命令', exact: true }).click()
  const alert = run.page.locator('.page.tools .alert.error[role="alert"]')
  await alert.waitFor({ timeout: 10000 })
  await sleep(250)
  scenario.mainRejection = await alert.innerText()
  scenario.formalStarted = readJson(formal.started)
  scenario.formalCompleted = readJson(formal.completed)
  assert.equal(scenario.formalStarted, null, 'configuration drift must reject confirmation before the original sentinel runs')
  assert.equal(scenario.formalCompleted, null)
  scenario.finding = 'MAIN_REJECTED_CONFIRMATION_AFTER_TOOL_CONFIGURATION_DRIFT'
}

async function testParameterDrift(run, scenario, profile) {
  const formal = writeProbeScript(profile, scenario, 'parameter-formal-sentinel', { output: 'PARAMETER_FORMAL_SENTINEL' })
  const dry = writeProbeScript(profile, scenario, 'parameter-dry-check', { output: 'PARAMETER_DRY_CHECK' })
  const action = commandAction(profile, 'parameter-drift-check', '参数变更确认检查', formal, dry, {
    params: [{ key: 'probe', label: '探针参数', default: 'before-preview' }]
  })
  await saveConfigAndOpen(run.page, shelfJson([action]), action.title)
  await previewFromCurrentPage(run.page, { parameterLabel: '探针参数', parameterValue: 'before-preview' })
  const rejection = await run.page.evaluate(async actionId => {
    const preview = await window.arckeep.previewTool(actionId, { probe: 'before-preview' }, crypto.randomUUID())
    if (!preview.ok) return { previewOk: false, runOk: null, error: preview.error }
    const result = await window.arckeep.runTool(actionId, { probe: 'after-preview-change' }, preview.data.confirmationId)
    return { previewOk: true, runOk: result.ok, error: result.ok ? null : result.error }
  }, action.id)
  scenario.directMainProcessAttempt = {
    previewIssued: rejection.previewOk,
    mutatedParameterRejected: rejection.runOk === false,
    error: rejection.error
  }
  assert.equal(rejection.previewOk, true)
  assert.equal(rejection.runOk, false, 'main process must reject parameters different from the issued preview')
  await run.page.getByRole('button', { name: '取消', exact: true }).click()
  await sleep(250)
  scenario.formalStarted = readJson(formal.started)
  scenario.formalCompleted = readJson(formal.completed)
  assert.equal(scenario.formalStarted, null)
  assert.equal(scenario.formalCompleted, null)
  scenario.finding = 'MAIN_REJECTED_CONFIRMATION_AFTER_PARAMETER_DRIFT'
}

async function testBackgroundSettingsPreservation(run, scenario, profile) {
  const formal = writeProbeScript(profile, scenario, 'long-formal', {
    sleepMs: 8500,
    output: 'LONG_COMMAND_OUTPUT_BEFORE_SETTINGS'
  })
  const dry = writeProbeScript(profile, scenario, 'long-dry', { output: 'LONG_DRY_CHECK' })
  const action = commandAction(profile, 'background-settings-check', '后台输出设置保留检查', formal, dry)
  await saveConfigAndOpen(run.page, shelfJson([action]), action.title)
  await previewFromCurrentPage(run.page)
  const eventStart = (await eventList(run.page)).length
  await run.page.getByRole('button', { name: '执行验证命令', exact: true }).click()
  const started = await waitForMarker(formal.started)
  scenario.formalStarted = { pid: started.pid, at: started.at }
  scenario.abortVisibleWhileRunning = await run.page.getByRole('button', { name: '中止', exact: true }).isVisible()
  assert.equal(scenario.abortVisibleWhileRunning, true)
  await navigate(run.page, 'settings')
  await run.page.locator('#github-pat').fill(testOnlyUnsavedPat)
  await run.page.locator('#watched-repo').fill('example/unsaved-field')
  const events = await waitForDone(run.page, eventStart, 15000)
  const done = events.slice(eventStart).findLast(event => event.type === 'done')
  assert.ok(done)
  scenario.completedWhileSettingsActive = await run.page.evaluate(() => document.querySelector('[data-view="settings"]')?.classList.contains('active') ?? false)
  const fieldState = await run.page.evaluate(expected => ({
    patPreserved: document.querySelector('#github-pat')?.value === expected,
    watchedRepoPreserved: document.querySelector('#watched-repo')?.value === 'example/unsaved-field'
  }), testOnlyUnsavedPat)
  scenario.unsavedInputPreservation = fieldState
  assert.equal(scenario.completedWhileSettingsActive, true)
  assert.equal(fieldState.patPreserved, true)
  assert.equal(fieldState.watchedRepoPreserved, true)
  assert.equal(done.exitCode, 0)
  await navigate(run.page, 'tools')
  await run.page.waitForFunction(() => {
    const status = document.querySelector('.page.tools .run-status')?.textContent?.trim()
    const output = [...document.querySelectorAll('.page.tools pre.tool-live')].map(node => node.textContent ?? '').join('')
    return status === '完成' && output.includes('LONG_COMMAND_OUTPUT_BEFORE_SETTINGS') && output.includes('LONG_COMMAND_OUTPUT_BEFORE_SETTINGS_DONE')
  }, null, { timeout: 10000 })
  const display = await run.page.evaluate(() => ({
    status: document.querySelector('.page.tools .run-status')?.textContent?.trim() ?? null,
    output: [...document.querySelectorAll('.page.tools pre.tool-live')].map(node => node.textContent ?? '').join(''),
    closeVisible: [...document.querySelectorAll('.page.tools button')].some(button => button.textContent?.trim() === '关闭'),
    stopVisible: [...document.querySelectorAll('.page.tools button')].some(button => button.textContent?.trim() === '中止')
  }))
  const firstOutput = events.slice(eventStart).find(event => event.type === 'output')
  scenario.returnedRun = {
    status: display.status,
    outputContainsStartAndEnd: display.output.includes('LONG_COMMAND_OUTPUT_BEFORE_SETTINGS') && display.output.includes('LONG_COMMAND_OUTPUT_BEFORE_SETTINGS_DONE'),
    closeVisible: display.closeVisible,
    stopVisibleAfterDone: display.stopVisible,
    sameRunIdForOutputAndDone: Boolean(firstOutput && firstOutput.runId === done.runId),
    runId: done.runId
  }
  assert.equal(display.status, '完成')
  assert.equal(scenario.returnedRun.outputContainsStartAndEnd, true)
  assert.equal(display.closeVisible, true)
  assert.equal(display.stopVisible, false)
  assert.equal(scenario.returnedRun.sameRunIdForOutputAndDone, true)
  scenario.finding = 'BACKGROUND_OUTPUT_AND_DONE_PRESERVED_UNSAVED_SETTINGS_AND_RETURNED_RUN_STATE'
}

async function testTerminalEvents(run, scenario, profile, customCmd) {
  const fast = writeProbeScript(profile, scenario, 'fast-formal', { output: 'FAST_COMPLETION_SENTINEL' })
  const dryFast = writeProbeScript(profile, scenario, 'fast-dry', { output: 'FAST_DRY_CHECK' })
  const fastAction = commandAction(profile, 'fast-event-check', '快速完成事件检查', fast, dryFast)
  await saveConfigAndOpen(run.page, shelfJson([fastAction]), fastAction.title)
  await previewFromCurrentPage(run.page)
  const fastStart = (await eventList(run.page)).length
  await run.page.getByRole('button', { name: '执行验证命令', exact: true }).click()
  const fastEvents = await waitForDone(run.page, fastStart, 12000)
  const fastDone = fastEvents.slice(fastStart).findLast(event => event.type === 'done')
  await run.page.waitForFunction(() => document.querySelector('.page.tools .run-status')?.textContent?.trim() === '完成'
    && [...document.querySelectorAll('.page.tools pre.tool-live')].some(node => node.textContent?.includes('FAST_COMPLETION_SENTINEL')), null, { timeout: 12000 })
  scenario.fastCompletion = {
    doneObserved: Boolean(fastDone),
    exitCode: fastDone?.exitCode ?? null,
    aborted: fastDone?.aborted ?? null,
    outputEventObserved: fastEvents.slice(fastStart).some(event => event.type === 'output' && event.text?.includes('FAST_COMPLETION_SENTINEL')),
    uiOutputAndDoneVisible: true,
    runId: fastDone?.runId ?? null
  }
  assert.equal(fastDone?.exitCode, 0)
  assert.equal(fastDone?.aborted, false)
  assert.equal(scenario.fastCompletion.outputEventObserved, true)
  await run.page.getByRole('button', { name: '关闭', exact: true }).click()
  await run.page.locator('.tool-card').waitFor()

  assert.ok(customCmd?.target)
  const customArchive = customCmd.target + '.archived'
  const failDry = 'echo STARTUP_FAILURE_DRY_OK'
  const failFormal = 'echo STARTUP_FAILURE_FORMAL_SENTINEL'
  const failAction = {
    id: 'startup-failure-check',
    title: '命令启动失败终态检查',
    type: 'run-command',
    shell: 'cmd',
    cwd: profile,
    command: failFormal,
    previewCommand: failDry,
    confirmLabel: '执行验证命令'
  }
  await saveConfigAndOpen(run.page, shelfJson([failAction]), failAction.title)
  await previewFromCurrentPage(run.page)
  assert.equal(fs.existsSync(customCmd.target), true, 'the isolated cmd copy must still exist during preview')
  fs.renameSync(customCmd.target, customArchive)
  scenario.customShellAfterPreview = {
    originalCopyAbsent: !fs.existsSync(customCmd.target),
    archivedCopyPresent: fs.existsSync(customArchive),
    archivedCopySha256: hashFile(customArchive)
  }
  const failureStart = (await eventList(run.page)).length
  await run.page.getByRole('button', { name: '执行验证命令', exact: true }).click()
  const failureEvents = await waitForDone(run.page, failureStart, 12000)
  const failureDone = failureEvents.slice(failureStart).findLast(event => event.type === 'done')
  await run.page.waitForFunction(() => document.querySelector('.page.tools .run-status')?.textContent?.startsWith('失败'), null, { timeout: 10000 })
  const failureUi = await run.page.evaluate(() => ({
    status: document.querySelector('.page.tools .run-status')?.textContent?.trim() ?? null,
    alert: document.querySelector('.page.tools .alert.error[role="alert"]')?.textContent?.trim() ?? null,
    output: [...document.querySelectorAll('.page.tools pre.tool-live')].map(node => node.textContent ?? '').join('')
  }))
  scenario.startupFailure = {
    doneObserved: Boolean(failureDone),
    exitCode: failureDone?.exitCode ?? null,
    aborted: failureDone?.aborted ?? null,
    error: failureDone?.error ?? null,
    errorIdentifiesMissingExecutable: /ENOENT/i.test(failureDone?.error ?? ''),
    uiStatus: failureUi.status,
    uiAlertPresent: Boolean(failureUi.alert),
    formalSentinelNotObserved: !failureUi.output.includes('STARTUP_FAILURE_FORMAL_SENTINEL'),
    runId: failureDone?.runId ?? null
  }
  assert.ok(failureDone)
  assert.equal(failureDone.exitCode, null)
  assert.equal(failureDone.aborted, false)
  assert.equal(scenario.startupFailure.errorIdentifiesMissingExecutable, true)
  assert.equal(scenario.startupFailure.uiAlertPresent, true)
  assert.equal(scenario.startupFailure.formalSentinelNotObserved, true)
  scenario.finding = 'FAST_DONE_AND_SPAWN_ERROR_TERMINAL_EVENTS_REACHED_UI'
}

function rehearsalFinding(afterDeadline) {
  const completed = afterDeadline.completed
  if (completed && afterDeadline.process.kind === 'absent') return 'COMPLETED_MARKER_AND_PROCESS_ABSENT_AT_DEADLINE_OBSERVATION'
  if (!completed && afterDeadline.process.kind === 'absent') return 'PROCESS_ABSENT_AT_DEADLINE_OBSERVATION_WITHOUT_COMPLETED_MARKER'
  if (completed && afterDeadline.process.kind === 'alive') return 'COMPLETED_MARKER_PRESENT_WHILE_RECORDED_PROCESS_ALIVE'
  if (!completed && afterDeadline.process.kind === 'alive') return 'PROCESS_STILL_ALIVE_WITHOUT_COMPLETED_MARKER_AT_DEADLINE_OBSERVATION'
  return 'QUERY_OR_IDENTITY_STATE_REQUIRES_REVIEW'
}

async function testLeaveDuringRehearsal(run, scenario, profile) {
  const formal = writeProbeScript(profile, scenario, 'leave-formal-sentinel', { output: 'LEAVE_FORMAL_SENTINEL' })
  const dry = writeProbeScript(profile, scenario, 'leave-rehearsal', { sleepMs: 20000, output: 'LEAVE_REHEARSAL_STARTED' })
  const action = commandAction(profile, 'leave-rehearsal-check', '预演离页观察', formal, dry, {
    params: [{ key: 'probe', label: '预演参数', default: 'safe' }]
  })
  await saveConfigAndOpen(run.page, shelfJson([action]), action.title)
  await previewFromCurrentPage(run.page, { parameterLabel: '预演参数', parameterValue: 'safe', waitForConfirmation: false })
  const marker = await waitForMarker(dry.started)
  const identity = recordProcessIdentity(scenario, marker.pid, dry.script, scenario.wrapperPath, run.runtime.mainPid)
  scenario.beforeLeave = {
    started: { pid: marker.pid, at: marker.at },
    completed: readJson(dry.completed),
    process: identity.initial,
    mainPid: run.runtime.mainPid,
    mainParentChain: identity.initialParentChain,
    visibleRehearsingButton: await run.page.getByRole('button', { name: '正在预演', exact: true }).isVisible()
  }
  assert.equal(scenario.beforeLeave.completed, null)
  assert.equal(scenario.beforeLeave.process.kind, 'alive')
  assert.equal(scenario.beforeLeave.visibleRehearsingButton, true)
  scenario.leaveRequestedAt = new Date().toISOString()
  scenario.startedToLeaveMs = Date.parse(scenario.leaveRequestedAt) - Date.parse(marker.at)
  assert.ok(scenario.startedToLeaveMs < 15000, 'leaving the page must be observed before the rehearsal deadline')
  await navigate(run.page, 'settings')
  scenario.immediatelyAfterLeave = {
    at: new Date().toISOString(),
    completed: readJson(dry.completed),
    process: observeIdentity(identity, scenario.wrapperPath),
    parentChain: processChain(identity.pid, scenario.wrapperPath)
  }
  const deadline = Date.parse(marker.at) + dry.sleepMs + 700
  await sleep(Math.max(0, deadline - Date.now()))
  const process = observeIdentity(identity, scenario.wrapperPath)
  scenario.afterNaturalDeadline = {
    at: new Date().toISOString(),
    process,
    completed: readJson(dry.completed),
    formalStarted: readJson(formal.started),
    parentChain: process.kind === 'alive' ? processChain(identity.pid, scenario.wrapperPath) : []
  }
  scenario.finding = rehearsalFinding(scenario.afterNaturalDeadline)
  assert.notEqual(scenario.afterNaturalDeadline.process.kind, 'query-error')
  assert.notEqual(scenario.afterNaturalDeadline.process.kind, 'pid-reused-or-identity-mismatch')
  assert.equal(scenario.afterNaturalDeadline.formalStarted, null)
}

async function testQuitDuringRehearsal(run, scenario, profile) {
  const formal = writeProbeScript(profile, scenario, 'quit-formal-sentinel', { output: 'QUIT_FORMAL_SENTINEL' })
  const dry = writeProbeScript(profile, scenario, 'quit-rehearsal', { sleepMs: 20000, output: 'QUIT_REHEARSAL_STARTED' })
  const action = commandAction(profile, 'quit-rehearsal-check', '预演退出观察', formal, dry, {
    params: [{ key: 'probe', label: '预演参数', default: 'safe' }]
  })
  await saveConfigAndOpen(run.page, shelfJson([action]), action.title)
  await previewFromCurrentPage(run.page, { parameterLabel: '预演参数', parameterValue: 'safe', waitForConfirmation: false })
  const marker = await waitForMarker(dry.started)
  const identity = recordProcessIdentity(scenario, marker.pid, dry.script, scenario.wrapperPath, run.runtime.mainPid)
  scenario.immediatelyBeforeQuit = {
    at: new Date().toISOString(),
    completed: readJson(dry.completed),
    process: identity.initial,
    parentChain: identity.initialParentChain,
    visibleRehearsingButton: await run.page.getByRole('button', { name: '正在预演', exact: true }).isVisible()
  }
  assert.equal(scenario.immediatelyBeforeQuit.completed, null)
  assert.equal(scenario.immediatelyBeforeQuit.process.kind, 'alive')
  assert.equal(scenario.immediatelyBeforeQuit.visibleRehearsingButton, true)
  scenario.startedToQuitMs = Date.now() - Date.parse(marker.at)
  assert.ok(scenario.startedToQuitMs < 15000, 'quit observation must begin before the rehearsal deadline')
  await requestQuit(run, scenario)
  scenario.afterAppExit = {
    at: new Date().toISOString(),
    process: observeIdentity(identity, scenario.wrapperPath),
    completed: readJson(dry.completed),
    parentChain: processChain(identity.pid, scenario.wrapperPath)
  }
  const deadline = Date.parse(marker.at) + dry.sleepMs + 700
  await sleep(Math.max(0, deadline - Date.now()))
  const process = observeIdentity(identity, scenario.wrapperPath)
  scenario.afterNaturalDeadline = {
    at: new Date().toISOString(),
    process,
    completed: readJson(dry.completed),
    formalStarted: readJson(formal.started),
    mainProcess: processQuery(run.runtime.mainPid).kind,
    parentChain: process.kind === 'alive' ? processChain(identity.pid, scenario.wrapperPath) : []
  }
  scenario.finding = rehearsalFinding(scenario.afterNaturalDeadline)
  assert.equal(scenario.afterNaturalDeadline.mainProcess, 'absent')
  assert.notEqual(scenario.afterNaturalDeadline.process.kind, 'query-error')
  assert.notEqual(scenario.afterNaturalDeadline.process.kind, 'pid-reused-or-identity-mismatch')
  assert.equal(scenario.afterNaturalDeadline.formalStarted, null)
}

async function testQuitDuringFormalLongCommand(run, scenario, profile) {
  const { formal, child } = writeFormalProbeWithChild(profile, scenario)
  const dry = writeProbeScript(profile, scenario, 'formal-quit-dry-check', { output: 'FORMAL_QUIT_DRY_CHECK' })
  const action = commandAction(profile, 'formal-quit-live-process-check', '正式长命令退出进程检查', formal, dry)
  await saveConfigAndOpen(run.page, shelfJson([action]), action.title)
  await previewFromCurrentPage(run.page)
  await run.page.getByRole('button', { name: '执行验证命令', exact: true }).click()

  const commandStarted = await waitForMarker(formal.started)
  const childStarted = await waitForMarker(child.started)
  assert.equal(commandStarted.childPid, childStarted.pid, 'formal command must report the started child PID')
  const commandIdentity = recordProcessIdentity(scenario, commandStarted.pid, formal.script, scenario.wrapperPath, run.runtime.mainPid)
  const childIdentity = recordProcessIdentity(scenario, childStarted.pid, child.script, scenario.wrapperPath, run.runtime.mainPid, commandStarted.pid)
  const mainBeforeQuit = processQuery(run.runtime.mainPid)
  scenario.startedToQuitMs = Date.now() - Date.parse(commandStarted.at)
  scenario.liveIdentitiesBeforeQuit = {
    observedAt: new Date().toISOString(),
    startedToQuitMs: scenario.startedToQuitMs,
    main: safeProcess(mainBeforeQuit, scenario.wrapperPath),
    command: commandIdentity.initial,
    child: childIdentity.initial,
    commandParentChain: commandIdentity.initialParentChain,
    childParentChain: childIdentity.initialParentChain,
    formalCompleted: readJson(formal.completed),
    childCompleted: readJson(child.completed)
  }
  assert.ok(scenario.startedToQuitMs < 45000, 'app quit must begin while the long formal command is still running')
  assert.equal(mainBeforeQuit.kind, 'alive')
  assert.equal(mainBeforeQuit.created, scenario.mainAtLaunch.created)
  assert.equal(commandIdentity.initial.kind, 'alive')
  assert.equal(commandIdentity.initial.parentPid, run.runtime.mainPid)
  assert.equal(childIdentity.initial.kind, 'alive')
  assert.equal(childIdentity.initial.parentPid, commandStarted.pid)
  assert.equal(scenario.liveIdentitiesBeforeQuit.formalCompleted, null)
  assert.equal(scenario.liveIdentitiesBeforeQuit.childCompleted, null)

  await requestQuit(run, scenario)
  scenario.afterAppExitBeforeCleanup = {
    observedAt: new Date().toISOString(),
    main: safeProcess(processQuery(run.runtime.mainPid), scenario.wrapperPath),
    command: observeIdentity(commandIdentity, scenario.wrapperPath),
    child: observeIdentity(childIdentity, scenario.wrapperPath),
    formalCompleted: readJson(formal.completed),
    childCompleted: readJson(child.completed)
  }
  assert.equal(scenario.afterAppExitBeforeCleanup.main.kind, 'absent')
  assert.equal(scenario.afterAppExitBeforeCleanup.command.kind, 'absent', 'formal command PID must be absent before cleanup')
  assert.equal(scenario.afterAppExitBeforeCleanup.child.kind, 'absent', 'formal command child PID must be absent before cleanup')
  assert.equal(scenario.afterAppExitBeforeCleanup.formalCompleted, null, 'formal completion sentinel must remain absent before cleanup')
  assert.equal(scenario.afterAppExitBeforeCleanup.childCompleted, null, 'child completion sentinel must remain absent before cleanup')
  scenario.finding = 'FORMAL_LONG_COMMAND_AND_CHILD_ABSENT_AFTER_APP_QUIT_WITHOUT_COMPLETION_SENTINELS'
}

async function main() {
  const deliveryRoot = path.resolve(getOption('--delivery-root', defaultDeliveryRoot))
  const selectionFlags = ['--rehearsals-only', '--formal-quit-only', '--probe-first-only'].filter(hasFlag)
  if (selectionFlags.length > 1) throw new Error('scenario selection flags cannot be combined')
  const rehearsalsOnly = hasFlag('--rehearsals-only')
  const formalQuitOnly = hasFlag('--formal-quit-only')
  if (hasFlag('--prepare-only')) {
    const snapshot = preparation(deliveryRoot)
    if (!snapshot.dependencies.playwrightCoreExists) throw new Error('old readiness Playwright Core dependency is missing')
    fs.writeFileSync(preparedPath, JSON.stringify(snapshot, null, 2), 'utf8')
    process.stdout.write(JSON.stringify({ state: snapshot.state, preparedPath, deliveryHead: snapshot.delivery.sourceHead, compiledManifestSha256: snapshot.delivery.compiledManifestSha256, electronLaunches: 0 }, null, 2) + '\n')
    return
  }
  if (!hasFlag('--serial-window-authorized')) {
    throw new Error('refusing to launch Electron: wait for owner-assigned serial GUI window and pass --serial-window-authorized')
  }
  if (process.platform !== 'win32') throw new Error('real Electron GUI run requires Windows')
  if (!fs.existsSync(preparedPath)) throw new Error('prepared.json is missing; run --prepare-only after the final build is ready')
  const prepared = JSON.parse(fs.readFileSync(preparedPath, 'utf8'))
  const live = preparation(deliveryRoot)
  assert.equal(live.delivery.sourceHead, prepared.delivery.sourceHead, 'delivery source HEAD changed after preparation')
  assert.equal(live.delivery.compiledManifestSha256, prepared.delivery.compiledManifestSha256, 'compiled outputs changed after preparation')
  assert.equal(live.delivery.electronExecutableSha256, prepared.delivery.electronExecutableSha256, 'Electron executable changed after preparation')
  if (!live.dependencies.playwrightCoreExists) throw new Error('old readiness Playwright Core dependency is missing')
  const playwright = await import(pathToFileURL(playwrightModulePath).href)
  electronApi = playwright._electron
  const electronPath = path.join(deliveryRoot, 'node_modules/electron/dist/electron.exe')
  const packageJson = JSON.parse(fs.readFileSync(path.join(deliveryRoot, 'package.json'), 'utf8'))
  results = {
    startedAt: new Date().toISOString(),
    source: live.delivery,
    preparedSnapshot: {
      sourceHead: prepared.delivery.sourceHead,
      compiledManifestSha256: prepared.delivery.compiledManifestSha256,
      buildProvenance: live.delivery.buildProvenance
    },
    buildCorrespondence: 'NOT_AUTOMATICALLY_VERIFIED; actual Electron runtime version, source HEAD, and compiled-output hashes are independent observations',
    entryMode: 'ROOT_WRAPPER_IMPORTS_DELIVERY_OUT_MAIN_INDEX',
    packageElectronVersion: packageJson.devDependencies?.electron ?? null,
    scope: 'Real Electron GUI through compiled delivery output with isolated userData/APPDATA/GH_CONFIG_DIR. Not packaged-entry, OS tray, business acceptance, Phase Accept, or Release acceptance.',
    scenarios: [],
    verdict: 'INCOMPLETE'
  }
  saveResults()
  log('prepared source HEAD and compiled artifact hashes match; beginning authorized serial GUI run')

  if (!rehearsalsOnly && !formalQuitOnly) {
    await runScenario('template-stale-params-page-same-id-command', testStaleTemplatePage, { deliveryRoot })
    if (hasFlag('--probe-first-only')) {
      results.finishedAt = new Date().toISOString()
      results.verdict = results.scenarios.length === 1 && results.scenarios[0].verdict === 'OBSERVED_WITH_RECORDED_SCOPE' && !process.exitCode
        ? 'PROBE_ONLY_COMPLETE'
        : 'PROBE_ONLY_FAILED'
      saveResults()
      log('probe-only-verdict=' + results.verdict)
      log('results=' + resultsPath)
      if (results.verdict !== 'PROBE_ONLY_COMPLETE') process.exitCode = 1
      return
    }
    await runScenario('configuration-drift-rejects-confirmation', testConfigurationDrift, { deliveryRoot })
    await runScenario('parameter-drift-rejects-confirmation', testParameterDrift, { deliveryRoot })
    await runScenario('background-output-preserves-unsaved-settings-inputs', testBackgroundSettingsPreservation, { deliveryRoot })
    await runScenario('fast-completion-and-startup-failure-terminal-events', testTerminalEvents, { deliveryRoot, customCmd: true })
  }
  if (formalQuitOnly) {
    await runScenario('formal-long-command-app-quit-live-processes', testQuitDuringFormalLongCommand, { deliveryRoot })
  } else {
    await runScenario('leave-page-during-rehearsal-observation', testLeaveDuringRehearsal, { deliveryRoot })
    await runScenario('quit-during-rehearsal-observation', testQuitDuringRehearsal, { deliveryRoot })
  }

  results.finishedAt = new Date().toISOString()
  const expectedScenarioCount = formalQuitOnly ? 1 : rehearsalsOnly ? 2 : 7
  results.scenarioSelection = formalQuitOnly ? 'FORMAL_LONG_COMMAND_QUIT_ONLY' : rehearsalsOnly ? 'TWO_REHEARSAL_SCENARIOS_ONLY' : 'ALL_SEVEN_SCENARIOS'
  results.verdict = results.scenarios.length === expectedScenarioCount && results.scenarios.every(item => item.verdict === 'OBSERVED_WITH_RECORDED_SCOPE') && !process.exitCode
    ? (rehearsalsOnly || formalQuitOnly) ? 'SELECTED_SCENARIOS_COMPLETE_WITH_RECORDED_SCOPE' : 'COMPLETE_WITH_RECORDED_SCOPE'
    : 'INCOMPLETE_OR_FAILED'
  saveResults()
  log('verdict=' + results.verdict)
  log('results=' + resultsPath)
  if (!['COMPLETE_WITH_RECORDED_SCOPE', 'SELECTED_SCENARIOS_COMPLETE_WITH_RECORDED_SCOPE'].includes(results.verdict)) process.exitCode = 1
}

main().catch(error => {
  const safe = String(error?.message ?? error).replaceAll(testOnlyUnsavedPat, '[REDACTED_TEST_INPUT]')
  process.stderr.write('RUNNER_ERROR: ' + safe + '\n')
  if (results) {
    results.runnerError = safe
    results.finishedAt = new Date().toISOString()
    results.verdict = 'INCOMPLETE_OR_FAILED'
    saveResults()
  }
  process.exitCode = 1
})
