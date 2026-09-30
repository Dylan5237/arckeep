#!/usr/bin/env bash
# Read-only git/workspace inventory for repo-reconciliation-cleanup.
# Prints metadata only; does not delete or modify.
set -euo pipefail

usage() { echo "usage: $0 <repo-root>" >&2; exit 64; }
[[ $# -eq 1 ]] || usage
[[ -d "$1" ]] || { echo "[ERR] not a directory: $1" >&2; exit 66; }
ROOT="$(cd "$1" && pwd -P)"

printf '# repo-reconciliation-cleanup inventory v1\n'
printf 'project_root=%s\n' "$ROOT"
printf 'generated_at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

if ! git -C "$ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  printf 'git_root=none\n'
  exit 0
fi

GIT_ROOT="$(git -C "$ROOT" rev-parse --show-toplevel)"
printf 'git_root=%s\n' "$GIT_ROOT"
printf '\n## remotes\n'
git -C "$GIT_ROOT" remote -v || true

printf '\n## head\n'
printf 'branch=%s\n' "$(git -C "$GIT_ROOT" branch --show-current 2>/dev/null || echo DETACHED)"
printf 'head=%s\n' "$(git -C "$GIT_ROOT" rev-parse HEAD)"
for c in origin/HEAD origin/main origin/master; do
  if git -C "$GIT_ROOT" rev-parse "$c" >/dev/null 2>&1; then
    printf '%s=%s\n' "$c" "$(git -C "$GIT_ROOT" rev-parse --short=12 "$c")"
  fi
done

printf '\n## status\n'
printf 'porcelain_lines=%s\n' "$(git -C "$GIT_ROOT" status --porcelain=v1 | wc -l | tr -d ' ')"
git -C "$GIT_ROOT" status -sb || true

printf '\n## worktrees\n'
git -C "$GIT_ROOT" worktree list || true

printf '\n## local-branches\n'
git -C "$GIT_ROOT" for-each-ref --format='%(refname:short) %(objectname:short) %(upstream:short)' refs/heads || true

printf '\n## remote-branches (origin)\n'
git -C "$GIT_ROOT" for-each-ref --format='%(refname:short) %(objectname:short)' refs/remotes/origin 2>/dev/null | head -200 || true

printf '\n## residue-candidates (names only)\n'
# common session leftovers — existence only
git -C "$GIT_ROOT" status --porcelain=v1 | awk '{print $2}' | head -200 || true
find "$GIT_ROOT" -maxdepth 2 \( -name '*_old*' -o -name '*_backup*' -o -name '*_v2*' -o -name '_scan*' -o -name 'PLAN.md' -o -name 'TODO.md' \) 2>/dev/null | head -100 || true

printf '\n## done\n'
