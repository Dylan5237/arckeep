#!/usr/bin/env bash
# Colleague share-export: filtered business tree. Not a full-tree projection.
# See docs/adr/0003-share-export-vs-projection.md and playbooks/share-export.md.
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
  printf 'share-export: error: missing lib %s\n' "${name}" >&2
  exit 1
}

source_lib url-guard.sh
source_lib share-export-denylist.sh

src_dir=""
ref="HEAD"
out_dir=""
push_url=""
branch="main"
do_check=0
dry_run=0
assume_yes=0
strip_all_github=0

usage() {
  cat <<'EOF'
share-export.sh — publish a business-only tree (ADR 0003)

Colleague GitLab is share-export, not a projection. This helper strips
agent-project-ops bindings (or refuses) and never git-pushes the bound
working tree.

  --dir PATH              Source git repository (default: cwd)
  --ref REF               Source revision (default: HEAD)
  --out PATH              Write a new filtered git repository here
  --push URL              Publish the filtered tree to a credential-free git URL
  --branch NAME           Destination branch (default: main)
  --check                 Fail if the source ref still contains denylist paths
                          (unfiltered push would leak ops)
  --dry-run               Print include/exclude plan; do not write or push
  --strip-all-github      Also exclude .github/workflows (default keeps business CI)
  --yes                   Required together with --push
  -h, --help              Show this help

Fail closed:
  - denylist path still present in the tree that would be published → no push
  - --push URL with query/credentials/token prefixes → no push
  - never --force
  - never add the share-export URL as a remote on the source clone

Denylist (minimum; see ADR 0003):
  .agent-project-ops/  .agents/  .claude/  .cursor/  .continue/  .githooks/
  .github/ISSUE_TEMPLATE/  .github/PULL_REQUEST_TEMPLATE/
  .github/CODEOWNERS  .github/copilot-instructions.md
  AGENTS.md  CLAUDE.md  .aider.conf.yml
  Default keeps .github/workflows/ (pure business CI).
EOF
}

log() { printf 'share-export: %s\n' "$*"; }
err() { printf 'share-export: error: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) src_dir="${2:-}"; shift 2 ;;
    --ref) ref="${2:-}"; shift 2 ;;
    --out) out_dir="${2:-}"; shift 2 ;;
    --push) push_url="${2:-}"; shift 2 ;;
    --branch) branch="${2:-}"; shift 2 ;;
    --check) do_check=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --strip-all-github) strip_all_github=1; shift ;;
    --yes) assume_yes=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown flag: $1 (see --help)" ;;
  esac
done

SHARE_EXPORT_STRIP_ALL_GITHUB="${strip_all_github}"
export SHARE_EXPORT_STRIP_ALL_GITHUB

[[ -n "${src_dir}" ]] || src_dir="$(pwd)"
src_dir="$(cd "${src_dir}" && pwd)"
git -C "${src_dir}" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || die "not a git repository: ${src_dir}"

src_sha="$(git -C "${src_dir}" rev-parse --verify "${ref}^{commit}" 2>/dev/null)" \
  || die "cannot resolve ref ${ref} in ${src_dir}"

if [[ -n "${push_url}" ]]; then
  url_has_secrets "${push_url}" && die "push URL is unsafe; credentials/query strings are forbidden"
  [[ "${assume_yes}" -eq 1 || "${dry_run}" -eq 1 ]] \
    || die "--push requires --yes (or --dry-run)"
fi

if [[ -z "${out_dir}" && -z "${push_url}" && "${do_check}" -eq 0 && "${dry_run}" -eq 0 ]]; then
  die "specify --check, --dry-run, --out PATH, and/or --push URL"
fi

list_source_paths() {
  git -C "${src_dir}" ls-tree -r --name-only "${src_sha}"
}

scan_paths() {
  local label="$1"
  local found=0
  local p
  while IFS= read -r p; do
    [[ -z "${p}" ]] && continue
    if share_export_path_is_denied "${p}"; then
      err "${label} contains denylist path: ${p}"
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
  if share_export_path_is_denied "${p}"; then
    excluded=$((excluded + 1))
    if [[ "${dry_run}" -eq 1 ]]; then
      printf 'exclude %s\n' "${p}"
    fi
  else
    included=$((included + 1))
    if [[ "${dry_run}" -eq 1 ]]; then
      printf 'include %s\n' "${p}"
    fi
  fi
done < <(list_source_paths)

log "source ${src_sha}  include=${included}  exclude=${excluded}"

if [[ "${do_check}" -eq 1 ]]; then
  if list_source_paths | scan_paths "source ${ref}"; then
    log "check: source ref has no denylist paths"
  else
    die "check failed: source ref contains agent-project-ops bindings; do not git push this clone to colleague GitLab. Use this helper to strip, or omit --check after a successful export."
  fi
fi

if [[ "${dry_run}" -eq 1 && -z "${out_dir}" && -z "${push_url}" ]]; then
  log "dry-run complete; no write, no push"
  exit 0
fi

[[ "${dry_run}" -eq 0 ]] || {
  log "dry-run: skipping write/push"
  exit 0
}

build_filtered_tree() {
  local dest="$1"
  mkdir -p "${dest}"
  git -C "${src_dir}" archive --format=tar "${src_sha}" | tar -x -C "${dest}"

  local p
  while IFS= read -r p; do
    [[ -z "${p}" ]] && continue
    if share_export_path_is_denied "${p}"; then
      rm -rf "${dest}/${p}"
    fi
  done < <(list_source_paths)

  # Remove denylist directories even if some children were already deleted as files.
  rm -rf \
    "${dest}/.agent-project-ops" \
    "${dest}/.agents" \
    "${dest}/.claude" \
    "${dest}/.cursor" \
    "${dest}/.continue" \
    "${dest}/.githooks" \
    "${dest}/.github/ISSUE_TEMPLATE" \
    "${dest}/.github/PULL_REQUEST_TEMPLATE"
  rm -f \
    "${dest}/AGENTS.md" \
    "${dest}/CLAUDE.md" \
    "${dest}/.aider.conf.yml" \
    "${dest}/.github/CODEOWNERS" \
    "${dest}/.github/copilot-instructions.md"
  if [[ "${SHARE_EXPORT_STRIP_ALL_GITHUB}" == 1 ]]; then
    rm -rf "${dest}/.github"
  fi
}

scan_tree_files() {
  local tree="$1"
  local label="$2"
  local rel
  (
    cd "${tree}"
    find . -type f -print | sed 's|^\./||'
  ) | scan_paths "${label}"
}

commit_filtered_repo() {
  local repo="$1"
  git -C "${repo}" add -A
  if git -C "${repo}" rev-parse --verify --quiet HEAD >/dev/null; then
    if git -C "${repo}" diff --cached --quiet; then
      log "filtered tree unchanged at ${repo}"
      return 0
    fi
  else
    if [[ -z "$(git -C "${repo}" ls-files -c)" ]]; then
      die "filtered tree is empty; refusing to publish an empty share-export"
    fi
  fi
  if ! git -C "${repo}" config user.email >/dev/null 2>&1; then
    git -C "${repo}" config user.email "share-export@local.invalid"
    git -C "${repo}" config user.name "agent-project-ops share-export"
  fi
  git -C "${repo}" commit -q -m "share-export: business tree from ${src_sha}"
}

if [[ -n "${out_dir}" ]]; then
  [[ ! -e "${out_dir}" ]] || die "out path exists: ${out_dir}"
  mkdir -p "${out_dir}"
  build_filtered_tree "${out_dir}"
  scan_tree_files "${out_dir}" "filtered out repo" \
    || die "filtered tree still contains denylist paths; refusing to keep ${out_dir}"
  git init -q -b "${branch}" "${out_dir}"
  commit_filtered_repo "${out_dir}"
  log "wrote filtered repository ${out_dir}"
fi

if [[ -n "${push_url}" ]]; then
  work="$(mktemp -d)"
  trap 'rm -rf "${work}"' EXIT
  filtered="${work}/tree"
  publish="${work}/publish"
  mkdir -p "${filtered}"
  build_filtered_tree "${filtered}"
  scan_tree_files "${filtered}" "filtered publish tree" \
    || die "filtered tree still contains denylist paths; refusing to push"

  mkdir -p "${publish}"
  git init -q -b "${branch}" "${publish}"
  git -C "${publish}" remote add origin "${push_url}"
  if git -C "${publish}" fetch -q origin "${branch}" 2>/dev/null; then
    git -C "${publish}" checkout -q -B "${branch}" FETCH_HEAD
  fi

  find "${publish}" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  # Copy contents; "${filtered}/." is the portable equivalent of trailing-slash copy.
  cp -a "${filtered}/." "${publish}/"
  commit_filtered_repo "${publish}"
  scan_tree_files "${publish}" "publish checkout" \
    || die "publish checkout contains denylist paths; refusing to push"

  git -C "${publish}" rev-parse --verify HEAD >/dev/null 2>&1 \
    || die "no filtered commit to publish (empty export or unchanged empty repo)"
  git -C "${publish}" push origin "HEAD:refs/heads/${branch}"
  if [[ -d "${push_url}" ]]; then
    git --git-dir="${push_url}" symbolic-ref HEAD "refs/heads/${branch}" >/dev/null 2>&1 || true
  fi
  log "pushed filtered ${branch} to ${push_url}"
fi
