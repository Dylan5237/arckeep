---
name: share-export
description: >
  Publish a filtered business-only git tree for colleague share (typically
  GitLab). Use when sharing with colleagues, excluding agent-project-ops
  bindings, denylisting AGENTS.md / .githooks / .github templates, or when
  tempted to git push --mirror / project the full ops tree to GitLab.
  Not a same-history projection remote. Related to the export= remote role
  (ADR 0005 / export-sync.sh) but this skill is the ADR 0003 snapshot helper.
  GitHub origin stays write authority.
---

# share-export (pinned wrapper)

Follow the full pinned skill at [../../../.agent-project-ops/skills/share-export/SKILL.md](../../../.agent-project-ops/skills/share-export/SKILL.md).

Do not invent a parallel process. `.agent-project-ops/PRINCIPLES.md` wins.
