# Arckeep

Arckeep：Dylan 的 AI 原生个人工作台（Windows 桌面应用，v1.0.0）。

Arckeep 把「记录想法 / 正式交办 / 掌握后台工作 / 作出必要决定 / 验收成果 / 恢复工作现场」放在同一个桌面工作台里。v1.0 的核心是一条真实闭环：

**交办任务 → 确认执行范围 → Codex 或 Claude Code 真正执行 → 等待 CI/定时/决定 → 条件变化后自动唤醒继续 → 查看成果与证据 → 验收或反馈返修。**

第一次使用请先看 [Arckeep 使用说明书](docs/USER-GUIDE.md)。

## 快速开始

1. 下载并运行 `Arckeep-Setup-1.0.0.exe`，或直接双击 `Arckeep-1.0.0-portable.exe`。程序未签名，Windows 可能显示 SmartScreen 提示；核对来源和 SHA256 后再决定运行。关闭主窗口会留在托盘，托盘菜单的「退出」才会结束应用。
2. 在本机安装并登录 Codex CLI 和/或 Claude Code CLI，确认 `codex`、`claude` 在 PATH 中。打开 Arckeep「设置 → AI 任务执行」可看到检测结果。
3. 打开「任务」新建交办：写清目标，选择本地工作目录（可关联仓库），选择 Agent、授权范围与优先级。先「创建任务」确认范围，或直接「创建并开始」。
4. 需要你决定的事项会出现在任务页顶部和「等我处理」；执行结束后在任务详情查看产物、检查、未验证事项，再点「验收通过」或填写反馈继续修改。

「设置」里还可以配置 GitHub 认证（优先使用已登录的 `gh`，也可保存只读 PAT）、关注仓库、全局热键、等我处理来源、项目总览规则和工具架。设置页显示应用版本。

## v1.0 能力

### 任务与交办

- 任务、项目、实际工作目录、Agent 会话、执行轮次、事件、回执与成果关联在同一张任务卡上。
- 灵感、待办和正式交办分离：灵感不会因为被记录就自动执行；需要时从灵感或待办点「交给 AI」，进入任务页确认范围。
- 任务详情直接显示目标、授权边界、等待原因、产物、检查结果、未验证事项和执行日志。

### 真实 Agent 执行

- **Codex**：`codex exec --json`，支持 `resume <thread>` 续接同一会话；默认 `workspace-write` 沙箱，完全自主模式需显式选择。
- **Claude Code**：`claude -p --output-format stream-json`，支持 `--resume`；本机已有 Claude 会话可在「Claude 会话」页按项目查看、阅读历史并恢复。
- 任务 prompt 通过 stdin 传入，不拼进命令行；运行有超时和进程树回收；失败会保留真实退出码、stderr 和日志位置。
- 同一工作目录内的任务串行执行，避免并发写入冲突；不同目录按并发上限并行。

### 后台事件与恢复

- 定时等待、GitHub PR/CI 变化、用户决定都能作为唤醒事件。
- Agent 遇到等待条件会结束本轮并释放进程；事件到达后先核对最新事实，再继续未完成步骤。
- 暂停的任务不会被新事件自动恢复；应用退出或被强制结束时，运行中的任务会标记为中断并暂停，等待你核对后继续，不会虚构仍在运行。
- 支持运行轮次、单轮时长、费用和启动重试上限；超时或状态不确定时停止并提示，不盲目重做有副作用的操作。

### 决策与验收

- 「需要你决定」只放业务取舍、授权边界或无法自行解决的问题；每项包含背景、建议、选项与影响。
- 回复绑定到具体任务和请求版本；重复、过期、非当前请求会被安全拒绝。
- 任务状态区分：待确认范围、排队中、执行中、等待事件、等我决定、待验收、已验收、已暂停、失败、已取消。
- 验收通过才进入「已验收」；PR 合并、CI 通过或 Agent 自述都不会自动代替你的验收。

### 已有功能

- 快速捕获、灵感、待办、提示词库、工具架、项目总览和「等我处理」均保留。
- 灵感与快速捕获的仓库改为从已知仓库下拉选择，可不关联，不再要求手填 owner/repo。
- 「等我处理」继续支持 APO v0.3.1 正式决策请求的快捷回复；对声明了处置人/拍板人的近义请求提供「可能相关」按钮，发送前必须二次确认，未识别、身份不符、已回复或历史内容不会生成按钮。

## 数据与安全

- 用户数据位于 `%APPDATA%\Arckeep\`。任务索引写入 `tasks.json`，运行日志在 `task-runs\`；原有 `todos.jsonl`、`ideas.json`、`prompts.json`、`settings.json` 等文件保持原路径。
- GitHub PAT 经 Electron `safeStorage` 加密后写入设置；不使用明文落盘，不写日志。
- Agent 运行日志可能包含工作目录中的输出，只保存在本机 userData；不会上传 GitHub，也不会作为任务内容发送到外部服务。
- 外部 Issue、PR、网页和事件内容按不可信资料处理，不能改变任务的工作目录、授权范围或系统规则。
- 备份前请从托盘退出，再复制整个 Arckeep 数据目录。

## 已知限制

- 当前交付目标为 Windows x64；没有代码签名和自动更新。
- 需要用户自行安装并登录 Codex CLI / Claude Code CLI。Arckeep 不代装、不代管它们的凭据。
- 完全自主模式仍受任务目标和提示约束，不是系统级安全沙箱；涉及合并、部署、生产数据或强制推送等高风险操作，必须先由任务目标明确授权，必要时通过「等我决定」停下。
- GitHub CI/PR 事件需要 `gh` 或 PAT 具备目标仓库的读取与 checks 权限；分类和等待状态可能漏判，需以 GitHub 原始记录为准。
- 由于 Windows PowerShell 管道的默认编码，Agent 写入非 ASCII 文件时必须显式使用 UTF-8；任务协议已提示这一点，但外部 Agent 的行为不完全由 Arckeep 控制。
- 「等待」超时、网络失败或进程被系统结束时，任务会停止并保留现场，不会自动猜测结果或重复有副作用的写入。
- 工具架命令与预演会在本机真实执行，预演也可能产生副作用；只有命令需要预览确认。
- 工具架的 Windows `cmd` 内建输出按 UTF-8 读取；外部原生命令固定输出旧代码页时需由命令本身切换编码。PowerShell 参数含双引号时按运行时命令类型选择编码；无法静态识别命令名的动态调用会明确失败。
- 本地 Claude 会话发现只读取本机 `~/.claude/projects` 下的记录；读取最近一段文字消息，不展示工具输入/输出全文，不上传或复制聊天内容。

## 开发

需要 Node.js 22.12.0 或更高版本。

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build:app
npm start
```

任务引擎也可以用同一套代码在命令行诊断（数据目录默认 `%APPDATA%\Arckeep`，可用 `--data` 隔离）：

```bash
npm run build:ts
node out/main/tasks/cli.js status
node out/main/tasks/cli.js create --goal "目标" --cwd "D:\\work\\demo" --repo owner/demo --agent codex --autonomy edit --watch
node out/main/tasks/cli.js reply --decision <id> --option A --watch
```

`npm run overview -- --json` 只读查询项目总览，认证用 `gh auth token` 或环境变量 `GITHUB_TOKEN`。默认不含已归档仓库；`--include-archived` 把它们加回来，并带 `archived: true`。

## 打包

```bash
npm run pack        # 运行测试后生成 NSIS 安装包和 portable exe
npm run pack -- fast # 只生成 unpacked 应用
```

在 Windows 上生成 `Arckeep-Setup-1.0.0.exe` 和 `Arckeep-1.0.0-portable.exe`。CI 的 `windows package` 任务会上传带 SHA256 清单的安装包。

品牌资产在 `docs/brand/`。界面颜色直接引用 `docs/brand/arckeep-brand-tokens.css`。
