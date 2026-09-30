#!/usr/bin/env bash
# pre-push hook: the fast lane (`just check`) for the commits a push adds,
# unless that content already passed (tools/dev/check-cache.sh — the Claude
# Code Stop hook records green content too, so a checked tree is not checked
# again when its commit and its tag are pushed).
#
# Skipped without checking:
#   - a push that adds no commit (a tag of a pushed commit, an up-to-date branch);
#   - a push of nothing but autosync commits: the ai-config project autosync
#     (scripts/project-sync.sh) pushes work in progress at session end within
#     a 25 s budget, which a ~1 min check would kill.
# The check runs on the working tree; when that differs from the pushed commit
# the hook says so (a parallel session's uncommitted work is in it).
set -uo pipefail

zero=0000000000000000000000000000000000000000
tips=() new=""
while read -r _local_ref local_sha _remote_ref remote_sha; do
  [[ "$local_sha" == "$zero" ]] && continue # a deletion
  if [[ "$remote_sha" == "$zero" ]]; then
    commits="$(git rev-list "$local_sha" --not --remotes 2>/dev/null)"
  else
    commits="$(git rev-list "$remote_sha..$local_sha" 2>/dev/null)"
  fi
  [[ -n "$commits" ]] || continue
  tips+=("$local_sha")
  new+="$commits"$'\n'
done

if ((${#tips[@]} == 0)); then exit 0; fi

subjects="$(xargs -r git log --no-walk --format=%s <<<"$new")"
if ! grep -qv '^autosync(' <<<"$subjects"; then
  echo "pre-push: autosync commits only — fast lane skipped" >&2
  exit 0
fi

cache="$(dirname "$0")/check-cache.sh"
worktree="$("$cache" fingerprint)" || exit 1
for tip in "${tips[@]}"; do
  fp="$("$cache" fingerprint "$tip")" || exit 1
  "$cache" is-green "$fp" && continue
  if [[ "$fp" != "$worktree" ]]; then
    echo "pre-push: the working tree differs from $(git rev-parse --short "$tip") (uncommitted changes); \`just check\` runs on the working tree" >&2
  fi
  "$cache" run || { echo "pre-push: \`just check\` failed — fix it, or see the output above" >&2; exit 1; }
  exit 0
done
exit 0
