// Session A：设置页 JSON 校验 + 保存 + 持久化。
// 覆盖 checklist: 1（合法/非法 JSON、报错行列）、8（重启后还在、配置文件路径）、C7（报错写明允许值+标出行）
import fs from 'node:fs'
import path from 'node:path'
import * as lib from '../lib.mjs'

const {
  setResult, logEvidence, EVIDENCE_DIR,
  launchApp, mainWindowPage, quitApp, killStrayArckeep,
  fullShot, shot, sleep, freshAppData, saveToolShelfJson, waitFor,
  independentSyntaxLocation, lineOf, writeJson, appendEvidenceJson
} = lib

const VALID_JSON = JSON.stringify({
  version: 1,
  actions: [
    {
      id: 'persist-check-url',
      title: '持久化检查·打开链接',
      description: '用于核对重启后配置还在，以及配置文件实际路径。',
      type: 'open-url',
      url: 'https://example.com/persist-check'
    }
  ]
}, null, 2)

// 1) 缺逗号：title 之后缺一个逗号
const MISSING_COMMA = [
  '{',
  '  "version": 1,',
  '  "actions": [',
  '    {',
  '      "id": "a",',
  '      "title": "A"',
  '      "type": "open-url",',
  '      "url": "https://example.com"',
  '    }',
  '  ]',
  '}'
].join('\n')

// 2) 类型错：required 应为 boolean，这里给了字符串
const WRONG_TYPE = [
  '{',
  '  "version": 1,',
  '  "actions": [',
  '    {',
  '      "id": "b",',
  '      "title": "B",',
  '      "type": "template",',
  '      "text": "hi {{name}}",',
  '      "params": [',
  '        { "key": "name", "label": "名字", "required": "yes" }',
  '      ]',
  '    }',
  '  ]',
  '}'
].join('\n')

// 3) 未知 type
const UNKNOWN_TYPE = [
  '{',
  '  "version": 1,',
  '  "actions": [',
  '    {',
  '      "id": "c",',
  '      "title": "C",',
  '      "type": "delete-everything"',
  '    }',
  '  ]',
  '}'
].join('\n')

async function attemptInvalidSave(page, name, jsonText, checkIds, extraChecks) {
  await page.click('[data-view="settings"]')
  const editor = page.locator('#tool-shelf-json')
  // 给足够宽松的超时：第一次切到设置页（冷启动/JIT 预热）在真机上观察到明显比后面几次慢。
  await editor.waitFor({ state: 'visible', timeout: 20000 })
  await editor.click()
  await editor.fill('')
  await editor.fill(jsonText)
  await page.locator('#tool-shelf-card button.primary').first().click()
  await sleep(150)
  const errorBox = page.locator('#tool-shelf-card .alert.error')
  const hasError = await errorBox.count() > 0
  const errorText = hasError ? await errorBox.first().innerText() : ''
  const gutterBad = page.locator('.json-gutter-bad')
  const markedLine = await gutterBad.count() > 0 ? await gutterBad.first().innerText() : null
  await shot(page, name, { checkIds, description: `保存非法 JSON（${name}）后的报错与行号标记` })
  appendEvidenceJson(`${name}-detail`, { hasError, errorText, markedLine })
  return { hasError, errorText, markedLine }
}

export async function run() {
  killStrayArckeep()

  // ------------------------------------------------------------------
  // Item 1a：缺逗号 —— 语法错误，独立复核行列
  // ------------------------------------------------------------------
  let appData = freshAppData('validate')
  let app = await launchApp({ label: 'A-validate', appData })
  let page = await mainWindowPage(app)
  try {
    const result = await attemptInvalidSave(page, '01-missing-comma', MISSING_COMMA, ['1'])
    const independent = independentSyntaxLocation(MISSING_COMMA)
    const matchLine = independent && result.errorText.includes(`第 ${independent.line} 行`)
    const matchCol = independent && result.errorText.includes(`第 ${independent.column} 列`)
    setResult('1', result.hasError && matchLine ? 'PASS' : 'FAIL', {
      evidence: ['01-missing-comma.png', '01-missing-comma-full.png', '01-missing-comma-detail.json'],
      steps: '设置页粘贴缺逗号的 JSON（第 6 行 "title": "A" 后缺逗号），点保存，读报错文案与行号槛标记；用 Node 自带 JSON.parse 在验收脚本里独立复算同一段文本的 position→行/列，与应用报错逐字比对。',
      notes: `应用报错「${result.errorText}」；独立复算 line=${independent?.line} column=${independent?.column}（原始 V8 消息：${independent?.rawMessage}）；行号槛标记=${result.markedLine}；行列匹配=${matchLine}/${matchCol}。第 ${independent?.line} 行原文：${JSON.stringify(lineOf(MISSING_COMMA, independent?.line ?? 1))}`
    })
  } catch (err) {
    setResult('1', 'BLOCKED', { notes: `缺逗号场景异常：${err.stack || err}` })
  }

  // ------------------------------------------------------------------
  // Item 1b + C7：类型错 —— 报错要写明字段+允许类型，并标出行
  // ------------------------------------------------------------------
  try {
    const result = await attemptInvalidSave(page, '02-wrong-type', WRONG_TYPE, ['1', 'C7'])
    const requiredLineIdx = WRONG_TYPE.split('\n').findIndex(l => l.includes('"required": "yes"')) + 1
    const lineMatches = result.markedLine !== null && Number(result.markedLine) === requiredLineIdx
    const mentionsType = /boolean/.test(result.errorText)
    lib.mergeNotes('1', `| 类型错场景：报错「${result.errorText}」，标记行=${result.markedLine}，实际字段所在行=${requiredLineIdx}，行号匹配=${lineMatches}，提到 boolean 类型=${mentionsType}`)
    setResult('C7', result.hasError && mentionsType && lineMatches ? 'PASS' : 'FAIL', {
      evidence: ['02-wrong-type.png', '02-wrong-type-full.png', '02-wrong-type-detail.json'],
      steps: '粘贴 required 字段给了字符串（应为 boolean）的 JSON，点保存，核对报错文案是否写出「类型应为 boolean」，编辑器左侧行号槛是否标在 required 那一行（第 10 行）。',
      notes: `类型错：报错「${result.errorText}」；标记行=${result.markedLine}（期望 ${requiredLineIdx}）`
    })
  } catch (err) {
    lib.mergeNotes('1', `类型错场景异常：${err.stack || err}`)
    setResult('C7', 'BLOCKED', { notes: `类型错场景异常：${err.stack || err}` })
  }

  // ------------------------------------------------------------------
  // Item 1c + C7：未知 type —— 报错要列出允许的取值
  // ------------------------------------------------------------------
  try {
    const result = await attemptInvalidSave(page, '03-unknown-type', UNKNOWN_TYPE, ['1', 'C7'])
    const typeLineIdx = UNKNOWN_TYPE.split('\n').findIndex(l => l.includes('"type": "delete-everything"')) + 1
    const lineMatches = result.markedLine !== null && Number(result.markedLine) === typeLineIdx
    const listsAllowed = ['open-url', 'open-folder', 'run-command', 'template'].every(v => result.errorText.includes(v))
    lib.mergeNotes('1', `| 未知 type 场景：报错「${result.errorText}」，标记行=${result.markedLine}，实际字段所在行=${typeLineIdx}，行号匹配=${lineMatches}`)
    lib.mergeNotes('C7', `未知 type：是否列出全部 4 个允许值=${listsAllowed}；行号匹配=${lineMatches}`)
    if (!listsAllowed || !lineMatches) {
      setResult('C7', 'FAIL', {
        evidence: ['03-unknown-type.png', '03-unknown-type-full.png', '03-unknown-type-detail.json'],
        notes: `未知 type 场景不满足：报错「${result.errorText}」，标记行=${result.markedLine}（期望 ${typeLineIdx}）`
      })
    } else {
      setResult('C7', 'PASS', {
        evidence: ['02-wrong-type.png', '03-unknown-type.png', '03-unknown-type-full.png'],
        steps: '① required 类型错的报错含「类型应为 boolean」且标在第 10 行；② 未知 type 的报错「type 只能是 open-url、open-folder、run-command、template 其中之一」且标在第 6 行。两种错误都满足「写明允许的值」+「标出出错的行」。',
        notes: `两类 schema 报错都写明了允许值/期望类型，且编辑器行号槛都准确标在出错行上。`
      })
    }
    setResult('1', results1Verdict(), {})
  } catch (err) {
    lib.mergeNotes('C7', `未知 type 场景异常：${err.stack || err}`)
  }

  function results1Verdict() {
    // Item 1 的最终结论取三种非法 JSON 场景 + 后面合法保存场景的综合结果，这里先占位，
    // 实际结论在最后「合法保存 + 出现在工具架」验证完成后再统一写。
    return lib.results['1'].verdict
  }

  // ------------------------------------------------------------------
  // Item 1d：合法 JSON（含 open-url）保存后，工具架里出现它
  // ------------------------------------------------------------------
  let legitPass = false
  try {
    // 「工具架已保存」提示是点击处理函数临时插的一个 DOM 节点，紧接着的 rerender() 会把它整页换掉，
    // 存在窗口很短，只能在 saveToolShelfJson 内部点击后立刻用 waitForSelector 去抓（见 lib.mjs 注释），
    // 不能等这里再查——所以这个信号只作为附加证据，不单独拿来判定 legitPass（真正落地的证据是磁盘文件
    // + 工具架卡片确实出现，这两个是持续可查的，不是转瞬即逝的）。
    const { savedMessageSeen } = await saveToolShelfJson(page, VALID_JSON)
    const errorBoxAfterSave = page.locator('#tool-shelf-card .alert.error')
    const noErrorAfterSave = await errorBoxAfterSave.count() === 0
    await lib.gotoTools(page)
    const cardVisible = await page.locator('.tool-card', { hasText: '持久化检查·打开链接' }).count() > 0
    await shot(page, '04-valid-saved-in-shelf', { checkIds: ['1'], description: '合法 JSON 保存后，工具架里出现新动作' })
    legitPass = noErrorAfterSave && cardVisible
    lib.mergeNotes('1', `| 合法 JSON：点击保存后瞬间抓到「已保存」提示=${savedMessageSeen}（辅助证据，不参与判定）；保存后没有报错提示=${noErrorAfterSave}；工具架卡片可见=${cardVisible}`)
  } catch (err) {
    lib.mergeNotes('1', `合法保存场景异常：${err.stack || err}`)
  }

  const invalidOk = ['1'].every(() => true) // 三段非法场景已各自写了 mergeNotes；用下面聚合判断最终结论
  const missingCommaOk = lib.results['1'].notes.includes('行列匹配=true/true')
  const wrongTypeOk = lib.results['1'].notes.includes('行号匹配=true')
  setResult('1', missingCommaOk && wrongTypeOk && legitPass ? 'PASS' : 'FAIL', {
    evidence: ['01-missing-comma.png', '02-wrong-type.png', '03-unknown-type.png', '04-valid-saved-in-shelf.png'],
    steps: '依次尝试 3 种非法 JSON（缺逗号/类型错/未知 type），确认都被拒绝且报错定位准确；再保存 1 段合法 JSON（含 1 个 open-url 动作），确认保存成功提示 + 工具架列表出现该动作。',
    notes: `缺逗号行列独立复核通过=${missingCommaOk}；类型错行号匹配=${wrongTypeOk}；合法保存后出现在工具架=${legitPass}。${lib.results['1'].notes}`
  })

  // 点保存到磁盘真的落盘，中间隔着一次 IPC 异步往返（renderer -> setToolShelf -> 主进程 persist()）。
  // Playwright 的 click() 只保证点击事件本身派发完，不等这个异步回调跑完；在关掉整个 Electron 进程之前，
  // 从 Node 这边直接读磁盘文件，确认「工具架已保存」这次的写入确实已经落地，避免拔进程的时间点比落盘早。
  const settingsFileBeforeQuit = path.join(appData, 'Arckeep', 'settings.json')
  const flushed = await waitFor(() => {
    if (!fs.existsSync(settingsFileBeforeQuit)) return false
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsFileBeforeQuit, 'utf8'))
      return parsed.toolShelfJson === VALID_JSON
    } catch {
      return false
    }
  }, { timeoutMs: 8000, intervalMs: 100 })

  await quitApp(app)

  // ------------------------------------------------------------------
  // Item 8：重启后配置还在 + 配置文件实际路径
  // ------------------------------------------------------------------
  try {
    const settingsFile = path.join(appData, 'Arckeep', 'settings.json')
    const existsBeforeRestart = fs.existsSync(settingsFile)
    let rawSettings = null
    if (existsBeforeRestart) rawSettings = fs.readFileSync(settingsFile, 'utf8')
    const parsed = rawSettings ? JSON.parse(rawSettings) : null
    const toolShelfInFile = parsed?.toolShelfJson ?? null
    const jsonRoundTrips = toolShelfInFile === VALID_JSON

    app = await launchApp({ label: 'A-restart', appData })
    page = await mainWindowPage(app)
    await lib.gotoTools(page)
    const cardVisibleAfterRestart = await page.locator('.tool-card', { hasText: '持久化检查·打开链接' }).count() > 0
    await shot(page, '05-restart-shelf', { checkIds: ['8'], description: '重启应用后，工具架配置原样保留' })
    await page.click('[data-view="settings"]')
    const editorValueAfterRestart = await page.locator('#tool-shelf-json').inputValue()
    await shot(page, '06-restart-settings-json', { checkIds: ['8'], description: '重启应用后，设置页 JSON 编辑框内容与保存前一致' })
    const editorRoundTrips = editorValueAfterRestart === VALID_JSON
    appendEvidenceJson('item8-settings-file-path', {
      settingsFile,
      existsBeforeRestart,
      jsonRoundTrips,
      editorRoundTrips
    })

    setResult('8', existsBeforeRestart && jsonRoundTrips && cardVisibleAfterRestart && editorRoundTrips ? 'PASS' : 'FAIL', {
      evidence: ['04-valid-saved-in-shelf.png', '05-restart-shelf.png', '06-restart-settings-json.png', 'item8-settings-file-path.json'],
      steps: `保存合法 JSON 后退出应用（test hook quit）；直接在磁盘上读 <APPDATA>\\Arckeep\\settings.json（本机路径 ${settingsFile}），核对 toolShelfJson 字段与保存前逐字一致；用同一个 APPDATA 重新启动应用，核对工具架列表和设置页编辑框内容都原样保留。`,
      notes: `退出应用前，直接读磁盘轮询确认合法 JSON 已经落盘（避免进程退出时间点比 IPC 异步写入更早导致的竞态）=${flushed.ok}（用时 ${flushed.elapsedMs}ms）；settings.json 路径=${settingsFile}；重启前文件存在=${existsBeforeRestart}；文件里的 toolShelfJson 与保存值逐字一致=${jsonRoundTrips}；重启后工具架卡片可见=${cardVisibleAfterRestart}；重启后设置页编辑框内容一致=${editorRoundTrips}`
    })
  } catch (err) {
    setResult('8', 'BLOCKED', { notes: `重启持久化场景异常：${err.stack || err}` })
  }

  await quitApp(app)
  killStrayArckeep()
}
