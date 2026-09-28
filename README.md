# Arckeep

Arckeep：Dylan 的 AI 原生个人工作台（Windows 桌面应用）。

这个仓库目前是骨架加待办：Electron + TypeScript，主进程 / preload / 渲染进程分离。等我处理、项目总览、工具架仍是占位页。设置、托盘和打包流水线已经接上。待办写在 userData 里的 `todos.jsonl`（只追加，读的时候折叠）。默认全局热键 `Ctrl+Alt+Space` 打开快速捕获，可以在设置里改。

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
```

设置写在 `app.getPath('userData')`。应用启动时把该目录指到 `%APPDATA%\Arckeep\`（目录名是 `Arckeep`，不是 package 名的小写）。GitHub token 经 Electron `safeStorage` 加密后写入 `settings.json`，不写日志、不以明文落盘。本机 `gh auth token` 可用时优先使用 gh CLI，不把这份 token 再存一份。

## 打包

```bash
npm run dist
```

在 Windows 上生成 NSIS 安装包（`*Setup*.exe`）和 portable exe。`npm run pack` 会先跑测试再打包。

品牌资产在 `docs/brand/`。界面颜色直接引用 `docs/brand/arckeep-brand-tokens.css`。
