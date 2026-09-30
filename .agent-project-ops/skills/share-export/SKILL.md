---
name: share-export
description: >
  Publish a filtered business-only git tree for colleague share (typically
  GitLab). Use when sharing with colleagues, excluding agent-project-ops
  bindings, denylisting AGENTS.md / .githooks / .github templates, or when
  tempted to git push --mirror / project the full ops tree to GitLab.
  Not a same-history projection remote. Related to the export= remote role
  (ADR 0005 / export-sync.sh) but this skill is the ADR 0003 snapshot helper.
  GitHub origin stays write authority.
---

# Share-export (colleague GitLab)

Follow **[PRINCIPLES.md](../../PRINCIPLES.md)** §5 (fail closed) and **§10** (one write authority).

Colleague-share GitLab is **not** a projection and not a second write authority. Load this skill for ADR 0003 **snapshot** publish. Load [export-remote](../export-remote/SKILL.md) when Command Center classifies `export=` and the copy must stay content-current (`authority − strip list`, merge + replay strip + FF).

## Playbooks

- [playbooks/share-export.md](../../playbooks/share-export.md) — **required** before any colleague-share snapshot publish
- [playbooks/export-remote.md](../../playbooks/export-remote.md) — first-class `export=` role + `export-sync.sh`
- [playbooks/git-authority-and-projection.md](../../playbooks/git-authority-and-projection.md) — only for a Command Center–named **same-history** projection remote
- [playbooks/adopt-existing-project.md](../../playbooks/adopt-existing-project.md) — existing repos: rewrite inverted `AGENTS.md` (GitLab ≠ write SoT) before PIN
- Contract: [docs/adr/0003-share-export-vs-projection.md](../../docs/adr/0003-share-export-vs-projection.md)
- Helper: [scripts/share-export.sh](../../scripts/share-export.sh)

## Conventions (do not improvise)

| Item | Rule |
| --- | --- |
| Write authority | GitHub `origin` (full ops tree) |
| Colleague GitLab | Export or share-export. Not SoT. Not `projection=` |
| Working clone | Do not `git push` it to the share host |
| Helper | Strip denylist or refuse. Never `--force` |
| Reflux | No feature branches on GitLab back into GitHub |
| Business CI | Keep `.github/workflows/` unless `--strip-all-github` |

## Agent checklist

1. If the user wants colleagues to have a GitLab copy of **product files**, this is share-export. Stop if you were about to add `remote projection` / `git push --mirror`.
2. Confirm Command Center does **not** classify that GitLab URL as projection.
3. Dry-run `scripts/share-export.sh` (or `.agent-project-ops/scripts/share-export.sh` in a bootstrapped repo).
4. `--check` on the bound clone should fail (bindings present). That is expected. Do not push that clone.
5. `--out` and/or `--push` with a credential-free URL and `--yes`. If denylist paths remain, the script exits non-zero — fail closed.
6. Comment source SHA + destination on the GitHub Issue. Chat ≠ state.
7. PR merge ≠ Phase PASS.

Do not vendor colleague hostnames into this methodology repository. Name the share URL on the **business** Command Center issue.
