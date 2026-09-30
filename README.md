# Arckeep

Arckeep：Dylan 的 AI 原生个人工作台（Windows 桌面应用）。

这个仓库是 Electron + TypeScript，主进程 / preload / 渲染进程分离。「等我处理」「项目总览」「待办」和「工具架」都已经接上。设置、托盘和打包流水线也已经接上。待办写在 userData 里的 `todos.jsonl`（只追加，读的时候折叠）。默认全局热键 `Ctrl+Alt+Space` 打开快速捕获，输入框直接获得焦点。正文里的 `#owner/repo`、能对上的 `#仓库名` 和 `!等我` 会在保存时拆出来。Esc 或点到窗口外不创建待办，草稿写在 `capture-draft.json`，下次热键还会回来。正文被清空后再按 Esc，连仓库标签和等我一起丢掉。可以在设置里改热键。

渲染层用 Vite 打包的普通 TypeScript，没有 UI 框架。

## 在 Windows 上运行

1. 获取同一版本的 Windows x64 安装包（`Arckeep-Setup-*.exe`）或便携版（`Arckeep-*-portable.exe`）。正式发行附件位于 [Releases](https://github.com/Dylan5237/arckeep/releases)；开发候选来自成功运行的 CI artifact `arckeep-windows`。当前本地 0.1.0 候选尚未正式发布。
2. 运行安装包并启动 Arckeep，或直接双击便携版。程序未签名，Windows 可能显示 SmartScreen 提示；核对来源和发行附件 SHA256 后再决定是否运行。关闭主窗口会留在托盘，托盘菜单的「退出」会结束应用。
3. 打开「设置」：已登录的 `gh` 会自动提供认证；也可保存具备目标仓库只读权限的 PAT，点击「测试连接」。添加 `owner/repo` 到关注仓库，再打开「等我处理」查看实际数据。设置页显示应用版本。

## 已知限制

- 当前交付目标为 Windows x64；没有代码签名和自动更新。
- GitHub 功能只读查询；分类规则可能漏判或误判，仍需核对 GitHub 原始记录。
- PAT 通过本机安全存储加密保存；安全存储不可用时会提示失败，不保存 PAT。优先复用已有 `gh` 登录。
- 工具架配置的命令和预演脚本会在本机实际执行，预演也可能产生文件或其他副作用。只有命令需要预览确认；链接、目录和模板按配置直接打开或复制。

## 开发

需要 Node.js 22.12.0 或更高版本。

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build:app
npm start
npm run overview -- --json
```

`npm run overview -- --json` 只读查询项目总览，认证用 `gh auth token` 或环境变量 `GITHUB_TOKEN`。默认不含已归档仓库；`--include-archived` 把它们加回来，并带 `archived: true`。每行还可以带 `group`（`active` / `stale` / `archived`）和 `stallBasis`（停滞看的是默认分支提交还是 Issue/PR 活动，以及较新的那个时间）。`--fixture` 不访问网络。

关注列表为空时走自动模式：列出你有写权限的全部仓库，也就是你拥有的、你是协作者的、以及你作为组织成员并且有推送权限的（`ADMIN` / `MAINTAIN` / `WRITE`）。只 watch、没有写权限的仓库不会出现，也不会计入页头数量。已归档仓库默认继续排除。没有单独的「最近 push」窗口。两个天数都可以在设置里改，默认是：

- 陈旧 30 天。最近活动取最后一次提交、最近的 Issue / PR 活动（创建、更新、评论）、仓库推送时间和仓库创建时间里最新的一个，缺了哪项就跳过。还在 30 天以内（含刚好 30 天）就留在活跃列表；超过 30 天才进「陈旧」。每个未归档仓库都会落在这两组之一。没有提交、也没有 Issue/PR 的空仓不再一律算活跃：多年前创建、之后没动过的空仓进「陈旧」。
- 停滞 7 天，只判活跃列表里的仓库。默认分支最后一次提交，以及 Issue / PR 活动，两边都要超过 7 天才算停滞；刚好 7 天不算。有一边还没超过就不算。行上的「停滞 X 天」按较新的那一边计算。陈旧分组不再标停滞。刚创建、还没有任何提交或 Issue/PR 活动的空仓不算停滞。
- 页头「需要看一眼」不算陈旧分组里的任何仓库，包括陈旧的空仓和陈旧仓库上的 CI 失败。这些提醒仍显示在行里。空仓只有留在活跃列表时才计入，并且行里仍显示「空仓」。

设置写在 `app.getPath('userData')`。应用启动时把该目录指到 `%APPDATA%\Arckeep\`（目录名是 `Arckeep`，不是 package 名的小写）。GitHub token 经 Electron `safeStorage` 加密后写入 `settings.json`，不写日志、不以明文落盘。本机 `gh auth token` 可用时优先使用 gh CLI，不把这份 token 再存一份。

## 打包

```bash
npm run dist
```

在 Windows 上生成 NSIS 安装包（`*Setup*.exe`）和 portable exe。`npm run pack` 会先跑测试再打包。

品牌资产在 `docs/brand/`。界面颜色直接引用 `docs/brand/arckeep-brand-tokens.css`。
