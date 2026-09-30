#!/usr/bin/env bash
# The fast lane (`just check`) with a memory: a content fingerprint of the
# code it checks is recorded when it passes, so the same content is never
# checked twice — not by the Claude Code Stop hook after a turn, not by the
# pre-push hook for the commit made from that tree, not for a tag pushed
# after it. Shared by .claude/hooks/stop-gate.sh and tools/dev/pre-push.sh.
#
#   check-cache.sh fingerprint [<commit>]   fingerprint of the working tree (untracked
#                                          files included) or of a commit
#   check-cache.sh is-green <fingerprint>   exit 0 when that content passed before
#   check-cache.sh run [<log>]              `just check` unless the working tree is
#                                          green; output to <log> (default: stdout)
#
# The fingerprint covers the paths below by content (git tree ids), so a
# commit of a green working tree is green too. One run at a time per clone
# (a lock in the git dir); a second caller waits for it and reuses its result.
set -uo pipefail

root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$root" || exit 1
gitdir="$(git rev-parse --absolute-git-dir)"
stamps="$gitdir/claude-check-green"
lock="$gitdir/claude-check.lock"

# What `just check` checks. Docs are formatted on write and checked by
# fmt-check too, but a docs-only change does not need the whole lane again.
paths=(apps packages tests tools scripts infra/scripts justfile lefthook.yml package.json
  pnpm-lock.yaml eslint.config.js tsconfig.base.json .prettierrc .prettierignore)

hash() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1
  else echo "check-cache: neither sha256sum nor shasum found" >&2; return 1; fi
}

fingerprint() {
  local tree
  if [[ -n "${1:-}" ]]; then
    tree="$(git rev-parse --verify --quiet "$1^{tree}")" || return 1
  else
    # The working tree as a tree object: HEAD plus every change and untracked
    # (not ignored) file under the paths, in a throwaway index.
    local index present=() p
    for p in "${paths[@]}"; do [[ -e "$p" ]] && present+=("$p"); done
    index="$(mktemp "${TMPDIR:-/tmp}/check-index.XXXXXX")" || return 1
    # A deleted path is simply absent from the add; read-tree already has it,
    # so drop it from the throwaway index first.
    GIT_INDEX_FILE="$index" git read-tree HEAD &&
      GIT_INDEX_FILE="$index" git rm -r -q --cached --ignore-unmatch -- "${paths[@]}" &&
      { ((${#present[@]} == 0)) || GIT_INDEX_FILE="$index" git -c core.safecrlf=false add -A -- "${present[@]}"; } &&
      tree="$(GIT_INDEX_FILE="$index" git write-tree)"
    local ok=$?
    rm -f "$index"
    ((ok == 0)) || return 1
  fi
  git ls-tree "$tree" -- "${paths[@]}" | hash
}

is_green() { [[ -n "$1" && -f "$stamps" ]] && grep -qxF "$1" "$stamps"; }

mark_green() {
  { [[ -f "$stamps" ]] && tail -n 19 "$stamps"; echo "$1"; } >"$stamps.tmp" && mv "$stamps.tmp" "$stamps"
}

run() {
  local log="${1:-/dev/stdout}" fp
  fp="$(fingerprint)" || { echo "check-cache: cannot fingerprint the working tree" >&2; return 1; }
  is_green "$fp" && return 0
  # One run at a time; a waiter re-reads the stamps after the first one ends.
  local waited=0
  until mkdir "$lock" 2>/dev/null; do
    if [[ -f "$lock/pid" ]] && ! kill -0 "$(cat "$lock/pid")" 2>/dev/null; then
      rm -rf "$lock"; continue # the holder died
    fi
    ((waited == 0)) && echo "check-cache: another \`just check\` is running; waiting for it" >&2
    sleep 2
    waited=$((waited + 2))
    if ((waited > 900)); then echo "check-cache: gave up waiting for $lock" >&2; return 1; fi
  done
  echo $$ >"$lock/pid"
  trap 'rm -rf "$lock"' RETURN
  fp="$(fingerprint)" || return 1
  is_green "$fp" && return 0
  if just check >"$log" 2>&1; then
    # Record the content that was checked (unchanged during the run, or the
    # next caller simply checks again).
    [[ "$(fingerprint)" == "$fp" ]] && mark_green "$fp"
    return 0
  fi
  return 1
}

case "${1:-}" in
  fingerprint) fingerprint "${2:-}" ;;
  is-green) is_green "${2:-}" ;;
  run) run "${2:-}" ;;
  *) echo "usage: $0 fingerprint [<commit>] | is-green <fingerprint> | run [<log>]" >&2; exit 2 ;;
esac
