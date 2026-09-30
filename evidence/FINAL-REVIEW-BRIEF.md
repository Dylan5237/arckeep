# 最终对抗性审查任务

用户要求持续完成实现，交付前仅进行一次完整独立审查；审查模型为 Astra，思考强度 high。审查以最终候选的实际源码、构建、制品和证据为准，不能把历史基线结论直接套用到当前版本。

## 输入与范围

- 产品：`D:/_projects/platform/arckeep/.worktrees/6-codex-mvp-delivery`，分支 `fix/6-mvp-delivery`。
- 产品基线：`417c3e453643ddeba09d961f7b72b6b1bab4327d`。
- 最终身份与当前有效制品以 `FINAL-CANDIDATE.md` 和对应 package manifest 为准。
- 最终证据：本目录；历史合同候选与需求对账在 `D:/_projects/platform/arckeep/.worktrees/6-codex-mvp-readiness/evidence/FREEZE-PROPOSALS.md` 和 `ACCEPTANCE-MATRIX.md`。
- 保留 PR #18/#22 的立即删除加约五秒撤销、链接/目录/模板直接动作、命令预览确认、实际执行 dry-run 的决定；不扩改 #2 已接受分类限制。

## 审查要求

1. 主动寻找反例：预览凭证重放/漂移、旧直接动作绕过、配置与仓库映射变化、事件到达顺序、快速终态、预演取消与退出清理。
2. 核查 shell 的真实参数、反注入、退出语义、中文 stdout/stderr、增量解码与混合输出；不能以单一 native UTF-8 用例代替 cmd 内建或 PowerShell cmdlet 行为。
3. 核查待办编辑草稿、撤销绝对期限、连续操作、重启持久化与 composing Enter；区分合成 IME 事件和真实 Windows 输入法。
4. 核查制品中的版本、Electron、ASAR、运行时依赖、图标、SHA256 与源码身份。图标必须是 Arckeep，旧 KCC 包不可作为交付物。
5. 核查 CI/Release 门禁的真实覆盖与失败处置，以及报告中测试、打包 fixture、正常 sandbox、安装/便携启动和真实业务接受的边界。
6. 每个缺陷必须给明确触发、影响、当前文件与行号、证据或可复现步骤及修复建议；按严重性区分阻断与非阻断，避免只报风格偏好。没有实证的疑点应标明未验证。

## 操作边界与输出

审查只读产品。允许必要的隔离验证，但不得修改产品、推送、评论、合并、发布或自接受阶段；启动桌面测试前与 root 协调窗口所有权。保存独立审查报告，明确具体检查、已验证问题和未完成接受项。控制面缺少 Freeze/Accept 等事实必须保留，但不得用它替代产品缺陷审查。

审查后 root 修复确证问题并做针对性验证；遵守用户安排，不再另开第二次完整独立审查。
