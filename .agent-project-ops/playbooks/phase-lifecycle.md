# Playbook: Phase lifecycle / 阶段生命周期

## Goal

Move a Phase from idea to **CLOSED** with a frozen contract, isolated implementation, independent evidence, and an explicit Accept. Merge is not PASS.

## When

- A Phase issue exists (`type:phase`).
- You are about to write code, verify, Accept, or close.

## Preconditions

- Command Center is open and names the disposer.
- The Phase states **one** core problem (Principle 6).
- Agent loaded `PRINCIPLES.md`. Fail closed if Freeze is missing.

## Steps

Every transition below includes: update Command Center **section 1** in the same turn, and check **「CC §1 updated」**. This is **mandatory Agent duty**, not a user habit. If CC cannot be updated → `BLOCKED:` on GitHub (not chat-only). See `skills/github-multi-agent-project-ops`.

### 0. Status labels (on the Phase issue)

Use exactly: `status:backlog` → `status:in-progress` → (`status:blocked` if needed) → `status:verification` → `status:done`. Remove the previous status when transitioning. Then update CC §1 (current phase, status word, gates, **single Next Action**).

- [ ] **CC §1 updated**

### 1. Freeze / 冻结合同

1. Fill the Phase template: in-scope, out-of-scope (NON-GOALS), acceptance tests, interfaces/data contracts, risks, owner.
2. Post a **Freeze** comment: `CONTRACT FREEZE <ISO-8601 date>` plus the frozen bullet list (or a permalink to the issue body revision).
3. Disposer confirms Freeze (comment `FREEZE ACK`). Agent must not ACK itself.
4. Update CC §1 (status word, Next Action). [ ] **CC §1 updated**
5. Only then may implementation branches be created.

### 2. Implement / 实现

1. One worktree + one branch per task/PR (`playbooks/git-worktree.md`, `git-branch-and-remote.md`).
2. Implementation PRs use `templates/PULL_REQUEST_TEMPLATE/implementation.md`.
3. Link `Closes` / `Refs` the Phase or child task issue.
4. Do not “improve” frozen fields in the same PR. That is an Architecture Exception.
5. Update CC §1 when the implementation PR opens or the Phase label moves. [ ] **CC §1 updated**
6. Before asking the disposer to merge / review-for-merge: follow `playbooks/issues-and-prs.md` step 8 — PR comment whose body is exactly `bugbot run`, then tell the disposer to wait for Bugbot results. Do not nudge merge while Bugbot is pending. Bugbot pass ≠ `PHASE ACCEPT`.

### 3. Verify / 验证

1. After implementation PR is reviewable (merged or merge-ready per Command Center policy — and only after the Bugbot-before-merge-ask gate in `playbooks/issues-and-prs.md` when asking for merge), open or update **evidence** work — separate PR if artifacts live in-repo (`playbooks/verification-and-evidence.md`).
2. Label Phase `status:verification`.
3. Evidence must be replayable by the disposer without the original chat.
4. Update CC §1. [ ] **CC §1 updated**

### 4. Accept / 验收

1. Agent **proposes** PASS: comment on the Phase with evidence links and a mapping “acceptance test → proof.”
2. Disposer comments `PHASE ACCEPT` or `PHASE RETURN` with gaps.
3. `PHASE ACCEPT` is the only PASS. PR merge never substitutes. Bugbot pass never substitutes.
4. After Accept or Return, update CC §1 (do not treat merge as PASS). [ ] **CC §1 updated**

### 5. CLOSED

1. Set `status:done`. Close the Phase issue when Accept is recorded and leftover tasks are closed or moved to a new Phase.
2. Link the Command Center index to the closed Phase (table row: issue number, date, result).
3. Update CC §1 (current phase, status word, Next Action). [ ] **CC §1 updated**

If blocked at any step: `playbooks/blocked-and-exceptions.md`. Do not skip Freeze or Accept. Blocked also updates CC §1.

## Done when

- [ ] Freeze ACK exists on the Phase.
- [ ] Implementation and evidence are on **distinct** PRs/branches when both exist.
- [ ] `PHASE ACCEPT` (or an explicit cancel/supersede note) is on the issue.
- [ ] Phase is `status:done` and closed, or still open only because a documented follow-on Phase owns remaining work.
- [ ] Command Center index updated.
- [ ] **CC §1 updated** on each gate flip recorded above (current phase, status word, gates, single Next Action).

## Anti-patterns

- Coding on `main` or before Freeze ACK.
- “We merged, so the phase passed.”
- Asking the disposer to merge before posting `bugbot run` on the PR, or treating Bugbot pass as Accept.
- Flipping a Phase label or Freeze/blocked/verification event without updating Command Center §1 (leaving the new state in chat).
- Quietly editing the frozen contract in a later commit message.
- One Phase with two unrelated acceptance suites.
- Agent commenting `PHASE ACCEPT` as if it were the disposer (unless the Command Center **explicitly** named that Agent as disposer — still prefer a distinct human ACK when available).
