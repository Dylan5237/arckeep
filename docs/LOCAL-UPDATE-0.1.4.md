# Arckeep 0.1.4 本地更新

2026-10-12，按用户明确要求完成本机更新。Windows 已安装并正常启动 0.1.4；开始菜单 Arckeep 入口指向原安装目录。版本和安装后的 ASAR 已回读，与验证过的包一致。

本次包含 Command Center 项目进度看板、两页共用排序与细化时间显示，以及等我处理的 APO 快捷评论。继承已完成 738 项测试与 Astra 对抗审查的功能源码，产品代码只调整应用版本为 0.1.4，原开发工作树保留。

打包采用独立 app staging，包含 Ajv、marked 及完整生产传递依赖。409 个运行文件及依赖元数据与 staging 核对，通过打包版看板、窄屏、APO 快捷按钮和提示词库四个隔离启动场景。正常启动时清除测试模式与 Electron Node 模式环境，主窗口和进程已确认运行。

安装前备份旧程序及完整用户数据，共 5,171 个文件，备份逐文件哈希核对通过。安装后、正常启动前，5,091 个用户数据文件哈希均未变化。开始菜单目标与图标位置核对通过，图标资源与 Arckeep 源图标一致。

- 安装目录：`C:\Users\howyo\AppData\Local\Programs\Arckeep`
- 用户数据：`C:\Users\howyo\AppData\Roaming\Arckeep`
- 本轮证据：`dist/local-update/deployment-check.json`、`installation.json`、`startup.json`
- 安装包：`dist/local-update/artifacts/Arckeep-Setup-0.1.4.exe`
- 回退备份：`dist/local-update/backup/`，包含 `program/`、`user-data/` 与原开始菜单快捷方式

这是本机试用更新，不是 GitHub 正式发行。制品以实际源文件快照和内容哈希记录，不冒充 Git HEAD 的正式发行制品；正式发行的 clean-tree/hash 门禁保持。没有提交继承改动、推送、创建 Release 或代用户接受阶段。
