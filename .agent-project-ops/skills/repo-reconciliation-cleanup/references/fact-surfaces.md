# Fact surfaces (borrowed from neat-freak closeout discipline)

Every applicable surface must get an explicit status before claiming clean:

| Status | Meaning |
| --- | --- |
| `verified-current` | Checked against live evidence this run |
| `changed-and-verified` | We changed it and re-checked |
| `pending` | Cannot verify yet — do **not** invent |
| `out-of-scope` | Real issue, outside this request |
| `not-applicable` | Surface does not exist for this topology (e.g. no PROD → no runtime floor) |

## Surfaces for this skill

| Surface | Question | Typical evidence |
| --- | --- | --- |
| Authority tip | What is **write authority** SHA (Dev SoT)? | `origin/<default>` after fetch. Never a GitLab/non-GitHub Issues host. |
| Projection tip(s) | Integration / release tips? | projection remotes (T2 only). **Deploy/manifest tip ≠ write SoT.** |
| Rule-file contract | Does `AGENTS.md` invert SoT? | `scan_inverted_sot.py` — MUST-FIX if GitLab (or other non-GitHub Issues host) is production/write SoT or GitHub is “mirror only” |
| Local tip / worktrees | What is checked out where? | `git worktree list`, branch -vv |
| Open PRs | What in-flight heads remain? | `gh pr list` |
| PROD / deploy identity | What is actually released? | releaseId + manifest SHA, or UNKNOWN |
| Backlog Issues | Product intent still recorded? | open Issues titled Backlog / salvage notes |
| Workspace residue | Untracked junk, `_old` copies, empty worktree dirs? | status porcelain + inventory script |

Do **not** treat `git status` clean, PR merged, or tests green alone as “fully clean.”

Distinguish: `merged` ≠ `projected` ≠ `deployed` ≠ `live-verified` ≠ `hygiene-closed` ≠ `cleaned`.
