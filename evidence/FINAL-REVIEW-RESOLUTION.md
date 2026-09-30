# 最终审查修复与针对性验证

唯一最终完整 Astra 审查固定在 f90e798，报告为 `FINAL-ADVERSARIAL-REVIEW.md`。本文件是实现方对五项 P2 的修复记录，不是第二次完整独立审查或 Phase Accept。审查对象包保留追溯，修复后需要新的源码和制品身份。

| 问题 | 状态与实现 | 针对性验证 |
| --- | --- | --- |
| R1 PowerShell 参数保真 | delivery ee03338：PowerShell AST + Get-Command 区分实际调用；带双引号参数的动态/未知命令明确失败 | quote/runner 31 项定向测试通过；PS5.1/pwsh 的多参数、块内 native、函数、模块限定 cmdlet 保真；动态调用 sentinel 未执行；定向 typecheck/lint/build 通过 |
| R2 返回/替换预演 | delivery b4b7ee4：返回及新预览先取消旧 requestId，延迟结果忽略 | 4 项真实 renderer DOM 测试通过：延迟成功、延迟失败、旧/新请求交错、无参数重复卡片；定向 lint、typecheck、build:app、diff-check 通过 |
| R3 stderr 实时与配额 | delivery d8b94c4：立即发送普通 stderr 与完整 CLIXML 记录，总内容 200k 且为两流各保留 8192 字符额度 | 6 项增量/真实进程测试通过，PS5.1/pwsh 的诊断先于 DONE、stdout 超额度仍保留 stderr、反向大 stderr 也保留 stdout；分块 CLIXML/progress/中文及末尾 flush 覆盖 |
| R4 shutdown 拒绝新工作 | delivery 6a36ea4：before-quit 同步关闭 runner/预演/IPC；shutdown 再等待已有任务 | IPC 在途预览不能颁发凭证、新 preview/run 拒绝、已有清理等待期间新预演不启动，两个新增测试通过；相关生命周期共 5 项通过 |
| R5 撤销到期编辑连续性 | delivery 12d69de：仅移除撤销条，过期旧按钮不触发整板重绘 | 新增 DOM 回归：同一编辑节点连接、焦点、选区、合成 composition Enter 跨截止时间保留；待办 6 项测试通过，定向 lint、typecheck、build:app、diff-check 通过 |

五项均已整合到 ee033380291d8968e3e8e5dd8fcf383e236f58fe。R3/R4 的 11 项组合定向检查、typecheck、lint、build:app 和 diff-check 均通过，日志为 checks/r3-r4-*.txt；R1 日志为 checks/r1-*.txt。最终完整检查为 40 files / 297 tests、typecheck、lint、build:app、diff-check 通过，checks/ee03338-* 记录结果。

新制品目录 candidate-ee03338-local，实际 Electron 43.7.6、196 个 ASAR out/schema 文件字节匹配、两类 EXE payload/四个关键文件/Arckeep 图标核对通过，打包 fixture 启动 exit0。两类 EXE 未签名；正式安装/业务接受仍未完成。完整身份与 SHA256 见 FINAL-CANDIDATE.md，不沿用 f90 制品代表修复结果。

上述 DOM/组件测试不表示真实 Windows IME 或并发 GUI/PID 故障环境已验收；既有成功 GUI 证据沿其固定提交与声明范围保留。本文件记录实现方针对五个确证反例的修复，不新增完整独立复审或自接受阶段。
