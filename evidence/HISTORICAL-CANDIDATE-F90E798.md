# Arckeep 0.1.0 本地交付候选

当前状态：以下 f90e798 是已完成最终 Astra 审查的固定候选，发现五项 P2 后正在修复，当前包仅保留追溯，暂不可交付。审查报告为 `FINAL-ADVERSARIAL-REVIEW.md`，修复进度及针对性验证见 `FINAL-REVIEW-RESOLUTION.md`；完成后将重建并更新本页身份。此前 cmd 内建中文乱码及正式命令退出后后代残留均已修复并复验。本文不表示 Phase Accept 或正式发布。

## 固定身份与制品

- 产品分支：`fix/6-mvp-delivery`；固定提交 `f90e798aa24e1726ea615f1b6f8d98c2afde4434`，产品工作区干净。
- 权威基线：`origin/main` 的 `417c3e453643ddeba09d961f7b72b6b1bab4327d`；实现提交均仅在本地。
- 产品工作区：`D:/_projects/platform/arckeep/.worktrees/6-codex-mvp-delivery`；当前制品目录 `dist/candidate-f90e798/`。
- 应用版本 0.1.0，Electron 43.7.6；manifest 的 tag 为 null。两类 EXE 均为 NotSigned，见 `checks/f90e798-signatures.json`。

| 文件 | bytes | SHA256 |
| --- | ---: | --- |
| Arckeep-Setup-0.1.0.exe | 104497805 | a0575bd47c704725212e903b3677aa151e753d14f212be4f9f5164ff40f769ce |
| Arckeep-0.1.0-portable.exe | 104272067 | 4ffb9dd500732ce1417e57cda05e1c39331a20f0512647c8962f18581ca84c42 |

同目录 `SHA256SUMS.txt`、`package-manifest.json` 记录完整身份。`package-verification-f90e798.json` 查询实际 packed EXE 的 Electron 版本，196 个 ASAR 内 out/schema 文件与该提交的本地构建逐字节一致；ASAR 无 happy-dom/vitest/@vitest。这是本地技术来源证明，不是远端可重复构建或业务接受证明。

`payload-verification-f90e798/verification.json` 解出两类 EXE 中字面路径 `$PLUGINSDIR\app-64.7z`：各 103914129 bytes，SHA256 均为 `712014CB873D1E81A035FEE1140C718946CA6A1CB1B3D5DAD6B46F1AA5F9100D`。其中 Arckeep.exe、app.asar、icon.ico、icon.png 均匹配 win-unpacked；15 条工具命令 JSON/TXT 日志记录退出码 0。大型 raw-payloads 保留本地，由精确 ignore 排除，不进入 git。

## 实现与检查

| 用户结果 | 实现 |
| --- | --- |
| 只执行已确认命令 | 主进程一次性预览凭证核对配置/参数/仓库映射，执行缓存计划；直接动作按 PR #22 打开或复制 |
| 执行结果可信 | cmdlet 错误返回失败，保留显式/native 退出码；分开编码 cmdlet/脚本与 native 参数；增量解码保留跨 chunk 中文，过滤 CLIXML progress |
| 导航不丢输入 | 工具事件缓冲并只更新工具会话；离页取消预演；正式运行状态跨页保留 |
| 待办不丢草稿 | 绝对撤销期限、过期撤销拦截、编辑草稿保留、composing Enter 防误提交 |
| 退出等待清理 | runner 独立保留终止 Promise；中止、预演取消和应用退出均等待清理完成 |
| 产品可识别 | 设置显示版本；README 包含获取/启动/认证和关注仓库步骤；Windows ICO 为 Arckeep 七层图标 |
| 上传前核对制品 | CI/Release 在上传前运行打包 fixture 检查；只清理自有 PID 树；记录 hash/源码清单，Release 校验 tag/version |

固定 f90e798 的完整测试为 37 files / 282 tests 通过，覆盖 cmd、Windows PowerShell、pwsh、Git Bash 真实进程。typecheck、lint、build:app、diff --check 通过；构建 Node 为 v22.22.1。日志为 `checks/f90e798-{tests,typecheck,lint,build,package,package-smoke}.txt`。受限运行与旧断言的原始失败仍保留。

cmd 原 FAIL 在 `cmd-output/cmd-output-results.json`。修复使用隐藏 PowerShell relay 为 cmd 建立隐藏 console、设置 UTF-8、并行转发原始 stdout/stderr、关闭 stdin、透传退出码；真实进程测试包含 builtin/native 混流、cwd、stdin EOF、hostile argv、exit3 与 relay 后代中止。最终编译产品的 `cmd-output-f90e798/cmd-output-results.json` 显示中文双流完整、code=0。外部程序硬编码 GBK/OEM 输出不在自动转码保证内，README 已说明。

## 桌面证据及边界

待办三组在 `final-candidate-todo-20260930T0706Z/`：删除 A 后编辑 B 不丢文字、跨页保持原撤销期限、过期旧按钮不能恢复、合成 composing Enter 不保存、普通 Enter 保存且重启属性保留。使用正常 sandbox、独立 profile；真实 main PID/graceful quit 已回读。合成事件不能证明真实 Windows 中文 IME。

命令前五组在 `final-candidate-command-20260930T070215Z/results-attempt-2-short-rehearsal-window.json`：旧 template 配置漂移、命令配置漂移、参数漂移、后台运行保留设置草稿、快速终态/启动失败。最终离页与退出预演两组在同目录 `results-rehearsals-final.json`：started→action 约 10.008 秒，早于 20 秒自然完成；操作前 PID live，操作后且 harness 清理前 absent，无 completed/formal started marker。这些回放先于最后两项修复；最终提交相关回归由完整测试覆盖，不声称所有 GUI 场景在 f90e798 重跑。

正式退出原始 FAIL 为同目录 `results-formal-quit.json`：main/command root 退出，后代仍活；记录在 finally 清理前，随后仅清理身份确认的残留。修复后只重跑失败场景，见 `results-formal-quit-f90e798.json`：最终提交/Electron 43.7.6，started→quit 21.236 秒；退出前 main/command/child 均 live，退出后且任何 harness 清理前均 absent，两类 completion sentinel 均不存在。独立 CIM 确认 main、Playwright、command、child、runner 均 absent；wrapper 同卷归档且 hash 匹配。原 FAIL、原 prepared manifest 和脚本补验记录保留。

最终打包 fixture 启动检查 exit0，截图在产品工作区 `dist/candidate-f90e798/package-smoke/540131a0beb4405eafee6425c04de44b/signed-out.png`。使用既有截图模式、隔离 profile、模拟认证且关闭 sandbox；只证明该包可加载 fixture UI，不证明正常认证、安装器执行或干净 Windows 接受。

## 图标与旧候选

最终程序/安装器/portable 的 32px 图标提取在 `payload-verification-f90e798/icons/`，三张 PNG hash 相同；root 已视觉确认应用图标为 Arckeep。ICO 含 16/24/32/48/64/128/256 七层，SHA256 为 `A3C7F9C99B512ABE5E57B4A06C2C50F0622C66D7DE6CA267A3912058332B47F4`。旧 candidate-88f71eb 含 KCC，不可交付；e3ea343 虽图标正确，未含最后两项修复，也不可作为当前候选。旧资源/制品保留追溯，当前入口仅指向 candidate-f90e798。

## 未完成接受项

- npm 官方审计不再列 Electron；happy-dom high、vitest/@vitest/mocker moderate 共三项测试工具风险仍在，实际 ASAR 无这些依赖。
- 本机受限运行曾触发目录读取/清理权限错误；已保留前后快照、为本地二进制目录补充 sandbox RX，并在完整进程权限下验证。正常产品回放未关闭 sandbox；打包 fixture 的例外如上。
- 真实 gh 查询仅关注本项目，复用既有登录、不保存 token；当前规则返回 0 待处理项，不证明业务事项成功显示。
- 尚未在独立干净 Windows 验证首次安装/便携启动、真实中文 IME、系统热键、托盘鼠标关闭/退出、真实认证与业务数据。无代码签名或自动更新。
- PR #31、Command Center、Freeze ACK、Bugbot、Phase Accept、正式 tag/Release、成功远端 CI 和附件回读未完成；Issue #6 六项接受条件未勾选。授权本地实现不等于远端写入、合并或发布授权。

## 最后交付门禁

一次最终 Astra 完整审查 → 修复确证问题并针对性验证 → 独立本地证据提交 → 提供固定身份的候选及远端 push 提案。后续不再另开第二次完整独立审查；不以控制面或人工接受缺口替代产品缺陷判断，不自接受阶段。未经对应授权，不推送、不建/修改远端 Issue/PR/评论、不合并、不打 tag/发布 Release。
