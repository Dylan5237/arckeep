# Playbook: Staff and dispatch / 编制与分派

## Goal

Make it obvious **who proposes**, **who disposes**, and **which Agent owns which worktree**, without a second product or a shop-floor bot.

## When

- Starting a project (after Command Center exists).
- Adding a second local Agent or a human reviewer.
- A task is ready to leave `backlog`.

## Preconditions

- Command Center issue exists.
- Labels from `templates/labels.md` exist.
- Each concurrent task can have its own worktree (Principle 8).

## Steps

1. **Name the disposer** on Command Center (human GitHub handle, or a single explicit control-plane owner). This person/role Freeze-ACKs and PHASE ACCEPTs.
2. **Name the project-ops Agent** (often the local coding Agent). It keeps Issues honest, proposes transitions, and refuses illegal shortcuts. It still **proposes**. **Mandatory duty:** on every gate flip / phase status / Freeze / blocked / verification, update Command Center **section 1** in the same turn. Update the Phase status label only when the Phase status actually changes (Freeze ACK is not a label change). Chat only pings humans to look at GitHub. If CC cannot be updated → `BLOCKED:` on GitHub, not chat-only. [ ] **CC §1 updated**
3. **Roster table** on Command Center:

   | Role | Handle / Agent id | May merge? | May Accept phase? |
   | --- | --- | --- | --- |
   | Disposer | | policy | yes |
   | Implementer Agent | | no (unless named) | no |
   | Reviewer | | optional | no |

4. **Dispatch a task:**
   - Pick one Issue (Phase or child). One core problem.
   - Comment `@owner START` with: issue number, branch name, worktree path, Freeze status.
   - Set `status:in-progress`. Assign the GitHub issue if the host is used.
   - Update Command Center §1 (current phase, status word, **single Next Action**). [ ] **CC §1 updated**
   - Create worktree + branch per git playbooks.
5. **Handoff:** if another Agent continues, comment `HANDOFF to <id>` with worktree path and uncommitted-file policy (commit or stash; never leave mystery dirty trees).
6. **Recall:** if scope drifts, disposer comments `STOP` or `RETURN TO BACKLOG`. Agent parks the worktree, sets `status:backlog` or `blocked`, and updates CC §1. [ ] **CC §1 updated**
7. **Parallelism:** N Agents ⇒ N worktrees. Shared `main` checkout is only for read/status, not for stacked unrelated diffs.

## Done when

- [ ] Command Center roster is complete.
- [ ] Every `in-progress` issue names an owner in the last dispatch comment.
- [ ] **CC §1 updated** after dispatch, handoff, recall, or status change (or `BLOCKED:` on GitHub if CC cannot be edited).
- [ ] No two in-progress tasks share a worktree.
- [ ] Agents can answer “who Accepts?” from the Command Center body alone.

## Anti-patterns

- “Everyone owns it” (nobody disposes).
- One worktree, two Agents, two features.
- Dispatch via chat only; Issue stays `backlog`.
- Treating CC §1 refresh as the human’s habit instead of the project-ops Agent’s duty.
- Implementer Agent self-Accepting because “I am the project owner.”
- Staffing a Notion workflow or Grok bot as part of this methodology (out of scope).
