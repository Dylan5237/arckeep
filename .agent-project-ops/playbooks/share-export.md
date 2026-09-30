# Playbook: Share-export / 同事分享导出（业务-only）

## Goal

Publish a **filtered business tree** for colleagues (typically GitLab) without copying `agent-project-ops` bindings. GitHub `origin` stays the only write authority and keeps the full ops tree.

This is **not** [projection](./git-authority-and-projection.md). Projection is an optional **same-history** fast-forward mirror.

A first-class **export** remote that must stay content-current with authority uses [export-remote.md](./export-remote.md) / `export=` / [`scripts/export-sync.sh`](../scripts/export-sync.sh) ([ADR 0005](../docs/adr/0005-export-remote-role.md)). This playbook is the ADR 0003 **snapshot** helper: new filtered history, default denylist **keeps** `.github/workflows/`. Both helpers refuse to invent a second write authority.

## When

- Command Center names a **colleague share** host (GitLab or similar) that must not receive Agent/ops files.
- Tempted to `git remote add gitlab …` and `git push --mirror` / FF-project the bound clone.
- Bootstrap asked “projection URL” and the answer would have been the colleague GitLab.

## Preconditions

- GitHub `origin` is authority ([git-branch-and-remote.md](./git-branch-and-remote.md)).
- Phase/share policy is frozen: [ADR 0003](../docs/adr/0003-share-export-vs-projection.md).
- Share-export URL has **no** embedded credentials or query tokens.
- Colleagues will **not** open feature branches on GitLab to merge back; reflux is GitHub-only.

## Terms

| Term | Meaning |
| --- | --- |
| **Authority** | GitHub `origin`. Full history + full ops binding. Issues/PRs live here. |
| **Projection** | Optional second remote: **same commits**, FF from authority. Includes ops. Not colleague share. |
| **Export remote** | `export=` role ([export-remote.md](./export-remote.md)): tree = authority − #46 strip list (includes all of `.github/`). Related-history merge + replay strip + FF. |
| **Share-export** | This helper: new/updated **filtered** snapshot. Denylist stripped. History on GitLab is export snapshots, not GitHub SHAs. |

## Steps

1. **Classify.** If the host must stay content-current with `authority − strip list` → [export-remote.md](./export-remote.md) (`export=`). If the host is a snapshot publish → this playbook. If Command Center names a same-history mirror → projection playbook. Unknown extra remotes → `status:blocked`. Do **not** register colleague GitLab as `projection=`.
2. **Do not add** the share URL as a push remote on the bound working clone. The client hook denies unregistered remotes; a registered `share_export=` name is denied for every push from that clone.
3. **Plan:**

   ```bash
   bash scripts/share-export.sh --dir . --ref origin/main --dry-run
   # in a bootstrapped business repo:
   bash .agent-project-ops/scripts/share-export.sh --dir . --ref origin/main --dry-run
   ```

4. **Check (fail closed):** an unfiltered `git push` of this clone would leak ops if `--check` fails (expected on a bound repo):

   ```bash
   bash scripts/share-export.sh --check --ref HEAD
   ```

   That command **must** fail on a normal agent-project-ops-bound tree. Do not “fix” it by deleting GitHub bindings. Use the helper to strip into a separate publish checkout.
5. **Export** to a directory (inspect) and/or **push** the filtered tree:

   ```bash
   bash scripts/share-export.sh --dir . --ref origin/main --out /tmp/business-share --yes
   bash scripts/share-export.sh --dir . --ref origin/main --push git@gitlab.example:group/business.git --yes
   ```

   `--push` requires `--yes`. The helper never `--force`. If GitLab already has `main`, it commits a new snapshot onto that branch when the filtered files changed.
6. **Business CI workflows.** Default **keeps** `.github/workflows/`. Issue/PR templates, CODEOWNERS, and Copilot instructions are stripped. If a workflow exists only to enforce this methodology, add it to an extra denylist or use `--strip-all-github` (drops all of `.github/`, including business CI — say so on the Issue).
7. Record on the Issue: source SHA, exclude count, destination URL (no secrets), and that GitLab is **not** SoT.

## Done when

- [ ] Colleague host is classified as share-export, not projection, on Command Center.
- [ ] Published tree has **no** denylist path (ADR 0003 minimum).
- [ ] Bound working clone was **not** pushed to that host.
- [ ] Topic branches and PRs remain on GitHub `origin` only.
- [ ] Merge on GitHub still is not Phase PASS.

## Anti-patterns

- `git push --mirror` or FF-projecting `main` to colleague GitLab.
- Passing the colleague GitLab URL to `bootstrap-project.sh --projection-url`.
- Registering GitLab as `projection=` so the hook allows a full-tree push.
- Treating GitLab Issues as the control plane.
- Writing GitLab as production / write SoT in `AGENTS.md` (inverted contract — [adopt-existing-project.md](./adopt-existing-project.md)).
- Force-pushing the export branch “to make the histories match GitHub.”
- Opening feature work on GitLab and merging it without a GitHub PR.
