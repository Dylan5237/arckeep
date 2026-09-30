---
name: bootstrap-project
description: >
  Initialize a new generic git project using Dylan5237/agent-project-ops:
  create a local folder, durable Agent binding files, a pinned methodology
  snapshot, .worktrees/, a GitHub origin as the single write authority, and an
  optional same-history projection remote. Colleague GitLab is export /
  share-export, not --projection-url. Use for one-shot project initialization; not for
  product/domain setup or creating a second source of truth.
---

# Bootstrap project

Read [PRINCIPLES.md](../../PRINCIPLES.md) first. This skill creates and binds a repository; it does not Freeze product scope, implement features, or Accept phases.

Design: [RFC 0001](../../docs/rfcs/0001-bootstrap-and-binding.md) plus its [post-audit hardening contract](../../docs/rfcs/0001-bootstrap-and-binding-hardening-contract.md). Free-private C posture: [ADR 0004](../../docs/adr/0004-free-private-capability-c.md).

## Required path

1. Confirm the destination is new/empty. Existing repositories are **adoption**, not this greenfield path — follow [adopt-existing-project](../../playbooks/adopt-existing-project.md). Adoption **step 1** is a must-fix rewrite of local `AGENTS.md` (and adapters) to GitHub `origin` = write authority; inverted contract (GitLab/non-GitHub Issues host as production/write SoT, GitHub as “mirror only”) fail-closes **before PIN binding is complete**. The helper refuses a non-empty dest after running that scan.
2. Collect a real project slug and real disposer GitHub handle. Do not emit placeholder `@DISPOSER`.
3. Ask whether a **projection** remote is required (same-history FF mirror). If yes, accept only a credential-free Git URL; it remains projection-only and **includes ops**. If the need is colleague GitLab / business-files-only, do **not** collect a projection URL — use [export-remote](../export-remote/SKILL.md) or [share-export](../share-export/SKILL.md) after GitHub `origin` exists.
4. Run `scripts/bootstrap-project.sh --dry-run ...` first when environment behavior is uncertain, then the real command.
5. After scaffold, verify `.agent-project-ops/PIN` contains a real SHA and `.agent-project-ops/remotes` classifies authority/projection.
6. Verify `git config --get core.hooksPath` is `.githooks` in the bootstrap checkout. Remember a later clone will not inherit it; root `AGENTS.md` instructs the next Agent to run the installer.
7. If GitHub creation is enabled, read the reported protection capability: A (code-owner review enforced), B (PR-only), or C (unprotected/unverifiable). Never upgrade the wording beyond what was verified. On GitHub Free **private** repos, C is **expected**: record C on Command Center and continue. Do not treat C as init failure or “do not start feature work.” Do not require Pro to finish init.
8. Run `playbooks/start-project.md` next (labels, Command Center, first Phase). No `feat/` / `fix/` implementation before Freeze.
9. **Register to Fleet REGISTRY** (mandatory; fail closed if skipped). After Command Center exists, upsert one row in `Dylan5237/agent-project-ops` [`fleet/REGISTRY.md`](../../fleet/REGISTRY.md) keyed by `owner/repo` (open or update a PR; never duplicate). Instruct/confirm the box mirror at `/home/box/agent-data/fleet-morning-digest/REGISTRY.md` is in sync with that SoT. Confirm to the disposer: **「已纳入舰队晨报扫描」**. Bootstrap is not done without this step. See [ADR 0002](../../docs/adr/0002-canonical-fleet-index.md).

## Important identity limit

If the local Agent and the human disposer use the **same GitHub identity**, GitHub cannot distinguish which one clicked/pushed/merged. CODEOWNERS cannot create a human-vs-Agent security boundary in that configuration. Default bootstrap therefore requests PR-only protection (B); request code-owner review (A) only when the repository has a genuinely independent reviewer/identity and the user wants that gate.

## Protection honesty

- Report A/B/C as verified. Never claim B/A when only C was verified.
- GitHub Free **private** → C is expected. Record C on Command Center and continue. Do not require Pro to finish init. Do not treat C as bootstrap failure.
- Client hooks + PR discipline still apply under C. Do not claim server protection exists.

## Fail closed

- Methodology source is not a git checkout / SHA cannot be determined → stop; supported bootstrap never writes silent `sha=unknown`.
- GitHub creation requested but `gh` is unavailable/unauthenticated → stop.
- Unknown remote → no push.
- Projection candidate is not current authority tip → no projection push.
- Colleague GitLab URL used as `--projection-url` → stop; that is export / share-export, not projection.
- Destination exists and is not empty → stop; that is [adoption](../../playbooks/adopt-existing-project.md). Inverted `AGENTS.md` SoT → fail closed (PIN not complete).
- Fleet REGISTRY row skipped, duplicated, or left only in chat → stop; do not claim bootstrap done. Mirror unwritable → still land the git row and report `BLOCKED:` on GitHub for the mirror gap.
- Do not use `--no-verify` as a workflow shortcut.
