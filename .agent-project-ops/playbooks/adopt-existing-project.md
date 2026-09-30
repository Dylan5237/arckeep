# Playbook: Adopt existing project / 存量仓库接入

## Goal

Bind an **existing** business git repository to `agent-project-ops` without inverting the remote contract.

Greenfield creation is [bootstrap-project.md](./bootstrap-project.md). This playbook is the adoption path. Chat-URL “load the methodology” is session guidance only; it is not binding.

**Step 1 (mandatory, before PIN):** audit and rewrite local Agent rule files so the remote contract matches [templates/AGENTS.md](../templates/AGENTS.md) and [git-authority-and-projection.md](./git-authority-and-projection.md):

| Role | Correct | **Anti-pattern (inverted contract)** |
| --- | --- | --- |
| Write authority | **GitHub `origin`** (Issues / PRs / landing) | GitLab, Gitee, Bitbucket, or any host that is **not** the GitHub Issues authority, written as the sole production / write SoT |
| Second remote | Optional **projection** (same-history FF, includes ops) **or** **export** (`authority − strip list`) / **share-export** snapshot | GitHub demoted to “mirror only”; colleague GitLab registered as `projection` or used as a second write target |
| Local / Cloud | Draft | Third SoT |

Export / share-export ≠ projection. Colleague GitLab is [export-remote.md](./export-remote.md) (`export=`) or [share-export.md](./share-export.md) / [ADR 0003](../docs/adr/0003-share-export-vs-projection.md). Do **not** register a colleague GitLab as projection during adoption. It is not a second write authority.

## When

- A business repo already exists and should become fleet-governed.
- Local `AGENTS.md` (or Claude / Cursor / Copilot adapters) still says GitLab (or another non-GitHub Issues host) is production / write SoT and GitHub is “mirror only”.
- Tempted to run `scripts/bootstrap-project.sh` on a non-empty directory (that script **refuses**; it is greenfield-only).

## Preconditions

- You can reach a real git checkout of this methodology (needed for the scanner and for a real PIN SHA).
- GitHub will be (or already is) the Issues/PR host. This methodology does not adopt a repo onto a non-GitHub Issues control plane.
- [PRINCIPLES.md](../PRINCIPLES.md) §5 (fail closed) and §10 (one write authority) are in force.
- You will **not** rewrite a concrete business repo from this methodology repository’s own PRs. Adoption edits happen on the business repo’s authority.

## Terms

| Term | Meaning |
| --- | --- |
| **Write authority tip** | The GitHub `origin` default-branch tip (or a Command Center–named transitional branch) that Issues and PRs describe. This is the only write SoT. |
| **Deploy / manifest tip** | The commit a release skill, deploy pipeline, or projection default branch currently consumes. It may lag, match, or (if mis-operated) diverge. It is **not** write SoT. |
| **Inverted contract** | Rule files that name a non-GitHub Issues host as production / write authority and/or demote GitHub to mirror-only. |
| **PIN binding** | Writing `.agent-project-ops/PIN` plus the remotes registry and Agent wrappers. Incomplete while inverted wording remains. |

## Steps

### 1. Audit and rewrite the local remote contract / 先改合同（第一步）

1. From the methodology checkout, scan the **business** repo (read-only; must-fix, not optional):

   ```bash
   python3 scripts/scan-inverted-sot.py --root /path/to/business-repo
   python3 skills/repo-reconciliation-cleanup/scripts/scan_inverted_sot.py --root /path/to/business-repo
   ```

   Either entrypoint is equivalent. Exit `1` = **MUST-FIX**. Exit `0` = clean. Do not treat hits as style nits.
2. If the scanner reports hits, **rewrite** root `AGENTS.md` (and the adapters that repeat the contract: `CLAUDE.md`, `.cursor/rules/*`, `.github/copilot-instructions.md`, Continue rules) so they match [templates/AGENTS.md](../templates/AGENTS.md):

   - `origin` (GitHub) is the only write authority.
   - Projection is optional, same-history FF only, and is **not** colleague GitLab.
   - Colleague GitLab is export / share-export, never `git push --mirror` from the bound clone.
3. If a release skill still consumes a projection (or other non-authority) default-branch tip, the same `AGENTS.md` **must** distinguish:

   | Tip | Use | Forbidden wording |
   | --- | --- | --- |
   | **Write authority tip** | `origin/<default>` after fetch; base worktrees and PRs here | Calling a projection / GitLab / deploy SHA “write SoT” |
   | **Deploy / manifest tip** | What the release skill or pipeline actually reads | Calling that tip write authority, production source, or 事实源 |

   Never use “GitLab is the authority because deploys read it” to smuggle a second SoT. Deploy identity is a floor, not write authority ([repo-reconciliation-cleanup](../skills/repo-reconciliation-cleanup/SKILL.md) fact surfaces).
4. Re-run the scanner. **PIN binding is fail-closed** until exit `0`.

`scripts/bootstrap-project.sh` also fail-closes if the destination already exists: it runs this scan (and prints MUST-FIX hits) then refuses to scaffold. That is not an adoption substitute; finish this playbook on the business repo instead.

### 2. Bind the methodology snapshot / 再写 PIN

Only after step 1 is clean:

1. Vendor or copy the methodology snapshot the same way bootstrap does (`.agent-project-ops/` with a **real** SHA in `PIN`, playbooks, skills, hook installer, remotes registry). Do not write `sha=unknown`.
2. `.agent-project-ops/remotes` names `authority=origin`. Projection is `(none)` unless Command Center will classify a same-history host. `export=(none)` / `share_export=(none)` unless Command Center later names a colleague export (bound-clone push still denied; sync needs disposer authorization).
3. Install tracked hooks: `bash .agent-project-ops/scripts/install-hooks.sh`. A clone does not inherit `core.hooksPath`.
4. Run the inverted-SoT scan again on the business root. Pinned `.agent-project-ops/` docs are skipped (they may describe the anti-pattern). Root rule files must stay clean.

### 3. Control plane / 控制面

Follow [start-project.md](./start-project.md): labels, Command Center, honest A/B/C protection, Fleet `REGISTRY.md` upsert, first Phase. No product implementation before that Phase has `FREEZE ACK`.

Do not claim adoption complete because the PIN file exists while `AGENTS.md` still inverts authority.

## Done when

- [ ] Step 1 scanner exits `0` on the business repo rule files.
- [ ] Root `AGENTS.md` matches the template contract: GitHub `origin` = write authority; projection optional; export / share-export ≠ projection and ≠ a second SoT.
- [ ] Inverted contract is absent (no “GitLab = production SoT / GitHub = mirror only”).
- [ ] If deploys still read a projection tip, `AGENTS.md` names **write authority tip** vs **deploy/manifest tip** and does not call the latter write SoT.
- [ ] Colleague share-export GitLab is **not** registered as projection.
- [ ] `.agent-project-ops/PIN` has a real SHA written **after** the contract rewrite.
- [ ] Command Center + Fleet REGISTRY path in [start-project.md](./start-project.md) is in progress or done.
- [ ] No Phase has been self-Accepted by the adopting Agent.

## Anti-patterns

- **Inverted contract:** GitLab (or any non-GitHub Issues host) as sole production / write SoT; GitHub as “mirror only”. This is the hole this playbook exists to close.
- Running greenfield `bootstrap-project.sh` on a non-empty business tree and calling that adoption.
- Writing `.agent-project-ops/PIN` first and “fixing AGENTS.md later”.
- Registering colleague share-export GitLab as `projection=` so the hook allows a full-tree push.
- Calling a projection / release / manifest tip the write authority because a skill still reads it.
- Editing a concrete business repo from a methodology-repo PR (out of scope here).
- Treating chat “we agreed GitHub is authority” as the rewrite. Chat ≠ state; the rule files must say it.
