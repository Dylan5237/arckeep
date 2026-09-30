# Shared denylist for colleague share-export (ADR 0003 / Phase #32).
# Source this file; do not execute it as a standalone command.
#
# Minimum list. Implementations may add paths. Do not shrink without disposer ACK.

share_export_path_is_denied() {
  local p="${1:-}"
  p="${p#./}"
  while [[ "${p}" == /* ]]; do p="${p#/}"; done

  case "${p}" in
    .agent-project-ops|.agent-project-ops/*) return 0 ;;
    .agents|.agents/*) return 0 ;;
    .claude|.claude/*) return 0 ;;
    .cursor|.cursor/*) return 0 ;;
    .continue|.continue/*) return 0 ;;
    .githooks|.githooks/*) return 0 ;;
    .github/ISSUE_TEMPLATE|.github/ISSUE_TEMPLATE/*) return 0 ;;
    .github/PULL_REQUEST_TEMPLATE|.github/PULL_REQUEST_TEMPLATE/*) return 0 ;;
    .github/CODEOWNERS) return 0 ;;
    .github/copilot-instructions.md) return 0 ;;
    AGENTS.md) return 0 ;;
    CLAUDE.md) return 0 ;;
    .aider.conf.yml) return 0 ;;
  esac

  if [[ "${SHARE_EXPORT_STRIP_ALL_GITHUB:-0}" == 1 ]]; then
    case "${p}" in
      .github|.github/*) return 0 ;;
    esac
  fi

  return 1
}
