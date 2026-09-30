---
name: export-remote
description: >
  First-class export remote role: colleague GitLab copy whose tree is
  authority main minus the methodology strip list. Use when classifying
  export= / export_url=, syncing a stripped copy after authority advances,
  or when tempted to treat colleague GitLab as projection or a second write
  authority. Fail closed; no force; each sync needs disposer authorization.
  Related to share-export.sh snapshots (ADR 0003) but not the same contract.
---

# Export remote (authority − strip list)

Follow **[PRINCIPLES.md](../../PRINCIPLES.md)** §5 (fail closed) and **§10** (one write authority; export is not a second SoT).

If `git remote -v` shows **only** `origin` and Command Center has no export host, do not apply this skill.

If the extra host is a **same-history full-tree mirror**, use [git-authority-and-projection](../git-authority-and-projection/SKILL.md). If the need is a **snapshot republish** with ADR 0003’s denylist (keeps `.github/workflows/` by default), use [share-export](../share-export/SKILL.md).

## Playbooks

- [playbooks/export-remote.md](../../playbooks/export-remote.md) — **required** before any export sync or `export=` registry edit
- [playbooks/share-export.md](../../playbooks/share-export.md) — ADR 0003 snapshot helper; related, not a second write authority
- [playbooks/git-authority-and-projection.md](../../playbooks/git-authority-and-projection.md) — projection only
- Contract: [docs/adr/0005-export-remote-role.md](../../docs/adr/0005-export-remote-role.md)
- Helper: [scripts/export-sync.sh](../../scripts/export-sync.sh)

## Conventions (do not improvise)

| Item | Rule |
| --- | --- |
| Write authority | GitHub `origin` (full ops tree). Export is never SoT. |
| Content identity | `export tree = authority tip − strip list` |
| Tip | May be **ahead** of authority because of strip/merge commits. Must not lag in content. |
| Registry | `export=` / `export_url=`. `share_export=` is a deny-push alias. |
| Bound clone | Fetch export if needed. Never `git push` it there. Hook denies export remotes. |
| Sync | On **current export tip**: merge authority → replay strip → verify → FF push. |
| Authorization | No disposer sync ACK → no `--authorized` → no push. |
| Force | Forbidden. Reject → stop. |
| Strip list | Methodology default; business may add, must not remove. |

## Agent checklist

1. Classify the host. Colleague copy that must stay content-current → this skill. Full-tree same-history → projection. Snapshot-only → share-export.
2. Confirm Command Center does **not** call that host a write authority or `projection=`.
3. Confirm disposer sync ACK is on the Issue before any push.
4. Dry-run `scripts/export-sync.sh` (or `.agent-project-ops/scripts/export-sync.sh` in a bootstrapped repo).
5. `--check` on the bound clone should fail (strip-list paths present). Expected. Do not push that clone.
6. `--authorized --yes` with a credential-free URL. If identity fails or push is not FF, the script exits non-zero — fail closed. Do not pass `--force` (the flag is rejected).
7. Comment authority SHA + destination (no secrets) on the GitHub Issue. Chat ≠ state.
8. PR merge ≠ Phase PASS.

Do not vendor colleague hostnames into this methodology repository. Name the export URL on the **business** Command Center issue.
