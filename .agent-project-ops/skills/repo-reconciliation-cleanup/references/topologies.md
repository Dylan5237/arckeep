# Topologies (T0–T4)

Read when deciding which surfaces exist. Record **Topology ID** on the recon Issue before inventory.

| ID | Signals | Surfaces |
| --- | --- | --- |
| **T0** Local-only | no remotes / fetch fails | Local |
| **T1** Local + authority | one write remote (GitHub `origin`); no projection | Local + Authority |
| **T2** + projection | second remote is same-history projection | Local + Authority + Projection |
| **T3** Remote-only | no usable local clone | Authority (+ Projection if reachable) |
| **T4** Split-brain | two write-looking remotes or unknown extra | **STOP** until disposer names one write authority |

Extra remote classes: **projection** (ops mirror) · **share-export** (colleague filtered tree — out of scope) · **unknown** (fail closed).

## Defaults by topology

| Topology | Dev SoT | Projection steps | Local steps |
| --- | --- | --- | --- |
| T0 | local default tip | skip | worktrees/junk only; add-remote is separate auth |
| T1 | `origin/<default>` | **skip entirely** | full local+remote hygiene |
| T2 | authority default | FF integration when ancestor; hold merge-tip dual-SoT unless align auth | full |
| T3 | authority via API | only if reachable | N/A |
| T4 | undecided | blocked | blocked |
