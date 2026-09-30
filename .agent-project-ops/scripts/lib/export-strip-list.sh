# Default strip list for the export remote role (Issue #46 / ADR 0005).
# Source this file; do not execute it as a standalone command.
#
# Methodology-owned. Business repos may ADD entries. They must not remove
# methodology entries. There is no shrink API.

EXPORT_STRIP_METHODOLOGY_PATHS=(
  '.agent-project-ops/'
  '.agents/'
  '.githooks/'
  '.github/'
  '.claude/'
  '.continue/'
  '.cursor/'
  'AGENTS.md'
  'CLAUDE.md'
  '.aider.conf.yml'
)

EXPORT_STRIP_EXTRA_PATHS=()

export_strip_normalize() {
  local p="${1:-}"
  p="${p#./}"
  while [[ "${p}" == /* ]]; do p="${p#/}"; done
  printf '%s' "${p}"
}

export_strip_print_methodology() {
  local e
  for e in "${EXPORT_STRIP_METHODOLOGY_PATHS[@]}"; do
    printf '%s\n' "${e}"
  done
}

export_strip_print_effective() {
  export_strip_print_methodology
  local e
  for e in "${EXPORT_STRIP_EXTRA_PATHS[@]}"; do
    printf '%s\n' "${e}"
  done
}

export_strip_assert_methodology_intact() {
  local required found e
  for required in "${EXPORT_STRIP_METHODOLOGY_PATHS[@]}"; do
    found=0
    while IFS= read -r e; do
      [[ "${e}" == "${required}" ]] && found=1
    done < <(export_strip_print_effective)
    if [[ "${found}" -ne 1 ]]; then
      printf 'export-strip: error: methodology strip entry missing from effective list: %s\n' "${required}" >&2
      return 1
    fi
  done
  return 0
}

export_strip_add_extra() {
  local raw="${1:-}"
  local p
  p="$(export_strip_normalize "${raw}")"
  if [[ -z "${p}" ]]; then
    return 0
  fi
  case "${p}" in
    '!'*|'-'*|'~'*)
      printf 'export-strip: error: extras may only add paths; refusing shrink syntax: %s\n' "${raw}" >&2
      return 1
      ;;
  esac
  EXPORT_STRIP_EXTRA_PATHS+=("${p}")
}

export_strip_load_extra_file() {
  local file="${1:-}"
  [[ -n "${file}" && -f "${file}" ]] || {
    printf 'export-strip: error: extra-strip file missing: %s\n' "${file}" >&2
    return 1
  }
  local line
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "${line}" ]] && continue
    export_strip_add_extra "${line}" || return 1
  done < "${file}"
}

export_strip_entry_matches() {
  local p="${1:-}"
  local entry="${2:-}"
  p="$(export_strip_normalize "${p}")"
  entry="$(export_strip_normalize "${entry}")"
  [[ -n "${p}" && -n "${entry}" ]] || return 1

  if [[ "${entry}" == */ ]]; then
    entry="${entry%/}"
    [[ "${p}" == "${entry}" || "${p}" == "${entry}/"* ]] && return 0
    return 1
  fi
  [[ "${p}" == "${entry}" ]] && return 0
  return 1
}

export_path_is_stripped() {
  local p="${1:-}"
  local entry
  while IFS= read -r entry; do
    [[ -z "${entry}" ]] && continue
    if export_strip_entry_matches "${p}" "${entry}"; then
      return 0
    fi
  done < <(export_strip_print_effective)
  return 1
}
