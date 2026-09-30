# Playbook: Git branch and remote / 分支与远端

## Goal

Use **one remote (`origin`)** and **named topic branches** so Agents never push `main` and never invent a shadow remote. This is the **default** for single-remote projects.

If a **projection** (same-history mirror) remote exists, this playbook still governs **topic branch names and authority pushes**. Mirroring, divergence, and cleanup are [git-authority-and-projection.md](./git-authority-and-projection.md) — do not treat the extra remote as a second `origin`.

**Colleague GitLab is not a projection remote.** A content-current stripped copy is [export-remote.md](./export-remote.md) (`export=`). A snapshot republish is [share-export.md](./share-export.md) ([ADR 0003](../docs/adr/0003-share-export-vs-projection.md)). Do not `git push` the bound clone there and do not full-mirror ops bindings onto it.

## When

- Creating or pushing any branch.
- Configuring a new clone.
- An Agent is tempted to “just commit on main.”

## Preconditions

- Default branch is protected (see start-project).
- Worktree playbook followed for in-flight work.
- Issue number known (used in the branch name).

## Steps

1. **Remotes.** Default: **`origin` only.** `git remote -v` should show a single write remote for this workflow. Fork remotes: do not push workflow branches there unless Command Center says so.
2. **Optional projection remote.** If Command Center names a second remote as **projection only** (same-history FF mirror, **not** colleague share), stop using this file as the full remote policy. Follow [git-authority-and-projection.md](./git-authority-and-projection.md) **before any non-`origin` push**. Still push topic branches **only** to authority `origin`. **Never** `git push` `feat/` `fix/` `docs/` `evidence/` (or other task branches) to the projection remote. If the second host is colleague GitLab, use [export-remote.md](./export-remote.md) or [share-export.md](./share-export.md) instead of adding a projection remote.
3. **Update base.**

   ```bash
   git fetch origin
   git merge --ff-only origin/main   # only on a throwaway sync; topic branches rebase/merge per Command Center
   ```

   Prefer: create branches from the **current authority tip** (usually `origin/main`, or the Command Center–named transitional branch until it merges), not from a dirty local `main`.
4. **Name the branch:** `{type}/{issue}-{slug}` where `type` is one of:
   - `feat` — new behavior
   - `fix` — defect
   - `docs` — documentation only
   - `evidence` — verification artifacts only (no product behavior change)
5. **Slug:** kebab-case, from the issue; keep it short. Example: `feat/42-add-healthcheck`, `evidence/42-healthcheck-logs`.
6. **Push:**

   ```bash
   git push -u origin HEAD
   ```

   Never: `git push origin main`. Never: `--force` on `main`. Force-with-lease on a **topic** branch only if the Issue comments that the branch is Agent-private and not under review.
7. **PR target:** `main` (or the default branch named on Command Center).
8. **After merge:** delete the remote topic branch on **authority**; remove worktree; do not keep pushing the old name. After the **authority tip** merges to the default branch, **new work starts from that tip** (fetch `origin`; do not base the next branch on a superseded transitional head).
9. **Do not** add `upstream` / `backup` / unnamed remotes to replace Issues or to dodge protected `main`. A named projection remote is not a backup workflow; it is a same-history mirror (see the projection playbook). A colleague-share GitLab URL is not a backup and not a projection.

## Done when

- [ ] Branch matches `feat|fix|docs|evidence/{issue}-{slug}`.
- [ ] `origin` is the topic-branch push target (projection, if any, was not used for features).
- [ ] `main` has no direct Agent commits from this workflow.
- [ ] Evidence work is not on a `feat/` / `fix/` branch (and vice versa).

## Anti-patterns

- `git push origin main` “because protection isn’t set yet.”
- Unnamed branches (`tmp`, `asdf`, `agent-1`).
- Mixing evidence files and feature code on `feat/…`.
- Adding `upstream`/`backup` remotes as a substitute for Issues or as a second SoT.
- Pushing topic branches to a projection/mirror remote.
- Adding colleague GitLab as `projection` so a full ops tree can be pushed (classify `export=` or use share-export).
- Rewriting `main` history (except disposer-authorized align in the projection playbook).
