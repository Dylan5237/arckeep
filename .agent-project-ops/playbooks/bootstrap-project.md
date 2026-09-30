# Playbook: Bootstrap project / 初始化并绑定项目

## Goal

Create a generic project repository that is born with durable `agent-project-ops` binding instead of relying on the bootstrap chat to be remembered later.

Bootstrap creates/binds a **new/empty** repository. It does **not** Freeze a product Phase, implement product code, or declare Phase PASS.

**Existing repositories are not this playbook.** Use [adopt-existing-project.md](./adopt-existing-project.md). Adoption step 1 is a must-fix rewrite of local `AGENTS.md` to GitHub `origin` = write authority (projection optional; share-export ≠ projection). The inverted contract (GitLab or any non-GitHub Issues host as production/write SoT; GitHub as “mirror only”) fail-closes before PIN binding is complete. `scripts/bootstrap-project.sh` refuses a non-empty destination after running that scan.

## Preconditions

- Run from a real git checkout of `agent-project-ops`; supported bootstrap requires a real methodology commit SHA.
- `git` is available. GitHub creation additionally requires an authenticated `gh` CLI.
- A real disposer GitHub handle is known; placeholder `@DISPOSER` is not accepted.
- Optional projection URL contains no embedded credential/query token. Do not use a colleague-share GitLab URL as projection; that is share-export.

## Supported path

```bash
scripts/bootstrap-project.sh \
  --name example-project \
  --disposer @example \
  --no-projection
```

Use `--dry-run` first when evaluating a new environment. Use `--skip-github` only for local scaffold/testing.

Optional **projection** (same-history FF mirror only — **not** colleague GitLab):

```bash
scripts/bootstrap-project.sh \
  --name example-project \
  --disposer @example \
  --projection-url git@git.internal.example:group/example-project.git
```

The remote is named `projection`; it is never a feature-push target and it **copies the full ops tree**.

**Colleague GitLab** is a [share-export](./share-export.md), not `--projection-url`. Do not pass a colleague-share URL here. After the GitHub authority exists, publish a filtered business tree with `scripts/share-export.sh` ([ADR 0003](../docs/adr/0003-share-export-vs-projection.md)).

## What bootstrap writes

- root `AGENTS.md` plus adapters for supported Agent tools (`CLAUDE.md`, Cursor rule, Copilot instructions, optional Aider/Continue files)
- `.agents/skills/*` and `.claude/skills/*` thin wrappers
- `.agent-project-ops/` pinned methodology snapshot with real `PIN` SHA
- `.agent-project-ops/remotes` (clone-portable classification; Git config itself is not portable)
- `.githooks/pre-push` plus local `core.hooksPath=.githooks`
- `.worktrees/` locally and a gitignore rule for it
- GitHub Issue/PR templates and CODEOWNERS binding paths

If a later user/Agent **clones** the business repo, the hook file arrives but `core.hooksPath` does not. Before first push it must run:

```bash
bash .agent-project-ops/scripts/install-hooks.sh
```

The root `AGENTS.md` carries this check.

## GitHub protection capability

Server policy is reported as observed capability, not marketing language:

- **A — code-owner review enforced:** PR required and code-owner/approval gate verified.
- **B — PR-only:** direct default-branch updates are blocked, but a writer may still be able to self-merge. This is the safe default when the Agent uses the same GitHub identity as the human owner.
- **C — unprotected/unverifiable:** requested branch protection could not be enabled or verified.

Default bootstrap requests **B**. `--require-codeowner-review` requests **A**, but use it only when repository identity/ownership actually supports an independent reviewer; otherwise a single-user repository can be locked into an unusable review gate.

If protection cannot be enabled after repository creation (typical on GitHub Free **private** repos), bootstrap **warns**, reports **C**, and **completes**. Record C on Command Center and continue with hooks + PR discipline. Do **not** treat C as init failure or “do not start feature work.” Do **not** require GitHub Pro to finish init. Never claim B or A when only C was verified. Use public or Pro only when a real server-side gate is required.

See [ADR 0004](../docs/adr/0004-free-private-capability-c.md).

## After bootstrap

1. Run [start-project.md](./start-project.md).
2. Create labels and Command Center.
3. Record the PIN, registered remotes, and protection capability (C is a valid recorded result; continue).
4. Open one Phase issue.
5. **Register to Fleet REGISTRY** (mandatory). Upsert one `owner/repo` row in `Dylan5237/agent-project-ops` [`fleet/REGISTRY.md`](../fleet/REGISTRY.md) via PR; confirm the box mirror `/home/box/agent-data/fleet-morning-digest/REGISTRY.md` matches; tell the disposer **「已纳入舰队晨报扫描」**. See [ADR 0002](../docs/adr/0002-canonical-fleet-index.md) and [fleet/README.md](../fleet/README.md).
6. Freeze before creating implementation work.

Skipping step 5 is fail closed. The bootstrap checklist cannot be marked done without the Fleet REGISTRY row (git SoT) and an explicit mirror confirm or GitHub `BLOCKED:` for the mirror gap.

## Done when

- [ ] Generated project is a git repository with a real methodology SHA in `.agent-project-ops/PIN`.
- [ ] Binding files and project skill wrappers exist.
- [ ] `.agent-project-ops/remotes` names `origin` as authority, only requested projection remotes, and `export=(none)` / `share_export=(none)` unless Command Center later records an export name (bound-clone push still denied).
- [ ] `core.hooksPath=.githooks` in the bootstrap checkout.
- [ ] Fresh-clone instructions explicitly reinstall the hook configuration before first push.
- [ ] `.worktrees/` exists locally and is ignored.
- [ ] No generated file contains credential-bearing remote URLs.
- [ ] If GitHub was created, `origin` is the GitHub authority and protection is reported as A, B, or C (C is expected on Free private and is not a failed init).
- [ ] **Register to Fleet REGISTRY:** `fleet/REGISTRY.md` has an idempotent `owner/repo` row (PR open or merged); box mirror confirmed or `BLOCKED:` recorded on GitHub; disposer told **「已纳入舰队晨报扫描」**.
- [ ] No product Phase has been self-Accepted by bootstrap.

## Anti-patterns

- Downloading the methodology as ZIP and accepting `sha=unknown`.
- Treating the presence of `.githooks/pre-push` as proof the hook is installed after clone.
- Calling PR-only protection “human approval enforced.”
- Claiming B or A when only C was verified.
- Treating Free-private C as bootstrap failure or “do not start feature work.”
- Requiring GitHub Pro to finish init.
- Requiring one approval on a single-identity repository without understanding the lockout/self-review semantics.
- Adding a second write remote for convenience.
- Using `--projection-url` for colleague GitLab (that leaks ops; use share-export).
- Running this greenfield script on a non-empty business tree and calling that adoption (use [adopt-existing-project.md](./adopt-existing-project.md)).
- Writing PIN while `AGENTS.md` still inverts authority (GitLab = production SoT; GitHub = mirror only).
- Using a projection failure as permission to retarget feature pushes.
- Treating bootstrap as done because the business repo exists while the project is absent from `fleet/REGISTRY.md`.
- Duplicating a Fleet REGISTRY row instead of upserting by `owner/repo`.
- Updating only the box mirror (or only chat) and leaving git SoT stale.
