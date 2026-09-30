Read root `AGENTS.md` and `.agent-project-ops/PRINCIPLES.md` before changing repository state.

GitHub `origin` is the single write authority. Push topic branches to `origin` only. Projection remotes are same-history mirror/fast-forward only. Colleague GitLab is share-export (filtered business tree), not a projection. Unknown remotes fail closed. Use `.worktrees/` for task work and keep the primary checkout clean. PR merge is not Phase PASS; the named disposer owns Freeze/Accept/Exception decisions.

On a fresh clone, verify `core.hooksPath=.githooks` before first push and run `.agent-project-ops/scripts/install-hooks.sh` if needed.
