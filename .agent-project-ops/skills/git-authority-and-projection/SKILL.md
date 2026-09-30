---
name: git-authority-and-projection
description: >
  Optional second git remote is projection-only (same-history mirror /
  fast-forward from GitHub authority). Use when remotes include more than
  origin, Command Center names a projection host, tips diverge, reconciling
  authority vs projection vs an aux repo, aligning protected main, failing
  closed on projection errors, or cleaning cursor/sync branches across remotes.
  Never push topic branches to the projection remote. Colleague-share GitLab
  is export / share-export, not this skill.
---

# Git authority and projection

Follow **[PRINCIPLES.md](../../PRINCIPLES.md)** §5 (fail closed; no shadow remote) and **§10** (at most one write authority).

If `git remote -v` shows **only** `origin`, do not apply this skill. Use [git-worktree-and-branch](../git-worktree-and-branch/SKILL.md) and origin-only [git-branch-and-remote.md](../../playbooks/git-branch-and-remote.md).

If the extra host is **colleague GitLab** (business files for humans, no ops bindings), do not apply this skill. Use [export-remote](../export-remote/SKILL.md) (`export=`, content-current) or [share-export](../share-export/SKILL.md) (ADR 0003 snapshot).

## Playbooks

- [playbooks/git-authority-and-projection.md](../../playbooks/git-authority-and-projection.md) — **required** before any non-`origin` **projection** push
- [playbooks/export-remote.md](../../playbooks/export-remote.md) — colleague export remote; not a projection; not a second SoT
- [playbooks/share-export.md](../../playbooks/share-export.md) — ADR 0003 snapshot helper; related to export
- [playbooks/git-branch-and-remote.md](../../playbooks/git-branch-and-remote.md) — topic names; push `origin` only
- [playbooks/git-worktree.md](../../playbooks/git-worktree.md) — start from current **authority tip**
- Companion: [git-worktree-and-branch](../git-worktree-and-branch/SKILL.md)

## Conventions (do not improvise)

| Item | Rule |
| --- | --- |
| Write authority | GitHub `origin` (Issues/PRs). One SoT. Inverted `AGENTS.md` (GitLab = production SoT; GitHub = mirror only) is must-fix — [adopt-existing-project](../../playbooks/adopt-existing-project.md). |
| Projection remote | Fetch + FF of the **same history** (or disposer-authorized align). Not a feature host. Not colleague GitLab. |
| Colleague GitLab | [export-remote](../export-remote/SKILL.md) or [share-export](../share-export/SKILL.md). Filtered tree. Never `git push --mirror` from the bound clone. |
| Topic push | `git push -u origin HEAD` only |
| Local / Cloud | Draft. Same rules; no privilege push to `main`. |
| Projection down | Fail closed; stop release. Do not invent a second SoT. |
| Projection ahead | Blocked → backfill PR on authority **or** written abandon, then project |
| Cleanup | Reconciliation table first; never delete authority tip, `evidence/*`, merged impl. Full dirty-repo hygiene (topology + edge cases): [repo-reconciliation-cleanup](../repo-reconciliation-cleanup/SKILL.md). |

## Agent checklist

1. `git remote -v` → classify authority vs projection vs export vs share-export vs unknown. Unknown → stop. Colleague GitLab → export-remote or share-export skill.
2. Fetch authority. Worktrees and branches from the **current authority tip**.
3. Push topic branches **only** to `origin`. Open PRs on GitHub.
4. After authority tip merges to the default branch, base new work on that tip.
5. Before mirroring: compare tips. Projection ahead of authority → Blocked (playbook §D).
6. Align protected `main` only per playbook §E (reclaim, then FF/force with disposer auth, or merge-align).
7. Before deleting branches: read-only three-surface table (playbook §F); honor red lines (§G).
8. PR merge ≠ Phase PASS.

Do not vendor product remotes, hostnames, or release IDs into the methodology repository. Name remotes on the **business** Command Center issue.
