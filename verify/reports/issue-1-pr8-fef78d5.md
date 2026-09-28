# Arckeep Issue #1「骨架 + CI + Windows 打包」独立验收报告

- **验收方角色**：独立验收（只验收、只报告，不改产品代码；只在 `verify/issue-1` 分支新增 `.github/workflows/verify-issue-1.yml` 与 `verify/**`）
- **报告写成时间**：2026-09-28 18:37（北京时间，UTC+8）；19:05 补充 AC2（Release 已修好）；19:35 补充第 5 节（X1 隔离重测、AC9 不滚动截图、Release 下载+启动冒烟）
- **被测对象分两组，互不混用，每条结论各自绑定各自的 SHA：**
  1. **PR #8 产物组**（AC1、AC3–AC9、X1–X6 用这一组）：[PR #8 "#1 骨架 + CI + Windows 打包"](https://github.com/Dylan5237/arckeep/pull/8)（已合并），head SHA `fef78d58ce1cd879472afded059ea0830c8fb358`（下称 `fef78d5`），合并提交（main）`699736cea1a51abb2b65ee58af6c3f85e7660022`（下称 `699736c`）。**tree 一致性核对**：`git rev-parse fef78d5^{tree} 699736c^{tree}` 两者均为 `fc485eccbedf3fb70a4d0b901319dafc799d3504` —— **一致**，`699736c` 是 `fef78d5` 的纯合并提交，没有额外改动。
  2. **Release 产物组**（只用于 AC2）：修复 PR [#11](https://github.com/Dylan5237/arckeep/pull/11)「#1 打包时关闭 electron-builder 隐式发布」合并后，`main` 前进到 `4c5f83b903faf2dd38f3108a84465d34f12efd4f`（下称 `4c5f83b`），`v0.0.1-test` tag 被重新指向这个提交（`git ls-remote --tags origin` 确认 `4c5f83b903faf2dd38f3108a84465d34f12efd4f refs/tags/v0.0.1-test`）。**`4c5f83b` 不等于 `699736c`／`fef78d5`，是一次独立于 PR #8 的后续修复提交**，AC2 的结论单独绑定在 `4c5f83b` 上，不影响本报告其余各条绑定在 `fef78d5`/`699736c` 上的结论。
- **冒烟产物来源**：CI run [`36407287806`](https://github.com/Dylan5237/arckeep/actions/runs/36407287806)（`event=pull_request`，`head_sha=fef78d5`，`conclusion=success`）
  - `arckeep-windows`：`Arckeep-Setup-0.1.0.exe`（NSIS 安装包）+ `Arckeep-0.1.0-portable.exe`（portable）
  - `arckeep-win-unpacked`：`arckeep-win-unpacked.zip` → `win-unpacked/Arckeep.exe`
  - SHA256（本次验收 run 里 `Get-FileHash` 现算，见 `00-exe-sha256.txt`）：
    | 文件 | SHA256 |
    |---|---|
    | `win-unpacked/Arckeep.exe` | `AD51406F3D652B409F1EA8A17B5617A8EC251C68CAF643E37A1EEA7845BEEC18` |
    | `Arckeep-0.1.0-portable.exe` | `40CCEE64864F31F7E17D564613AB5A98956B360D5C90A1AC94966F5D6E58BA7A` |
    | `Arckeep-Setup-0.1.0.exe` | `92624B3A596325C83F58DBFF29E3B3E2AFF81B9648A923A30474412875E4372D` |
- **验收 workflow run（Windows 冒烟，首次完整跑通）**：<https://github.com/Dylan5237/arckeep/actions/runs/36409794693>（`conclusion=success`，第 2 次推送即跑通）
- **验收 workflow run（补测：X1 隔离重测 + AC9 截图补证 + Release 冒烟，最新最完整的一次）**：<https://github.com/Dylan5237/arckeep/actions/runs/36414606477>（`conclusion=success`，一次推送即跑通）
- **证据 artifact（首次）**：`verify-issue-1-evidence-fef78d5` — <https://github.com/Dylan5237/arckeep/actions/runs/36409794693/artifacts/10964290813>
- **证据 artifact（补测，最新）**：`verify-issue-1-evidence-fef78d5-retest` — <https://github.com/Dylan5237/arckeep/actions/runs/36414606477/artifacts/10966793560>
- **Actions 推送预算**：8 次里用了 6 次（1 次权限探测 + 5 次实际推送，全部成功；其中 3 次只改了报告文本却仍触发全量冒烟，已如实记录），本轮补测后还剩 2 次余量

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

这一条**先出现过一次 FAIL，随后被工程方修复，现在改判 PASS**，两次判定分别绑定不同的 SHA，都如实记录：

**第一次核对（绑定 `699736c`）—— FAIL：**

- `gh release view v0.0.1-test` → `release not found`（截至 2026-09-28 18:36 北京时间，Release **不存在**）。
- 对应打包 run [`36407712335`](https://github.com/Dylan5237/arckeep/actions/runs/36407712335)（`push`，`head_branch=v0.0.1-test`，`head_sha=699736c`）：**`conclusion=failure`**。`lint`/`typecheck`/`test` 三步 success，但 `Build NSIS installer and portable exe` 步骤失败，`Publish GitHub Release` 被 `skipped`：
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
  根因：`.github/workflows/release.yml` 只在「Publish GitHub Release」这一步注入了 `GH_TOKEN`；更早的「Build NSIS installer and portable exe」步骤（`npm run dist` → `electron-builder --win`，未带 `--publish never`）在检测到 `v*` tag 时隐式尝试发布，因为没有 token 而直接失败，连 exe 都没生成，Release 从未创建。

**第二次核对（绑定 `4c5f83b`）—— PASS：**

- 2026-09-28 18:47:45 北京时间，Dylan5237 合并 [PR #11](https://github.com/Dylan5237/arckeep/pull/11)「#1 打包时关闭 electron-builder 隐式发布」，修复方式（给 `dist`/`build` 脚本加 `--publish never`）与本报告第一次核对时给出的建议一致；`main` 从 `699736c` 前进到 `4c5f83b`。
- `v0.0.1-test` tag 被重新指向 `4c5f83b`（`git ls-remote --tags origin` 确认）；main push CI 新 run [`36411815385`](https://github.com/Dylan5237/arckeep/actions/runs/36411815385) 绿；对应 Release run [`36411825544`](https://github.com/Dylan5237/arckeep/actions/runs/36411825544)（`Windows Release`，`push`，`head_branch=v0.0.1-test`）：**`conclusion=success`**。
- Release 页面 <https://github.com/Dylan5237/arckeep/releases/tag/v0.0.1-test>（`isPrerelease=true`，`publishedAt=2026-09-28T10:50:58Z` = 18:50:58 北京时间），附件正好两个，命名符合要求：
  | 资产名 | SHA256（`gh release view --json assets` 里的 digest，与本验收 workflow 里 `gh release download` 后现算的哈希一致，见 `24-release-exe-sha256.txt`） |
  |---|---|
  | `Arckeep-Setup-0.1.0.exe` | `B2BB471DC471EFC6045AC140F7D16619E2EC1F987193423222C84828F60FE47A` |
  | `Arckeep-0.1.0-portable.exe` | `1F7F323E437027518D6280DDA40A28527488F678CF633EF42018398BA9641EFC` |
- **前一次跑残留的记录也如实归档**：旧的红色打包 run `36407712335` 和它对应的旧 main push CI run `36407703708` 现在已经作废（分别被 `36411825544` 和 `36411815385` 取代），本报告不删除前一次的 FAIL 记录，只在此标注「已被取代」。
- **额外做的实测**（`verify/release-smoke.ps1`，只用 workflow 自带的 `GITHUB_TOKEN`，没有用任何其它 token）：`gh release download v0.0.1-test` 下载两个资产后，`Get-FileHash` 现算的 SHA256 与上表完全一致；`portable.exe` 不带参数启动，25 秒后 `Get-Process Arckeep` 有进程、`MainWindowTitle` 非空（截图 `25-release-portable-launch.png`）；`Setup.exe /S -Wait` 静默安装，`exitCode=0`，能找到 `Arckeep*.lnk` 快捷方式并解析出目标路径，启动后 20 秒进程存在（截图 `26-release-installed-launch.png`）。这满足「从 Release 下载后三步内能跑起来」这条附加检查。**完整步骤和 SHA256 逐字比对表见第 5.3 节「补测」。**
- **附注（不算缺陷）**：安装包/portable exe 文件名里的版本号是 `0.1.0`（来自 `package.json` 的 `version` 字段），和 tag 名 `v0.0.1-test` 不是同一个版本号体系——`v0.0.1-test` 是一次性的手动测试 tag，`0.1.0` 是产品的语义化版本号，两者本来就不需要一致，只是命名上容易让人误会，记为附注即可，不影响 AC2 判定。

**结论：PASS**（绑定 `4c5f83b`；`699736c` 上的历史结论仍是 FAIL，已在上面完整保留，不做删除式修改）

## 2. Windows 冒烟验收（AC3–AC9、X1–X6）

验收 workflow：`.github/workflows/verify-issue-1.yml`，只在 push 到 `verify/issue-1` 时触发；下载 run `36407287806` 的两个 artifact 前先核对 `run.head_sha == fef78d5`（脚本里写了 `throw`，核对通过）；被测应用启动环境去掉了 `GH_TOKEN`/`GITHUB_TOKEN`；全程只用假 token `ghp_Vf9QzXk2LmP4rT8wYb6nHc3JdA1sE7uG0oKi`。

- 第 1 次推送：仅探测「push 新 workflow 文件」是否被 GitHub App 权限拒绝——**未被拒绝**，run [`36408808526`](https://github.com/Dylan5237/arckeep/actions/runs/36408808526) 正常触发并成功。
- 第 2 次推送：完整验收脚本（`verify/run-all.ps1` + `verify/smoke.mjs`），run [`36409794693`](https://github.com/Dylan5237/arckeep/actions/runs/36409794693)，**一次性跑通**。第一次运行时脚本的判定逻辑有误（X1-network 场景被错判为 PASS），所以当时的 scenes.json 汇总结果作废。各项结论以验证方人工核对和第 5 节补测为准。修正判定逻辑后重跑的结果是 25 PASS / 1 FAIL（X1-network，原因是复用长期进程，已由 5.1 的隔离重测取代）/ 2 INFO。
- 第 3、4、5 次推送：分别是加报告文件、微调 X1 措辞、加 Release 冒烟骨架，都没有改验收脚本的核心逻辑，但 `on: push: branches: ['verify/issue-1']` 对任何推送都会重新触发整套 Windows 冒烟——run [`36411183904`](https://github.com/Dylan5237/arckeep/actions/runs/36411183904)、[`36411910710`](https://github.com/Dylan5237/arckeep/actions/runs/36411910710)、[`36412546852`](https://github.com/Dylan5237/arckeep/actions/runs/36412546852) 都又完整跑了一遍，结果都与第 2 次一致（`conclusion=success`）。曾尝试 `gh run cancel` 去省分钟，被拒绝（`HTTP 403: Resource not accessible by integration`，GitHub App 没有 `actions:write`），按硬性规则没有绕过，让它们跑完。
- 第 6 次推送：加上 X1 隔离重测脚本、AC9 不滚动截图逻辑、Release 冒烟脚本，run [`36414606477`](https://github.com/Dylan5237/arckeep/actions/runs/36414606477)，**一次性跑通**，见第 5 节「补测」。**Actions 分钟预算：截至目前 8 次里用了 6 次（1 次权限探测 + 5 次实际推送，全部成功）。**

所有截图和原始数据都在证据 artifact `verify-issue-1-evidence-fef78d5`（首次）和 `verify-issue-1-evidence-fef78d5-retest`（补测，最新最完整）里，文件名与 `evidence/index.md` 对照见本报告末尾清单（第 6 节）。

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
- 在设置页把热键改成 `Ctrl+Alt+K` 并保存：出现警告 `Ctrl+Alt+K 已被其他程序占用`（写明了具体组合键，满足 X3 第一条）；`scrollIntoViewIfNeeded()` 之后测得警告容器 `boundingBox` 为 `{x:281,y:565,w:663,h:62.5}`，其内部的「新的热键组合」输入框（`x:632.5,y:576`）、「录制」按钮（`x:783,y:576`）、「改用这个」按钮（`x:847,y:577`）都在**同一个 DOM 容器、同一行**（Y 坐标几乎相同），满足 X3「提示旁边就有输入框/录制/改用这个」。截图 `08-settings-hotkey-conflict.png`。
- **⚠️ 补测发现（见「补测」小节）：不滚动时这条警告在默认窗口尺寸下看不见。** 点击「保存热键」后**不做任何滚动**立即截的图（`08a-settings-hotkey-conflict-no-scroll.png`）显示页面还停在设置页顶部，`全局热键` 卡片的「保存热键」按钮已经贴着窗口底边，警告完全在可视区域之外；只有程序或用户主动往下滚动，才能看到 `08-settings-hotkey-conflict.png` 里的完整警告。**这是一个真实的 UX 问题**：用户点了保存之后，第一眼看不出保存失败、也看不出为什么，除非往下滚。记入第 4 节「产品缺陷」。
- `settings.json` 里没有出现过 `Ctrl+Alt+K`（`settingsFileHasConflictCombo: false`）——失败的组合没有被持久化。
- **对照组**：改成空闲组合 `Ctrl+Alt+Shift+A`，保存后没有出现 `.hotkey-alert`（`warningVisible: 0`）。
- **附加检查**（不影响 AC9 结论）：先占住默认热键 `Ctrl+Alt+Space`，再冷启动应用，截图 `23-bonus-default-hotkey-occupied.png`（应用启动时是否显式提示默认热键被占用，见截图；这条不影响 AC9 判定）。

**结论：PASS**（AC9 功能性判定与 X3 均 PASS；警告内容和相邻控件都符合要求；不滚动时不可见是产品侧的 UX 缺陷，记入第 4 节，不改变本条 PASS 判定，因为标准原文只要求「有提示」，没有要求「不滚动就能看到」）

### X1：失败原因三分类（token 无效 / 权限不够 / 网络不通），每类附下一步

- **token 无效（401）**：见 AC5c，提示 `这个 token 无效或已过期（HTTP 401）。请重新生成 PAT，或执行 gh auth login 后再试。`——已实测。
- **网络不通：已用全新进程重测，结论 PASS。** 第一次尝试（复用长期运行的进程）拿到的是 401 文案而不是网络类文案；按要求做了一次严格重测（见下方「补测」小节），**先**用防火墙彻底切断网络（程序级 + `140.82.112.0/20` CIDR + 解析出的具体 IP，三条规则同时生效），用 `Test-NetConnection api.github.com -Port 443` 确认网络确实断了（`TcpTestSucceeded: false`），**然后才**冷启动一个全新的 Arckeep 进程去测试连接。这一次拿到的提示是：
  > 连不上 GitHub（网络不可达、DNS 失败或超时）。请检查网络或代理，恢复后再点一次测试连接。

  提示分类正确（`isNetworkClassMessage: true`），点击前后 `Test-NetConnection` 都确认网络处于断开状态，token 仍在输入框，进程没有崩溃。**结论：这不是产品缺陷，是第一次验收方法论的问题**（同一进程复用了已建立的连接）；已在 `verify/smoke.mjs` 里修好了判定逻辑（第一次那种「拿到任意提示就算 PASS」的写法本身是验收脚本的缺陷，现在改成必须匹配「网络不可达」类文案才算 PASS，第一次的场景现在会正确地显示为 FAIL 并带上「结果存疑，请看隔离重测」的说明，不再误报 PASS）。
- **权限不够（403 / 缺 scope）**：没有真实 token 触发不了，按规则未测。覆盖这条分类逻辑的单测：`test/github-auth.test.ts` › `classifyGithubFailure` › `separates invalid tokens, missing scopes, and unreachable networks`（同时覆盖 `status:403` 和 `missing scope` 两种情况），该测试在 run `36407287806` 的 `test` 步骤里执行过。

**结论：PARTIAL**（invalid-token 类实测 PASS；network 类经隔离重测后确认 PASS，第一次的异常结果已排查清楚是验收方法论问题、不是产品缺陷；insufficient-scope 类只有单测、无实测，所以整条仍然是 PARTIAL 而不是 PASS）

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
| AC2 | 推测试 tag 后 windows-latest 打包成功，Release 有 `*Setup*.exe` 和 portable `*.exe` | **PASS**（绑定 `4c5f83b`；`699736c` 上历史结论是 FAIL，已被 PR #11 取代，详见 AC2 小节） | `4c5f83b`（历史：`699736c`） | Release run [36411825544](https://github.com/Dylan5237/arckeep/actions/runs/36411825544) success；Release 页面两个资产齐全，SHA256 与 `24-release-exe-sha256.txt` 一致；`25-release-portable-launch.png`/`26-release-installed-launch.png` 冒烟通过 | `gh release download v0.0.1-test`（workflow 自带 `GITHUB_TOKEN`）→ 启动/静默安装 | 无（历史缺陷已由 PR #11 修复；文件名版本号 `0.1.0` 与 tag `v0.0.1-test` 不一致，记为附注不算缺陷） |
| AC3 | 干净 Win10/11 装安装包能启动；portable 双击能启动 | **PARTIAL** | `fef78d5` | `21-ac3-installer.json`（exitCode=0，快捷方式已解析）、`22-ac3-installed-launch.png`、`20-ac3-portable.json`/`.png`（进程存活、标题非空）；Crashpad 目录始终为空 | `Start-Process Setup.exe -ArgumentList '/S' -Wait`；`Start-Process portable.exe` | 无失败；仍需 Dylan 在真实干净 Win10/11 上补验（产品经理已认可 CI 只能到 PARTIAL） |
| AC4 | 左侧导航从上到下 等我处理/项目总览/待办/工具架 + 设置，点击切换 | **PASS** | `fef78d5` | `02-nav-waiting.png`…`06-settings-empty.png`；`AC4-order` 场景 boundingBox 数据 | Playwright `_electron.launch` + `boundingBox()` + 逐个 `click()` | 无 |
| AC5 | gh 已登录显示来源 gh CLI 且测试连接显示 Dylan5237；gh 不在 PATH 可粘贴 PAT 测试成功；错误 token 有明确提示不崩溃 | **PARTIAL** | `fef78d5` | `06-settings-empty.png`（未误报 gh-cli）；`AC5b-pat-path` 场景（sourceLabel 变为「来源：本机 PAT」）；`07-settings-invalid-token.png` + `invalid-token-message.txt` | 见 AC5 小节 | 5a 按产品经理决定固定 PARTIAL；5b 缺真实 token 验证「测试连接成功」；5c 已实测 PASS |
| AC6 | `%APPDATA%\Arckeep\` 下 `findstr /s` 搜 token 前 8 位搜不到 | **PASS** | `fef78d5` | `AC6-findstr` 场景：两次 `findstr` `exitCode=1` 无输出，UTF-16 匹配数 0；`17-settings.json.copy.json` 只含密文 | `findstr /s /m /c:"ghp_Vf9Q" "%APPDATA%\Arckeep\*"` → `exit=1` | 无 |
| AC7 | 加 2 个关注仓库 + 改热键，托盘退出再启动，设置还在 | **PASS** | `fef78d5` | `13-settings-repos-hotkey-saved.png`、`18-settings-after-restart.png`；`AC7-restart` 场景数据 | `__ARCKEEP_TEST_HOOKS__.quit()` → 重启 → 读设置页 | 无 |
| AC8 | 关窗口留托盘；托盘菜单能重新打开/退出 | **PASS** | `fef78d5` | `14-hook-close-fullscreen.png`、`15-hook-show.png`；`src/main/index.ts:74-113` 源码引用；`AC8-second-instance` 场景 | `__ARCKEEP_TEST_HOOKS__.close()/.show()/.quit()`；二次实例 `--arckeep-test=close` | 无（托盘图标视觉外观未做 UIA 验证，按允许口径不影响结论，需人工补充） |
| AC9 | 热键设成已占用组合时有提示 | **PASS**（附注：不滚动看不见，见问题描述） | `fef78d5` | `08-settings-hotkey-conflict.png`（滚动后）、`08a-settings-hotkey-conflict-no-scroll.png`（不滚动）；`hotkey-warning-message.txt`；`AC9-conflict`/`AC9-control` 场景数据 | `verify/hold-hotkey.ps1` 占住 `Ctrl+Alt+K` → 设置页改热键保存 | 提示本身内容和控件都正确，但保存后页面不会自动滚动，默认窗口尺寸下用户第一眼看不到这条提示（在可视区域下方），需要手动往下滚才能看到；不影响 PASS 判定（标准原文只要求「有提示」），但记为产品侧 UX 缺陷 |
| X1 | 失败原因三分类（token 无效/权限不够/网络不通），每类附下一步 | **PARTIAL** | `fef78d5` | `07-settings-invalid-token.png`（401 类，PASS）；`11-settings-network-error-retest.png`（**全新进程**+确认断网后重测，PASS，见「补测」小节） | 见 X1 小节和「补测」小节 | 网络不通类：第一次用复用进程测得 401 文案，怀疑是分类逻辑缺陷；用全新进程+确认断网重测后拿到正确的「网络不可达」文案，**排查清楚是验收方法论问题（连接复用），不是产品缺陷**；权限不够类无真实 token，只有单测覆盖 |
| X2 | 测试连接失败后 token 仍在输入框 | **PASS** | `fef78d5` | AC5c、X1 两个场景 `tokenKeptInField: true` | 见上 | 无 |
| X3 | 热键冲突提示写明组合键，旁边就能直接改 | **PASS** | `fef78d5` | `08-settings-hotkey-conflict.png`；`AC9-conflict` 场景 boundingBox 数据 | 见 AC9 | 无 |
| X4 | 不设 ARCKEEP_TEST_HOOKS=1 时钩子完全不起作用（反向检查） | **PASS** | `fef78d5` | `12-hooks-off.png`；`X4-hooks-off-typeof`/`X4-hooks-value-0`/`X4-hooks-value-true` 场景数据 | 见 X4 小节 | 无 |
| X5 | README 写清 SmartScreen「更多信息→仍要运行」 | **PASS** | `699736c` | README.md 第 12 行原文引用 | `git show 699736c:README.md` | 无 |
| X6 | 窄窗口（约 800px、最小宽度）表现 | **PASS** | `fef78d5` | `09-window-narrow-800.png`、`10-window-narrow-min.png`；`X6-narrow` 场景 metrics 数据 | 见 X6 小节 | 无 |

## 4. 产品缺陷 / 偏离工程方承诺 / 验收环境限制

### 产品缺陷

1. **【已修复】Release workflow 曾在打包步骤缺少 `GH_TOKEN`，导致推测试 tag 后打包直接失败，Release 从未创建。**
   `699736c` 上的 `.github/workflows/release.yml` 只有「Publish GitHub Release」步骤注入了 `GH_TOKEN: ${{ github.token }}`；更早的「Build NSIS installer and portable exe」步骤（`npm run dist` → `electron-builder --win`，未加 `--publish never`）在检测到当前 ref 是 `v*` tag 时会**隐式尝试发布**，因为没有 token 而直接报错退出（`GitHub Personal Access Token is not set`），NSIS installer 和 portable exe 都没能生成。参见 run [36407712335](https://github.com/Dylan5237/arckeep/actions/runs/36407712335) 的失败日志。**状态：已修复**——[PR #11](https://github.com/Dylan5237/arckeep/pull/11)（2026-09-28 18:47:45 北京时间合并，`main` → `4c5f83b`）给 `dist`/`build` 脚本加了 `--publish never`，修复方式与本报告当时给出的建议一致；修复后的 Release run [36411825544](https://github.com/Dylan5237/arckeep/actions/runs/36411825544) 成功，AC2 现在改判 PASS（详见 AC2 小节）。记录在案是为了说明这条缺陷确实存在过、也确实被修复了，不是本报告判断有误。
2. **【AC9 UX 问题】热键冲突警告保存后不会自动滚动到可视区域，默认窗口尺寸下用户第一眼看不到。**
   详见 AC9 小节和下方「补测」小节的 `08a-settings-hotkey-conflict-no-scroll.png` 截图。警告本身的内容、位置关系（和输入框/录制/改用这个同一容器）都是对的，只是页面没有在警告出现时自动滚动或把警告放到可视区域内。**建议**：保存热键失败时，把 `.hotkey-alert` `scrollIntoView()` 一次，或者把警告放在卡片顶部而不是最下面。这不影响 AC9/X3 的 PASS 判定（标准原文只要求「有提示」），但是个值得修的真实可用性问题。

### 已排查清楚、确认不是产品缺陷的事项

1. **X1 网络不通场景第一次实测显示了「token 无效或已过期（HTTP 401）」而不是「网络不可达」类提示——已用全新进程重测，确认是验收方法论问题，不是产品缺陷。**
   第一次测试复用了 AC5c 场景里已经成功连接过 `api.github.com` 的长期运行进程，`fetch`/undici 的连接池很可能复用了已建立的 TLS 连接，绕开了新增的出站防火墙规则。按要求做了一次严格的隔离重测（`verify/x1-network-retest.mjs`）：**先**用三条防火墙规则（程序级 + `140.82.112.0/20` CIDR + DNS 解析出的具体 IP）彻底切断网络，用 `Test-NetConnection` 确认网络确实断了，**然后才**冷启动一个全新进程去点「测试连接」。这一次拿到的是正确的「连不上 GitHub（网络不可达、DNS 失败或超时）...」提示，`isNetworkClassMessage: true`，`Test-NetConnection` 在点击前后都确认网络处于断开状态。**结论：`classifyGithubFailure` 的分类逻辑本身没有问题，第一次的异常结果是验收脚本方法论的缺陷**（已在 `verify/smoke.mjs` 里修好判定逻辑，避免同类问题被误判为 PASS）。详见「补测」小节。

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

## 5. 补测（4c5f83b / Release + X1 隔离重测 + AC9 截图补证）

补测时间：2026-09-28 19:35 北京时间。补测 run（一次跑完全部三项）：<https://github.com/Dylan5237/arckeep/actions/runs/36414606477>（`conclusion=success`，一次推送即跑通）。证据 artifact：`verify-issue-1-evidence-fef78d5-retest` — <https://github.com/Dylan5237/arckeep/actions/runs/36414606477/artifacts/10966793560>。

### 5.1 X1 网络不通隔离重测（绑定 `fef78d5`）

用 `verify/x1-network-retest.mjs`（全新脚本，和其余场景共用的长期进程完全隔离）：

1. 冷启动前先测一次网络：`Test-NetConnection api.github.com -Port 443` → `TcpTestSucceeded: true`（正常）。
2. DNS 解析 `api.github.com` → `140.82.114.5`。
3. 建 3 条出站防火墙规则：按 `Arckeep.exe` 程序路径、按 `140.82.112.0/20` CIDR、按刚解析出的 `140.82.114.5`，三条都成功创建（`ok: true`）。
4. 再测一次网络：`TcpTestSucceeded: false`——网络确认已经断开。
5. **这时才**冷启动一个全新的 Arckeep 进程（此前从未连接过网络），进入设置页，粘贴假 token，点「测试连接」。
6. 30 秒内出现提示：
   > 连不上 GitHub（网络不可达、DNS 失败或超时）。请检查网络或代理，恢复后再点一次测试连接。

   `isNetworkClassMessage: true`；token 仍在输入框（`tokenKeptInField: true`）。截图 `11-settings-network-error-retest.png` / `-retest-win.png`。
7. 点击后再测一次网络：`TcpTestSucceeded: false`——确认整个测试过程中网络一直是断开的，不是网络中途恢复导致的假阳性。
8. 清理 3 条防火墙规则后最后一次测网络：`TcpTestSucceeded: true`——确认清理干净，没有影响后续步骤（包括随后需要联网的 Release 冒烟）。

**判定：PASS。** 第一次（复用进程）的异常结果确认是验收方法论问题（连接复用），不是产品缺陷。完整步骤记录见 `x1-retest.json`，一句话结论见 `x1-retest-verdict.txt`。

### 5.2 AC9 不滚动可见性截图补证（绑定 `fef78d5`）

点击「保存热键」→ 出现冲突警告后，**立即**（不做任何滚动）截图 `08a-settings-hotkey-conflict-no-scroll.png`：页面仍停在设置页顶部（GitHub 认证卡片在最上面），`全局热键` 卡片的「保存热键」按钮已经贴着窗口下边缘，**冲突警告完全看不到**。

然后对警告元素调用 `scrollIntoViewIfNeeded()`，再截图 `08-settings-hotkey-conflict.png`：这时能看到完整的警告文字、旁边的「新的热键组合」输入框、「录制」和「改用这个」按钮。

**结论：不滚动时提示不可见。** 这是一个真实的产品 UX 问题（已记入第 4 节「产品缺陷」第 2 条），但不改变 AC9/X3 的 PASS 判定——标准原文只要求「有提示」，没有要求「不滚动也能看到」。

### 5.3 Release（`v0.0.1-test` / `4c5f83b`）冒烟测试（绑定 `4c5f83b`）

用 `verify/release-smoke.ps1`，只用 workflow 自带的 `GITHUB_TOKEN`（没有用任何其它 token）：

1. `gh release view v0.0.1-test` 确认 tag 对应的 commit sha：`4c5f83b903faf2dd38f3108a84465d34f12efd4f`（与 `git ls-remote --tags` 结果一致）。见 `24-release-view.json` / `24-release-tag-sha.txt`。
2. `gh release download v0.0.1-test --repo Dylan5237/arckeep` 下载两个资产。
3. `Get-FileHash` 现算 SHA256，和预期值逐字比对：

   | 资产 | 现算 SHA256 | 预期 SHA256 | 一致？ |
   |---|---|---|---|
   | `Arckeep-Setup-0.1.0.exe` | `B2BB471DC471EFC6045AC140F7D16619E2EC1F987193423222C84828F60FE47A` | `b2bb471dc471efc6045ac140f7d16619e2ec1f987193423222c84828f60fe47a` | ✅ 一致（大小写不同，内容相同） |
   | `Arckeep-0.1.0-portable.exe` | `1F7F323E437027518D6280DDA40A28527488F678CF633EF42018398BA9641EFC` | `1f7f323e437027518d6280dda40a28527488f678cf633ef42018398ba9641efc` | ✅ 一致 |

   见 `24-release-exe-sha256.txt`；脚本里也做了程序化比对，两个都通过，没有触发 `hash mismatch` 异常。
4. **portable 启动冒烟**：不带参数启动 `Arckeep-0.1.0-portable.exe`，25 秒后 `Get-Process Arckeep` 有进程（4 个同名子进程，Electron 多进程模型），`MainWindowTitle="Arckeep"`。截图 `25-release-portable-launch.png` 显示主窗口正常打开在「等我处理」页。见 `25-release-portable-launch.json`。
5. **安装包冒烟**：`Arckeep-Setup-0.1.0.exe /S` 静默安装，`exitCode=0`；在开始菜单找到 `Arckeep.lnk`，解析出目标 `C:\Users\runneradmin\AppData\Local\Programs\Arckeep\Arckeep.exe`；从这个快捷方式目标启动，20 秒后截图 `26-release-installed-launch.png`，同样显示主窗口正常打开。见 `26-release-installer.json`。

   **附注（证据较弱，如实说明）**：`26-release-installed-launch.png` 和 `25-release-portable-launch.png` 逐字节相同。脚本在两次启动之间已经 `Stop-Process` 了所有 `Arckeep` 进程，所以相同的原因是画面确定、两张截图都是同一个「等我处理」默认页面、在同一分钟内截取，不是脚本没有真的重新启动。但 `26-release-installer.json` 没有记下已安装 exe 那次启动的进程路径（只记了 `exitCode`、快捷方式链接和目标），没有像 `25-release-portable-launch.json` 一样留下 `pids`/`title` 之类能证明「这次启动确实用的是已安装路径」的进程级证据，这一点记为证据较弱，建议下次补上启动后 `Get-Process Arckeep -FileVersionInfo` 或等效的进程路径记录。

**判定：满足「从 Release 下载后三步内能跑起来」——下载 → 校验哈希 → 启动（或静默安装后启动），两种资产都在这三步内跑起来了。** `release-smoke-errors.txt` 没有产生（脚本里所有 `Write-Section` 都没有捕获到异常）。

**附注（不算缺陷）**：两个 exe 文件名里的版本号是 `0.1.0`（来自 `package.json` 的 `version` 字段），tag 名是 `v0.0.1-test`——这是两套不同的版本号体系（`0.1.0` 是产品语义化版本号，`v0.0.1-test` 是这次一次性的手动测试 tag），本来就不需要一致，只是命名容易让人以为对不上，这里明确记为附注，不影响 AC2 判定。

## 6. 附：证据 artifact 内容清单

本报告涉及两个 GitHub Actions 证据 artifact：

- **`verify-issue-1-evidence-fef78d5`**（第 1～4 节引用的原始证据，来自 run [36409794693](https://github.com/Dylan5237/arckeep/actions/runs/36409794693) 及其后 3 次仅改报告文本、结果一致的重跑）
- **`verify-issue-1-evidence-fef78d5-retest`**（第 5 节引用的补测证据，来自 run [36414606477](https://github.com/Dylan5237/arckeep/actions/runs/36414606477)，同时包含了修好判定逻辑后完整重跑一遍的全部 27 个原有场景 + 新增的 X1 隔离重测 + Release 冒烟，**这是当前最新、最完整的一份证据**）— <https://github.com/Dylan5237/arckeep/actions/runs/36414606477/artifacts/10966793560>

| 文件 | 对应勾选项 |
|---|---|
| `00-artifact-tree.txt` / `00-exe-sha256.txt` | 下载的 artifact 目录树、三个 exe 的 SHA256 |
| `01-main-window.png` / `-win.png` | AC4（主窗口默认尺寸） |
| `02-nav-waiting.png` … `05-nav-toolshelf.png` | AC4（四个模块页面） |
| `06-settings-empty.png` | AC4/AC5（首次设置页空状态） |
| `07-settings-invalid-token.png` | AC5c / X2 |
| `08a-settings-hotkey-conflict-no-scroll.png` | AC9/X3（不滚动，警告不可见） |
| `08-settings-hotkey-conflict.png` | AC9 / X3（滚动后，警告 + 控件都可见） |
| `09-window-narrow-800.png` / `10-window-narrow-min.png` | X6 |
| `11-settings-network-error.png` | X1（复用进程，方法论存疑，参考用） |
| `11-settings-network-error-retest.png` / `-retest-win.png` | X1（全新进程 + 确认断网，权威结果） |
| `x1-retest.json` / `x1-retest-verdict.txt` | X1 隔离重测完整记录 |
| `12-hooks-off.png` | X4 |
| `13-settings-repos-hotkey-saved.png` | AC7 |
| `14-hook-close-fullscreen.png` / `15-hook-show.png` | AC8 |
| `16-appdata-tree.txt` / `17-settings.json.copy.json` | AC6 / AC7 |
| `18-settings-after-restart.png` | AC7 |
| `19-eventlog-arckeep.txt` | AC3（见环境限制第 6 条） |
| `20-ac3-portable.png` / `.json`，`21-ac3-installer.json`，`22-ac3-installed-launch.png` | AC3（PR #8 产物，`fef78d5`） |
| `23-bonus-default-hotkey-occupied.png` | AC9 附加检查（不影响结论） |
| `24-release-view.json` / `24-release-tag-sha.txt` / `24-release-exe-sha256.txt` | AC2（Release 产物，`4c5f83b`） |
| `25-release-portable-launch.png` / `.json` | AC2（Release portable 冒烟） |
| `26-release-installer.json` / `26-release-installed-launch.png` | AC2（Release 安装包冒烟） |
| `scenes.json` | 27 个场景的机器可读结果 |
| `invalid-token-message.txt` / `hotkey-warning-message.txt` | 提示文案原文 |
| `index.md` | 文件与勾选项对照表 |

## 7. 时间线备注

- 本报告最初（18:37 北京时间）判定 AC2 为 FAIL，绑定在 `699736c`。
- 18:47:45 北京时间，Dylan5237 合并 [PR #11](https://github.com/Dylan5237/arckeep/pull/11) 修复了这个问题（`main` → `4c5f83b`），修复方式与本报告给出的建议一致。
- 18:52 北京时间，收到明确指示，把 AC2 的结论按 `4c5f83b` 上的新状态改判，并授权用 workflow 自带的 `GITHUB_TOKEN` 去下载 Release 资产做一次实测——19:05 北京时间更新，AC2 一节改写为「PASS（绑定 `4c5f83b`）」，历史上 `699736c` 的 FAIL 记录原样保留，标注「已被取代」。
- 19:07 北京时间，收到进一步指示：X1 网络场景要用全新进程重测并修正验收脚本的判定 bug、AC9 要补不滚动的截图、Release 要做真正的下载+启动冒烟。19:35 北京时间完成，即本报告第 5 节。
- 本报告除 AC2 外的其余各条（AC1、AC3–AC9、X1–X6）仍然只绑定 `fef78d5`/`699736c`，没有因为 `main` 前进而重新验证——那些结论描述的是 PR #8 那次提交本身的状态，这个事实不会因为后续有没有新提交而改变。

——本报告完——
