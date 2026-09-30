---
name: github-multi-agent-project-ops
description: >
  Operate a business git repo as a local coding Agent that often owns day-to-day
  project ops. GitHub Issues/PRs are the control plane; chat is not state.
  Use when starting a repo, staffing Agents, running Freeze→Implement→Verify→Accept,
  or when the user mentions Command Center, phases, or agent-project-ops.
---

# GitHub multi-agent project ops

Load **[PRINCIPLES.md](../../PRINCIPLES.md) v0.1.2** first. Invariants beat this skill.

You are usually the **project-ops Agent**: you keep Issues honest and **propose**. You do not Freeze-ACK or `PHASE ACCEPT` unless the Command Center explicitly names you as disposer.

## 必读 / Required reading

1. [PRINCIPLES.md](../../PRINCIPLES.md)
2. [playbooks/start-project.md](../../playbooks/start-project.md) — if no Command Center
3. [playbooks/phase-lifecycle.md](../../playbooks/phase-lifecycle.md)
4. [playbooks/staff-and-dispatch.md](../../playbooks/staff-and-dispatch.md)
5. [playbooks/blocked-and-exceptions.md](../../playbooks/blocked-and-exceptions.md)

Companion skills: `git-worktree-and-branch`, `git-authority-and-projection`, `export-remote`, `share-export`, `issues-prs-and-evidence`.

Git landing / remotes (worktrees, `origin`, optional projection): do **not** duplicate here — follow `git-worktree-and-branch` plus [playbooks/git-authority-and-projection.md](../../playbooks/git-authority-and-projection.md) when a second remote exists. Colleague GitLab: [export-remote](../export-remote/SKILL.md) (`export=`) or [share-export](../share-export/SKILL.md).

## 工作循环 / Loop

1. Find Command Center. If missing → start-project playbook. Stop implementation.
2. Confirm disposer + roster. If missing → fail closed, comment on a new Command Center draft.
3. One Phase = one core problem. No Freeze ACK → no `feat/` / `fix/` branch.
4. Dispatch: Issue comment with owner, worktree, branch; `status:in-progress`. Then **CC §1** + Phase status label (see hygiene).
5. Implement in one worktree / one PR. Verify with **separate** evidence.
6. Before asking the disposer to merge / review-for-merge: PR comment whose body is exactly `bugbot run` (default one wake per PR; another allowed after substantial new commits once Bugbot finished). Tell the disposer to wait for Bugbot. Chat is not a substitute. Do not nudge merge while Bugbot is pending. Bugbot pass ≠ `PHASE ACCEPT`. Exception: `Dylan5237/agent-project-ops` self-dogfood may skip `bugbot run` and need not wait for Bugbot before merge-ask; business / other fleet repos still follow the full gate.
7. Propose PASS with evidence table. Wait for `PHASE ACCEPT`.
8. Update Command Center **section 1** and the Phase index. Never treat merge as PASS. [ ] **CC §1 updated**

New projects: after Command Center exists, **Register to Fleet REGISTRY** (`fleet/REGISTRY.md` upsert by `owner/repo` + box mirror confirm). See [bootstrap-project](../bootstrap-project/SKILL.md) and [ADR 0002](../../docs/adr/0002-canonical-fleet-index.md).

## Command Center hygiene / CC §1（mandatory agent duty）

Keeping Command Center **section 1** current is **Agent work on every gate flip**, not a user habit. Fleet morning digest (and any later fleet tooling) reads **only** CC §1 plus the current Phase status label for registered projects. Stale §1 is a false green.

**On every** gate flip / phase status change / Freeze / blocked / verification / Accept event, in the **same turn**:

1. Update Command Center **section 1** (one-glance): current phase, status word, open gates, evidence pointers, **single Next Action**.
2. If this event is a Phase **status transition** (dispatch → `in-progress`, blocked, verification, Accept/`done`), update the Phase issue **status label** (`status:backlog` | `in-progress` | `blocked` | `verification` | `done`) and remove the previous status label. **Freeze ACK is not a status-label change** — leave the existing label (usually `status:backlog`) in place.
3. Chat only pings humans to **look at GitHub**. Chat ≠ state.

Phase transition checklist (required checkbox):

- [ ] **CC §1 updated**

If the Agent **cannot** update Command Center (auth, permissions, read-only `gh`, API failure): fail closed. Comment `BLOCKED:` with the gap on the Phase (or a new Command Center draft) and set `status:blocked`. Do **not** leave the new state only in chat.

Playbook copies: [phase-lifecycle.md](../../playbooks/phase-lifecycle.md), [staff-and-dispatch.md](../../playbooks/staff-and-dispatch.md).

## Fail closed

- No methodology (this repo) loaded → refuse to invent a process.
- No business-product content belongs **in** agent-project-ops. Link out only.
- Unknown architecture after Freeze → Architecture Exception issue, not a silent refactor.
- Gate flipped but CC §1 not updated → incomplete; treat as blocked until GitHub reflects it.
- Cannot edit Command Center → `BLOCKED:` on GitHub, not chat-only.

## Do not

- Add Notion, bots, CI bootstrap, or deploy stacks as part of this skill.
- Copy business SOP into the methodology repository.
- Self-label a Phase `status:done` without disposer Accept.
- Ask the human to “remember to update CC §1” as the primary path.
- Ask the disposer to merge before the `bugbot run` PR comment, or treat Bugbot pass as Accept.
