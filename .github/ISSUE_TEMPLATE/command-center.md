---
name: Command Center
about: 项目指挥中心 — single index, roster, and policy for Agent-owned ops
title: "[Command Center] Project control plane"
labels: "type:command-center, status:in-progress"
---

## 1. One-glance / 一眼状态（agents keep fresh）

Agents **must** rewrite this section on every gate flip / phase status / Freeze / blocked / verification / Accept. This is Agent duty, not a user habit. Chat pings are not a substitute. If this section cannot be updated → `BLOCKED:` on GitHub.

| Field | Value |
| --- | --- |
| **Current phase** | # |
| **Status word** | backlog / implementation / blocked / verification / awaiting Accept |
| **Last closed phase** | — |
| **Open gates** | |
| **Single Next Action** | |

Updated: YYYY-MM-DD. Chat ≠ State.

## 目的 / Purpose

Canonical **control plane** for this business repository. Chat is not state. Methodology: https://github.com/Dylan5237/agent-project-ops (`PRINCIPLES.md` v0.1.2).

## Methodology binding

- PIN URL:
- PIN SHA:
- PIN ref/date:
- Root binding files present: yes / no

## Disposer / 拍板人

- Handle:
- May `FREEZE ACK` / `PHASE ACCEPT` / `EXCEPTION ACCEPT`: **yes**
- Distinct GitHub identity from day-to-day Agent credentials?: yes / no / unknown

## Project-ops Agent / 日常 Owner（仍为 propose）

- Agent id:
- GitHub identity used for git/PR operations (if known):
- May push directly to `main`: no
- May self-Accept phases: **no**

## Roster

| Role | Handle / Agent | Notes |
| --- | --- | --- |
| Disposer | | |
| Implementer | | |
| Reviewer | | |

## Git authority / remotes

- Default branch: `main`
- Authority remote: `origin`
- Projection remote(s): `(none)` or names — **same-history** FF mirror only
- Export remote(s): `(none)` or names — **export** = `authority − strip list`; not a second write authority; not on the auto-push whitelist
- Colleague-share GitLab: **export** (`scripts/export-sync.sh`) or **share-export** snapshot (`scripts/share-export.sh`). Not a projection; bound-clone push denied.
- `.agent-project-ops/remotes` matches the lines above: yes / no / n/a
- Unknown extra remotes: **BLOCKED until classified**
- Branch names: `feat|fix|docs|evidence/{issue}-{slug}`
- Worktrees: `{repo}/.worktrees/{issue-or-phase}-{owner}-{slug}`
- Direct push to default branch: **forbidden**

## Protection capability

Record what was actually verified, not what was requested:

- Capability: **A / B / C**
  - A = PR + code-owner/independent review gate verified
  - B = PR-only; no independent-human-review guarantee
  - C = unprotected or protection could not be verified. On GitHub Free **private** this is **expected**. Record C and continue. Do not claim B/A. Do not treat C as init failure. Optional Pro/public when a real server gate is required.
- Force push disabled: yes / no / unknown
- Default-branch deletion disabled: yes / no / unknown
- Notes / plan limitation:

If Agent and disposer use the same GitHub identity, GitHub cannot distinguish human from Agent actions; do not describe CODEOWNERS as a human-vs-Agent security boundary in that configuration.

## Hook state for this clone

- `git config --get core.hooksPath` = `.githooks`: yes / no
- If this was a fresh clone and value was missing, installer run: yes / no / n/a

## Phase index

| Phase issue | Core problem (one sentence) | Status | Result |
| --- | --- | --- | --- |
| # | | backlog | |

## Open exceptions / blocks

| Issue / block | Phase | Status |
| --- | --- | --- |
| | | |

## Adopt notes

- Binding path: root `AGENTS.md` → pinned `.agent-project-ops/PRINCIPLES.md`
- Relevant project skills: `.agents/skills/*/SKILL.md`
- Projection operations require `git-authority-and-projection` before non-origin push.
- Colleague GitLab requires `export-remote` (ADR 0005) or `share-export` (ADR 0003); never full-tree mirror of ops bindings; never a second write authority.
- Fleet index SoT: `Dylan5237/agent-project-ops` `fleet/REGISTRY.md` (box path is a mirror).
- After this issue exists, **Register to Fleet REGISTRY** once: upsert `owner/repo` + this Command Center number and confirm the box mirror. Fail closed if skipped. Do not repeat on later §1 rewrites.
