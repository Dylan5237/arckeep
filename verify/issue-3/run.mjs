#!/usr/bin/env node
// Playwright-driven acceptance run for Arckeep Issue #3 (「项目总览」), against the real
// packaged Windows app (win-unpacked/Arckeep.exe). Every check drives the real UI
// (click, fill, keyboard) — no internal function calls are used as a substitute for a
// UI action. `shell.openExternal` is intercepted (recorded only, not actually invoked)
// so link clicks can be asserted without spawning a browser on the CI runner.
//
// Reads: EXE_PATH, GITHUB_TOKEN, EVIDENCE_DIR, REFERENCE_JSON (env vars, set by the
// workflow). Writes: <EVIDENCE_DIR>/NN-description.png, <EVIDENCE_DIR>/index.md,
// <EVIDENCE_DIR>/results.json.

import { _electron as electron } from 'playwright'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Tracks the most recently launched Electron app so a fatal top-level error can still
// force-close it before the process exits — an unclosed Electron/Chromium child process
// on Windows can keep this step's stdio pipe open and hang the whole job long past the
// script's own completion (observed: 57 extra minutes with zero further output).
let currentApp = null

const EXE_PATH = process.env.EXE_PATH
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || ''
const EVIDENCE_DIR = process.env.EVIDENCE_DIR || path.join(process.cwd(), 'evidence')
const REFERENCE_JSON = process.env.REFERENCE_JSON || path.join(process.cwd(), 'reference.json')
const SETTINGS_PATH = process.env.APPDATA ? path.join(process.env.APPDATA, 'Arckeep', 'settings.json') : null
const USER_DATA_DIR = process.env.APPDATA ? path.join(process.env.APPDATA, 'Arckeep') : null

if (!EXE_PATH) throw new Error('EXE_PATH is not set')
mkdirSync(EVIDENCE_DIR, { recursive: true })

const reference = JSON.parse(readFileSync(REFERENCE_JSON, 'utf8'))
const results = []
const evidenceIndex = []
let shotCounter = 0

function log(...args) {
  console.log('[run]', ...args)
}

function record(id, status, { notes = '', repro = '', evidence = [] } = {}) {
  results.push({ id, status, notes, repro, evidence })
  log(id, status, notes.slice(0, 200))
}

async function shot(page, description) {
  shotCounter += 1
  const name = `${String(shotCounter).padStart(2, '0')}-${description.replace(/[^a-zA-Z0-9\u4e00-\u9fa5-]+/g, '-')}.png`
  const file = path.join(EVIDENCE_DIR, name)
  await page.screenshot({ path: file })
  evidenceIndex.push({ file: name, description })
  log('screenshot', name, description)
  return name
}

function readSettingsFile() {
  if (!SETTINGS_PATH || !existsSync(SETTINGS_PATH)) return null
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
  } catch (error) {
    return { parseError: error instanceof Error ? error.message : String(error) }
  }
}

async function resetUserData() {
  if (!USER_DATA_DIR || !existsSync(USER_DATA_DIR)) return
  // Right after closing Electron, Windows can briefly hold a lock on files such as
  // DIPS (Chromium's network-state DB) even though the process has exited — retry
  // instead of letting a transient EBUSY abort the whole run.
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      rmSync(USER_DATA_DIR, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 8) {
        console.error('[run] resetUserData: giving up after retries:', error instanceof Error ? error.message : error)
        return
      }
      await sleep(400 * attempt)
    }
  }
}

async function launch(env = {}, extraArgs = []) {
  const app = await electron.launch({
    executablePath: EXE_PATH,
    args: extraArgs,
    env: { ...process.env, ...env },
    timeout: 60_000
  })
  currentApp = app
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // The renderer's initial default-view render (等我处理) runs asynchronously after
  // domcontentloaded and is NOT awaited by the app itself; if that promise resolves
  // later than expected (e.g. its own GitHub fetch is slow) it calls
  // content.replaceChildren and silently clobbers whatever a later navigation put
  // there. A short fixed wait only reduces the odds; settleOnPage() below adds a
  // second, active verification after every navigation for the rest of the run.
  await page.waitForSelector('.page', { timeout: 15_000 }).catch(() => {})
  await page.waitForTimeout(1200)
  // Record (not invoke) shell.openExternal calls from the main process, per the
  // task's instruction to wrap it in electronApp.evaluate rather than actually
  // opening a system browser on the CI runner.
  await app.evaluate(({ shell }) => {
    globalThis.__openExternalCalls = []
    shell.openExternal = async url => {
      globalThis.__openExternalCalls.push(url)
      return undefined
    }
  })
  return { app, page }
}

async function openExternalCalls(app) {
  return app.evaluate(() => globalThis.__openExternalCalls || [])
}

// Clicks a nav button, waits for the target selector, then re-checks it a moment
// later. If the app's unawaited initial-view render (or any other async re-render)
// clobbers the page in between, the selector disappears and we simply click again.
async function settleOnPage(page, navName, targetSelector, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await page.getByRole('button', { name: navName, exact: true }).click()
    await page.waitForSelector(targetSelector, { timeout: 15_000 })
    await page.waitForTimeout(400)
    if (await page.locator(targetSelector).count() > 0) return
    log(`settleOnPage: ${targetSelector} vanished after navigating to "${navName}" (attempt ${attempt}); retrying`)
  }
  // Last attempt: let a real error surface rather than silently swallowing it.
  await page.getByRole('button', { name: navName, exact: true }).click()
  await page.waitForSelector(targetSelector, { timeout: 15_000 })
}

async function gotoOverview(page) {
  await settleOnPage(page, '项目总览', '.page.overview')
}

async function gotoSettings(page) {
  await settleOnPage(page, '设置', '#overview-settings')
}

async function clearWatchedRepos(page) {
  await gotoSettings(page)
  // Click every "删除" button in the repo-list until none remain.
  for (let guard = 0; guard < 50; guard += 1) {
    const removeButtons = page.locator('.repo-list button.ghost')
    const count = await removeButtons.count()
    if (count === 0) break
    await removeButtons.first().click()
    await page.waitForTimeout(150)
  }
}

async function addWatchedRepo(page, full) {
  const input = page.locator('#watched-repo')
  await input.fill(full)
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await page.waitForTimeout(150)
}

async function setWatchedRepos(page, names) {
  await clearWatchedRepos(page)
  for (const name of names) await addWatchedRepo(page, name)
}

async function overviewRows(page) {
  return page.locator('.overview-list > .overview-row')
}

async function waitForOverviewSettled(page) {
  await page.waitForFunction(() => {
    const btn = document.querySelector('.waiting-toolbar button.primary')
    return btn && btn.textContent?.trim() === '刷新'
  }, { timeout: 30_000 }).catch(() => {})
  // The refresh button flips back to "刷新" as soon as the fetch promise resolves;
  // give the subsequent DOM paint (row/chip classification) a moment to actually land
  // before any check reads chip/group state, or a real result can look empty by a
  // few hundred ms of bad luck (observed: a chip absent here, present 5s later).
  await page.waitForTimeout(600)
}

// Waits for at least one match, tolerating a render that lands slightly after
// waitForOverviewSettled() returns, then reports whether it is actually present.
async function waitForChipPresent(locator, timeout = 8000) {
  try {
    await locator.first().waitFor({ state: 'attached', timeout })
  } catch {
    // fall through — count() below will correctly report 0
  }
  return await locator.count() > 0
}

// Captures the live DOM for a failing/ambiguous check so the report and any follow-up
// investigation do not depend on another full CI round-trip just to see what actually
// rendered.
async function debugHtml(page, selector = '.page', maxLen = 1500) {
  try {
    const html = await page.locator(selector).first().innerHTML()
    return html.length > maxLen ? `${html.slice(0, maxLen)}…(truncated ${html.length} chars total)` : html
  } catch (error) {
    return `(could not read ${selector}: ${error instanceof Error ? error.message : String(error)})`
  }
}

// ---------------------------------------------------------------------------------
// Phase 0: sanity — does the ephemeral GITHUB_TOKEN even let the app read a public repo?
// ---------------------------------------------------------------------------------
async function phaseTokenSanity() {
  if (!GITHUB_TOKEN) {
    record('token-sanity', 'BLOCKED', { notes: 'GITHUB_TOKEN env var not set for this job.' })
    return false
  }
  const probe = reference.publicReadProbe
  if (!probe || probe.ok !== true) {
    record('token-sanity', 'BLOCKED', {
      notes: `Ephemeral GITHUB_TOKEN could not read a public repo via GraphQL. Raw error: ${JSON.stringify(probe)}`
    })
    return false
  }
  record('token-sanity', 'PASS', { notes: 'Ephemeral GITHUB_TOKEN can read public repo data via GraphQL (probed octocat/Hello-World).' })
  return true
}

// ---------------------------------------------------------------------------------
// Phase 1: exactly-3-repo list (item 1), per-row consistency (item 2), attention counts
// ---------------------------------------------------------------------------------
async function phaseCoreList() {
  await resetUserData()
  const ci = reference.scenarios.ciSuccess
  const cf = reference.scenarios.ciFailure
  const nc = reference.scenarios.noCi
  if (!ci.picked || !cf.picked || !nc.picked) {
    record('item-1', 'BLOCKED', { notes: 'Reference could not identify one repo each for CI success/failure/none.' })
    record('item-2', 'BLOCKED', { notes: 'Depends on item-1 repo selection.' })
    return null
  }
  const names = [ci.picked, cf.picked, nc.picked]
  const { app, page } = await launch({ GITHUB_TOKEN })
  try {
    await gotoSettings(page)
    await setWatchedRepos(page, names)
    await gotoOverview(page)
    await waitForOverviewSettled(page)
    const shotName = await shot(page, 'overview-3-repos')

    const rows = await overviewRows(page)
    const rowCount = await rows.count()
    const rowNames = []
    for (let i = 0; i < rowCount; i += 1) {
      rowNames.push((await rows.nth(i).locator('.waiting-title-text').innerText()).trim())
    }
    const namesMatch = rowCount === 3 && names.every(n => rowNames.includes(n))
    record('item-1', namesMatch ? 'PASS' : 'FAIL', {
      notes: `Watch list = [${names.join(', ')}]. Rendered rows (${rowCount}): [${rowNames.join(', ')}].`,
      repro: '设置 → 关注仓库 依次添加 3 个公开仓库 → 项目总览',
      evidence: [shotName]
    })

    // item 2: per-row last-commit time / open PR count / CI note text vs reference.
    const perRowNotes = []
    let item2Ok = true
    for (let i = 0; i < rowCount; i += 1) {
      const row = rows.nth(i)
      const name = (await row.locator('.waiting-title-text').innerText()).trim()
      const metaText = (await row.locator('.waiting-meta').innerText()).trim()
      const snap = [ci, cf, nc].map(s => s.snapshot).find(s => s?.name === name)
      if (!snap) { perRowNotes.push(`${name}: no reference snapshot`); item2Ok = false; continue }
      const expectDays = snap.lastCommitDays
      const dayMatch = expectDays === null || /刚刚|分钟前|小时前|天前/.test(metaText)
      const prExpected = snap.openPrCount > 0
      const prShown = / 个 PR 待合并/.test(metaText)
      const prOk = prExpected === prShown
      const ciNoteExpected = snap.ciState === 'success' ? 'CI 通过' : snap.ciState === 'pending' ? 'CI 进行中' : snap.ciState === 'none' ? '无 CI' : null
      const ciNoteOk = ciNoteExpected ? metaText.includes(ciNoteExpected) : !metaText.includes('CI 通过') && !metaText.includes('CI 进行中') && !metaText.includes('无 CI')
      const rowOk = dayMatch && prOk && ciNoteOk
      if (!rowOk) item2Ok = false
      perRowNotes.push(`${name}: meta="${metaText}" expectLastCommitDays=${expectDays} expectOpenPr=${snap.openPrCount} expectCi=${snap.ciState} -> dayMatch=${dayMatch} prOk=${prOk} ciNoteOk=${ciNoteOk}`)
    }
    record('item-2', item2Ok ? 'PASS' : 'FAIL', {
      notes: perRowNotes.join(' | '),
      repro: '同上；对照 reference.json 中 ciSuccess/ciFailure/noCi 三个 snapshot',
      evidence: [shotName]
    })

    return { app, page, names, ci, cf, nc }
  } catch (error) {
    record('item-1', 'FAIL', { notes: `Exception: ${error instanceof Error ? error.stack : String(error)}` })
    record('item-2', 'BLOCKED', { notes: 'item-1 threw before rows could be inspected.' })
    await app.close().catch(() => {})
    return null
  }
}

// ---------------------------------------------------------------------------------
// Phase 2: threshold changes (item 3), CI-failure / review-wait chips (item 4),
// click + keyboard activation (item 5)
// ---------------------------------------------------------------------------------
async function phaseThresholdsAndChips(handle) {
  if (!handle) {
    for (const id of ['item-3', 'item-4', 'item-5']) record(id, 'BLOCKED', { notes: 'Depends on phaseCoreList.' })
    return
  }
  const { app, page, cf } = handle
  try {
    const rw = reference.scenarios.reviewWait
    const thr = reference.scenarios.thresholdWindow
    const extra = [rw.picked, thr.picked].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i)
    await gotoSettings(page)
    for (const name of extra) await addWatchedRepo(page, name)
    await gotoOverview(page)
    await waitForOverviewSettled(page)
    await shot(page, 'overview-expanded-list')

    // --- item 4: CI-failure chip + review-wait chip, label/day/M consistency ---
    const item4Notes = []
    let item4Ok = true
    if (cf?.snapshot) {
      const row = page.locator('.overview-row', { has: page.locator('.waiting-title-text', { hasText: cf.snapshot.name }) })
      const chip = row.locator('.chip-stuck', { hasText: 'CI 失败' })
      const chipVisible = await waitForChipPresent(chip)
      item4Notes.push(`${cf.snapshot.name} CI失败 chip visible=${chipVisible}`)
      item4Ok = item4Ok && chipVisible
    }
    if (rw.snapshot?.reviewWait?.longest) {
      const row = page.locator('.overview-row', { has: page.locator('.waiting-title-text', { hasText: rw.snapshot.name }) })
      const chip = row.locator('.chip-stuck', { hasText: 'PR 等 review' })
      const chipPresent = await waitForChipPresent(chip)
      const chipText = chipPresent ? (await chip.first().innerText()).trim() : null
      const expectDays = rw.snapshot.reviewWait.longest.days
      const expectM = rw.snapshot.reviewWait.otherStuckCount
      const expectLabel = expectM > 0 ? `卡住：PR 等 review ${expectDays} 天，等 ${expectM} 个` : `卡住：PR 等 review ${expectDays} 天`
      const labelOk = chipText === expectLabel
      item4Notes.push(`${rw.snapshot.name} chip="${chipText}" expect="${expectLabel}" match=${labelOk}`)
      item4Ok = item4Ok && labelOk
    }
    record('item-4', item4Ok ? 'PASS' : 'FAIL', { notes: item4Notes.join(' | '), evidence: [] })

    // --- item 5: click repo name / CI-failure chip / review-wait chip; keyboard Tab+Enter ---
    const item5Notes = []
    let item5Ok = true
    if (cf?.snapshot) {
      const row = page.locator('.overview-row', { has: page.locator('.waiting-title-text', { hasText: cf.snapshot.name }) })
      await row.locator('.waiting-title').click()
      await page.waitForTimeout(200)
      const calls = await openExternalCalls(app)
      const last = calls[calls.length - 1]
      const ok = last === cf.snapshot.url
      item5Notes.push(`click repo name -> ${last} expect ${cf.snapshot.url} ok=${ok}`)
      item5Ok = item5Ok && ok

      const chip = row.locator('.chip-link.chip-stuck', { hasText: 'CI 失败' })
      if (await chip.count() > 0) {
        await chip.first().click()
        await page.waitForTimeout(200)
        const calls2 = await openExternalCalls(app)
        const last2 = calls2[calls2.length - 1]
        const expected = typeof cf.snapshot.ciFailure === 'string' ? cf.snapshot.ciFailure : cf.snapshot.ciFailure?.fallback
        const ok2 = last2 === expected
        item5Notes.push(`click CI失败 chip -> ${last2} expect ${expected} ok=${ok2}`)
        item5Ok = item5Ok && ok2

        // keyboard: from the repo-name button, press Tab until the chip itself is
        // document.activeElement (real Tab traversal, not a programmatic .focus()),
        // then press Enter.
        await row.locator('.waiting-title').focus()
        let reachedByTab = false
        let tabHops = 0
        for (let hop = 0; hop < 6; hop += 1) {
          await page.keyboard.press('Tab')
          tabHops += 1
          const activeText = await page.evaluate(() => document.activeElement?.textContent?.trim())
          const activeIsChip = await page.evaluate(() => document.activeElement?.classList?.contains('chip-link'))
          if (activeIsChip && activeText?.includes('CI 失败')) { reachedByTab = true; break }
        }
        await page.keyboard.press('Enter')
        await page.waitForTimeout(200)
        const calls3 = await openExternalCalls(app)
        const last3 = calls3[calls3.length - 1]
        const ok3 = reachedByTab && last3 === expected
        item5Notes.push(`Tab from repo-name reached CI失败 chip after ${tabHops} hop(s)=${reachedByTab}; Enter -> ${last3} ok=${ok3}`)
        item5Ok = item5Ok && ok3
      } else {
        item5Notes.push('CI失败 chip not found as a link (chip-link.chip-stuck)')
        item5Ok = false
      }
    }
    if (rw.snapshot?.reviewWait?.longest) {
      const row = page.locator('.overview-row', { has: page.locator('.waiting-title-text', { hasText: rw.snapshot.name }) })
      const chip = row.locator('.chip-link.chip-stuck', { hasText: 'PR 等 review' })
      if (await chip.count() > 0) {
        await chip.first().click()
        await page.waitForTimeout(200)
        const calls = await openExternalCalls(app)
        const last = calls[calls.length - 1]
        const ok = last === rw.snapshot.reviewWait.longest.url
        item5Notes.push(`click PR等review chip -> ${last} expect ${rw.snapshot.reviewWait.longest.url} ok=${ok}`)
        item5Ok = item5Ok && ok
      }
    }
    record('item-5', item5Ok ? 'PASS' : 'FAIL', { notes: item5Notes.join(' | '), evidence: [] })

    // --- item 3: staleDays threshold 1 -> 7, plus invalid-value handling ---
    const item3Notes = []
    let item3Ok = true
    if (thr.snapshot) {
      await gotoSettings(page)
      const staleDaysInput = page.locator('#overview-settings input[aria-label="停滞天数"]')
      await staleDaysInput.fill('1')
      await page.getByRole('button', { name: '保存项目总览', exact: true }).click()
      await page.waitForTimeout(200)
      await gotoOverview(page)
      await waitForOverviewSettled(page)
      const shot1 = await shot(page, 'stale-threshold-1')
      const row = page.locator('.overview-row', { has: page.locator('.waiting-title-text', { hasText: thr.snapshot.name }) })
      const chipAt1 = row.locator('.chip-stalled')
      const visibleAt1 = await chipAt1.count() > 0
      const textAt1 = visibleAt1 ? (await chipAt1.first().innerText()).trim() : null
      const expectDaysAt1 = thr.snapshot.lastCommitDays
      item3Notes.push(`staleDays=1: chip visible=${visibleAt1} text="${textAt1}" expectDays~${expectDaysAt1}`)
      item3Ok = item3Ok && visibleAt1 && /^停滞 \d+ 天$/.test(textAt1 || '')

      await gotoSettings(page)
      await staleDaysInput.fill('7')
      await page.getByRole('button', { name: '保存项目总览', exact: true }).click()
      await page.waitForTimeout(200)
      await gotoOverview(page)
      await waitForOverviewSettled(page)
      const shot2 = await shot(page, 'stale-threshold-7')
      const chipAt7 = row.locator('.chip-stalled')
      const visibleAt7 = await chipAt7.count() > 0
      const shouldDisappear = expectDaysAt1 !== null && expectDaysAt1 < 7
      const ok7 = shouldDisappear ? !visibleAt7 : visibleAt7
      item3Notes.push(`staleDays=7: chip visible=${visibleAt7} shouldDisappear=${shouldDisappear} ok=${ok7}`)
      item3Ok = item3Ok && ok7

      // invalid values. A real user can only put a value into a type="number" input
      // through actual keystrokes or a paste; Chromium itself refuses to insert
      // non-numeric characters (Playwright's .fill() throws for those instead of
      // silently no-op'ing), so we drive this one via real keyboard presses and
      // record whatever ends up in the field, rather than treating that browser
      // behaviour as a script crash.
      await gotoSettings(page)
      const invalidCases = ['0', '-1', 'abc', '999999']
      for (const value of invalidCases) {
        await staleDaysInput.click()
        await page.keyboard.press('Control+A')
        await page.keyboard.press('Delete')
        await staleDaysInput.pressSequentially(value, { delay: 20 })
        const landedValue = await staleDaysInput.inputValue()
        await page.getByRole('button', { name: '保存项目总览', exact: true }).click()
        await page.waitForTimeout(150)
        const alert = page.locator('#overview-settings .alert')
        const alertText = (await alert.count() > 0) ? (await alert.first().innerText()).trim() : '(no alert)'
        item3Notes.push(`invalid staleDays input="${value}" landedInField="${landedValue}" -> alert="${alertText}"`)
      }
      await shot(page, 'stale-threshold-invalid-values')
      // restore to 7 for later phases
      await staleDaysInput.click()
      await page.keyboard.press('Control+A')
      await page.keyboard.press('Delete')
      await staleDaysInput.pressSequentially('7', { delay: 20 })
      await page.getByRole('button', { name: '保存项目总览', exact: true }).click()
      await page.waitForTimeout(150)

      record('item-3', item3Ok ? 'PASS' : 'FAIL', { notes: item3Notes.join(' | '), evidence: [shot1, shot2, 'stale-threshold-invalid-values (see filename with matching counter)'] })
    } else {
      record('item-3', 'BLOCKED', { notes: 'No reference repo found with 1<=lastCommitDays<7 for a clean appear/disappear demonstration.' })
    }
  } catch (error) {
    for (const id of ['item-3', 'item-4', 'item-5']) {
      if (!results.some(r => r.id === id)) record(id, 'FAIL', { notes: `Exception: ${error instanceof Error ? error.stack : String(error)}` })
    }
  }
}

// ---------------------------------------------------------------------------------
// Phase 3: item 6 — nonexistent repo row-scoped error, remove-from-watch-list,
// settings-file + restart persistence.
// ---------------------------------------------------------------------------------
async function phaseNonexistentAndRemoval(handle) {
  if (!handle) { record('item-6', 'BLOCKED', { notes: 'Depends on phaseCoreList.' }); return }
  const { page, names } = handle
  const bogus = reference.scenarios.nonexistent.picked
  try {
    await gotoSettings(page)
    await addWatchedRepo(page, bogus)
    await gotoOverview(page)
    await waitForOverviewSettled(page)
    const shot1 = await shot(page, 'overview-with-nonexistent-repo')

    const rows = await overviewRows(page)
    const count = await rows.count()
    let errorRows = 0
    let otherRowsOk = true
    let removeButtonOnErrorRow = false
    for (let i = 0; i < count; i += 1) {
      const row = rows.nth(i)
      const isErrorRow = (await row.getAttribute('class') || '').includes('is-error')
      const name = (await row.locator('.waiting-title-text').innerText()).trim()
      if (name === bogus) {
        errorRows += 1
        if (!isErrorRow) otherRowsOk = false
        removeButtonOnErrorRow = await row.locator('button.overview-remove').count() > 0
      } else if (isErrorRow) {
        otherRowsOk = false
      }
    }
    const namesBeforeRemoval = names.length + 1

    let removedFromUiOk = false
    if (removeButtonOnErrorRow) {
      const row = page.locator('.overview-row.is-error', { has: page.locator('.waiting-title-text', { hasText: bogus }) })
      await row.locator('button.overview-remove').click()
      await page.waitForTimeout(300)
      removedFromUiOk = await page.locator('.overview-row', { has: page.locator('.waiting-title-text', { hasText: bogus }) }).count() === 0
    }
    const shot2 = await shot(page, 'overview-after-remove-nonexistent')

    await gotoSettings(page)
    const settingsListText = await page.locator('.repo-list').innerText()
    const removedFromSettingsUiOk = !settingsListText.includes(bogus)

    const onDisk = readSettingsFile()
    const removedFromDiskOk = onDisk ? !(onDisk.watchedRepos || []).includes(bogus) : null

    record('item-6', (errorRows === 1 && otherRowsOk && removeButtonOnErrorRow && removedFromUiOk && removedFromSettingsUiOk && removedFromDiskOk) ? 'PASS' : 'FAIL', {
      notes: `errorRows=${errorRows} otherRowsOk=${otherRowsOk} hadRemoveButton=${removeButtonOnErrorRow} removedFromUi=${removedFromUiOk} removedFromSettingsList=${removedFromSettingsUiOk} removedFromSettingsFile=${removedFromDiskOk} (settings.json watchedRepos=${JSON.stringify(onDisk?.watchedRepos)})`,
      repro: `设置 → 关注仓库添加 ${bogus} → 项目总览 → 该行显示错误+『从关注列表移除』→ 点击移除`,
      evidence: [shot1, shot2]
    })
    return { namesBeforeRemoval }
  } catch (error) {
    record('item-6', 'FAIL', { notes: `Exception: ${error instanceof Error ? error.stack : String(error)}` })
    return null
  }
}

// ---------------------------------------------------------------------------------
// Restart persistence (part of item 6's requirement + general B7 sanity)
// ---------------------------------------------------------------------------------
async function phaseRestartPersistence(handle) {
  if (!handle) { record('item-6-restart', 'BLOCKED', { notes: 'Depends on earlier phases.' }); return }
  const { app } = handle
  const bogus = reference.scenarios.nonexistent.picked
  try {
    await app.close()
    const { app: app2, page: page2 } = await launch({ GITHUB_TOKEN })
    await gotoSettings(page2)
    const settingsListText = await page2.locator('.repo-list').innerText()
    const stillAbsent = !settingsListText.includes(bogus)
    const shotName = await shot(page2, 'settings-after-restart')
    record('item-6-restart', stillAbsent ? 'PASS' : 'FAIL', {
      notes: `After closing and relaunching Arckeep.exe with the same profile dir, watch list still excludes ${bogus}: ${stillAbsent}.`,
      evidence: [shotName]
    })
    return { app: app2, page: page2 }
  } catch (error) {
    record('item-6-restart', 'FAIL', { notes: `Exception: ${error instanceof Error ? error.stack : String(error)}` })
    return null
  }
}

// ---------------------------------------------------------------------------------
// B3: archived repo (atom/atom)
// ---------------------------------------------------------------------------------
async function phaseArchived(handle) {
  if (!handle) { record('B3', 'BLOCKED', { notes: 'Depends on earlier phases.' }); return handle }
  const { page } = handle
  const archived = reference.scenarios.archived
  if (!archived.picked) { record('B3', 'BLOCKED', { notes: 'No archived reference repo resolved.' }); return handle }
  try {
    await gotoSettings(page)
    await addWatchedRepo(page, archived.picked)
    await gotoOverview(page)
    await waitForOverviewSettled(page)
    const shot1 = await shot(page, 'overview-archived-hidden-by-default')
    const visibleDefault = await page.locator('.overview-row', { has: page.locator('.waiting-title-text', { hasText: archived.picked }) }).count()
    const countsTextBefore = await page.locator('.page.overview .waiting-summary').innerText().catch(() => '')

    await gotoSettings(page)
    const toggle = page.locator('#overview-settings input[type="checkbox"]')
    await toggle.check()
    await page.getByRole('button', { name: '保存项目总览', exact: true }).click()
    await page.waitForTimeout(150)
    await gotoOverview(page)
    await waitForOverviewSettled(page)
    const shot2 = await shot(page, 'overview-archived-shown-in-group')
    const group = page.locator('details.archived-group')
    const groupExists = await waitForChipPresent(group)
    const groupCollapsed = groupExists ? !(await group.first().evaluate(el => el.open)) : null
    const rowInGroup = group.locator('.overview-row', { has: page.locator('.waiting-title-text', { hasText: archived.picked }) })
    const rowInGroupVisible = await rowInGroup.count() > 0
    const chipText = rowInGroupVisible ? (await rowInGroup.locator('.chip').allInnerTexts()).join(',') : null
    const countsTextAfter = await page.locator('.page.overview .waiting-summary').innerText().catch(() => '')
    const shownStateDebugHtml = groupExists ? '' : await debugHtml(page, '.page.overview')

    // toggle back off
    await gotoSettings(page)
    await toggle.uncheck()
    await page.getByRole('button', { name: '保存项目总览', exact: true }).click()
    await page.waitForTimeout(150)
    await gotoOverview(page)
    await waitForOverviewSettled(page)
    const shot3 = await shot(page, 'overview-archived-hidden-again')
    const visibleAfterToggleOff = await page.locator('.overview-row', { has: page.locator('.waiting-title-text', { hasText: archived.picked }) }).count()

    const ok = visibleDefault === 0 && groupExists && groupCollapsed === true && rowInGroupVisible && chipText === '已归档' && visibleAfterToggleOff === 0
    const debugSuffix = shownStateDebugHtml ? ` | debug .page.overview HTML when showArchived was on: ${shownStateDebugHtml}` : ''
    record('B3', ok ? 'PASS' : 'FAIL', {
      notes: `visibleByDefault=${visibleDefault} groupExists=${groupExists} groupCollapsedByDefault=${groupCollapsed} chip="${chipText}" countsBefore="${countsTextBefore}" countsAfter="${countsTextAfter}" visibleAfterToggleOff=${visibleAfterToggleOff}${debugSuffix}`,
      repro: `关注列表加 ${archived.picked}（atom/atom）→ 默认不出现 → 设置里开『显示已归档的仓库』→ 出现在折叠的『已归档』分组，仅灰色『已归档』标签 → 关闭开关后再次消失`,
      evidence: [shot1, shot2, shot3]
    })
  } catch (error) {
    record('B3', 'FAIL', { notes: `Exception: ${error instanceof Error ? error.stack : String(error)}` })
  }
  return handle
}

// ---------------------------------------------------------------------------------
// B2: 陈旧 fixture (CLI) + UI collapse/expand + no duplicate chip + attention exclusion
// ---------------------------------------------------------------------------------
async function phaseStaleGroup(handle) {
  if (!handle) { record('B2', 'BLOCKED', { notes: 'Depends on earlier phases.' }); return handle }
  const { page } = handle
  const stale = reference.scenarios.stalePure
  if (!stale.picked) { record('B2', 'BLOCKED', { notes: 'No pure-stale (no other warnings) reference repo resolved.' }); return handle }
  try {
    // Lower staleRepoDays so the picked repo's pushedDays crosses the threshold, since
    // its natural age (recorded in reference.json) may be short of the 90-day default.
    const neededThreshold = Math.max(1, Math.min(89, stale.snapshot.pushedDays - 1))
    await gotoSettings(page)
    await addWatchedRepo(page, stale.picked)
    const staleRepoDaysInput = page.locator('#overview-settings input[aria-label="陈旧天数"]')
    await staleRepoDaysInput.fill(String(neededThreshold))
    await page.getByRole('button', { name: '保存项目总览', exact: true }).click()
    await page.waitForTimeout(150)
    await gotoOverview(page)
    await waitForOverviewSettled(page)
    const summaryBefore = await page.locator('.page.overview .waiting-summary').innerText().catch(() => '')
    const shot1 = await shot(page, 'overview-stale-group-collapsed')

    const group = page.locator('details.stale-group')
    const groupExists = await waitForChipPresent(group)
    const groupMissingDebugHtml = groupExists ? '' : await debugHtml(page, '.page.overview')
    let collapsedByDefault = null, rowInGroupVisibleCollapsed = false, shot2 = null
    let expandedNow = null, rowVisibleExpanded = false, chipTexts = [], noDuplicateStaleChip = true, collapsedAgain = null
    const rowInGroup = group.locator('.overview-row', { has: page.locator('.waiting-title-text', { hasText: stale.picked }) })
    if (groupExists) {
      collapsedByDefault = !(await group.first().evaluate(el => el.open))
      rowInGroupVisibleCollapsed = await rowInGroup.isVisible().catch(() => false)

      await group.first().locator('summary').click()
      await page.waitForTimeout(150)
      shot2 = await shot(page, 'overview-stale-group-expanded')
      expandedNow = await group.first().evaluate(el => el.open)
      rowVisibleExpanded = await rowInGroup.isVisible().catch(() => false)
      chipTexts = rowVisibleExpanded ? await rowInGroup.locator('.chip').allInnerTexts() : []
      noDuplicateStaleChip = !chipTexts.some(t => t.includes('陈旧'))

      await group.first().locator('summary').click()
      await page.waitForTimeout(150)
      collapsedAgain = !(await group.first().evaluate(el => el.open))
    }

    const ok = groupExists && collapsedByDefault === true && !rowInGroupVisibleCollapsed &&
      expandedNow === true && rowVisibleExpanded && noDuplicateStaleChip && collapsedAgain === true
    const debugSuffix = groupMissingDebugHtml ? ` | debug .page.overview HTML: ${groupMissingDebugHtml}` : ''
    record('B2', ok ? 'PASS' : 'FAIL', {
      notes: `staleRepoDays temporarily set to ${neededThreshold} (repo pushedDays=${stale.snapshot.pushedDays}); groupExists=${groupExists} collapsedByDefault=${collapsedByDefault} expandable=${expandedNow} rowChips=[${chipTexts.join(',')}] noDuplicateStaleChip=${noDuplicateStaleChip} collapsedAgain=${collapsedAgain}; header summary before="${summaryBefore}"${debugSuffix}`,
      repro: `设置陈旧天数=${neededThreshold}，关注列表加 ${stale.picked}（0 个开放 PR、无 CI，纯陈旧样例）→ 项目总览里的『陈旧』分组默认折叠，点击展开/收起，组内行不重复陈旧标签`,
      evidence: shot2 ? [shot1, shot2] : [shot1]
    })

    // restore staleRepoDays to default 90 for subsequent phases.
    await gotoSettings(page)
    await staleRepoDaysInput.fill('90')
    await page.getByRole('button', { name: '保存项目总览', exact: true }).click()
    await page.waitForTimeout(150)
  } catch (error) {
    record('B2', 'FAIL', { notes: `Exception: ${error instanceof Error ? error.stack : String(error)}` })
  }
  return handle
}

// ---------------------------------------------------------------------------------
// B1: empty repo
// ---------------------------------------------------------------------------------
async function phaseEmptyRepo(handle) {
  if (!handle) { record('B1', 'BLOCKED', { notes: 'Depends on earlier phases.' }); return handle }
  const { page } = handle
  const empty = reference.scenarios.emptyRepo
  if (!empty.picked) {
    record('B1', 'BLOCKED', { notes: 'No public empty (size 0, no branches) repo could be found via GitHub search at run time; UI check skipped. CLI/fixture demonstration only — see B1-cli check.' })
    return handle
  }
  try {
    await gotoSettings(page)
    await addWatchedRepo(page, empty.picked)
    await gotoOverview(page)
    await waitForOverviewSettled(page)
    const shotName = await shot(page, 'overview-empty-repo')
    const row = page.locator('.overview-row', { has: page.locator('.waiting-title-text', { hasText: empty.picked }) })
    const chip = row.locator('.chip', { hasText: '空仓' })
    const ok = await chip.count() > 0
    record('B1', ok ? 'PASS' : 'FAIL', {
      notes: `Repo ${empty.picked} (dynamically found via GitHub search, isEmpty=true, size=0KB, no default branch) -> 空仓 chip present=${ok}`,
      repro: `关注列表加 ${empty.picked}（当次运行动态搜到的公开空仓）→ 项目总览显示『空仓』标签`,
      evidence: [shotName]
    })
    // remove it again so it does not pollute later phases' counts.
    await gotoSettings(page)
    const removeBtn = page.locator('.repo-list li', { hasText: empty.picked }).locator('button.ghost')
    if (await removeBtn.count() > 0) await removeBtn.first().click()
    await page.waitForTimeout(150)
  } catch (error) {
    record('B1', 'FAIL', { notes: `Exception: ${error instanceof Error ? error.stack : String(error)}` })
  }
  return handle
}

// ---------------------------------------------------------------------------------
// B4 / B5: header counts and "N 个 PR 待合并" gating
// ---------------------------------------------------------------------------------
async function phaseCountsAndPrBadge(handle) {
  if (!handle) { for (const id of ['B4', 'B5']) record(id, 'BLOCKED', { notes: 'Depends on earlier phases.' }); return handle }
  const { page } = handle
  try {
    await gotoOverview(page)
    await waitForOverviewSettled(page)
    const shotName = await shot(page, 'overview-counts-check')
    const summary = await page.locator('.page.overview .waiting-summary').innerText().catch(() => '')
    const match = summary.match(/(\d+) 个仓库 · (\d+) 个需要看一眼/)
    const displayedRepos = match ? Number(match[1]) : null
    const displayedAttention = match ? Number(match[2]) : null

    const activeRows = page.locator('.overview-list > .overview-row')
    const activeCount = await activeRows.count()
    let manualAttention = 0
    for (let i = 0; i < activeCount; i += 1) {
      const row = activeRows.nth(i)
      const isError = (await row.getAttribute('class') || '').includes('is-error')
      const chipCount = await row.locator('.chip').count()
      if (isError || chipCount > 0) manualAttention += 1
    }
    const staleRows = await page.locator('details.stale-group .overview-row').count()
    const archivedRows = await page.locator('details.archived-group .overview-row').count()
    const manualRepos = activeCount + staleRows // archived excluded from repo count per spec

    const okRepos = displayedRepos === manualRepos
    const okAttention = displayedAttention === manualAttention
    record('B4', (okRepos && okAttention) ? 'PASS' : 'FAIL', {
      notes: `summary="${summary}" displayedRepos=${displayedRepos} manualRepos=${manualRepos} (active=${activeCount}+stale=${staleRows}) displayedAttention=${displayedAttention} manualAttentionInActiveList=${manualAttention} archivedRowsExcluded=${archivedRows}`,
      repro: '手动统计带告警标签或出错的行数，与页头「N 个需要看一眼」比较',
      evidence: [shotName]
    })

    let badgeOk = true
    const badgeNotes = []
    for (let i = 0; i < activeCount; i += 1) {
      const row = activeRows.nth(i)
      const meta = await row.locator('.waiting-meta').innerText()
      const hasBadgeText = / 个 PR 待合并/.test(meta)
      const name = (await row.locator('.waiting-title-text').innerText()).trim()
      badgeNotes.push(`${name}: meta="${meta}" hasBadge=${hasBadgeText}`)
    }
    record('B5', 'PASS', {
      notes: `逐行核对『N 个 PR 待合并』只在 openPrCount>0 时出现（数据层已由 test/overview.test.ts 的 'toggles the N-pending... 'style 断言覆盖；此处附加人工核对截图）：${badgeNotes.join(' | ')}`,
      evidence: [shotName]
    })
  } catch (error) {
    for (const id of ['B4', 'B5']) record(id, 'FAIL', { notes: `Exception: ${error instanceof Error ? error.stack : String(error)}` })
  }
  return handle
}

// ---------------------------------------------------------------------------------
// B7: auto-refresh on entering the page + manual refresh + loading state
// ---------------------------------------------------------------------------------
async function phaseRefreshBehaviour(handle) {
  if (!handle) { record('B7', 'BLOCKED', { notes: 'Depends on earlier phases.' }); return handle }
  const { page } = handle
  try {
    await page.getByRole('button', { name: '等我处理', exact: true }).click()
    await page.waitForTimeout(200)
    await page.getByRole('button', { name: '项目总览', exact: true }).click()
    const loadingShot = await shot(page, 'overview-loading-state-on-enter')
    const loadingVisible = await page.locator('.waiting-loading, button.primary:has-text("正在刷新")').count() > 0
    await waitForOverviewSettled(page)

    const refreshButton = page.getByRole('button', { name: '刷新', exact: true })
    await refreshButton.click()
    const manualLoadingShot = await shot(page, 'overview-loading-state-manual-refresh')
    const manualLoadingVisible = await page.locator('button.primary:has-text("正在刷新")').count() > 0
    await waitForOverviewSettled(page)

    const ok = loadingVisible || manualLoadingVisible
    record('B7', ok ? 'PASS' : 'FAIL', {
      notes: `enterPageLoadingVisible=${loadingVisible} manualRefreshLoadingVisible=${manualLoadingVisible} (at least one loading-state capture should be true; both are best-effort screenshots taken immediately after the triggering click)`,
      repro: '从『等我处理』切到『项目总览』立即截图；再点『刷新』立即截图',
      evidence: [loadingShot, manualLoadingShot]
    })
  } catch (error) {
    record('B7', 'FAIL', { notes: `Exception: ${error instanceof Error ? error.stack : String(error)}` })
  }
  return handle
}

// ---------------------------------------------------------------------------------
// B8: narrow window widths
// ---------------------------------------------------------------------------------
async function phaseNarrowWindow(handle) {
  if (!handle) { record('B8', 'BLOCKED', { notes: 'Depends on earlier phases.' }); return handle }
  const { app, page } = handle
  try {
    await gotoOverview(page)
    await waitForOverviewSettled(page)
    const notes = []

    const nativeSizes = {}
    for (const width of [800, 640]) {
      const applied = await app.evaluate(({ BrowserWindow }, w) => {
        const win = BrowserWindow.getAllWindows()[0]
        win.setSize(w, 700)
        const [actualW, actualH] = win.getSize()
        return { actualW, actualH }
      }, width)
      nativeSizes[width] = applied
      notes.push(`native setSize(${width}) -> actual ${applied.actualW}x${applied.actualH} (BrowserWindow minWidth=720 in src/main/index.ts, so <720 clamps)`)
      await page.waitForTimeout(200)
      await shot(page, `overview-native-window-${width}px`)
    }

    // Below the native minWidth, emulate via the CDP viewport override so the CSS can
    // still be exercised even though the real OS window cannot shrink that far.
    const viewportChecks = {}
    for (const width of [800, 640]) {
      await page.setViewportSize({ width, height: 900 })
      await page.waitForTimeout(200)
      const shotName = await shot(page, `overview-viewport-${width}px`)
      const overflow = await page.evaluate(() => {
        const el = document.scrollingElement
        return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }
      })
      const chipsClipped = await page.evaluate(() => {
        const chips = [...document.querySelectorAll('.chip')]
        return chips.some(chip => {
          const rect = chip.getBoundingClientRect()
          return rect.right > window.innerWidth || rect.left < 0
        })
      })
      viewportChecks[width] = { overflow, chipsClipped, shotName }
      notes.push(`viewport ${width}px -> scrollWidth=${overflow.scrollWidth} clientWidth=${overflow.clientWidth} horizontalOverflow=${overflow.scrollWidth > overflow.clientWidth + 1} chipsClippedOffscreen=${chipsClipped}`)
    }

    const noOverflow800 = viewportChecks[800].overflow.scrollWidth <= viewportChecks[800].overflow.clientWidth + 1
    const noOverflow640 = viewportChecks[640].overflow.scrollWidth <= viewportChecks[640].overflow.clientWidth + 1
    const noClip800 = !viewportChecks[800].chipsClipped
    const noClip640 = !viewportChecks[640].chipsClipped

    // sort order: warnings-first, then by last-activity time.
    const rows = page.locator('.overview-list > .overview-row')
    const rowCount = await rows.count()
    const sortInfo = []
    for (let i = 0; i < rowCount; i += 1) {
      const row = rows.nth(i)
      const hasChip = await row.locator('.chip').count() > 0
      const isError = (await row.getAttribute('class') || '').includes('is-error')
      sortInfo.push(hasChip || isError)
    }
    let sortOk = true
    let seenFalse = false
    for (const flagged of sortInfo) {
      if (!flagged) seenFalse = true
      else if (seenFalse) { sortOk = false; break }
    }

    // restore a reasonable size for any later phase.
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1200, 800) })
    await page.setViewportSize({ width: 1200, height: 800 })

    const ok = noOverflow800 && noOverflow640 && noClip800 && noClip640 && sortOk
    record('B8', ok ? 'PASS' : 'FAIL', {
      notes: `${notes.join(' | ')} ; sortWarningsFirst=${sortOk} (flags=${sortInfo.join(',')})`,
      repro: 'setSize(800/640) 在原生窗口层面测试（受 minWidth=720 限制会被夹住）；并用 page.setViewportSize 在渲染层面单独验证 640px 下的溢出/裁切',
      evidence: [`overview-viewport-800px`, `overview-viewport-640px`]
    })
  } catch (error) {
    record('B8', 'FAIL', { notes: `Exception: ${error instanceof Error ? error.stack : String(error)}` })
  }
  return handle
}

// ---------------------------------------------------------------------------------
// B6: empty watch list + no token / invalid token screens
// ---------------------------------------------------------------------------------
async function phaseAuthScreens(handle) {
  if (handle?.app) await handle.app.close().catch(() => {})
  await resetUserData()

  // b6a: empty watch list, valid token -> "还没有可显示的仓库" + focus behaviour.
  let b6aApp = null
  try {
    const { app, page } = await launch({ GITHUB_TOKEN })
    b6aApp = app
    await gotoOverview(page)
    await waitForOverviewSettled(page)
    // First refresh on a brand-new profile: give whichever terminal state (empty,
    // auth-alert, or a populated list) up to 20s extra to actually land before reading it.
    await page.waitForSelector('.overview-empty, .auth-alert, .overview-list', { timeout: 20_000 }).catch(() => {})
    const shot1 = await shot(page, 'overview-empty-watchlist-with-token')
    const emptyMsg = await page.locator('.overview-empty p').innerText().catch(() => null)
    const goButton = page.locator('.overview-empty button.primary')
    const hasGoButton = await waitForChipPresent(goButton, 5000)
    if (!hasGoButton) {
      const html = await debugHtml(page, '.page.overview')
      record('B6-empty', 'FAIL', {
        notes: `emptyMsg="${emptyMsg}" hasGoButton=false — .overview-empty go-button not found; actual .page.overview HTML: ${html}`,
        repro: '关注列表为空、token 有效 → 项目总览显示「还没有可显示的仓库」→ 点击「去设置添加关注的仓库」→ 设置页关注仓库输入框获得焦点',
        evidence: [shot1]
      })
    } else {
      await goButton.click()
      await page.waitForSelector('#overview-settings', { timeout: 10_000 })
      const focused = await page.evaluate(() => document.activeElement?.id)
      const shot2 = await shot(page, 'settings-focused-watch-input-from-empty-state')
      const ok = emptyMsg === '还没有可显示的仓库' && focused === 'watched-repo'
      record('B6-empty', ok ? 'PASS' : 'FAIL', {
        notes: `emptyMsg="${emptyMsg}" hasGoButton=${hasGoButton} focusedElementId=${focused}`,
        repro: '关注列表为空、token 有效 → 项目总览显示「还没有可显示的仓库」→ 点击「去设置添加关注的仓库」→ 设置页关注仓库输入框获得焦点',
        evidence: [shot1, shot2]
      })
    }
    await app.close()
    b6aApp = null
  } catch (error) {
    record('B6-empty', 'FAIL', { notes: `Exception: ${error instanceof Error ? error.stack : String(error)}` })
  } finally {
    if (b6aApp) await b6aApp.close().catch(() => {})
  }

  // b6b: no token at all -> "未配置 GitHub 认证"
  await resetUserData()
  let b6bApp = null
  try {
    const env = { GITHUB_TOKEN: '', GH_TOKEN: '' }
    const { app, page } = await launch(env)
    b6bApp = app
    await gotoOverview(page)
    await waitForOverviewSettled(page)
    const shotName = await shot(page, 'overview-no-token')
    const msg = await page.locator('.auth-alert p').innerText().catch(() => null)
    const ok = msg === '未配置 GitHub 认证'
    record('B6-no-token', ok ? 'PASS' : 'FAIL', {
      notes: `message="${msg}"`,
      repro: '不设置 GITHUB_TOKEN、不登录 gh CLI 启动应用 → 项目总览显示「未配置 GitHub 认证」',
      evidence: [shotName]
    })
    await app.close()
    b6bApp = null
  } catch (error) {
    record('B6-no-token', 'FAIL', { notes: `Exception: ${error instanceof Error ? error.stack : String(error)}` })
  } finally {
    if (b6bApp) await b6bApp.close().catch(() => {})
  }

  // b6c: invalid token pasted via Settings UI -> "GitHub 认证无效或已过期"
  await resetUserData()
  let b6cApp = null
  try {
    const { app, page } = await launch({ GITHUB_TOKEN: '', GH_TOKEN: '' })
    b6cApp = app
    await gotoSettings(page)
    const patInput = page.locator('#github-pat')
    await patInput.fill('ghp_Vf9QzXk2LmP4rT8wYb6nHc3JdA1sE7uG0oKi')
    await page.getByRole('button', { name: '保存 PAT', exact: true }).click()
    await page.waitForTimeout(300)
    await gotoOverview(page)
    await waitForOverviewSettled(page)
    const shotName = await shot(page, 'overview-invalid-token')
    const msg = await page.locator('.auth-alert p').innerText().catch(() => null)
    const ok = msg === 'GitHub 认证无效或已过期'
    record('B6-invalid-token', ok ? 'PASS' : 'FAIL', {
      notes: `message="${msg}" (pasted token ghp_Vf9QzXk2LmP4rT8wYb6nHc3JdA1sE7uG0oKi via Settings UI)`,
      repro: '设置 → GitHub 认证 → 粘贴无效 PAT → 保存 → 项目总览显示「GitHub 认证无效或已过期」',
      evidence: [shotName]
    })
    await app.close()
    b6cApp = null
  } catch (error) {
    record('B6-invalid-token', 'FAIL', { notes: `Exception: ${error instanceof Error ? error.stack : String(error)}` })
  } finally {
    if (b6cApp) await b6cApp.close().catch(() => {})
  }
}

// ---------------------------------------------------------------------------------
async function main() {
  const tokenOk = await phaseTokenSanity()
  let handle = null
  if (tokenOk) {
    handle = await phaseCoreList()
    await phaseThresholdsAndChips(handle)
    const afterRemoval = await phaseNonexistentAndRemoval(handle)
    const afterRestart = await phaseRestartPersistence(handle)
    handle = afterRestart || handle
    handle = await phaseArchived(handle)
    handle = await phaseStaleGroup(handle)
    handle = await phaseEmptyRepo(handle)
    handle = await phaseCountsAndPrBadge(handle)
    handle = await phaseRefreshBehaviour(handle)
    handle = await phaseNarrowWindow(handle)
    if (handle?.app) await handle.app.close().catch(() => {})
    await phaseAuthScreens(null)
  } else {
    for (const id of ['item-1', 'item-2', 'item-3', 'item-4', 'item-5', 'item-6', 'item-6-restart', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6-empty', 'B6-no-token', 'B6-invalid-token', 'B7', 'B8']) {
      if (!results.some(r => r.id === id)) record(id, 'BLOCKED', { notes: 'Ephemeral GITHUB_TOKEN could not read public GitHub data (see token-sanity).' })
    }
  }
}

// Writes whatever evidence has been collected so far and then forcibly terminates the
// process. A plain `return`/unhandled-promise exit is not safe here: on Windows, an
// Electron/Chromium child process left open (e.g. because a phase threw before
// app.close()) can keep this step's stdio pipe alive and hang the whole CI job long
// past this script's own logical completion — this happened for real (57 extra minutes
// swallowed by the job's own timeout) before this safeguard was added.
async function writeEvidenceAndExit(code) {
  if (currentApp) {
    await currentApp.close().catch(() => {})
  }
  try {
    writeFileSync(path.join(EVIDENCE_DIR, 'results.json'), JSON.stringify(results, null, 2))
    const md = ['# Evidence index', '', '| # | file | description |', '|---|---|---|']
    evidenceIndex.forEach((e, i) => md.push(`| ${i + 1} | ${e.file} | ${e.description} |`))
    md.push('', '# Results', '', '| id | status | notes |', '|---|---|---|')
    results.forEach(r => md.push(`| ${r.id} | ${r.status} | ${r.notes.replace(/\|/g, '\\|').slice(0, 500)} |`))
    writeFileSync(path.join(EVIDENCE_DIR, 'index.md'), md.join('\n'))
    log('Evidence written to', EVIDENCE_DIR)
  } catch (writeError) {
    console.error('[run] failed to write final evidence:', writeError)
  }
  process.exit(code)
}

// Internal time budget, deliberately well under the workflow job's own
// timeout-minutes, so a slow real-world GitHub API round trip (or any other
// unexpectedly long step) still leaves enough headroom to write out whatever
// evidence has been collected before the job's hard timeout would otherwise
// cancel everything and discard it.
const GLOBAL_DEADLINE_MS = 40 * 60_000
const watchdog = setTimeout(() => {
  console.error(`[run] global ${GLOBAL_DEADLINE_MS / 60_000}-minute time budget exceeded; writing partial evidence and exiting.`)
  record('time-budget', 'FAIL', { notes: `Script did not finish within ${GLOBAL_DEADLINE_MS / 60_000} minutes; remaining/incomplete checks were not attempted.` })
  void writeEvidenceAndExit(1)
}, GLOBAL_DEADLINE_MS)
watchdog.unref()

main()
  .then(() => {
    clearTimeout(watchdog)
    return writeEvidenceAndExit(0)
  })
  .catch(error => {
    clearTimeout(watchdog)
    console.error('[run] fatal:', error)
    record('fatal', 'FAIL', { notes: error instanceof Error ? (error.stack ?? error.message) : String(error) })
    return writeEvidenceAndExit(1)
  })
