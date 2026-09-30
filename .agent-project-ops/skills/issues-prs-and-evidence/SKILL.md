---
name: issues-prs-and-evidence
description: >
  Keep GitHub Issues as canonical state, use status labels, split implementation
  PRs from evidence PRs, and fail closed when blocked or the freeze must change.
  Use when filing phases, Command Center, Architecture Exception, verification,
  or PR templates.
---

# Issues, PRs, and evidence

**Chat ≠ state.** If it is not on the Issue, PR, or git object, it did not happen.

## Playbooks

- [playbooks/issues-and-prs.md](../../playbooks/issues-and-prs.md)
- [playbooks/verification-and-evidence.md](../../playbooks/verification-and-evidence.md)
- [playbooks/blocked-and-exceptions.md](../../playbooks/blocked-and-exceptions.md)
- Templates: [templates/](../../templates/) · Labels: [templates/labels.md](../../templates/labels.md)

## Status (exactly one per issue)

`status:backlog` | `status:in-progress` | `status:blocked` | `status:verification` | `status:done`

## PR split (Principle 9)

| PR kind | Branch prefix | Template | Contains |
| --- | --- | --- | --- |
| Implementation | `feat/` `fix/` `docs/` | `templates/PULL_REQUEST_TEMPLATE/implementation.md` | product/library/test **code** |
| Evidence | `evidence/` | `templates/PULL_REQUEST_TEMPLATE/evidence.md` | replayable proofs only |

PR merge ≠ Phase PASS. Propose `EVIDENCE READY`; disposer writes `PHASE ACCEPT`.

## Agent checklist

1. Link every branch to an Issue. Empty issue bodies are invalid.
2. Copy Freeze text / ACK into the implementation PR.
3. Map each frozen acceptance test → proof (table).
4. On gaps: `BLOCKED:` comment + `status:blocked`.
5. Frozen field wrong → new Architecture Exception issue; do not edit-and-continue.
6. Redact secrets from logs.
7. On every status/gate flip: update Command Center **section 1** and the Phase status label. [ ] **CC §1 updated**. Cannot edit CC → `BLOCKED:` on GitHub, not chat-only.
8. Before asking the disposer to merge / review-for-merge: post a PR comment whose body is exactly `bugbot run` (default one wake per PR; another allowed after substantial new commits once Bugbot finished). Then tell the disposer to wait for Bugbot results. Chat is not a substitute. Do not nudge merge while Bugbot is pending. Bugbot pass ≠ `PHASE ACCEPT`. Exception: `Dylan5237/agent-project-ops` self-dogfood may skip `bugbot run` and need not wait for Bugbot before merge-ask; business / other fleet repos still follow the full gate.

Do not add a second control plane (chat logs, unofficial boards) as a substitute.
