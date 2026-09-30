# Playbook: Start project / 启动项目

## Goal

Stand up a **control plane** in the **business** git repository so a local Agent can own day-to-day ops without treating chat as state.

## When

- A repo was just created by `bootstrap-project`.
- A business repo already exists and **already completed** [adopt-existing-project.md](./adopt-existing-project.md) step 1 (local `AGENTS.md` remote contract rewritten; inverted SoT fail-closed). Adoption is not this playbook.
- The repository has no Command Center yet.

## Preconditions

- You can create Issues and labels on the business repo.
- GitHub is the write authority (`origin`).
- `PRINCIPLES.md` v0.1.2 is in force, either from a pinned `.agent-project-ops/` snapshot or an explicitly loaded methodology checkout.
- If the repo was bootstrapped, `.agent-project-ops/PIN` contains a real methodology SHA and `.agent-project-ops/remotes` is the remote registry.

## Steps

1. **Load the binding.** Prefer root `AGENTS.md` in a bootstrapped or adopted repo, then read `.agent-project-ops/PRINCIPLES.md`. Confirm: Chat ≠ state; Agent proposes / control plane disposes; merge ≠ Phase PASS; GitHub `origin` is the only write authority. If this is an existing repo, [adopt-existing-project.md](./adopt-existing-project.md) step 1 (inverted-SoT scan + rewrite) must already be clean — do not open Command Center on an inverted contract.
2. **Fresh-clone hook check.** Run `git config --get core.hooksPath`. A clone does not inherit this local config. In a bootstrapped repo, if it is not `.githooks`, run `bash .agent-project-ops/scripts/install-hooks.sh`. Missing client hook is not permission to push `main`.
3. **Create labels.** Apply `templates/labels.md` (or the pinned snapshot copy) without inventing overlapping status names.
4. **Verify `main` protection.** Require pull requests and disable force/deletion as hosting capability permits. Record observed capability on Command Center: **A** code-owner review enforced, **B** PR-only, or **C** unprotected/unverifiable. Never call B an independent-human-review gate. On GitHub Free private, C is expected: record C and continue (hooks + PR discipline). Do not claim B/A. Do not treat C as a stop-all-work gate. See [ADR 0004](../docs/adr/0004-free-private-capability-c.md).
5. **Open the Command Center issue.** Use `templates/ISSUE_TEMPLATE/command-center.md`. Fill **section 1** (one-glance), disposer, PIN, default branch, protection capability, Agent roster, and Freeze/Accept policy.
6. **Register to Fleet REGISTRY** (mandatory). Upsert `owner/repo` + Command Center `#N` into `Dylan5237/agent-project-ops` [`fleet/REGISTRY.md`](../fleet/REGISTRY.md) via PR; confirm box mirror `/home/box/agent-data/fleet-morning-digest/REGISTRY.md`; tell the disposer **「已纳入舰队晨报扫描」**. Fail closed if skipped. [ADR 0002](../docs/adr/0002-canonical-fleet-index.md).
7. **Reconcile remotes.** `git remote -v` must match the registered classification. Default is `origin` only. If a **projection** is required, it remains same-history mirror/FF only and `git-authority-and-projection` applies before any non-origin push. If colleagues need a GitLab copy, that is [export-remote](./export-remote.md) (`export=`) or [share-export](./share-export.md), not a projection and not a second write authority. Unknown remotes → Blocked.
8. **Open Phase-0/Phase-1.** One core problem only. Use the Phase template with backlog status.
9. **Do not implement yet.** Run Freeze on that Phase before any `feat/` / `fix/` branch.

## Done when

- [ ] Command Center exists as the single project index, has a filled **section 1**, and names the disposer.
- [ ] **Register to Fleet REGISTRY** completed (`owner/repo` row in `fleet/REGISTRY.md`; mirror confirmed or GitHub `BLOCKED:`; disposer told **「已纳入舰队晨报扫描」**).
- [ ] Status labels exist.
- [ ] `git config --get core.hooksPath` is `.githooks` for this clone when the tracked hook exists.
- [ ] Command Center records protection capability A/B/C honestly; capability C (expected on GitHub Free private) is recorded and work continues. Never claim B/A when only C was verified.
- [ ] Command Center records authority/projection/export (and share-export alias) and matches `.agent-project-ops/remotes` when present.
- [ ] At least one Phase issue exists with one core problem and no implementation before Freeze.
- [ ] Agent can find the pinned/current playbooks without the original bootstrap chat.

## Anti-patterns

- Treating the methodology repository as the product repository.
- Treating a tracked hook file as proof `core.hooksPath` is active after clone.
- Calling PR-only protection “human approval enforced” when Agent and disposer share an identity.
- Treating Free-private capability C as “stop all work” or claiming B/A when only C was verified.
- Skipping Command Center and tracking work only in chat.
- Skipping Fleet REGISTRY registration after Command Center exists.
- Pushing “just this once” to `main`.
- Adding a second write authority or using projection as a fallback.
- Registering colleague GitLab as projection so the bound clone can be mirrored.
- Treating an `export=` remote as a second write authority, or syncing it without disposer authorization.
- Embedding business SOP into this methodology repository.
- Starting this playbook while `AGENTS.md` still names GitLab (or another non-GitHub Issues host) as production/write SoT.
