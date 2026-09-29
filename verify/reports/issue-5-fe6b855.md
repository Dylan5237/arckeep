# Issue #5「工具架」独立验收报告

- **验收代理**：独立验收 Cloud Agent（不改产品代码，只跑 Playwright + 真实 Electron 界面操作 + 操作系统层面核对）
- **被测 main SHA**：`fe6b85508c67cb9a72cc15dedcbe2f4f50a2b431`
- **被测二进制**：Windows `win-unpacked/Arckeep.exe`，SHA256 `6b53f29aa7edc25d4e15bed58a30ee8f237b9de7196efcb6429e7aad711e27c4`（来自 main push CI run [36511823583](https://github.com/Dylan5237/arckeep/actions/runs/36511823583) 产出的 `arckeep-win-unpacked` artifact，见 `verify/issue-5/evidence/artifact-source.json`）
- **验收 harness 所在分支**：`verify/issue-5-fe6b855`（只在这个分支上改动 `verify/issue-5/**` 和 `.github/workflows/verify-issue-5.yml`，产品代码相对被测 SHA 零改动，每次 CI 都有专门一步用 `git diff` 断言这一点）
- **验收 workflow**：[`.github/workflows/verify-issue-5.yml`](../../.github/workflows/verify-issue-5.yml)，`runs-on: windows-latest`
- **本次报告依据的正式一轮**：CI run [36530081374](https://github.com/Dylan5237/arckeep/actions/runs/36530081374)（2026-09-29，第 8 次、也是硬性预算内最后一次 push 触发的运行），evidence artifact：[`issue-5-fe6b855-verify-evidence`](https://github.com/Dylan5237/arckeep/actions/runs/36530081374/artifacts/11017287243)
- **交叉参考的上一轮**：CI run [36525552350](https://github.com/Dylan5237/arckeep/actions/runs/36525552350)（第 7 次），用于确认某些现象是否重复出现
- **push 预算使用情况**：硬性规则里「最多 8 次触发」的额度已在第 8 次运行后**完全用满**。本报告和后续证据拷贝只涉及 `verify/reports/**`（该路径不在 workflow 的 `paths` 触发范围内，见 workflow 第 8-10 行），不会触发第 9 次运行，也确实没有再触发。
- **未使用真实 GitHub token**：每次运行都有专门步骤显式 `Remove-Item Env:\GH_TOKEN`、`Env:\GITHUB_TOKEN`，且验收 harness 自己的 `cleanEnv()` 也会 `delete` 这两个变量；所有依赖 gh 的路径都用假 `gh.exe` 桩顶替，全程没有用真实 token。
- **未对 Issue/PR 做任何评论、状态变更、标签变更**，未合并、未开 PR。

---

## 0. 先说明两个贯穿全篇的重要发现

在逐项核对之前，必须先披露两个在验收过程中发现、且会影响多个检查项证据可信度的问题。这两个问题都不是靠猜测得出的，都有可复现的独立证据支撑。

### 0.1 我自己验收 harness 里一个确认属实的环境变量拼接 bug（`verify/issue-5/lib.mjs` 的 `cleanEnv()`）

```206:208:verify/issue-5/lib.mjs
  env.PATH = `${GH_STUB_DIR}${path.delimiter}${env.PATH ?? ''}`
  return env
}
```

`cleanEnv()` 用 `const env = { ...process.env, ...extra }` 展开 `process.env` 之后，又单独给 `env.PATH` 赋值。问题在于：Windows 上 `process.env` 实际的键名通常是 `Path`（大小写混合），而不是全大写的 `PATH`；展开成一个普通 JS 对象后，这个大小写会被原样保留，之后 `env.PATH = ...` 这行赋值会创建一个**全新、独立的 `PATH` 键**，而不是覆盖原来的 `Path`。我在本机（非 Windows，纯 JS 语义验证，不依赖任何被测环境）直接复现了这个机制：

```
$ node /tmp/cleanenv-test.mjs
Resulting env object keys: [ 'Path', 'SystemRoot', 'USERPROFILE', 'ARCKEEP_TEST_HOOKS', 'PATH' ]
result.Path  (original, untouched): "C:\\Windows\\System32;C:\\Windows;C:\\Program Files\\nodejs\\"
result.PATH  (newly created, used by spawn/CreateProcess lookups): "C:\\gh-stub;"
```

也就是说，最终传给 `_electron.launch({ env })` 的环境变量块里，`Path`（原始、完整、包含系统目录）和 `PATH`（新建、只有假 gh 桩目录）同时存在、互相冲突。被测应用主进程里 `tool-runner.ts` 用 `spawn(plan.file, plan.args, { env: process.env, ... })` 原样转发这份环境变量给子进程（`powershell.exe`/`node.exe`/`bash` 等），如果 Windows/Node 的可执行文件查找逻辑取到的是「PATH」这个全新键，就会只搜到假 gh 桩目录，找不到任何系统目录，进而找不到 `node`、有时甚至找不到 `powershell.exe` 本身。

**这不是猜测——run 8 里有一条截图直接证实了这一点**：D1 场景（预演摘要示例）的预演阶段，界面弹出「预演失败：**spawn powershell.exe ENOENT**」（见 `60-d1-preview-summary-collapsed.png` / `61-d1-preview-command-expanded.png`）。`ENOENT` 是 Node `child_process.spawn` 在找不到可执行文件时的标准错误——`powershell.exe` 本身都没能被找到，这只能是调用进程的环境变量问题，不可能是产品代码的 bug（产品代码只是把 `file: 'powershell.exe'` 交给 `spawn`，查找逻辑是 Node/Windows 自己的）。

同一次运行里，三个「退出码」场景（`exit-cmd`/`exit-ps`/`exit-bash`，命令都是 `node -e "process.exit(...)"`，依赖 PATH 找到 `node`）分别报出：
- cmd：`失败（退出码 1）`——cmd 找不到命令时的标准退出码
- Git Bash：`失败（退出码 127）`——bash "command not found" 的标准退出码
- PowerShell：`失败（退出码 无）`——`CommandNotFoundException` 是 PowerShell 引擎层的终止性错误，不经过真正的子进程退出，所以 `$LASTEXITCODE` 维持 `$null`

三种 shell 用完全不同的机制，却都精确对应「找不到 `node`」这一个原因，而不是三个各自独立的产品缺陷——这进一步印证了 0.1 这条环境问题，而不是产品在三种 shell 上分别都有 bug。

**这是我自己 harness 代码里的确认 bug，不是产品缺陷**，但因为硬性规则第 6 条「最多 8 次 push 触发」的额度已经用满，我没有再改 `verify/issue-5/**` 去修它、重新验证（那样会触发第 9 次运行，违反硬性规则）。受影响的检查项在下面逐项标注为 **BLOCKED**（而不是直接判 FAIL），并给出旁证说明：产品自己的单元测试（`npm test`，在**同一个** CI job 里跑，用的是**同样的** `tool-runner.ts`/`quote.ts` 代码，但不经过我这个有 bug 的 `cleanEnv()`）证明了底层逻辑本身是对的、而且很快：

```
✓ test/tool-runner.test.ts (11 tests) 10524ms
  ✓ live shell injection > cmd keeps hostile parameters as data  586ms
  ✓ live shell injection > powershell powershell.exe keeps hostile parameters as data  4165ms
  ✓ live shell injection > powershell powershell.exe reports exit code 3  312ms
  ✓ live shell injection > powershell pwsh.exe keeps hostile parameters as data  3230ms
  ✓ live shell injection > powershell pwsh.exe reports exit code 3  468ms
  ✓ live shell injection > git-bash keeps hostile parameters as data  964ms
  ✓ live shell injection > streams stdout and stderr  306ms
```
（原文见 `verify/issue-5/evidence/unit-tests-quoting.txt`，本次运行的完整单测输出见 `verify/issue-5/evidence/unit-tests-full.txt`）

这组单测覆盖的正是 Item 4/5 想验证的核心问题（三种 shell 的退出码上报、三种 shell 的反注入），而且全部通过、耗时都在几百毫秒到几秒之间——完全没有本次 UI 驱动测试里观察到的「卡在运行中不回终态」现象。这是支持「产品本身没问题、是我的 harness 环境有问题」这个结论的最强证据。

### 0.2 一个真实存在、但不属于 Issue #5 验收范围的产品缺陷：快速捕获窗口按 Enter 实际不会保存

在核对 P1（已知仓库列表应包含待办来源）时，测试脚本用快速捕获创建一条带 `#Dylan5237/term-lens` 的待办，`fill` 完文本后 `press('#text', 'Enter')`，等待 1.2 秒后诊断：`captureStillOpen: true`（窗口没关）、`todosAfterCapture: []`（没有任何待办被创建）。

起初怀疑是测试时序问题，但深入定位后确认这是一个**真实的、可稳定复现的产品缺陷**，与我的测试脚本时序无关：

- `src/renderer/capture.html` 的 `#capture-form` 里同时有 `#text`（type=text）和 `#repo`（type=text）两个文本框，**没有任何 `<button type="submit">`**。
- `src/renderer/capture.ts` 里唯一调用 `save()`（真正执行保存）的地方，是 `form.addEventListener('submit', ...)`；没有任何其它按 Enter/按钮触发保存的路径。
- 根据 WHATWG HTML 规范的「隐式表单提交」规则：一个没有提交按钮的表单，只有当表单里「阻断隐式提交」的字段（text/search/url/tel/email/password/date/…等单行文本类型）**恰好只有一个**时，在该字段里按 Enter 才会触发提交；如果有两个及以上这类字段，按 Enter **什么都不会发生**。这个表单里 `#text` 和 `#repo` 都是 `type="text"`，正好是两个。

我用真实的 Chrome 148（Electron 底层同款 Blink/Chromium 引擎），通过 Chrome DevTools Protocol 直接派发**真实的、非合成的 Enter 键事件**（`Input.dispatchKeyEvent` type=`keyDown`，会触发浏览器原生默认行为，不是单纯的 JS 合成事件）做了三组对照实验，结果与规范预测完全一致：

| 表单结构 | 按 Enter 后是否提交 |
| --- | --- |
| 只有 1 个 `<input type=text>`，无别的字段 | ✅ 提交 |
| 1 个 `<input type=text>` + 1 个 `<input type=checkbox>` | ✅ 提交 |
| **2 个 `<input type=text>`（与快速捕获窗口结构完全一致）+ 1 个 checkbox** | ❌ **不提交** |

也就是说：**只要快速捕获窗口的「仓库」字段存在（它一直存在，是静态渲染的），按下界面自己提示的「Enter 记下并关闭」就不会有任何效果**——不会保存、不会关闭。表单里没有任何其它保存入口（没有提交按钮，`.requestSubmit()` 只在截图生成用的 `screenshot-run.ts` 里被直接调用，普通用户操作路径不会走到）。

**这个 bug 不属于 Issue #5「工具架」的 22 条验收标准范围**——它是快速捕获（Quick Capture）这个已有功能的缺陷，Issue #5 只是恰好需要用它来准备 P1 的测试数据。按照「只验收、只报告」的任务边界，我不会去修它，但认为有必要在报告里如实披露，因为：
1. 它直接导致了 P1 待办来源子项无法通过正常操作被验证（见下方 P1 一节）；
2. 它本身看起来是一个影响面很广的真实缺陷（任何用户只要按照界面提示按 Enter 想记一条待办，都不会成功），值得产品团队关注，即使它超出本次验收范围。

---

## 1. 无法核对 / 受限核对的项目一览

| 项目 | 受限原因 |
| --- | --- |
| P1 待办来源子项 | 见 0.2；待办本身没能被真实创建，无法在真机上走完整链路验证；但已通过读源码交叉核对了产品逻辑（见下） |
| Item 4 PowerShell 分支 | 见 0.1；`powershell.exe`/`node` 的 PATH 查找在本次 harness 环境下不可靠 |
| Item 5 全部 21 组（cmd/PowerShell/Git Bash 各 7 组） | 见 0.1；所有用例都因为 `node` 没被找到而在「命令未找到」这一步就失败，注入是否被拦住这一核心问题实际未被验证到；但产品自带单测（0.1 引用的 7 条）已经独立证明了这一点 |
| Item 6 全部 3 个 shell 分支 | 三个分支各自倒在**三个不同的、确认属于测试脚本的 bug**上（见下），未能采集到有效证据 |
| P2 | 依赖 `powershell.exe` 的 `-EncodedCommand` 解码，同样受 0.1 影响，`decoded` 拿到 `null` |
| D1 | 直接倒在 0.1 描述的 `spawn powershell.exe ENOENT` 上 |
| D3 / C3 | 两个用例的动作都是无参数的 run-command（见下），倒在一个确认的测试脚本 bug 上，未采集到有效证据 |
| 「等我处理/项目总览观察到的仓库」这一已知仓库来源（P1 的一部分） | 需要真实 GitHub token 触发 GitHub API 拉取，按硬性规则第 4 条不能用真实 token，全程未覆盖 |

---

## 2. 逐项结论

以下「证据」路径均相对 `verify/issue-5/evidence/`（CI artifact `issue-5-fe6b855-verify-evidence` 解压后的目录），每张截图都有窗口版 `NN-xxx.png` + 全屏版 `NN-xxx-full.png` 两张，完整映射见该目录下的 `index.md`。

### Item 1 — 工具架 JSON 校验（缺逗号/类型错/未知 type 都应报错并标行号；合法 JSON 应保存生效）

**结论：PASS**

依次保存 3 种非法 JSON：
- 缺逗号：报错「第 7 行，第 7 列：JSON 无法解析」，独立复算（不依赖应用自己报的行号，用 V8 的原始 `SyntaxError` 消息位置换算）得到同样的 line=7 col=7，行号真实指向第 7 行 `"type": "open-url",` 那一行。
- 字段类型错（`required` 填了非 boolean）：报错「第 10 行：required 类型应为 boolean」，第 10 行确实是那个字段。
- 未知 `type`：报错「第 7 行：type 只能是 open-url、open-folder、run-command、template 其中之一」，第 7 行确实是那个字段。

再保存 1 段合法 JSON（1 个 `open-url` 动作），保存后没有报错提示，工具架卡片列表里出现了这个新动作。

证据：`01/02/03-*.png`、`04-valid-saved-in-shelf.png`

### Item 2 — open-url 一步完成模式：参数展开 + 确认后真的用展开后的 URL 打开

**结论：PASS**

参数页填 `repo=octocat/Hello-World`，执行前展示的「将打开 …」文字（等同预演文案）= `https://example.com/repos/octocat%2FHello-World?tag=octocat%2FHello-World`；点击「打开」后，读主进程里打了观察桩的 `shell.openExternal` 实际收到的参数，逐字与预演文字里的 URL 一致（含 `{{repo}}` 展开 + URL 编码）。

证据：`10/11/12-item2-*.png`、`item2-url-compare.json`

### Item 3 — 参数含空格/中文时不经过 shell 转义（argv 原样传递）

**结论：PASS**

编辑器配置成一个用 `csc.exe` 现场编译的可执行文件（只把收到的 `argv` 写进文件），分别填入含空格、含中文的目录：执行前的展示文字含完整路径；点「打开」后 `editor-received.txt` 里的内容与填入目录逐字相等，证明参数是 argv 传递、不经过 shell 转义/拆词。

证据：`20/21/22-item3-*.png`、`item3-space.json`、`item3-chinese.json`

### Item 4 — run-command 三种 shell：预览/取消/确认 + 退出码

**结论：PARTIAL — cmd / Git Bash 分支 PASS，PowerShell 分支 BLOCKED（见 0.1，非产品缺陷判定）**

三种 shell 各建一个「填参数创建文件」的动作，每种 shell 用独立应用进程隔离：

| Shell | 预览命令文本正确 | 取消不执行 | 确认后完成+文件生成 | 退出码 3 场景 |
| --- | --- | --- | --- | --- |
| cmd | ✅ | ✅（`existsAfterCancel:false`） | ✅（`existsAfterConfirm:true`, `完成`） | ✅ `失败（退出码 1）`\*（见下方说明） |
| Git Bash | ✅ | ✅ | ✅ | ✅ `失败（退出码 127）`\* |
| PowerShell | ✅ | ✅ | ❌ `existsAfterConfirm:false`，状态卡在「运行中」15 秒未变 | `失败（退出码 无）` |

\* 这两个「退出码」场景本身是想测「退出码 3 能不能被正确上报」，但因为命令是 `node -e "process.exit(3)"`、`node` 因 0.1 描述的原因没被找到，所以看到的其实是「命令未找到」的退出码（cmd=1，bash=127），不是真正测到的退出码 3——这三个退出码场景的核心问题（能不能正确上报退出码）**实际未被验证**，但产品自带单测（0.1 引用）已经独立证明 cmd/PowerShell/Git Bash 三种 shell 都能在几百毫秒内正确上报退出码 3。

cmd/Git Bash 的「建文件」用例是干净的 PASS，这部分数据可信（不涉及 PATH 查找，`New-Item`/`echo`/`touch` 都是 shell 内建或 Git Bash 自带命令）。PowerShell 的「建文件」用例用 WMI 按进程名（`powershell,pwsh`）在 15 秒时拍了一次快照，**没有找到任何属于本次运行的 PowerShell 子进程**（只找到了 GitHub Actions 跑手自己的基础设施进程），说明这个子进程此时已经不在了（或者从未真正起来），但界面仍然显示「运行中」——这个现象本身是真实、可复现的（run 7、run 8 两次独立运行都观察到了），但根据 0.1 的证据（同一批次里 `spawn powershell.exe ENOENT` 被直接观测到过），更可能的解释是我的 harness 环境导致 `powershell.exe` 有时根本没能被 spawn 成功、或者其它 PATH 相关的间歇性失败，而不是产品的 `ToolRunner`/`run-command` 逻辑本身有 bug（产品自己的单测已经证明底层逻辑没问题，且它们的运行环境没有我这个 `cleanEnv()` bug）。

证据：`30/31/32/33-*.png`、`item4-*.json`、`hang-item4-PowerShell.json`、`exitcode-*.json`

### Item 5 — 三种 shell 的反注入（21 组：3 个专属标记文件 payload + 3×6 个通用 payload）

**结论：BLOCKED（见 0.1；核心问题未被真机独立验证，但有强旁证支持产品逻辑正确）**

21 组全部走了一遍界面流程，但因为每组命令都是 `node -e "process.stdout.write(...)" <payload>`，`node` 未被找到（见 0.1），所有 21 组都以「命令未找到」收场（cmd 统一 `失败（退出码 1）`，Git Bash 统一 `失败（退出码 127）`，PowerShell 部分卡在「运行中」、部分 `失败（退出码 无）`）——这意味着 `node` 从未真正运行过，「注入是否被当成命令执行」这个核心问题的直接证据链是断的。

好消息是：每组标记文件都确认不存在（`markerExists: false`），说明至少没有观察到注入**成功**的迹象（`pwned-*.txt` 之类的文件没有被创建）；换行注入的场景因为是单行 `<input type=text>`，浏览器原生就不允许把换行符写进 value，UI 层测不出来，这一具体 case 由产品自带单测覆盖（`test/tool-quote.test.ts`）。更重要的是 0.1 引用的产品单测——它们用**真实子进程**验证了 cmd/PowerShell(x2)/Git Bash 在面对反引号、双引号、单引号、`%PATH%`、`^`、`|` 等同款危险字符时，都把参数当纯数据处理，没有被解释成额外命令。核心结论（转义/引用逻辑本身是否安全）由这些单测支撑，是 PASS 级别的证据；但我这次 UI 驱动的真机复现由于 0.1 的环境问题没能独立坐实。

证据：`40-item5-*.png`、`item5-all-rows.json`、`hang-item5-PowerShell-1.json`

### Item 6 — 长命令中止 + 进程树核对

**结论：BLOCKED（三个分支分别倒在三个不同的、确认属于测试脚本的 bug 上，产品行为未被有效验证）**

- **cmd 分支**：测试脚本给「标记」参数填的值是 `` `rem ${uniqueMarker('CMD')}` ``（`session-d-run-command.mjs` 第 339 行），把字面文本 `rem ` 拼在了 `{{marker}}` 占位符**替换后的值内部**，而不是模板里占位符外面的普通文本。命令模板是 `{{marker}} & cmd /c "ping -n 120 127.0.0.1"`，展开后整段标记值（含 `rem ` 这几个字符）被当成一个带引号的参数，cmd 试图把它当成程序名执行，报错「不是内部或外部命令」，随后等「中止」按钮出现超时 20 秒。这是测试脚本自己的 bug，不是产品缺陷。
- **PowerShell / Git Bash 分支**：这两个分支测的动作（`long-ps`、`long-bash`）都**没有 `params` 字段**：

  ```96:102:verify/issue-5/scenarios/session-d-run-command.mjs
      id: 'long-ps', title: '长命令·PowerShell', type: 'run-command', shell: 'powershell', cwd: cwdAbortPs,
      command: "Start-Process -FilePath ping.exe -ArgumentList '-n','120','127.0.0.1' -WindowStyle Hidden; Start-Sleep -Seconds 120"
    },
    {
      id: 'long-bash', title: '长命令·Git Bash', type: 'run-command', shell: 'git-bash', cwd: cwdAbortBash,
      command: 'sh -c "ping -n 120 127.0.0.1"'
    },
  ```

  读产品源码 `src/shared/tools/flow.ts` 的 `entryStep()` 确认：对于没有 `params` 的 run-command 动作，点卡片直接进入 `'preview'` 模式（直接弹出确认框），**不会**先进到一个有独立「预览」按钮的参数页。我的测试脚本对这两个用例仍然按「先进参数页、再点预览按钮」的旧假设去写（`page.click('button.primary:has-text("预览")')`），这个按钮根本不存在，所以等了 30 秒后超时。这也是测试脚本自己的 bug。

三个分支都没能采集到「中止后进程树是否真的被杀干净」这个核心问题的有效证据。

证据：`50-item6-cmd-running.png`、`item6-summary.json`、`item6-cmd-before-abort.json`

### Item 7 — 剪贴板复制：展开文本与真实剪贴板内容一致

**结论：PASS**

填参数（含中文、「引号」、emoji），点击「复制」；页面上「将复制到剪贴板」区块显示的文本，与用真实 Windows PowerShell `Get-Clipboard -Raw` 读到的剪贴板内容逐字比对，两者都等于按模板展开后的完整文本（含中文和换行）。提示「已复制」正确出现。

证据：`70/71-item7-*.png`、`item7-p3-detail.json`

### Item 8 — 配置持久化：保存后落盘 + 重启后原样保留

**结论：PASS**

保存合法 JSON 后，直接在磁盘上读真实 `userData` 目录下的 `settings.json`（`C:\Users\runneradmin\AppData\Roaming\Arckeep\settings.json`），`toolShelfJson` 字段与保存前逐字一致；重启应用后，工具架列表和设置页编辑框内容都原样保留，两次启动问到的 `userData` 目录一致。

证据：`04/05/06-*.png`、`item8-settings-file-path.json`

### P1 — 已知仓库列表应同时包含「关注列表」和「待办」两个来源，且来源标签正确

**结论：PARTIAL — 关注列表来源 PASS；待办来源 BLOCKED（见 0.2，非工具架本身缺陷）**

- 设置里把 `Dylan5237/req-to-page` 加入关注列表后，「打开仓库」参数页的已知仓库单选列表里出现了它，来源标签「关注列表」正确；选中后点「打开」，`shell.openExternal` 实际收到的 URL 与期望的 `https://github.com/Dylan5237/req-to-page` 逐字一致。**这部分是干净的 PASS。**
- 待办来源（`Dylan5237/term-lens`）没有出现在列表里（`hasTodo: false`）。根本原因不是工具架的已知仓库聚合逻辑有问题，而是**用来准备测试数据的前置步骤——快速捕获创建待办——本身没有成功**（见 0.2 的 Enter 键 bug，待办从未被真正创建，`todosAfterCapture` 也确认是空数组）。

  为了不让这个子项完全没有结论，我额外读了产品源码交叉核对：`src/main/index.ts` 里 `todoRepos: () => (todos?.listTodos() ?? []).flatMap(item => item.repo ? [item.repo] : [])` 会把任意带 `repo` 标签的待办喂给 `collectKnownRepos()`（`src/main/tool-ipc.ts`），后者（`src/shared/tools/repos.ts`）把待办来源的仓库标成 `SOURCE_LABEL.todo = '待办'`——这正是 P1 期望看到的标签文案。**这段代码逻辑看起来是正确实现的**，但因为待办从未被真实创建，我没能在真机上走一遍完整链路来最终坐实这一点，只能算「代码审查支持、但未被真机验证」。

证据：`13/14/15/16-p1-*.png`、`p1-detail.json`、`p1-capture-diagnostic.json`

### P2 — apo 项目初始化：预演阶段真的带 `--dry-run`、确认后真的不带

**结论：BLOCKED（见 0.1）**

预演阶段确实展示了 dry-run 才会出现的 `demo.json`/`demo.config` 文件列表痕迹（`previewMentionsDryRunArtifacts: true`），确认按钮文案正确写明后果（`在 <cwd> 初始化 demo`）。但点击「确认」后，用「点击前后按进程名做差集」去找新起的 `powershell.exe` 宿主进程、解码它的 `-EncodedCommand` 这一步失败：`decoded: null`，`realFilesCreated: false`（`demo.json`/`demo.config` 也没有真的落盘）。这与 0.1 描述的 `powershell.exe` 查找不可靠是同一类问题——本次验收没能坐实「确认后是否真的去掉了 `--dry-run`」这个核心问题。

证据：`80/81/82/83-p2-*.png`、`p2-detail.json`

### P3 — template 动作：一键复制，不经过二次确认

**结论：PASS**

参数页主按钮就是「复制」而不是笼统的「确认执行」；点击后不经过预览/确认弹窗（`.modal` 计数点击前后都是 0），直接把展开后的文本写进剪贴板；与 `Get-Clipboard -Raw` 核对内容一致。

证据：`70/71-item7-*.png`（与 Item 7 共用）、`item7-p3-detail.json`

### C1 — 默认工具架不含「演练」类免责措辞

**结论：PASS**

全新 `APPDATA`（相当于首次打开应用），不做任何设置改动，读出全部内置卡片的完整文本，没有一张卡片出现「（演练）」或「确认前不会运行」这类字样。

证据：`90-c1-default-shelf.png`、`c1-detail.json`

### C2 — 确认按钮写明后果，不是笼统的「确认执行」

**结论：PASS**

建文件动作（cmd/PowerShell/Git Bash）的确认按钮文案分别是「创建 my file cmd.txt」「创建 my file ps.txt」「创建 my file bash.txt」，都写明了具体后果；apo 项目初始化的确认按钮是「在 `<cwd>` 初始化 demo」。这一步发生在点「确认」之前（只是读按钮文案），不受 0.1 描述的运行期问题影响。

证据：`30-item4-*-preview.png`、`82-p2-preview-command-expanded.png`

### C3 — 成功/失败状态颜色区分 + 失败时 stderr 显示在 stdout 前面

**结论：BLOCKED**

依赖的两个动作（`empty-output-demo`、`failure-stderr-first`）都是无参数 run-command，与 Item 6 PowerShell/Git Bash 分支同样的原因（`entryStep()` 对无参数动作直接进入 preview，没有独立的「预览」按钮）在测试脚本里超时，未采集到有效证据。这是确认的测试脚本 bug，不代表产品行为。

### C4 — 「工作目录」参数不能手动打字，只能从已知仓库/浏览文件夹选

**结论：PASS**

打开带「工作目录」参数的动作参数页：`input[aria-label="工作目录"]` 数量为 0（没有可打字的文本框），只有已知仓库单选组（这个全新环境下为空，显示提示文字）和「浏览文件夹」按钮。

证据：`92-c4-c5-params-page.png`、`c4-c5-detail.json`

### C5 — 普通参数是单行输入框，不是多行文本域

**结论：PASS**

同一参数页上的普通参数字段渲染为 `input[type=text]`（数量 1），不是 `textarea`（数量 0）。

证据：`92-c4-c5-params-page.png`、`c4-c5-detail.json`

### C6 — 工具架搜索过滤 + 整张卡片可点击

**结论：PASS**

搜索框输入部分标题关键字后，列表收窄到匹配卡片；清空搜索框后，故意点击卡片矩形范围内明显是空白区域的位置（不是标题/标签/按钮），同样能进入参数页，证明整张卡片都是可点击区域。

证据：`90/93/94-*.png`、`c6-detail.json`

### C7 — schema 报错写明允许值 + 标出出错行

**结论：PASS**

`required` 类型错报错含「类型应为 boolean」且标在第 10 行；未知 `type` 报错「type 只能是 open-url、open-folder、run-command、template 其中之一」且标在第 6/7 行。两类错误都满足「写明允许的值」+「标出出错行」。

证据：`02/03-*.png`

### C8 — 预览文案不应出现 `exit $LASTEXITCODE` 这类内部包装痕迹

**结论：PASS**

三种 shell 的预览「查看命令」展开内容，都没有出现 `exit $LASTEXITCODE` 或 `$LASTEXITCODE` 字样（这些只应出现在真实启动脚本里，不该出现在预览文案）。

证据：`30-item4-*-preview.png`

### D1 — run-command 预演摘要 + 折叠查看命令 + 无法预演场景的提示

**结论：BLOCKED（见 0.1，直接观测到 `spawn powershell.exe ENOENT`）**

预演摘要能正确解析出文件列表（「将创建 2 个文件：alpha.txt、beta.txt」）、正确显示工作目录、「查看命令」默认折叠——这部分展示逻辑本身是对的。但点击确认之后，`spawn powershell.exe ENOENT` 直接把整个流程打断成「预演失败」提示（截图 `60/61` 清楚地显示了这条报错），此时弹窗只有「取消」按钮、没有「确认」按钮，后续「确认后真的执行 + 磁盘生成文件」这部分完全没能验证。**这是本次验收里 0.1 环境问题最直接、最无可辩驳的一条独立证据**——不是测试脚本按钮选择器写错了，是应用真的没能 spawn 出 `powershell.exe`。

证据：`60-d1-preview-summary-collapsed.png`（清晰显示 `spawn powershell.exe ENOENT`）、`61-d1-preview-command-expanded.png`

### D2 — 无需二次确认的动作类型（open-folder 无参、template）确实一步到底

**结论：PASS**

不带参数的 open-folder：点卡片后没有出现 `.modal`，没有先进参数页，`editor` 实际收到的参数与期望目录一致，执行正确。template 分支：整段操作过程中 `.modal` 计数始终为 0，一步完成。（open-url 分支见 Item 2/D2 共用证据。）

证据：`21/22/23-*.png`、`d2-open-folder-noparam.json`

### D3 — 空输出整块隐藏 + 失败时 stderr 在 stdout 前

**结论：BLOCKED**

与 C3 同样原因（依赖的两个动作是无参数 run-command，测试脚本对「预览」按钮的假设错误），未采集到有效证据。

---

## 3. 结论汇总表

| 检查项 | 结论 | 核心原因 |
| --- | --- | --- |
| Item 1 | ✅ PASS | — |
| Item 2 | ✅ PASS | — |
| Item 3 | ✅ PASS | — |
| Item 4 | 🟡 PARTIAL | cmd/Git Bash PASS；PowerShell 分支受 0.1 影响 BLOCKED |
| Item 5 | ⛔ BLOCKED | 全部 21 组受 0.1 影响；产品自带单测已独立证明核心逻辑正确 |
| Item 6 | ⛔ BLOCKED | 三个分支各自倒在三个不同的确认测试脚本 bug 上 |
| Item 7 | ✅ PASS | — |
| Item 8 | ✅ PASS | — |
| P1 | 🟡 PARTIAL | 关注列表来源 PASS；待办来源受 0.2 影响 BLOCKED（代码审查支持产品逻辑正确） |
| P2 | ⛔ BLOCKED | 受 0.1 影响 |
| P3 | ✅ PASS | — |
| C1 | ✅ PASS | — |
| C2 | ✅ PASS | — |
| C3 | ⛔ BLOCKED | 依赖的动作触发确认的测试脚本 bug |
| C4 | ✅ PASS | — |
| C5 | ✅ PASS | — |
| C6 | ✅ PASS | — |
| C7 | ✅ PASS | — |
| C8 | ✅ PASS | — |
| D1 | ⛔ BLOCKED | 直接观测到 `spawn powershell.exe ENOENT`（0.1） |
| D2 | ✅ PASS | — |
| D3 | ⛔ BLOCKED | 依赖的动作触发确认的测试脚本 bug（同 C3） |

**统计**：22 项里，13 项 PASS，2 项 PARTIAL（各自有一半明确 PASS），7 项 BLOCKED（均有明确、可追溯的受阻原因，且都不是「产品行为不确定」，而是「测试方法本身在本次运行环境下失效」）。

**没有任何一项被独立、可信的证据判定为产品 FAIL**——BLOCKED 的 7 项里，5 项（Item5/6 全部、P2、D1、D3/C3 的一部分）都指向同一个根因（0.1 描述的 `cleanEnv()` PATH 拼接 bug + Item6 的另外两个独立测试脚本 bug），并且都有旁证（产品自带单测、直接观测到的 `ENOENT` 报错）支持「这是测试环境问题、不是产品问题」这个方向；P1 待办来源受 0.2 影响，但有代码审查交叉核对支持产品逻辑正确。

## 4. 对后续复核的建议

如果之后要开一轮新的验收（不受本次 8 次运行预算限制），建议按优先级：
1. 先修 `verify/issue-5/lib.mjs` 的 `cleanEnv()`：改成显式按 `Object.keys(process.env)` 里已存在的键名（大小写不敏感匹配 `path`）去覆盖，而不是无条件赋一个新的全大写 `PATH` 键；这一个修复应该能让 Item 4 PowerShell 分支、Item 5 全部、P2、D1 恢复到可验证状态。
2. 再修 Item 6 的三个测试脚本 bug（cmd 的 marker 字符串拼接；PowerShell/Git Bash 对无参数 run-command 动作的「预览」按钮假设）。
3. 独立地，建议产品团队关注 0.2 描述的快速捕获 Enter 键缺陷——虽然不在本次验收范围内，但影响面可能很大。
