# Playbook: Issues and PRs / 议题与拉取请求

## Goal

Keep **Issues as state** and **PRs as proposals**. Labels make the board machine-readable for Agents.

## When

- Opening, updating, or closing work.
- Connecting a branch to the control plane.
- Changing status.

## Preconditions

- Command Center exists.
- Labels from `templates/labels.md` are applied on the business repo.
- Chat decisions will be copied into the Issue in the same session.

## Steps

1. **Choose the issue type**
   - Command Center: one per repo (index, roster, policy).
   - Phase: one core problem; lifecycle in `phase-lifecycle.md`.
   - Child task (optional): small implementable slice under a Phase; still one PR.
   - Architecture Exception: frozen-contract change request.
2. **Status label (exactly one):**
   - `status:backlog` — not started
   - `status:in-progress` — dispatched, worktree exists
   - `status:blocked` — cannot proceed; gap listed
   - `status:verification` — implementation proposed; evidence in flight or waiting Accept
   - `status:done` — disposer finished (Accept or explicit cancel)
3. **Type labels:** `type:command-center` | `type:phase` | `type:task` | `type:exception` | `type:docs`
4. **Open implementation PR** with `templates/PULL_REQUEST_TEMPLATE/implementation.md`.
   - Title: `{type}(#{issue}): short slug`
   - Body: links Issue, Freeze permalink, test plan, NON-GOALS respected.
   - Label PR `pr:implementation`. Do not add product-only labels from a business SOP pack.
5. **Open evidence PR** (if artifacts are in git) with `templates/PULL_REQUEST_TEMPLATE/evidence.md`, label `pr:evidence`, branch `evidence/{issue}-{slug}`.
6. **Comments are the log.** Status changes get a one-line reason. Paste command output **summaries** that matter; do not dump secrets.
7. **CC §1 on every status/gate change.** Same turn: rewrite Command Center section 1 and keep exactly one Phase `status:*` label. [ ] **CC §1 updated**. If CC cannot be edited → `BLOCKED:` on GitHub, not chat-only.
8. **Bugbot before merge-ask / 提合并前必须唤醒 Bugbot.** Ordered gate: do this **before** asking the disposer to merge or review-for-merge a PR.
   1. Post a **PR comment** whose body is exactly `bugbot run` (wakes Cursor Bugbot). Chat is not a substitute.
   2. Default: **one** such wake per PR. If substantial new commits land after Bugbot finished, another `bugbot run` is allowed.
   3. After commenting, tell the disposer to **wait for Bugbot review results before deciding whether to merge**. Do not nudge merge as the default while Bugbot is pending.
   4. Bugbot pass ≠ `PHASE ACCEPT`. Merge still needs disposer ACK (Principle 3). This is comment discipline, not a Capability A requirement, and does not change Bugbot product/automation config.
   **Exception — `Dylan5237/agent-project-ops` self-dogfood** may skip `bugbot run` and need not wait for Bugbot before merge-ask. Business / other fleet repos still follow the full gate above.
9. **Close rules.** Close tasks when their PR is merged **and** the Phase still owns Accept. Close Phase only after `PHASE ACCEPT` or documented supersede. Closing a PR ≠ closing a Phase.

## Done when

- [ ] Every in-flight branch has a linked open Issue.
- [ ] Exactly one `status:*` label on each tracked Issue.
- [ ] PRs declare implementation vs evidence.
- [ ] Command Center table lists open Phases.
- [ ] **CC §1 updated** for the latest status/gate flip (or `BLOCKED:` recorded on GitHub).
- [ ] Merge-ask (if any) followed the Bugbot gate: PR comment `bugbot run`, disposer told to wait for Bugbot, no merge nudge while pending.

## Anti-patterns

- Issues with empty bodies (“fix it”).
- Five status labels at once.
- PR with no linked Issue.
- Using Projects/boards as the only state and leaving Issues blank.
- Merging then deleting the Issue before Accept is recorded.
- Changing a Phase status label without rewriting Command Center §1 (or recording `BLOCKED:` on GitHub).
- Asking the disposer to merge / review-for-merge before posting a PR comment whose body is exactly `bugbot run`.
- Substituting chat for that PR comment, or nudging merge while Bugbot is still pending.
- Treating Bugbot pass as `PHASE ACCEPT` or as a substitute for disposer merge ACK.
