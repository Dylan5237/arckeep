# Arckeep Issue #1「骨架 + CI + Windows 打包」独立验收报告

- **验收方角色**：独立验收（只验收、只报告，不改产品代码；只在 `verify/issue-1` 分支新增 `.github/workflows/verify-issue-1.yml` 与 `verify/**`）
- **报告写成时间**：2026-09-28 18:37（北京时间，UTC+8）
- **被测 PR**：[#8 "#1 骨架 + CI + Windows 打包"](https://github.com/Dylan5237/arckeep/pull/8)（已合并）
- **被测 head SHA**：`fef78d58ce1cd879472afded059ea0830c8fb358`（下称 `fef78d5`）
- **合并提交（main）**：`699736cea1a51abb2b65ee58af6c3f85e7660022`（下称 `699736c`）
- **tree 一致性核对**：`git rev-parse fef78d5^{tree} 699736c^{tree}` 两者均为 `fc485eccbedf3fb70a4d0b901319dafc799d3504` —— **一致**。`699736c` 是 `fef78d5` 的纯合并提交，没有额外改动。
- **冒烟产物来源**：CI run [`36407287806`](https://github.com/Dylan5237/arckeep/actions/runs/36407287806)（`event=pull_request`，`head_sha=fef78d5`，`conclusion=success`）
  - `arckeep-windows`：`Arckeep-Setup-0.1.0.exe`（NSIS 安装包）+ `Arckeep-0.1.0-portable.exe`（portable）
  - `arckeep-win-unpacked`：`arckeep-win-unpacked.zip` → `win-unpacked/Arckeep.exe`
  - SHA256（本次验收 run 里 `Get-FileHash` 现算，见 `00-exe-sha256.txt`）：
    | 文件 | SHA256 |
    |---|---|
    | `win-unpacked/Arckeep.exe` | `AD51406F3D652B409F1EA8A17B5617A8EC251C68CAF643E37A1EEA7845BEEC18` |
    | `Arckeep-0.1.0-portable.exe` | `40CCEE64864F31F7E17D564613AB5A98956B360D5C90A1AC94966F5D6E58BA7A` |
    | `Arckeep-Setup-0.1.0.exe` | `92624B3A596325C83F58DBFF29E3B3E2AFF81B9648A923A30474412875E4372D` |
- **验收 workflow run（Windows 冒烟）**：<https://github.com/Dylan5237/arckeep/actions/runs/36409794693>（`verify-issue-1`，push 到 `verify/issue-1`，`conclusion=success`，第 2 次推送即跑通，共用了 8 次预算里的 2 次：第 1 次是权限探测）
- **证据 artifact**：`verify-issue-1-evidence-fef78d5` — <https://github.com/Dylan5237/arckeep/actions/runs/36409794693/artifacts/10964290813>

## 0. 无法核对的项目（验收环境限制，如实说明）

本验收方使用的 GitHub �) App 安装令牌**没有 `issues:read` 权限**：

```
$ gh api repos/Dylan5237/arckeep/issues/1
{"message":"Resource not accessible by integration","documentation_url":"https://docs.github.com/rest/issues/issues#get-an-issue","status":"403"}
$ gh issue view 1 --comments
GraphQL: Could not resolve to an issue or pull request with the number of 1. (repository.issue)
$ gh issue list --repo Dylan5237/arckeep --state all
GraphQL: Resource not accessible by integration (repository.issues)
```

同样的令牌**能**读取 PR（`pull-requests:read`），包括 PR 上的 issue-comment（`gh api repos/.../issues/8/comments` 成功），说明这不是账号问题，而是这个 App 安装本身没有勾选 Issues 权限。按硬性规则「遇到权限问题不要绕过」，本报告**没有**尝试用其它 token 或方式读取 Issue #1 正文/评论，也没有更换凭证。

**处理方式**：改用 PR #8 描述里的「怎么验证」小节（9 条勾选项，逐字对应 Issue #1 正文,来源见 PR #8 body）作为验收标准的文本依据；随附的验收清单附件（`issue1-checklist.md`）里对 Issue #1 正文的转述与 PR #8 的 9 条勾选项逐一吻合，交叉印证。**如果 Issue #1 正文与 PR #8 的转述有出入，本报告的判定可能需要重新核对**，这一点请工程方或 Dylan 确认。

## 1. AC1 / AC2（只读核对）

### AC1：PR 自动触发 CI，lint/typecheck/test 三步都执行并通过；故意 lint 错误的 PR 会让 CI 变红（PR 里附 run 链接）

- Run `36407287806`（`fef78d5`，`pull_request`）：`windows-latest`、`ubuntu-latest` 两个 job 都有 `lint`→`typecheck`→`test` 三个独立 step，均 `conclusion=success`。日志摘录（windows-latest）：
  ```
  > arckeep@0.1.0 lint
  > eslint .
  > arckeep@0.1.0 typecheck
  > tsc -p tsconfig.main.json --noEmit && tsc -p tsconfig.renderer.json --noEmit
  > arckeep@0.1.0 test
  > vitest run
  ...
   Test Files  12 passed (12)
        Tests  43 passed (43)
  ```
  `windows package` job（`needs: windows`）在 lint 通过后执行 `npm run dist`，上传了 `arckeep-windows` 与 `arckeep-win-unpacked`，均 `conclusion=success`。
- `.github/workflows/ci.yml`（@`699736c`）：触发条件 `on: push: branches: [main]` + `pull_request`；三步都没有 `continue-on-error`，命令没有 `|| true`（唯一带 `continue-on-error: true` 的是 `windows package` job 里额外的「Launch unpacked smoke」冒烟步骤，不是 lint/typecheck/test 三步之一）。
- 故意 lint 错误：PR [#9](https://github.com/Dylan5237/arckeep/pull/9)（`test/ci-lint-red`，head `fada735`，未合并已关闭），run [`36407721575`](https://github.com/Dylan5237/arckeep/actions/runs/36407721575)：`conclusion=failure`，两个 job 都在 `lint` 步骤失败，`typecheck`/`test`/`windows package` 全部 `skipped`。日志：
  ```
  D:\a\arckeep\arckeep\src\main\lint-canary.ts
  ##[error]  3:3  error  Unexpected 'debugger' statement                    no-debugger
  ##[error]  4:3  error  Unexpected var, use let or const instead           no-var
  ##[error]  4:7  error  'unused' is assigned a value but never used...      @typescript-eslint/no-unused-vars
  ✖ 3 problems (3 errors, 0 warnings)
  ##[error]Process completed with exit code 1.
  ```
- run 链接是否写进了 PR：PR #8 **描述**里写的是占位语「会在补上一次 lint 错误提交后把链接写在这里」，链接没写进描述；但 Dylan（`OWNER`）在 PR #8 上发了一条**评论**（2026-09-28T10:08:51Z = 18:08:51 北京时间）：
  > CI 变红验证（#1 第 2 项）：故意带 lint 错误的 PR #9 在 https://github.com/Dylan5237/arckeep/actions/runs/36407721575 失败，windows-latest 和 ubuntu-latest 都卡在 `lint` 步骤，打包任务被跳过。Release 验证（tag `v0.0.1-test`）https://github.com/Dylan5237/arckeep/actions/runs/36407712335 还在跑，结果出来再补。

  按验收提示词的口径（「如果只能在 #9 的 checks 里看到、描述里没有链接，判 PASS（附注：链接没写进 PR 描述）」）：链接**确实**出现在 PR #8 上（评论而非描述），比提示词假设的最差情形更好。**判 PASS，附注：链接在 PR #8 的评论里，不在描述正文里**。

- `gh pr list --state all`：仓库里只有 #8、#9 两个 PR，均有 `event=pull_request` 的自动触发 run，无需手动 `workflow_dispatch`。

**结论：PASS**

### AC2：推测试 tag（`v0.0.1-test`）后，windows-latest 打包 job 成功，Release 附件里有 `*Setup*.exe` 和 portable `*.exe`

- `gh release view v0.0.1-test` → `release not found`（截至 2026-09-28 18:36 北京时间，Release **不存在**）。
- 对应打包 run [`36407712335`](https://github.com/Dylan5237/arckeep/actions/runs/36407712335)（`push`，`head_branch=v0.0.1-test`，`head_sha=699736c`）：**`conclusion=failure`**（不是「还在跑」——本报告核对时该 run 已经跑完并失败，比验收清单附件里 17:36 记录的「18:09 还在跑」更新）。`lint`/`typecheck`/`test` 三步 success，但 `Build NSIS installer and portable exe` 步骤失败，`Publish GitHub Release` 被 `skipped`：
  ```
  • building        target=portable file=dist\Arckeep-0.1.0-portable.exe archs=x64
  • signing with signtool.exe  path=dist\Arckeep-0.1.0-portable.exe
    ⨯ GitHub Personal Access Token is not set, neither programmatically, nor using env "GH_TOKEN"
  ##[error]Process completed with exit code 1.
  ```
  更早的日志里有一行关键线索：
  ```
  • Implicit publishing triggered by git tag. This behavior will be disabled in electron-builder v27. Please use --publish explicitly.  tag=v0.0.1-test
  ```

**根因（产品缺陷，详见第 4 节）**：`.github/workflows/release.yml` 只在**「Publish GitHub Release」**这一步注入了 `GH_TOKEN: ${{ github.token }}`；而更早的**「Build NSIS installer and portable exe」**步骤执行 `npm run dist`（即 `electron-builder --win`，未带 `--publish never`）。electron-builder 26.x 检测到当前 ref 是 `v*` 格式的 git tag，就会**隐式**尝试发布（打包阶段就要用 token 签发 publish 相关的元数据），而这一步的环境里没有 `GH_TOKEN`，导致打包本身失败,连 NSIS/portable exe 都没生成，Release 从未被创建。

**结论：FAIL**（不是 BLOCKED——已有确定性的失败日志和「release not found」的确定性证据，不是「还没跑完」）

## 2. Windows 冒烟验收（AC3–AC9、X1–X6）

验收 workflow：`.github/workflows/verify-issue-1.yml`，只在 push 到 `verify/issue-1` 时触发；下载 run `36407287806` 的两个 artifact 前先核对 `run.head_sha == fef78d5`（脚本里写了 `throw`，核对通过）；被测应用启动环境去掉了 `GH_TOKEN`/`GITHUB_TOKEN`；全程只用假 token `ghp_Vf9QzXk2LmP4rT8wYb6nHc3JdA1sE7uG0oKi`。

- 第 1 次推送：仅探测「push 新 workflow 文件」是否被 GitHub App 权限拒绝——**未被拒绝**，run [`36408808526`](https://github.com/Dylan5237/arckeep/actions/runs/36408808526) 正常触发并成功。
- 第 2 次推送：完整验收脚本（`verify/run-all.ps1` + `verify/smoke.mjs`），run [`36409794693`](https://github.com/Dylan5237/arckeep/actions/runs/36409794693)，**一次性跑通**，`scenes.json` 里 27 个场景全部 `PASS`（无 FAIL）。
- 第 3 次推送：只是把这份报告文件加进分支（没有改验收脚本），但 `on: push: branches: ['verify/issue-1']` 对任何推送都会重新触发整套 Windows 冒烟——run [`36411183904`](https://github.com/Dylan5237/arckeep/actions/runs/36411183904) 又完整跑了一遍，结果与第 2 次一致（`conclusion=success`）。尝试过 `gh run cancel` 去省分钟，被拒绝（`HTTP 403: Resource not accessible by integration`，GitHub App 没有 `actions:write`），按硬性规则没有绕过，让它跑完。**Actions 分钟预算：8 次里用了 3 次（第 1 次只是权限探测）。**

所有截图和原始数据都在证据 artifact `verify-issue-1-evidence-fef78d5` 里（<https://github.com/Dylan5237/arckeep/actions/runs/36409794693/artifacts/10964290813>），文件名与 `evidence/index.md` 对照见本报告末尾清单。

### AC3：干净 Win10/11 装安装包 / portable 双击启动

- **安装包**：`Start-Process Arckeep-Setup-0.1.0.exe -ArgumentList '/S' -Wait` → `exitCode=0`；`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Arckeep.lnk` 存在，`WScript.Shell` 解析出的 `TargetPath` 为 `C:\Users\runneradmin\AppData\Local\Programs\Arckeep\Arckeep.exe`，该路径确实存在；启动后 20 秒 `Get-Process Arckeep` 有进程（截图 `22-ac3-installed-launch.png`）。
- **portable**：不带参数 `Start-Process Arckeep-0.1.0-portable.exe`，30 秒后 `Get-Process Arckeep` 返回 4 个 pid（Electron 多进程模型下同名进程，非多开），`MainWindowTitle="Arckeep"`；再等 5 秒进程仍在（`aliveAfter20s: true`，见 `20-ac3-portable.json`，截图 `20-ac3-portable.png`）。
- **崩溃检查**：冷启动前后 `%APPDATA%\Arckeep\Crashpad\reports` 均为空目录（`01-launch` 场景记录 `crashReportsBefore: [] / crashReportsAfter: []`）；Application 事件日志 1000/1001/1026 的 Arckeep 相关事件查询脚本本次跑出空结果（`19-eventlog-arckeep.txt` 为空），**这个查询脚本本身的行为需要在后续迭代里再确认一次是否总是能正确区分「无事件」和「查询失败」——本报告不能仅凭这一空文件断言事件日志绝对干净，但结合 Crashpad 目录始终为空、进程存活秒数达标，没有观察到任何崩溃迹象**。
- **README**（@`699736c`）确认写清了 SmartScreen 步骤，原文：
  > 双击 exe。安装包没有代码签名，SmartScreen 会提示风险：点「更多信息」，再点「仍要运行」。

**结论：PARTIAL**（CI 代理测试全部通过；按产品经理决定，仍需 Dylan 在真实干净的 Win10/11 上补验一次开始菜单和双击体验）

### AC4：左侧导航顺序 + 点击切换

- `boundingBox()` 核对：`inbox`(y=108.2) → `projects`(y=154.7) → `todos`(y=201.2) → `tools`(y=247.7)，`settings`(y=622.5) 在最下方；全部 `x=14`，明显在窗口左侧（`orderOk: true, allLeft: true`）。
- 依次点击四个模块 + 设置，每次点击后 `#content h1` 的文字都切换为对应标题（`等我处理`/`项目总览`/`待办`/`工具架`/`设置`），截图 `02-nav-waiting.png`…`05-nav-toolshelf.png`、`06-settings-empty.png`。

**结论：PASS**

### AC5：GitHub 认证（gh CLI / PAT / 错误 token）

- **5a（gh 已登录显示「来源：gh CLI」+ Dylan5237）**：按产品经理决定**固定判 PARTIAL**。本次只验证了「runner 上 gh 未登录时,没有误显示来源：gh CLI」——冷启动后 `sourceLabel === '未配置'`（场景 `AC5-empty`），不是误报的 `gh-cli`。覆盖这条路径的单测：
  - `test/settings-service.test.ts` › `uses gh CLI when it is logged in, and a saved PAT otherwise`（用 mock `readGh`/`fetchImpl` 断言 `sourceLabel: '来源：gh CLI'`、`testConnection()` 返回 `login: 'Dylan5237'`）
  - `test/github-auth.test.ts` › `prefers gh CLI and otherwise uses a saved PAT`
  这些用例都在 run `36407287806` 的 `test` 步骤里执行过（该步骤 `Tests 43 passed (43)`，包含全部 12 个测试文件）。
- **5b（gh 不在 PATH → 出现 PAT 输入框，能粘贴保存）**：验收 runner 上 `gh CLI` 默认未登录（等效于「不可用」），设置页始终渲染 PAT 密码输入框（`renderGithubCard` 无条件渲染）；粘贴假 token 点「保存 PAT」后，`sourceLabel` 变为 `来源：本机 PAT`，`patSaved=true`，输入框保存后清空（`AC5b-pat-path` 场景）。**「测试连接成功显示 Dylan5237」这部分需要真实 PAT，按硬性规则不使用真实 token，未测**，整条最多判 PARTIAL。
- **5c（错误 token → 明确提示，不崩溃，必须实测）**：粘贴假 token 点「测试连接」，5 秒内出现红色提示：
  > 这个 token 无效或已过期（HTTP 401）。请重新生成 PAT，或执行 gh auth login 后再试。

  点击后输入框内容仍是完整的假 token（`tokenKeptInField: true`）；`Get-Process Arckeep` 确认进程存活（`processAlive: true`）；Crashpad 目录全程为空。截图 `07-settings-invalid-token.png`。

**结论：PARTIAL**（5c 已实测 PASS；5a 按产品经理决定固定 PARTIAL；5b 因禁用真实 token 只验证了一半）

### AC6：`%APPDATA%\Arckeep\` 下 `findstr /s` 搜不到 token

- 保存假 token 后，通过 `__ARCKEEP_TEST_HOOKS__.quit()`（AC8 同一条退出路径）正常退出，确认进程全部结束，再执行：
  ```
  findstr /s /m /c:"ghp_Vf9Q" "%APPDATA%\Arckeep\*"   → exitCode=1，无输出
  findstr /s /m /c:"Vf9QzXk2" "%APPDATA%\Arckeep\*"   → exitCode=1，无输出
  ```
  UTF-16 参考搜索（`Select-String -Encoding Unicode`）匹配数 = `0`。
- `settings.json`（副本见 `17-settings.json.copy.json`）里 `patCiphertext` 是一段 Base64 密文（`"djEwcURJUZ18iQrZAXTQA684m13NM1F9bRFt2imLYzs4mhjMQpCxn+..."`），不包含明文 token 前缀；文件确实位于 `C:\Users\runneradmin\AppData\Roaming\Arckeep\settings.json`（即 `%APPDATA%\Arckeep\settings.json`）。

**结论：PASS**

### AC7：加 2 个关注仓库 + 改热键，托盘退出再启动，设置还在

- 清空数据目录后冷启动，添加 `octocat/Hello-World`、`Dylan5237/arckeep`，热键改为 `Ctrl+Alt+Shift+A`（空闲组合，保存时无冲突提示）；截图 `13-settings-repos-hotkey-saved.png`。
- 通过 `__ARCKEEP_TEST_HOOKS__.quit()` 退出（与托盘「退出」走同一组函数，见下方 AC8 的源码引用），1085ms 内 `Get-Process Arckeep` 变为空列表。
- 重新启动（不清空数据目录），进入设置页：`repoListText` 含两个仓库，`hotkeyInput === 'Ctrl+Alt+Shift+A'`，`sourceLabel === '来源：本机 PAT'`（附加检查：假 token 重启后仍显示「已保存」，来源仍是 PAT，符合「打码显示、来源为 PAT」的附加要求）。截图 `18-settings-after-restart.png`。

**结论：PASS**

### AC8：关窗口留在托盘；托盘菜单能重新打开/退出

- **源码引用**（只读，确认钩子和托盘菜单调用同一组函数）：

  ```74:80:src/main/index.ts
  function trayActions(): TrayActions {
    return {
      closeWindow: closeMainWindow,
      showWindow: showMainWindow,
      quit: quitFromTray
    }
  }
  ```

  托盘菜单（`88:89:src/main/index.ts`）：`{ label: '打开', click: () => showMainWindow() }`、`{ label: '退出', click: () => quitFromTray() }`；测试钩子在 `installTestHooks()`（`95:113:src/main/index.ts`）里把同一个 `trayActions()` 对象传给 `installTrayTestHooks`，`close`/`show`/`quit` 分别对应 `closeMainWindow`/`showMainWindow`/`quitFromTray`——**是同一组函数引用，不是重新实现的一套逻辑**。
- **实测（走钩子路径，等价于点击托盘菜单）**：
  - `close`：`isVisible()` 变为 `false`，`Get-Process Arckeep` 仍在（`AC8-close-hook`：`visible:false, stillRunning:true`）；全屏截图 `14-hook-close-fullscreen.png` 确认桌面上看不到窗口。
  - `show`：`isVisible()` 恢复 `true`（截图 `15-hook-show.png`）。
  - 命令行二次实例转交：应用运行中再启动一次 `Arckeep.exe --arckeep-test=close`（带 `ARCKEEP_TEST_HOOKS=1`），新进程 179ms 内退出（`secondProcessExitCode: 0`），当前实例被转交动作后 `isVisible()` 变为 `false`，主实例继续存活（`primaryStillRunning: true`）。
  - `quit`：调用后 1085ms 内所有 `Arckeep.exe` 进程消失。
- **未做的部分**：没有用 UI Automation/pywinauto 去右键真实托盘图标截「打开/退出」菜单图——按验收提示词「拿不到菜单截图不影响结论，只写明托盘外观需人工确认」的口径处理，**托盘图标本身的视觉外观（是否在通知区域正确显示、右键菜单的实际渲染）仍需 Dylan 人工确认**。

**结论：PASS**（四个功能性动作全部通过实测；托盘图标视觉外观未做 UI 自动化，按允许口径不影响结论，但需人工补充确认外观）

### AC9：热键冲突提示 + X3（提示写明组合键、旁边能改）

- `verify/hold-hotkey.ps1` 用 `RegisterHotKey` 抢占 `Ctrl+Alt+K`，确认 `registered=True`。
- 在设置页把热键改成 `Ctrl+Alt+K` 并保存：出现警告 `Ctrl+Alt+K 已被其他程序占用`（写明了具体组合键，满足 X3 第一条）；警告容器 `boundingBox` 为 `{x:281,y:684,w:663,h:62.5}`，其内部的「新的热键组合」输入框（`x:632.5,y:695`）、「录制」按钮（`x:783,y:695`）、「改用这个」按钮（`x:847,y:696`）都在**同一个 DOM 容器、同一行**（Y 坐标几乎相同），满足 X3「提示旁边就有输入框/录制/改用这个」。截图 `08-settings-hotkey-conflict.png`。
- `settings.json` 里没有出现过 `Ctrl+Alt+K`（`settingsFileHasConflictCombo: false`）——失败的组合没有被持久化。
- **对照组**：改成空闲组合 `Ctrl+Alt+Shift+A`，保存后没有出现 `.hotkey-alert`（`warningVisible: 0`）。
- **附加检查**（不影响 AC9 结论）：先占住默认热键 `Ctrl+Alt+Space`，再冷启动应用，截图 `23-bonus-default-hotkey-occupied.png`（应用启动时是否显式提示默认热键被占用，见截图；这条不影响 AC9 判定）。

**结论：PASS**（AC9 与 X3 均 PASS）

### X1：失败原因三分类（token 无效 / 权限不够 / 网络不通），每类附下一步

- **token 无效（401）**：见 AC5c，提示 `这个 token 无效或已过期（HTTP 401）。请重新生成 PAT，或执行 gh auth login 后再试。`——已实测。
- **网络不通**：`New-NetFirewallRule` 成功阻断了 `Arckeep.exe` 的出站连接（管理员权限足够，不需要退到 hosts 文件方案），再点「测试连接」，25 秒内出现：
  > 这个 token 无效或已过期（HTTP 401）。请重新生成 PAT，或执行 gh auth login 后再试。

  **⚠️ 这里出现了一个和预期不一致的结果**：防火墙阻断出站后，UI 显示的仍是跟「token 无效」相同的 401 文案，**没有**出现 network 类提示。token 仍在输入框（`tokenKeptInField: true`），进程没有崩溃。测完后已经 `Remove-NetFirewallRule` 清理规则。截图 `11-settings-network-error.png`。

  **这个结果的定性存疑，本报告不把它算作确定的产品缺陷**，理由见第 4 节——最可能的原因是本验收脚本的方法论问题（同一个长期运行的 Electron 进程在此之前已经和 `api.github.com` 建立过一次 TLS 连接，`fetch`/undici 的连接池可能复用了这条已建立的连接，而新增的出站防火墙规则通常只拦截**新建**连接，不会掐断已经建立的连接），而不是 `classifyGithubFailure` 的分类逻辑本身有问题。
- **权限不够（403 / 缺 scope）**：没有真实 token 触发不了，按规则未测。覆盖这条分类逻辑的单测：`test/github-auth.test.ts` › `classifyGithubFailure` › `separates invalid tokens, missing scopes, and unreachable networks`（同时覆盖 `status:403` 和 `missing scope` 两种情况），该测试在 run `36407287806` 的 `test` 步骤里执行过。

**结论：PARTIAL**（invalid-token 类实测 PASS；network 类实测了但结果与预期文案不符,定性存疑（很可能是本验收方法论的问题,见第 4 节),建议工程方或用新进程重测一次;insufficient-scope 类只有单测、无实测)

### X2：测试连接失败后，已粘贴的 token 仍留在输入框

- AC5c（401 场景）与 X1（网络场景）都验证了 `tokenInput.value` 在失败后原样保留完整假 token，两次都是 `tokenKeptInField: true`。

**结论：PASS**

### X4：测试钩子反向检查（不设 ARCKEEP_TEST_HOOKS=1，钩子必须完全不起作用）

- 不设变量，冷启动带 `--arckeep-test=quit`：10 秒后进程仍在、`isVisible()===true`（截图 `12-hooks-off.png`）；`app.evaluate(() => typeof globalThis.__ARCKEEP_TEST_HOOKS__)` 返回 `'undefined'`。
- 应用运行中再执行一次 `Arckeep.exe --arckeep-test=quit`（同样不设变量）：主实例没有退出（`stillRunningAfterSecond: true`）。
- `ARCKEEP_TEST_HOOKS=0` 和 `ARCKEEP_TEST_HOOKS=true` 各冷启动一次并带 `--arckeep-test=close`：两种情况下 `typeof === 'undefined'`、窗口都保持可见（提交说明里写的「必须恰好是 "1"」得到验证）。
- 覆盖这条惰性路径的单测：`test/test-hooks.test.ts` › `stays disabled unless ARCKEEP_TEST_HOOKS is exactly 1` 与 `does nothing when ARCKEEP_TEST_HOOKS is not 1: flags and IPC stay unregistered`，均在 run `36407287806` 的 `test` 步骤里执行过。
- 全部 5 种情况下钩子都没有生效。

**结论：PASS**

### X5：README 写清了 SmartScreen「更多信息 → 仍要运行」

- 见 AC3 小节引用的 README 原文，已写清。

**结论：PASS**

### X6：窄窗口表现（约 800px 和最小宽度）

- `getMinimumSize()` 返回 `[720, 600]`。
- 宽度设为 800px：`document.documentElement.scrollWidth === clientWidth === 784`（无横向溢出），`navOverflow: false`（导航按钮文字没有被截断）。截图 `09-window-narrow-800.png`。
- 宽度设为最小值 `720`：`scrollWidth === clientWidth === 704`，`hasHorizontalScrollbar: false`。截图 `10-window-narrow-min.png`（可以看到导航文字和内容都完整显示，没有横向滚动条）。

**结论：PASS**

## 3. 汇总表

| # | 标准原文（摘自 PR #8「怎么验证」清单，逐字对应 Issue #1；Issue #1 正文本身因权限无法直接读取，见第 0 节） | 结论 | 绑定 SHA | 证据（run/step 链接、截图文件名、日志片段、退出码） | 复现步骤（命令级） | 问题描述 |
|---|---|---|---|---|---|---|
| AC1 | 任意 PR 自动触发 CI，lint/typecheck/test 三步都执行并通过；故意带 lint 错误的 PR 会让 CI 变红（PR 里附 run 链接） | **PASS**（附注：链接在 PR 评论而非描述里） | `fef78d5`（CI）/ `fada735`（lint 红） | run [36407287806](https://github.com/Dylan5237/arckeep/actions/runs/36407287806) 三步 success；run [36407721575](https://github.com/Dylan5237/arckeep/actions/runs/36407721575) lint 失败；[PR #8 评论](https://github.com/Dylan5237/arckeep/pull/8#issuecomment-5867843319) | `gh run view 36407287806 --json jobs`；`gh run view 36407721575 --json jobs`；`gh api repos/Dylan5237/arckeep/issues/8/comments` | 无 |
| AC2 | 推测试 tag 后 windows-latest 打包成功，Release 有 `*Setup*.exe` 和 portable `*.exe` | **FAIL** | `699736c` | run [36407712335](https://github.com/Dylan5237/arckeep/actions/runs/36407712335) `conclusion=failure`；`release not found` | `gh run view 36407712335 --json conclusion,jobs`；`gh release view v0.0.1-test` | 期望：Release 创建成功，两个附件齐全。实际：`Build NSIS installer and portable exe` 步骤报错 `GitHub Personal Access Token is not set`，electron-builder 因检测到 `v*` tag 而隐式触发发布，但该步骤没有 `GH_TOKEN`；Release 从未创建 |
| AC3 | 干净 Win10/11 装安装包能启动；portable 双击能启动 | **PARTIAL** | `fef78d5` | `21-ac3-installer.json`（exitCode=0，快捷方式已解析）、`22-ac3-installed-launch.png`、`20-ac3-portable.json`/`.png`（进程存活、标题非空）；Crashpad 目录始终为空 | `Start-Process Setup.exe -ArgumentList '/S' -Wait`；`Start-Process portable.exe` | 无失败；仍需 Dylan 在真实干净 Win10/11 上补验（产品经理已认可 CI 只能到 PARTIAL） |
| AC4 | 左侧导航从上到下 等我处理/项目总览/待办/工具架 + 设置，点击切换 | **PASS** | `fef78d5` | `02-nav-waiting.png`…`06-settings-empty.png`；`AC4-order` 场景 boundingBox 数据 | Playwright `_electron.launch` + `boundingBox()` + 逐个 `click()` | 无 |
| AC5 | gh 已登录显示来源 gh CLI 且测试连接显示 Dylan5237；gh 不在 PATH 可粘贴 PAT 测试成功；错误 token 有明确提示不崩溃 | **PARTIAL** | `fef78d5` | `06-settings-empty.png`（未误报 gh-cli）；`AC5b-pat-path` 场景（sourceLabel 变为「来源：本机 PAT」）；`07-settings-invalid-token.png` + `invalid-token-message.txt` | 见 AC5 小节 | 5a 按产品经理决定固定 PARTIAL；5b 缺真实 token 验证「测试连接成功」；5c 已实测 PASS |
| AC6 | `%APPDATA%\Arckeep\` 下 `findstr /s` 搜 token 前 8 位搜不到 | **PASS** | `fef78d5` | `AC6-findstr` 场景：两次 `findstr` `exitCode=1` 无输出，UTF-16 匹配数 0；`17-settings.json.copy.json` 只含密文 | `findstr /s /m /c:"ghp_Vf9Q" "%APPDATA%\Arckeep\*"` → `exit=1` | 无 |
| AC7 | 加 2 个关注仓库 + 改热键，托盘退出再启动，设置还在 | **PASS** | `fef78d5` | `13-settings-repos-hotkey-saved.png`、`18-settings-after-restart.png`；`AC7-restart` 场景数据 | `__ARCKEEP_TEST_HOOKS__.quit()` → 重启 → 读设置页 | 无 |
| AC8 | 关窗口留托盘；托盘菜单能重新打开/退出 | **PASS** | `fef78d5` | `14-hook-close-fullscreen.png`、`15-hook-show.png`；`src/main/index.ts:74-113` 源码引用；`AC8-second-instance` 场景 | `__ARCKEEP_TEST_HOOKS__.close()/.show()/.quit()`；二次实例 `--arckeep-test=close` | 无（托盘图标视觉外观未做 UIA 验证，按允许口径不影响结论，需人工补充） |
| AC9 | 热键设成已占用组合时有提示 | **PASS** | `fef78d5` | `08-settings-hotkey-conflict.png`；`hotkey-warning-message.txt`；`AC9-conflict`/`AC9-control` 场景数据 | `verify/hold-hotkey.ps1` 占住 `Ctrl+Alt+K` → 设置页改热键保存 | 无 |
| X1 | 失败原因三分类（token 无效/权限不够/网络不通），每类附下一步 | **PARTIAL** | `fef78d5` | `07-settings-invalid-token.png`（401 类，PASS）；`11-settings-network-error.png`（网络断开后，PASS/实测但文案分类有缺陷，见问题描述） | 见 X1 小节 | 网络不通场景下，`classifyGithubFailure` 把 `fetch` 失败误判为「token 无效或已过期（HTTP 401）」而不是「网络不可达」类文案；权限不够类无真实 token，只有单测覆盖 |
| X2 | 测试连接失败后 token 仍在输入框 | **PASS** | `fef78d5` | AC5c、X1 两个场景 `tokenKeptInField: true` | 见上 | 无 |
| X3 | 热键冲突提示写明组合键，旁边就能直接改 | **PASS** | `fef78d5` | `08-settings-hotkey-conflict.png`；`AC9-conflict` 场景 boundingBox 数据 | 见 AC9 | 无 |
| X4 | 不设 ARCKEEP_TEST_HOOKS=1 时钩子完全不起作用（反向检查） | **PASS** | `fef78d5` | `12-hooks-off.png`；`X4-hooks-off-typeof`/`X4-hooks-value-0`/`X4-hooks-value-true` 场景数据 | 见 X4 小节 | 无 |
| X5 | README 写清 SmartScreen「更多信息→仍要运行」 | **PASS** | `699736c` | README.md 第 12 行原文引用 | `git show 699736c:README.md` | 无 |
| X6 | 窄窗口（约 800px、最小宽度）表现 | **PASS** | `fef78d5` | `09-window-narrow-800.png`、`10-window-narrow-min.png`；`X6-narrow` 场景 metrics 数据 | 见 X6 小节 | 无 |

## 4. 产品缺陷 / 偏离工程方承诺 / 验收环境限制

### 产品缺陷

1. **【AC2 失败的根因】Release workflow 在打包步骤缺少 `GH_TOKEN`，导致推测试 tag 后打包直接失败，Release 从未创建。**
   `.github/workflows/release.yml` 里只有「Publish GitHub Release」步骤注入了 `GH_TOKEN: ${{ github.token }}`；更早的「Build NSIS installer and portable exe」步骤（`npm run dist` → `electron-builder --win`，未加 `--publish never`）在检测到当前 ref 是 `v*` tag 时会**隐式尝试发布**，因为没有 token 而直接报错退出（`GitHub Personal Access Token is not set`），NSIS installer 和 portable exe 都没能生成。参见 run [36407712335](https://github.com/Dylan5237/arckeep/actions/runs/36407712335) 的失败日志。**建议修复**：给 `dist` 脚本加 `--publish never`（或在 `package.json` 的 `build` 字段里设 `"publish": null`），把真正的发布逻辑完全留给 release.yml 里已有的 `gh release create/upload` 步骤；或者把 `GH_TOKEN` 一并注入打包步骤。这个缺陷会阻塞 AC2，也会阻塞 Issue #7 里「CI 绿且验收标准全部勾完才关闭」的收尾条件。

### 存疑事项（建议工程方复核，本报告不计入产品缺陷）

1. **X1 网络不通场景下，`测试连接` 显示的是「token 无效或已过期（HTTP 401）」而不是「网络不可达」类提示。**
   代码路径上看，`fetchGitHubLogin`（`src/main/github-auth.ts`）在 `fetch()` 抛错时会调用 `classifyGithubFailure({ network: true })`，理论上应该走 network 分支。但本次实测在防火墙阻断 `Arckeep.exe` 出站流量后，UI 显示的仍是 401 文案。**最可能的原因是本验收脚本的方法论问题，而不是产品代码的缺陷**：X1 场景复用了 AC5c 场景里同一个已经跑了几分钟、且刚刚成功和 `api.github.com` 建立过 TLS 连接的 Electron 进程；Node/undici 的底层连接池可能会对同一 host 复用已建立的连接，而新建的 `New-NetFirewallRule` 出站规则通常只拦截**新建**连接，不一定能掐断已经建立、处于 keep-alive 状态的连接——这样「网络阻断」在这个具体场景下就可能根本没有真正生效在这次请求上，UI 显示的 401 其实还是命中了真实的 GitHub API（用假 token 请求本来就会收到 401）。**建议**：工程方或后续验收用一个全新冷启动的进程（而不是复用已经建立过连接的实例）单独测一次网络不通场景,更准确地定性;在此之前不应该把这条计入产品缺陷,X1 因此判 PARTIAL 而不是 FAIL。

### 偏离工程方承诺的地方

1. AC2 相关：PR #8 描述里承诺「同一 workflow 的 windows package job 上传 arckeep-windows 和 arckeep-win-unpacked」——这部分（CI 内打包）本身兑现良好；但 PR #8 评论里说的「Release 验证还在跑，结果出来再补」这句话**没有后续更新**，而实际 Release 从未成功创建，也没有人在 PR 或 Issue 上更新这一状态（本报告因为没有 Issues 权限，无法确认是否在 Issue 侧有后续说明）。
2. 验收清单附件里记录「main push CI run 36407703708（699736c）」——本报告没有单独重复核对这条（其内容与被测 PR #8 的 CI run 逐步骤一致，属于同一套 workflow 配置在 push 触发下的运行，判定依据已经在 AC1 里通过 PR 触发的 run 完整核对过，不再重复列出单独结论行）。

### 验收环境的限制

1. **无法读取 Issue #1 正文/评论**（GitHub App 缺少 `issues:read` 权限），详见第 0 节。已改用 PR #8 描述里逐字对应的检查清单代替。
2. **AC3「干净 Win10/11」**：`windows-latest` 是预装了大量软件（Node、gh、Git 等）的 Server 镜像,不是真正的干净客户端系统,CI 只能做代理验证。按产品经理决定,这一条最多判 PARTIAL,需 Dylan 在真机或 Windows Sandbox 上补验。
3. **AC5a/5b 的「真实身份」部分**：没有 Dylan 的真实 PAT/gh 登录（按硬性规则禁止使用任何真实 token），「测试连接显示 Dylan5237」无法被真实触发,只验证了周边行为（来源标签正确性、PAT 保存流程、单测覆盖）。
4. **AC8 托盘视觉外观**：没有做 UI Automation 右键真实托盘图标截图，只验证了功能等价的测试钩子路径（源码确认调用同一组函数）。按提示词允许口径,不影响 AC8 判定,但外观仍需人工确认。
5. **X1 权限不够（403/缺 scope）分类**：没有真实的、权限不足的 token 可用于实测，只能引用单测佐证。
6. **验收 workflow 的事件日志检查脚本**（`crash-and-eventlog` 场景）本次跑出的是空字符串，既不是明确的「查询失败」提示也不是明确列出的「无匹配事件」提示——这条证据本身有轻微的不确定性，但结合 Crashpad 目录全程为空、所有进程存活性检查全部通过，没有观察到任何实际崩溃现象，不影响 AC3 的最终判定。

## 5. 附：证据 artifact 内容清单（`verify-issue-1-evidence-fef78d5`）

| 文件 | 对应勾选项 |
|---|---|
| `00-artifact-tree.txt` / `00-exe-sha256.txt` | 下载的 artifact 目录树、三个 exe 的 SHA256 |
| `01-main-window.png` / `-win.png` | AC4（主窗口默认尺寸） |
| `02-nav-waiting.png` … `05-nav-toolshelf.png` | AC4（四个模块页面） |
| `06-settings-empty.png` | AC4/AC5（首次设置页空状态） |
| `07-settings-invalid-token.png` | AC5c / X2 |
| `08-settings-hotkey-conflict.png` | AC9 / X3 |
| `09-window-narrow-800.png` / `10-window-narrow-min.png` | X6 |
| `11-settings-network-error.png` | X1（网络不通） |
| `12-hooks-off.png` | X4 |
| `13-settings-repos-hotkey-saved.png` | AC7 |
| `14-hook-close-fullscreen.png` / `15-hook-show.png` | AC8 |
| `16-appdata-tree.txt` / `17-settings.json.copy.json` | AC6 / AC7 |
| `18-settings-after-restart.png` | AC7 |
| `19-eventlog-arckeep.txt` | AC3（见环境限制第 6 条） |
| `20-ac3-portable.png` / `.json`，`21-ac3-installer.json`，`22-ac3-installed-launch.png` | AC3 |
| `23-bonus-default-hotkey-occupied.png` | AC9 附加检查（不影响结论） |
| `scenes.json` | 27 个场景的机器可读结果（本次全部 PASS） |
| `invalid-token-message.txt` / `hotkey-warning-message.txt` | 提示文案原文 |
| `index.md` | 文件与勾选项对照表 |

## 6. 事后动态（仅供参考，不改变本报告对 `fef78d5`/`699736c` 的结论）

本报告的全部结论都绑定在 `fef78d5`（PR #8 head）/ `699736c`（main 合并提交）。在本次验收进行期间，`main` 分支上出现了新的提交，**超出了本次验收的范围**，本报告不因此改判任何一条结论，只如实记录时间线：

- 2026-09-28 18:47:45 北京时间：Dylan5237 合并了 [PR #11](https://github.com/Dylan5237/arckeep/pull/11)「#1 打包时关闭 electron-builder 隐式发布」，`main` 从 `699736c` 前进到 `4c5f83b`。commit message：「push 和 tag 的 CI 会被 electron-builder 当成要发布，缺少 GH_TOKEN 时 dist 在产物生成后退出 1。所有 electron-builder 调用显式 `--publish never`，并让 PR 上的 windows package 按 push 条件跑。」——修复方式（给 `dist`/`build` 脚本加 `--publish never`）与本报告第 4 节「产品缺陷」第 1 条给出的建议**完全一致**。
- `v0.0.1-test` tag 被重新指向 `4c5f83b`；对应 Release workflow run [`36411825544`](https://github.com/Dylan5237/arckeep/actions/runs/36411825544) `conclusion=success`；`gh release view v0.0.1-test` 现在能看到 Release，附件里有 `Arckeep-Setup-0.1.0.exe` 和 `Arckeep-0.1.0-portable.exe`（`publishedAt: 2026-09-28T10:50:58Z` = 18:50:58 北京时间）。

**本报告没有对 `4c5f83b` 做任何验收动作**（没有下载新产物、没有跑新的 Windows 冒烟、没有核对新的 Release 附件的 SHA256），因为这超出了「验收 PR #8 / `fef78d5`」这个既定任务范围；如果需要对 `4c5f83b`（或 PR #11）单独出一份验收报告，应该作为新的验收任务另外发起。**AC2 在 `699736c` 上的结论仍然是 FAIL**——这是基于当时代码状态的确定性事实，不是"过时"的判断。

——本报告完——
