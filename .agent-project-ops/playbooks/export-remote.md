# Playbook: Export remote / 导出远端（权威 − 剥离清单）

## Goal

Keep a colleague-facing **export** copy whose tree is `authority main − strip list`, without creating a second write authority.

GitHub `origin` stays the only write SoT and keeps the full ops tree. Export is a classified remote role, not a projection and not an Architecture Exception.

## When

- Command Center names a colleague GitLab (or similar) copy that must stay **content-current** with authority, minus methodology / Agent-tool paths.
- Tempted to register that host as `projection=` or to `git push --mirror` the bound clone.
- A previous stripped GitLab copy needed EXCEPTION only because the methodology had no export role.
- After authority advances and the disposer has authorized one export sync.

## Preconditions

- [PRINCIPLES.md](../PRINCIPLES.md) §5 (fail closed) and §10 (one write authority) are in force.
- Phase/export policy is frozen: [ADR 0005](../docs/adr/0005-export-remote-role.md).
- Export URL has **no** embedded credentials or query tokens.
- Disposer has commented an explicit **sync ACK** (who, when, authority SHA, destination without secrets) before any push.
- Colleagues will **not** open feature branches on the export host to merge back; reflux is GitHub-only.

## Terms

| Term | Meaning |
| --- | --- |
| **Authority** | GitHub `origin`. Full history + full ops binding. Issues/PRs live here. Sole write SoT. |
| **Projection** | Optional second remote: **same commits**, FF from authority, **includes ops**. [git-authority-and-projection.md](./git-authority-and-projection.md). |
| **Export** | Classified remote (`export=` / `export_url=`). Tree = authority tip − strip list. Tip may be **ahead** because of strip/merge commits. Not SoT. |
| **Share-export helper** | [`scripts/share-export.sh`](../scripts/share-export.sh) ([ADR 0003](../docs/adr/0003-share-export-vs-projection.md)): filtered **snapshot** publish, different denylist (keeps `.github/workflows/` by default), new history. Related tooling — not a second write authority. |
| **Strip list** | Methodology default (below). Business may **add** entries. Business must **not** remove methodology entries. |

## Default strip list

Methodology-owned. Directory prefixes include the directory and every descendant:

```
.agent-project-ops/
.agents/
.githooks/
.github/
.claude/
.continue/
.cursor/
AGENTS.md
CLAUDE.md
.aider.conf.yml
```

Add business extras in `.agent-project-ops/export-strip-extra` (one path per line) or `--extra-strip` / `--extra-file`. Lines that start with `!`, `-`, or `~` are refused (no shrink syntax).

This list **includes all of `.github/`**. That is stricter than share-export’s default denylist.

## Registry

`.agent-project-ops/remotes`:

```
authority=origin
projection=(none)
projection_url=
export=gitlab
export_url=git@gitlab.example:group/business.git
share_export=(none)
share_export_url=
```

- `export=` / `export_url=` are the first-class keys (Issue #46 / zentao-mcp practice).
- `share_export=` / `share_export_url=` remain aliases with the same **bound-clone push deny**.
- The same remote name must not be both `projection=` and `export=` / `share_export=`.
- Unknown remotes stay **BLOCKED**.

The bound clone may **fetch** `export`. It must not `git push` to it. The client hook denies export remotes (not on the auto-push whitelist).

## Steps

### A. Classify

1. `git remote -v`. Label each URL **authority**, **projection**, **export**, or **unknown**.
2. Colleague share that must stay content-current → `export=`. Same-history full-tree mirror → projection playbook. Snapshot-only publish → [share-export.md](./share-export.md).
3. Unknown → `status:blocked` until the disposer names the role. Do not push “to be safe.”

### B. First seed (empty export branch)

Only after disposer seed/sync ACK:

```bash
bash scripts/export-sync.sh \
  --dir . \
  --ref origin/main \
  --export-url git@gitlab.example:group/business.git \
  --authorized --yes
```

The helper checks out the authority tip, deletes strip-list paths, commits, verifies `export tree = authority − strip`, and pushes (first push; no force).

Do **not** `git push` the bound working tree. Do **not** reset a later sync to `origin/main` and drop the seed strip commit.

### C. Sync after authority advances

1. Fetch authority. Confirm the disposer sync ACK names this authority SHA.
2. Run the same helper with `--authorized --yes`.
3. Required order (the helper does this; do not improvise):

   - start from the **current export tip**;
   - merge the authority tip;
   - replay strip (delete newly introduced strip-list paths);
   - verify content identity;
   - fast-forward push.

4. If merge conflicts, identity fails, or the remote rejects: **stop**. Comment `BLOCKED:` with the gap. **No force.** The observed failure mode is resetting to `origin/main` (losing export strip commits) and then getting a non-FF reject — recover by returning to the export tip and replaying strip, not by forcing.

### D. Dry-run / check

```bash
bash scripts/export-sync.sh --dir . --ref origin/main --dry-run
bash scripts/export-sync.sh --dir . --ref origin/main --check
```

`--check` on a bound authority tree **must** fail (strip-list paths present). That is expected. Do not “fix” it by deleting GitHub bindings.

`--authorized` is required for any push. Dry-run never pushes.

## Done when

- [ ] Command Center classifies the host as **export** (or origin-only / projection / share-export snapshot) — not as a second SoT.
- [ ] `.agent-project-ops/remotes` has `export=` / `export_url=` (or explicit `(none)`).
- [ ] Published export tree matches authority minus the effective strip list.
- [ ] Bound working clone was **not** pushed to that host.
- [ ] Each push had disposer `--authorized` sync ACK on the Issue.
- [ ] No force-push. Reject → stopped.
- [ ] Merge on GitHub still is not Phase PASS.

## Anti-patterns

- Treating export as a second write authority or Issues/PR host.
- Registering colleague GitLab as `projection=` so the hook allows a full-tree FF.
- `git push` / `git push --mirror` of the bound clone to the export URL.
- Resetting to `origin/main` and dropping export strip commits, then forcing.
- Syncing without disposer authorization (silent drift).
- Removing methodology strip entries “because the business CI should travel.” Use share-export’s workflow exception, or add (not remove) entries. Shrinking the methodology list needs Exception.
- Opening feature work on the export host and merging it without a GitHub PR.
- Inventing `--force` to “make histories match.”
