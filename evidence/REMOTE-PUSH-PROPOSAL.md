# 本地候选的远端提交提案

状态：最终一次 Astra 完整审查完成，五项 P2 已修复；40 files / 297 tests、typecheck、lint、build、制品/图标/fixture 检查通过。两个分支与制品均在本地，尚未执行远端写入。

只提议将以下两个候选分支推送至唯一权威 GitHub origin（Dylan5237/arckeep）：

- 产品实现 `fix/6-mvp-delivery`，固定 HEAD `ee033380291d8968e3e8e5dd8fcf383e236f58fe`。
- 证据 `evidence/6-final-mvp`，固定 HEAD 在本地证据提交后显示于交付答复；包含本文件、最终候选汇总、独立审查及修复记录和可复核证据，不含制品二进制、原始 profile 或提取 payload。

执行前再次核对用户确认的两提交、primary 清洁状态、远端登记和 `.githooks`；分支如有额外变化，不能把未确认的内容自动纳入推送。仅在 primary 控制工作区执行：

```powershell
git push -u origin fix/6-mvp-delivery
git push -u origin evidence/6-final-mvp
```

影响：GitHub 上出现两条候选分支，可审阅各自的已提交文件和历史。推送不表示产品或阶段被接受，不包含 PR/Issue/评论、合并、tag、Release 或附件上传。未完成的控制面、Bugbot、干净 Windows 和业务接受按其自身门禁处置；本提案不重复请求旧的 bugbot 评论授权。

本地候选为 `dist/candidate-ee03338-local/`，版本0.1.0、实际Electron43.7.6、两类EXE未签名。详细SHA256与验证边界见 FINAL-CANDIDATE.md。latest只读回查见 control-plane-readback-ee03338.json：origin/main仍417c3e4，PR31仍OPEN，Issue6六项条件未勾选。

确认依据：用户最新 AGENTS.md 要求“推送前取得用户明确确认，确认过的范围内不重复询问”。本仓库绑定 origin 为唯一写入权威，未配置 GitLab export；准备完成后等待这两条 origin 分支的明确确认，不擅自推送或发布。
