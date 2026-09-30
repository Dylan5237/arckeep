# 最终候选独立对抗审查

审查日期：2026-09-30。审查对象固定为 `f90e798aa24e1726ea615f1b6f8d98c2afde4434`，基线为 `417c3e453643ddeba09d961f7b72b6b1bab4327d`，产品目录为 `D:/_projects/platform/arckeep/.worktrees/6-codex-mvp-delivery`。本报告是用户要求的这一次最终完整独立审查；后续由实现方修复确证问题并针对性验证，不要求再启动一次完整独立复审。

## 结论

**发现 5 项 P2 产品缺陷，建议修复后更新候选。没有发现 P0/P1，也没有复现历史的直接动作绕过预览。** 当前参数保真、预演取消、输出可见性、退出接收新工作及编辑连续性仍有具体反例，因此不能写成“无阻断、可直接正式交付”。本结论基于产品缺陷，不以 Freeze/Accept 缺口替代代码审查。

R1/R3 为本轮真实 Windows PowerShell 进程实证；R2/R5 为本轮真实 renderer 源码的 DOM 回放；R4 为本轮生命周期组件调度实证及生产 IPC 接线审查。后两种证据不冒充真实 Electron/Windows IME 或 GUI 进程残留实证。以下行号均对应固定 f90e798。

## 检查方法与范围

- 读取 FINAL-CANDIDATE.md、FINAL-REVIEW-BRIEF.md，以及历史 ACCEPTANCE-MATRIX.md、FREEZE-PROPOSALS.md、ADVERSARIAL-REVIEW.md；历史失败仅作反例来源。
- 核对固定 HEAD、干净产品工作区，检查完整基线 diff（39 个文件，2242 行新增、182 行删除），读取相关当前实现及测试。`git diff --check 417c3e4 HEAD` 通过。
- 检查主进程一次性凭证、过期/重放/配置 revision/参数/仓库签名、缓存计划执行、旧直接动作防护、快速 done 事件缓冲、页面离开/返回、预演及正式进程生命周期、独立 termination Promise、清理错误聚合、退出接线。
- 检查 PowerShell 参数/错误/退出码/中文解码/CLIXML，cmd 隐藏 PowerShell relay 的参数构造、原始双流 CopyToAsync、stdin EOF、cwd、退出码和进程树终止。已有 282 项测试记录包含 Windows PowerShell、pwsh、cmd、Git Bash 真实进程；本轮未重复整套测试。
- 运行下述最小反例：通过当前 `out/shared/tools/quote.js`、`out/main/tool-launch.js`、`out/main/tool-runner.js` 直接执行无业务副作用的输出命令；renderer 用 esbuild `write:false` 内存打包真实源码、happy-dom 模拟 IPC 异步返回，没有改产品逻辑或落盘测试脚本。
- 检查 CI/Release 上传顺序、fixture 门禁、manifest/tag/version、README 声明及图标；独立重算两类 EXE hash，独立读取 ASAR 对照本地 196 个 out/schema 文件。
- 本轮未启动 GUI、未操作用户认证/业务数据、未推送/评论/合并/发布；唯一新增文件是本报告。

## R1 — P2：PowerShell 参数类型推断会改写正常参数

**位置：** `src/shared/tools/quote.ts:240-247`、`:254-260`、`:265-276`，由 `expandCommand` 在 `:359-362` 调用。

**触发与影响：** 一个 native 命令含多个占位符、块内先调用 cmdlet 再调用 native、或调用自定义函数/模块限定 cmdlet 时，合法文本被错误编码。目标收到的参数与用户输入不同，但命令仍返回 0；可影响带引号的提交信息、检索表达式、JSON 等实际参数。

本轮在默认 `powershell.exe` 上调用 `expandCommand(template, params, 'powershell') → planShell → runPlan`，工作目录为产品目录。输入 `value = 'a"b 中文'`。

| 模板 / 参数 | 预期 | 实际 stdout（全部 code=0） |
| --- | --- | --- |
| `node -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" {{first}} {{second}}`；first=`first`，second=value | JSON `["first","a\"b 中文"]` | JSON `["first","ab 中文"]` |
| `if ($true) { Write-Output prefix; node -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" {{value}} }` | prefix 后 native argv 保留 value | `prefix\r\n["ab 中文"]` |
| `function EchoValue { param($p) [Console]::Out.Write($p) }; EchoValue {{value}}` | 原始 value | 字面 `"a""b 中文"`，含新增外层引号及重复内部引号 |
| `Microsoft.PowerShell.Utility\Write-Output {{value}}` | 原始 value 加换行 | 字面 `"a""b 中文"\r\n` |

单占位符 `node -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" {{value}}` 对照组正确输出 `["a\"b 中文"]`。

**原因：** 扫描第二个占位符时，先前的 `{{first}}` 被当作真实脚本花括号并重置 command start；块内分号只在 braces=0 时更新 command start；函数和模块限定 cmdlet 又被命令名启发式归为 native。

**建议：** 至少将占位符视为不可拆分 token，正确定位块内当前命令；为无法可靠判断的函数、模块限定命令和动态调用采用有明确契约的解析/运行时类型识别，或明确拒绝不支持的形式。不要仅增加一两个命令名白名单。以上四种反例与单占位符对照均应做真实 PowerShell/pwsh 回归。

## R2 — P2：预演期间返回工具架没有取消，旧结果仍会覆盖当前操作

**位置：** `src/renderer/tools-page.ts:313-316`；相关 `:201-206`、`:755-761`。

**触发：** 配置一个有参数、带延迟 previewCommand 的命令，进入参数页点“预览”，在“正在预演”时点“返回”。返回仅把 session 改成 shelf，没有取消/清空 activePreviewRequestId。

**本轮 DOM 实证：** 使用真实 tools-page.ts 的内存 bundle、延迟的 previewTool Promise，依次点击卡片→预览→返回。返回后页面为工具架，`cancelToolPreview` 调用为 0；随后完成旧 Promise，页面重新出现“即将执行”对话框，`dialogAfterBack=true`。没有点击确认或运行正式命令。

**影响：** 返回不能停止实际预演，预演脚本仍可产生其已声明的副作用；旧结果可覆盖用户回到工具架后开展的新操作。相同所有权问题也出现在 `showPreview` 覆盖旧 requestId 时：无参数卡片没有 pending 禁用，快速重复点击可发起多个预演，而离页只知道最后一个请求。

**建议：** 把返回、离页、替换请求统一接入取消函数；使旧 requestId 失效后再切页面，旧成功和失败结果都不得重绘。新预览应先取消旧预览，或用明确 pending 状态阻止重复发起。验证延迟成功、延迟失败、旧请求晚于新请求完成及无参数重复点击。

## R3 — P2：PowerShell stderr 被延迟到结束，并可被后续 stdout 配额吞掉

**位置：** `src/main/tool-runner.ts:300-310`、`:286-295`，结合 `:275-284` 的共用 capped 标志。

**真实进程反例 1：**

```powershell
[Console]::Error.WriteLine("EARLY-STDERR"); Start-Sleep -Seconds 2; Write-Output "DONE"
```

ToolRunner 实际事件为：stdout `DONE\r\n` 在 2289 ms；stderr `EARLY-STDERR\r\n` 在 2309 ms；随后 done。开始时写出的纯文本 stderr 整段运行期间不可见。

**真实进程反例 2：**

```powershell
[Console]::Error.WriteLine("EARLY-DIAGNOSTIC"); [Console]::Out.Write(("x" * 200001))
```

实际 `code=0`、stdoutLength=200006（含“输出已截断”）、`stderr=""`。先产生的诊断永久消失，因为 stdout 先占满配额，close 时 emitText 直接跳过尚未发出的 stderr。

**影响：** 长命令的诊断和进度不可实时查看；大量普通输出可让更早的错误说明从最终显示和复制结果中消失。CLIXML 过滤不能以推迟整个 stderr 流为代价。

**建议：** 增量区分纯文本与 CLIXML：纯文本立即发送，只缓冲尚未完整的 CLIXML 记录，并对规范化后的输出按到达顺序/明确的双流预算限额。回归必须断言命令仍运行时已收到 stderr，以及早到诊断不会被后到 stdout 吞掉。

## R4 — P2：关闭开始后仍接收新预演，清理快照不覆盖新进程

**位置：** `src/main/tool-ipc.ts:203-205`、`:84-104`，`src/main/tool-rehearse.ts:171-178`、`:191-201`；生产退出接线为 `src/main/index.ts:647-655`。

**触发：** 已有预演 A 正在清理，before-quit 等待清理期间又收到新 previewTool 请求 B。tool IPC 的 shutdown 只清空凭证并调用 cancelAll，没有设置关闭状态或拒绝新 preview/run；cancelAll 只获取一次 active 快照。`isQuitting` 仅在 index.ts 设置，不传入此 IPC guard。

**本轮组件实证：** 对真实 createToolRehearsals 注入可控 runner：启动 A→调用 cancelAll→在 A 的 done 前启动 B→发送 A aborted done。实际 shutdown Promise 已完成，A start=1/abort=1，B start=1/abort=0 且仍 pending；随后 B 成功返回 `canConfirm=true`。此回放没有真实子进程，明确不作为 Windows 残留 PID 实证。

**影响与生产接线：** 应用退出的“等待全部预演清理”承诺仅对快照前工作成立；窗口/在途 IPC 在异步退出期间仍能启动未被这次清理等待的新 runner。现有正式退出 GUI 成功样例没有并发新请求，不能覆盖此时序。

**建议：** shutdown 开始时同步关闭接收入口，拒绝新的 previewTool/runTool，并确保在途预览不能在关闭后颁发凭证或启动 runner。采用明确 closing 状态；验证退出开始后 preview/run 被拒绝，已有清理失败仍可收敛且不会放行新工作。

## R5 — P2：撤销到期仍替换编辑节点，持续输入被打断

**位置：** `src/renderer/todos-page.ts:58-59` 调用整页 draw，`:119` 整板 replaceChildren，`:398-410` 重新创建输入节点。

**触发：** 删除 A，立刻编辑 B，聚焦内容输入框，把光标放在文字中间；保持编辑跨过五秒撤销期限。

**本轮 DOM 实证：** 真实 todos-page.ts 内存 bundle + happy-dom，输入 `draft`、光标位置 2。5.1 秒后：旧节点 `isConnected=false`、新旧节点不相同、activeElement=`BODY`、新输入框不聚焦、光标位置 5；草稿值仍是 `draft`。

**影响：** 已修复“旧值覆盖草稿”，但用户继续打字时输入不再落入编辑器，需要重新点击并定位光标。销毁正在 composition 的节点还可能打断选词，不过本轮没有真实 Windows IME 证据，不能把该推断写成实证数据丢失。

**建议：** 期限到达只移除撤销条，保持编辑 DOM 节点；若确实必须更新列表，应保存并恢复焦点/选区，且不要替换处于 composition 的编辑器。回归在到期后检查节点、焦点及选区，而不只检查 value。

## 已核查的修复与制品事实

- 一次性凭证在 take 时删除，配置 revision/原 JSON/参数/仓库签名/展开预览同时核验；确认执行缓存的 ShellPlan。旧直接动作按当前类型变成 run-command 时无凭证会拒绝。未发现新的同类绕过，不要求恢复链接/目录/模板的预览弹窗。
- 快速 output/done 有 runId 缓冲；正式运行事件离开工具页后只更新会话，host 被置空；主导航到其他页面会取消其知道的预演。R2 是工具页内部返回/替换请求的遗漏，不能把“所有导航都失败”作为结论。
- 独立 terminations 集合和 drain Promise 使 close 后仍可等待清理；记录的正式退出 f90e798 回放在 harness 清理前 main/command/child 均 absent，无 completion sentinel。该记录符合其声明范围，不能沿用旧 FAIL 断言此路径仍失败。R4 是不同的并发新工作时序。
- 待办恢复核验绝对期限，旧按钮过期不能恢复；保存了文本/repo/waiting 草稿，composing Enter 有检查。R5 是节点和焦点生命周期，区别于已修复的字段回退。
- CI 和 Release 的 fixture 启动检查、checksum/manifest 均在上传之前；没有 continue-on-error 放行该检查。清理针对本次 PID 树。Release tag 必须与 package version 相同。fixture 关闭 sandbox、模拟认证的边界已披露；没有把其成功当正常认证、首次安装或业务验收。
- 独立读取实际 candidate-f90e798：版本 0.1.0，manifest 固定到 f90e798，Electron 配置 43.7.6；实际运行时 43.7.6 来自已有 package-verification 记录，本轮没有重新启动 GUI 查询。
- 独立重算 Setup：104497805 bytes，SHA256 `a0575bd47c704725212e903b3677aa151e753d14f212be4f9f5164ff40f769ce`；portable：104272067 bytes，SHA256 `4ffb9dd500732ce1417e57cda05e1c39331a20f0512647c8962f18581ca84c42`。均与 manifest 相同。
- 独立 ASAR 提取比较 196 个 out/schema 文件，全部与本地构建及已记 hash 相同；未发现 happy-dom/vitest/@vitest 打入 ASAR。Windows ASAR 路径首次使用 `/` 查询失败，改用 `path.normalize` 后完成读取；这是读取路径问题，不是制品失败。
- 已读两类容器的 payload-verification，记录 app-64.7z 两者相同及关键文件与 win-unpacked 相同；本轮没有重复解包。独立计算 build/icon.ico SHA256 为 `a3c7f9c99b512abe5e57b4a06c2c50f0622c66d7de6ca267a3912058332b47f4`，视觉检查已提取 application.png 为 Arckeep 图形；旧 KCC 包不作为候选。

## 未验证疑点与接受边界

- 本轮没有在真实 GUI 制造 R4 的并发退出时序，也没有模拟 Windows 拒绝 taskkill、父进程先退出或受保护后代的故障环境。清理错误有聚合/日志，但这些路径不能宣布 OS 层全部成功；不把未运行故障环境直接新增为确证缺陷。
- 无参数重复预演的资源所有权遗漏来自静态路径，R2 的主要 DOM 实证是带参数预演返回；修复方应针对相关替换路径验证，不必为此再发起完整审查。
- 真实 Windows 中文 IME、系统热键及前台焦点、托盘鼠标退出、干净 Windows 安装/便携启动、真实认证和非空业务数据仍待接受。测试/fixture/本机打包不替代这些结果。
- 未签名、无自动更新、分类误差、外部 native 固定旧代码页输出不自动识别，属于已披露范围；测试工具依赖风险与实际运行时风险分开，不宣称不存在风险或代理可自接受。
- 远端 CI、PR/Command Center、Freeze ACK、Bugbot、Phase Accept、正式 tag/Release/附件回读未由本轮完成。报告没有外部写入授权或阶段接受效力。
- 修复上述问题后源 SHA 将变化，当前 f90e798 两类包只证明本次审查对象，必须重新构建、绑定 hash 和保留针对性验证；不能沿用本次制品身份代表修复结果。

**交付建议：** 实现方修复 R1–R5，按每条反例做针对性验证并更新最终候选身份。保留这份固定 SHA 审查报告及修复证据，不将报告改写为已修复版本的第二次完整审查。
