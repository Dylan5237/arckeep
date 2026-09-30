#!/usr/bin/env bash
# Export remote sync: authority main − strip list. Not a second write authority.
# See docs/adr/0005-export-remote-role.md and playbooks/export-remote.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

source_lib() {
  local name="$1"
  local candidate
  for candidate in \
    "${SCRIPT_DIR}/lib/${name}" \
    "${SCRIPT_DIR}/../lib/${name}"
  do
    if [[ -f "${candidate}" ]]; then
      # shellcheck source=/dev/null
      source "${candidate}"
      return 0
    fi
  done
  printf 'export-sync: error: missing lib %s\n' "${name}" >&2
  exit 1
}

source_lib url-guard.sh
source_lib export-strip-list.sh

src_dir=""
authority_ref=""
export_url=""
export_remote=""
branch="main"
do_check=0
dry_run=0
assume_yes=0
authorized=0
extra_file=""

usage() {
  cat <<'EOF'
export-sync.sh — sync an export remote (ADR 0005 / Issue #46)

Export is not a second write authority. Content identity:
  export tree = authority tip − strip list

Sync (after disposer authorization): fetch both sides; work from the
current export tip; merge authority; replay strip (delete newly introduced
strip-list paths); verify identity; fast-forward push. Reject → stop.
There is no --force.

  --dir PATH              Bound source git repository (default: cwd)
  --ref REF               Authority revision (default: origin/main, then HEAD)
  --export-url URL        Export git URL (or remotes export_url=)
  --export-remote NAME    Registry name (documentation / URL lookup only)
  --branch NAME           Export branch (default: main)
  --check                 Fail if the authority ref still contains strip paths
  --dry-run               Print plan; do not merge, commit, or push
  --authorized            Required to push; disposer sync ACK is already on the Issue
  --yes                   Required together with --authorized for push
  --extra-strip PATH      Additional strip path (repeatable; cannot shrink)
  --extra-file PATH       File of extra strip paths (or .agent-project-ops/export-strip-extra)
  -h, --help              Show this help

Fail closed:
  - no --authorized → no push (bound-clone hook also denies export= remotes)
  - strip-list path remains in the export tree → no push
  - methodology strip entry missing → refuse
  - extras that try to remove/negate methodology entries → refuse
  - non-fast-forward → stop; never --force
  - unsafe URL → no push
  - unrelated export history → stop (use share-export.sh snapshots, or re-seed)

Related helper: scripts/share-export.sh (ADR 0003) publishes a filtered
snapshot with a different denylist (keeps .github/workflows/ by default)
and different history. See playbooks/export-remote.md.
EOF
}

log() { printf 'export-sync: %s\n' "$*"; }
err() { printf 'export-sync: error: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) src_dir="${2:-}"; shift 2 ;;
    --ref|--authority-ref) authority_ref="${2:-}"; shift 2 ;;
    --export-url) export_url="${2:-}"; shift 2 ;;
    --export-remote) export_remote="${2:-}"; shift 2 ;;
    --branch) branch="${2:-}"; shift 2 ;;
    --check) do_check=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --authorized) authorized=1; shift ;;
    --yes) assume_yes=1; shift ;;
    --extra-strip)
      export_strip_add_extra "${2:-}" || exit 1
      shift 2
      ;;
    --extra-file) extra_file="${2:-}"; shift 2 ;;
    --force|--force-with-lease|-f)
      die "force is forbidden for export sync; reject → stop"
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown flag: $1 (see --help)" ;;
  esac
done

[[ -n "${src_dir}" ]] || src_dir="$(pwd)"
src_dir="$(cd "${src_dir}" && pwd)"
git -C "${src_dir}" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || die "not a git repository: ${src_dir}"

registry="${src_dir}/.agent-project-ops/remotes"
if [[ -z "${export_url}" && -f "${registry}" ]]; then
  export_url="$(sed -n 's/^export_url=//p' "${registry}" | head -1)"
  if [[ -z "${export_url}" ]]; then
    export_url="$(sed -n 's/^share_export_url=//p' "${registry}" | head -1)"
  fi
  if [[ -z "${export_remote}" ]]; then
    export_remote="$(sed -n 's/^export=//p' "${registry}" | head -1)"
  fi
fi

if [[ -z "${authority_ref}" ]]; then
  if git -C "${src_dir}" rev-parse --verify -q origin/main >/dev/null; then
    authority_ref="origin/main"
  else
    authority_ref="HEAD"
  fi
fi

auth_sha="$(git -C "${src_dir}" rev-parse --verify "${authority_ref}^{commit}" 2>/dev/null)" \
  || die "cannot resolve authority ref ${authority_ref} in ${src_dir}"

default_extra="${src_dir}/.agent-project-ops/export-strip-extra"
if [[ -n "${extra_file}" ]]; then
  export_strip_load_extra_file "${extra_file}" || exit 1
elif [[ -f "${default_extra}" ]]; then
  export_strip_load_extra_file "${default_extra}" || exit 1
fi

export_strip_assert_methodology_intact || die "methodology strip list is incomplete; refuse to sync"

list_authority_paths() {
  git -C "${src_dir}" ls-tree -r --name-only "${auth_sha}"
}

scan_paths() {
  local label="$1"
  local found=0
  local p
  while IFS= read -r p; do
    [[ -z "${p}" ]] && continue
    if export_path_is_stripped "${p}"; then
      err "${label} contains strip-list path: ${p}"
      found=1
    fi
  done
  [[ "${found}" -eq 0 ]] || return 1
  return 0
}

excluded=0
included=0
while IFS= read -r p; do
  [[ -z "${p}" ]] && continue
  if export_path_is_stripped "${p}"; then
    excluded=$((excluded + 1))
    if [[ "${dry_run}" -eq 1 ]]; then
      printf 'strip %s\n' "${p}"
    fi
  else
    included=$((included + 1))
    if [[ "${dry_run}" -eq 1 ]]; then
      printf 'keep %s\n' "${p}"
    fi
  fi
done < <(list_authority_paths)

log "authority ${auth_sha}  keep=${included}  strip=${excluded}"

if [[ "${do_check}" -eq 1 ]]; then
  if list_authority_paths | scan_paths "authority ${authority_ref}"; then
    log "check: authority ref has no strip-list paths"
  else
    die "check failed: authority ref contains strip-list paths; do not git push this clone to the export remote. Use this helper after disposer authorization."
  fi
fi

if [[ -z "${export_url}" && "${dry_run}" -eq 1 ]]; then
  log "dry-run complete; no export URL; no write, no push"
  exit 0
fi

if [[ -z "${export_url}" && "${do_check}" -eq 1 && "${dry_run}" -eq 0 ]]; then
  exit 0
fi

[[ -n "${export_url}" ]] || die "specify --export-url or remotes export_url="
url_has_secrets "${export_url}" && die "export URL is unsafe; credentials/query strings are forbidden"

if [[ "${dry_run}" -eq 1 ]]; then
  log "dry-run: would sync ${auth_sha} onto export ${export_url} branch ${branch} (FF only; no force)"
  log "dry-run: push requires --authorized --yes after disposer sync ACK"
  exit 0
fi

if [[ "${authorized}" -ne 1 || "${assume_yes}" -ne 1 ]]; then
  die "push requires --authorized --yes (disposer explicit sync ACK). Export remotes are not on the auto-push whitelist."
fi

work="$(mktemp -d)"
cleanup() { rm -rf "${work}"; }
trap cleanup EXIT

git init -q -b "${branch}" "${work}"
git -C "${work}" config user.email "export-sync@local.invalid"
git -C "${work}" config user.name "agent-project-ops export-sync"
git -C "${work}" remote add authority "${src_dir}"
git -C "${work}" fetch -q authority "${auth_sha}"
git -C "${work}" remote add export "${export_url}"

has_export=0
export_tip=""
if git -C "${work}" fetch -q export "${branch}" 2>/dev/null; then
  export_tip="$(git -C "${work}" rev-parse FETCH_HEAD)"
  has_export=1
  log "export tip ${export_tip}"
fi

strip_checkout() {
  local dest="$1"
  local p
  while IFS= read -r p; do
    [[ -z "${p}" ]] && continue
    if export_path_is_stripped "${p}"; then
      rm -rf "${dest}/${p}"
    fi
  done < <(git -C "${dest}" ls-tree -r --name-only HEAD)

  while IFS= read -r p; do
    [[ -z "${p}" ]] && continue
    p="${p%/}"
    rm -rf "${dest}/${p}"
  done < <(export_strip_print_effective)

  git -C "${dest}" add -A
  if [[ -z "$(git -C "${dest}" ls-files)" ]]; then
    die "export tree is empty after strip; refusing to publish"
  fi
}

verify_identity() {
  local dest="$1"
  local p blob_a blob_e
  while IFS= read -r p; do
    [[ -z "${p}" ]] && continue
    if export_path_is_stripped "${p}"; then
      if git -C "${dest}" cat-file -e "HEAD:${p}" 2>/dev/null; then
        die "export tree still contains strip-list path: ${p}"
      fi
      continue
    fi
    blob_a="$(git -C "${src_dir}" rev-parse "${auth_sha}:${p}")"
    blob_e="$(git -C "${dest}" rev-parse "HEAD:${p}" 2>/dev/null)" \
      || die "export tree lags authority; missing ${p}"
    [[ "${blob_a}" == "${blob_e}" ]] \
      || die "export blob for ${p} does not match authority"
  done < <(list_authority_paths)

  while IFS= read -r p; do
    [[ -z "${p}" ]] && continue
    if export_path_is_stripped "${p}"; then
      die "export tree still contains strip-list path: ${p}"
    fi
    git -C "${src_dir}" cat-file -e "${auth_sha}:${p}" 2>/dev/null \
      || die "export tree has path not on authority (not a strip leftover): ${p}"
  done < <(git -C "${dest}" ls-tree -r --name-only HEAD)
}

if [[ "${has_export}" -eq 0 ]]; then
  git -C "${work}" checkout -q -B "${branch}" "${auth_sha}"
  strip_checkout "${work}"
  if git -C "${work}" diff --cached --quiet && git -C "${work}" diff --quiet; then
    log "seed: authority tree already has no strip-list paths"
  else
    git -C "${work}" commit -q -m "export: strip methodology paths from ${auth_sha}"
  fi
else
  if ! git -C "${work}" merge-base "${export_tip}" "${auth_sha}" >/dev/null 2>&1; then
    die "export history is unrelated to authority; stop. Use scripts/share-export.sh for snapshot republish, or re-seed an empty export branch with this helper."
  fi
  git -C "${work}" checkout -q -B "${branch}" "${export_tip}"
  if [[ "${export_tip}" != "${auth_sha}" ]]; then
    if ! git -C "${work}" merge --no-edit --no-ff "${auth_sha}"; then
      git -C "${work}" merge --abort >/dev/null 2>&1 || true
      die "merge of authority ${auth_sha} onto export tip failed; fail closed (no force, no reset-to-origin/main)"
    fi
  fi
  strip_checkout "${work}"
  if git -C "${work}" diff --cached --quiet && git -C "${work}" diff --quiet; then
    log "replay strip: no newly introduced strip-list paths"
  else
    git -C "${work}" commit -q -m "export: replay strip after ${auth_sha}"
  fi
  git -C "${work}" merge-base --is-ancestor "${export_tip}" HEAD \
    || die "result is not a fast-forward of export tip ${export_tip}; stop; no force"
fi

git -C "${work}" rev-parse --verify HEAD >/dev/null \
  || die "no export commit to publish"
verify_identity "${work}"

# Never --force / --force-with-lease. Reject → stop.
if ! git -C "${work}" push export "HEAD:refs/heads/${branch}"; then
  die "export push rejected; stop; no force"
fi
if [[ -d "${export_url}" ]]; then
  git --git-dir="${export_url}" symbolic-ref HEAD "refs/heads/${branch}" >/dev/null 2>&1 || true
fi
log "pushed export ${branch} (authority ${auth_sha}; FF only)"
