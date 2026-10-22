# 等我处理、项目总览排序与 APO 快捷评论

2026-10-12，本地实现候选。源码位于 `.worktrees/local-codex-waiting-actions`，分支 `feat/local-waiting-sort-actions`。本轮没有提交、推送、打包或安装；已安装的 0.1.3 尚未包含本次功能。不是正式发布或 Phase Accept。

## 用户行为

- 两页共用排序控件，默认最近活动从新到旧，可切换从旧到新或仓库名称；各页记住自己的选择。排序不触发 GitHub 请求，弱相关、陈旧、归档分组保留。
- 等我处理按事项 `updatedAt` 排序，等待时长来自触发原因的时间。项目总览按提交、Issue/PR 活动、推送和创建时间中最新的一项排序，列表同时显示最近活动时间。缺少或无效的排序时间放在末尾；同时间按仓库及身份确定顺序。
- 等待不足一天显示小时或分钟，少于一分钟显示「刚刚」。没有可靠事件时间时显示估算或「不足 1 天」，不补造精度。仓库名和 Issue/PR 序号加粗。
- 明确、无前置条件且身份/目标可核对的人工评论请求提供 `FREEZE ACK`、`EXCEPTION ACCEPT`、`PHASE ACCEPT` 按钮。点击向显示的目标评论对应原文；请求来源可为 PR，三类 APO 决定只发送到对应 Phase/架构例外 Issue。

使用细节与 PAT 评论权限见 [使用说明](USER-GUIDE.md)。自然语言识别采用保守规则，未覆盖的格式仍需要打开原记录处理；拒绝/退回的理由由用户在 GitHub 编写。

## 共用实现与提交边界

`shared/list-order.ts`、`renderer/list-sort.ts`、`shared/time.ts` 服务两页；`waiting/local-time.ts` 保留兼容导出。Markdown 结构由固定版本 `marked 18.1.0` 的 Lexer 解析，不自行解释代码块、引文或标题。词法匹配、处置人声明、终结性决定和撤回语义分别复用于列表识别与提交核对。

主进程只接受主窗口主 frame 的已知行和动作 ID，不接收任意评论正文。REST 提交前核对当前账号、源请求完整评论、指定目标完整评论、既有决定/撤回、处置人声明，以及请求和目标的最新 revision/body/comment count。不会自行关闭 Issue、合并 PR 或修改阶段状态。

同一目标的并行提交被拒绝，写前持久化尝试记录。每次点击最多发起一次 POST；POST 超时、取消、异常响应等不确定结果会跨重启保留，不自动重发，也不能借新来源 revision 绕过去重。独立的「核对评论结果」接口只读取 GitHub。该功能使用 REST，不消耗 GraphQL 查询配额，仍受 REST 速率限制和目标 Issues 写权限约束。

新依赖只增加了 `marked`，没有改变既有依赖版本。后续安装包的生产依赖 staging 必须包含 `package.json.dependencies` 全部内容，包括 `marked` 和 Ajv 的传递依赖；不能继续只复制旧版的 Ajv 五包清单。

## 验证证据

- 最终全量：`npm test -- --reporter=default --maxWorkers=4`，73 文件、672 测试通过，日志 `dist/task-evidence/regression-final.log`。
- 类型检查、lint、应用构建与 `git diff --check` 通过。
- Astra 在同一次独立审查中确认 5 个 P1、1 个 P2，并核对修复。最终 16 项独立反例/正例及 5 文件、105 项专项测试通过，无未关闭的已确认阻断项。报告保留初审和中间失败：`dist/task-review/astra-review.md`；37 个审查文件指纹：`dist/task-review/final-reviewed-hashes.json`。
- 真实 Electron 宽/窄窗口使用隔离 profile 和模拟数据。排序正反方向、分钟/小时、三个按钮、主窗口 IPC、截图模式禁止评论、无横向溢出检查通过。最终图片为 `dist/task-evidence/waiting-apo-final-retry.png`、`waiting-apo-narrow-final-retry.png` 和 `overview-narrow-final-retry.png`，已视觉检查。并行运行时一次 `capturePage` 报 `UnknownVizError`，原日志保留，串行重试成功。
- 312 个继承源码文件原目录哈希保持不变。本轮增量单独记录在 `dist/task-evidence/task-delta.json`，不将继承的未提交改动视为本轮工作。
- 已安装 ASAR 仍为 `2cf4de5b71ecbe25990d0898637eeef5b7023b471d0233b4b58e59ff247369a2`，未替换本地程序或用户数据。

验证中的 GitHub 响应全部模拟，真实外部评论为零；未执行线上控制面身份、实际评论权限或业务验收，也未重新测量真实网络下的刷新耗时。测试与技术审查不代表正式发布或用户验收。
