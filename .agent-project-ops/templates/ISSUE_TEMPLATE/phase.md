---
name: Phase
about: 一个阶段只解决一个核心问题 — Freeze before implementation
title: "[Phase] "
labels: "type:phase, status:backlog"
---

## Core problem / 核心问题（仅一个）

<!-- One sentence. If you need two, open two phases. -->

## NON-GOALS / 非目标

-

## Owner (implementer)

-

## Freeze contract / 待冻结

### In scope

-

### Interfaces / data contracts

-

### Acceptance tests / 验收口径（可复验）

1.
2.

### Risks

-

## Freeze log

- [ ] Contract written in this body
- [ ] Disposer comment: `FREEZE ACK` + date
- [ ] No `feat/`/`fix/` branch before ACK
- [ ] **CC §1 updated** on this Freeze / status change

## Control-plane hygiene

On every gate flip / phase status / Freeze / blocked / verification: update Command Center **section 1** and this Phase status label in the same turn. Agent duty, not user habit. If CC cannot be updated → `BLOCKED:` on GitHub.

- [ ] **CC §1 updated**

## Implementation links

- Worktree:
- PRs:

## Verification

- Evidence PR or proof comment:
- Agent proposal (`EVIDENCE READY`):
- Disposer: `PHASE ACCEPT` / `PHASE RETURN`

## Notes

<!-- Paste chat decisions here. Chat ≠ state. -->
