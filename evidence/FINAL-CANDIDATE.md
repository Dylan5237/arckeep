# Arckeep 0.1.0 本地交付候选

本地候选已完成一次最终 Astra/high 完整对抗审查，并修复报告中的五项 P2；最终整合检查与制品验证通过。没有再开展第二次完整独立审查。此结果是本地技术交付候选，不是正式发布、业务验收或 Phase Accept。

## 固定身份与制品

- 分支：`fix/6-mvp-delivery`；源码提交 `ee033380291d8968e3e8e5dd8fcf383e236f58fe`，产品工作区干净。
- 基线：GitHub `origin/main` 的 `417c3e453643ddeba09d961f7b72b6b1bab4327d`；所有实现和证据均尚未推送。
- 产品工作区：`D:/_projects/platform/arckeep/.worktrees/6-codex-mvp-delivery`。
- 当前制品目录：`dist/candidate-ee03338-local/`。版本 0.1.0，实际 Electron 43.7.6，manifest tag=null；两类 EXE 均 NotSigned。

| 文件 | bytes | SHA256 |
| --- | ---: | --- |
| Arckeep-Setup-0.1.0.exe | 104497538 | 017f59a4aebb8af442562c3174a063e713ecd424a0b5d02387b029d77859602f |
| Arckeep-0.1.0-portable.exe | 104271801 | 66356a3f76b98f0907e07d34495cf0ac29bfb94a08609ba7dbe434166bb70b23 |

同目录 `package-manifest.json` 与 `SHA256SUMS.txt` 记录完整身份，副本在 `checks/ee03338-*`。默认网络打包在 Electron 下载显示完成后停滞六分多钟；仅停止身份确认的自有 builder，原日志 `checks/ee03338-package.txt` 保留。随后用本机已验证的 Electron 43.7.6 runtime、`--publish never` 在新目录构建成功，日志 `checks/ee03338-package-local-runtime.txt`。最终实际版本与 payload 已另行核对，未将停滞尝试记成通过。

## 审查修复与检查

最终审查对象固定为 f90e798，报告 `FINAL-ADVERSARIAL-REVIEW.md` 确认五项 P2、无 P0/P1。实现方闭环记录在 `FINAL-REVIEW-RESOLUTION.md`，对应独立提交为：

| 问题 | 最终修复提交 | 针对性证据 |
| --- | --- | --- |
| R1 PowerShell 参数被改写 | ee03338 | PS5.1/pwsh 多参数、块内 native、函数、模块限定 cmdlet 保真；带双引号参数的动态/未知命令明确失败，sentinel 未执行 |
| R2 预演期间返回及替换请求 | b4b7ee4 | 四项真实 renderer DOM 回归覆盖延迟成功/失败、旧新请求交错、无参数重复点击 |
| R3 stderr 延迟或被 stdout 吞掉 | d8b94c4 | 普通文本及完整 CLIXML 记录增量显示；PS5.1/pwsh 早 stderr/晚 stdout、双向超额度及分块记录回归通过 |
| R4 关闭期间仍接收新工作 | 6a36ea4 | 同步关闭 IPC/runner/预演入口；新 preview/run 拒绝，在途预览不颁发凭证，已有清理期间新预演不启动 |
| R5 撤销到期丢编辑焦点 | 12d69de | 只移除撤销条，保留同一输入节点、焦点、选区及合成 composing Enter；过期旧按钮不触发重绘 |

最终固定提交的完整测试为 40 files / 297 tests 通过；typecheck、lint、build:app、diff-check 通过。日志 `checks/ee03338-{tests,typecheck,lint,build}.txt`。测试涵盖 Windows PowerShell、pwsh、cmd、Git Bash 真实进程，并保留预览凭证重放/配置参数仓库漂移、事件终态、待办草稿和退出清理回归。

修复保留直接动作打开/复制、命令预览确认和实际 dry-run 的既有交互。新增边界准确记录在 README：参数含双引号且无法可靠识别 PowerShell 命令名时明确失败；外部程序固定 GBK/OEM 输出不自动转码。双流总内容上限 200k，为每流预留 8192 字符，截断标记另计。

## 制品与图标验证

`package-verification-ee03338.json` 查询实际 EXE 的 Electron 43.7.6；196 个 ASAR 内 out/schema 文件与本地构建逐字节一致，ASAR 无 happy-dom/vitest/@vitest。此为本地技术来源证明，不是远端可重复构建证明。

`payload-verification-ee03338/verification.json` 单次脚本运行 exit0、result=PASS。两类 EXE 的字面 `$PLUGINSDIR\app-64.7z` 均为 103913864 bytes、SHA256 `CC87E5AD0BCC081A09DA87B09B5AA3056380453318A5274E21641644412DC026`。Arckeep.exe、app.asar、icon.ico、icon.png 均匹配 win-unpacked。三张应用/安装器/portable 图标 PNG 同 hash，root 已视觉确认 Arckeep；七层 ICO hash 为 `A3C7F9C99B512ABE5E57B4A06C2C50F0622C66D7DE6CA267A3912058332B47F4`。

最终打包 fixture 启动检查 exit0，截图位于产品工作区 `dist/candidate-ee03338-local/package-smoke/4cb37a892b3245ed8737eb907e98f9e0/signed-out.png`。它使用隔离 profile、模拟认证和关闭 sandbox 的既有截图模式，只证明该包能加载 fixture UI。

旧 KCC 制品、旧 e3/f90 候选和原始失败均保留追溯，不作为当前交付物。f90 固定候选的历史汇总为 `HISTORICAL-CANDIDATE-F90E798.md`；正式退出 f90 GUI 复验、待办三组及命令七组沿其原提交和声明范围保留。没有声称全部 GUI 场景在 ee03338 重跑；本次新增五项按真实进程、DOM、组件调度针对性验证。

## 接受边界与下一步

- 本次没有独立干净 Windows 的首次安装/便携启动、真实中文 IME、系统热键、托盘鼠标退出、真实认证和非空业务数据接受；fixture 与本机测试不替代这些结果。
- 未签名、无自动更新；测试工具链依赖风险仍保留且未打入 ASAR。先前受限权限运行与脚本补证失败仍保留，不改写成成功。
- 最新只读回查见 `control-plane-readback-ee03338.json`：main 未变化，PR #31 仍 OPEN，Issue #6 六项接受条件未勾选。远端 CI、Command Center、Freeze ACK、Bugbot、Phase Accept、正式 tag/Release 和附件回读尚未完成。
- 实现与证据采用独立本地分支。下一步的固定身份和两条 origin push 命令在 `REMOTE-PUSH-PROPOSAL.md`，按用户约定等待明确确认。提案不包含 PR/Issue/评论、合并、tag 或 Release 写入，不自接受阶段。
