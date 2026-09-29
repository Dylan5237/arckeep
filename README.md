# Arckeep

Arckeep：Dylan 的 AI 原生个人工作台（Windows 桌面应用）。

这个仓库是 Electron + TypeScript，主进程 / preload / 渲染进程分离。「等我处理」「项目总览」「待办」和「工具架」都已经接上。设置、托盘和打包流水线也已经接上。待办写在 userData 里的 `todos.jsonl`（只追加，读的时候折叠）。默认全局热键 `Ctrl+Alt+Space` 打开快速捕获，输入框直接获得焦点。正文里的 `#owner/repo`、能对上的 `#仓库名` 和 `!等我` 会在保存时拆出来。Esc 或点到窗口外不创建待办，草稿写在 `capture-draft.json`，下次热键还会回来。正文被清空后再按 Esc，连仓库标签和等我一起丢掉。可以在设置里改热键。

渲染层用 Vite 打包的普通 TypeScript，没有 UI 框架。页面只有导航和一张设置表单，先不引入组件运行时。

## 在 Windows 上运行

1. 下载 CI artifact `arckeep-windows` 里的 portable exe（`Arckeep-*-portable.exe`），或运行 NSIS 安装包（`Arckeep-Setup-*.exe`）。
2. 双击 exe。安装包没有代码签名，SmartScreen 会提示风险：点「更多信息」，再点「仍要运行」。
3. 窗口打开就能用。关掉窗口会留在托盘；要从托盘菜单选「退出」才会结束进程。

## 开发

需要 Node.js 22。

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
- 停滞 7 天，只判活跃列表里的仓库。默认分支最后一次提交，以及 Issue / PR 活动，两边都满 7 天才算停滞；有一边还在 7 天内就不算。行上的「停滞 X 天」按较新的那一边计算。陈旧分组不再标停滞。刚创建、还没有任何提交或 Issue/PR 活动的空仓不算停滞。
- 页头「需要看一眼」不算陈旧分组里的任何仓库，包括陈旧的空仓和陈旧仓库上的 CI 失败。这些提醒仍显示在行里。空仓只有留在活跃列表时才计入，并且行里仍显示「空仓」。

设置写在 `app.getPath('userData')`。应用启动时把该目录指到 `%APPDATA%\Arckeep\`（目录名是 `Arckeep`，不是 package 名的小写）。GitHub token 经 Electron `safeStorage` 加密后写入 `settings.json`，不写日志、不以明文落盘。本机 `gh auth token` 可用时优先使用 gh CLI，不把这份 token 再存一份。

## 打包

```bash
npm run dist
```

在 Windows 上生成 NSIS 安装包（`*Setup*.exe`）和 portable exe。`npm run pack` 会先跑测试再打包。

品牌资产在 `docs/brand/`。界面颜色直接引用 `docs/brand/arckeep-brand-tokens.css`。
