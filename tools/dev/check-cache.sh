#!/usr/bin/env bash
# The fast lane (`just check`) with a memory: a content fingerprint of the
# tree it checks is recorded when it passes, so the same content is never
# checked twice — not by the Claude Code Stop hook after a turn, not by the
# pre-push hook for the commit made from that tree, not for a tag pushed
# after it. Shared by .claude/hooks/stop-gate.sh and tools/dev/pre-push.sh.
#
#   check-cache.sh fingerprint [<commit>]   fingerprint of the working tree (untracked
#                                          files included) or of a commit
#   check-cache.sh is-green <fingerprint>   exit 0 when that content passed `just check`
#   check-cache.sh run [<log>]              `just check` unless the working tree is
#                                          green; output to <log> (default: stdout)
#   check-cache.sh run-affected [<log>]     the affected lane (tools/dev/check-affected.sh)
#                                          against the last content that passed either
#                                          lane; `just check` when there is none
#
# The fingerprint covers the tree by content (git tree ids), so a
# commit of a green working tree is green too. One run at a time per clone
# (a lock in the git dir); a second caller waits for it and reuses its result.
#
# Two lanes, two records. `run` (pre-push, `just check`) records the content
# as green; `run-affected` (the Stop hook) checks only the workspace
# packages a change reaches and records it as affected-green, which the
# Stop hook accepts and pre-push does not — a push still needs one whole
# `just check`. Both remember the tree they passed (`claude-check-base`):
# the next affected run checks what changed since then. Sound step by step:
# each run covers every package changed since a tree whose every package
# had passed.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$root" || exit 1
gitdir="$(git rev-parse --absolute-git-dir)"
stamps="$gitdir/claude-check-green"
affected_stamps="$gitdir/claude-check-affected-green"
base_file="$gitdir/claude-check-base"
lock="$gitdir/claude-check.lock"

# What `just check` checks: the whole tree (formatting covers docs and
# config too), so the fingerprint does as well — a cache that called content
# green without having checked all of it would let an unformatted file
# through (2026-09-30: .claude/settings.json). Ignored files stay out.
paths=(.)

hash() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1
  else echo "check-cache: neither sha256sum nor shasum found" >&2; return 1; fi
}

# The tree id of a commit, or of the working tree (untracked files included).
tree_of() {
  if [[ -n "${1:-}" ]]; then
    git rev-parse --verify --quiet "$1^{tree}"
    return
  fi
  # The working tree as a tree object: HEAD plus every change and untracked
  # (not ignored) file under the paths, in a throwaway index.
  local index present=() p tree
  for p in "${paths[@]}"; do [[ -e "$p" ]] && present+=("$p"); done
  index="$(mktemp "${TMPDIR:-/tmp}/check-index.XXXXXX")" || return 1
  # A deleted path is simply absent from the add; read-tree already has it,
  # so drop it from the throwaway index first.
  # Before the first commit there is no HEAD: start from the empty tree.
  local base=HEAD
  git rev-parse -q --verify HEAD >/dev/null || base=--empty
  GIT_INDEX_FILE="$index" git read-tree "$base" &&
    GIT_INDEX_FILE="$index" git rm -r -q --cached --ignore-unmatch -- "${paths[@]}" &&
    { ((${#present[@]} == 0)) || GIT_INDEX_FILE="$index" git -c core.safecrlf=false add -A -- "${present[@]}"; } &&
    tree="$(GIT_INDEX_FILE="$index" git write-tree)"
  local ok=$?
  rm -f "$index"
  ((ok == 0)) || return 1
  echo "$tree"
}

fingerprint_of_tree() { git ls-tree "$1" -- "${paths[@]}" | hash; }

fingerprint() {
  local tree
  tree="$(tree_of "${1:-}")" || return 1
  fingerprint_of_tree "$tree"
}

listed() { [[ -n "$2" && -f "$1" ]] && grep -qxF "$2" "$1"; }
is_green() { listed "$stamps" "${1:-}"; }
is_affected_green() { listed "$affected_stamps" "${1:-}"; }

record() {
  { [[ -f "$1" ]] && tail -n 19 "$1"; echo "$2"; } >"$1.tmp" && mv "$1.tmp" "$1"
}
mark_green() { record "$stamps" "$1"; }
mark_affected_green() { record "$affected_stamps" "$1"; }
# The tree object stays in the object store (write-tree put it there); a gc
# may prune it one day, and then the next affected run checks everything.
remember_base() { echo "$1" >"$base_file"; }

# One run at a time; a waiter re-reads the stamps after the first one ends.
take_lock() {
  local waited=0
  until mkdir "$lock" 2>/dev/null; do
    if [[ -f "$lock/pid" ]] && ! kill -0 "$(cat "$lock/pid")" 2>/dev/null; then
      rm -rf "$lock"; continue # the holder died
    fi
    ((waited == 0)) && echo "check-cache: another check is running; waiting for it" >&2
    sleep 2
    waited=$((waited + 2))
    if ((waited > 900)); then echo "check-cache: gave up waiting for $lock" >&2; return 1; fi
  done
  echo $$ >"$lock/pid"
}

run() {
  local log="${1:-/dev/stdout}" tree fp
  # A git failure must not read as "already checked" or skip the check: run
  # it, uncached (nothing to record without a fingerprint).
  if ! tree="$(tree_of)" || ! fp="$(fingerprint_of_tree "$tree")"; then
    echo "check-cache: cannot fingerprint the working tree; running \`just check\` uncached" >&2
    just check >"$log" 2>&1
    return
  fi
  is_green "$fp" && return 0
  take_lock || return 1
  trap 'rm -rf "$lock"' RETURN
  { tree="$(tree_of)" && fp="$(fingerprint_of_tree "$tree")"; } || { just check >"$log" 2>&1; return; }
  is_green "$fp" && return 0
  if just check >"$log" 2>&1; then
    # Record the content that was checked (unchanged during the run, or the
    # next caller simply checks again).
    if [[ "$(tree_of)" == "$tree" ]]; then
      mark_green "$fp"
      remember_base "$tree"
    fi
    return 0
  fi
  return 1
}

run_affected() {
  local log="${1:-/dev/stdout}" tree fp base=""
  if ! tree="$(tree_of)" || ! fp="$(fingerprint_of_tree "$tree")"; then
    echo "check-cache: cannot fingerprint the working tree; running \`just check\` uncached" >&2
    just check >"$log" 2>&1
    return
  fi
  { is_green "$fp" || is_affected_green "$fp"; } && return 0
  take_lock || return 1
  trap 'rm -rf "$lock"' RETURN
  { tree="$(tree_of)" && fp="$(fingerprint_of_tree "$tree")"; } || { just check >"$log" 2>&1; return; }
  { is_green "$fp" || is_affected_green "$fp"; } && return 0
  [[ -f "$base_file" ]] && base="$(cat "$base_file")"
  if [[ -z "$base" ]] || ! git cat-file -e "$base^{tree}" 2>/dev/null; then
    # Nothing passed yet in this clone (or its tree was pruned): the whole lane.
    if just check >"$log" 2>&1; then
      if [[ "$(tree_of)" == "$tree" ]]; then
        mark_green "$fp"
        remember_base "$tree"
      fi
      return 0
    fi
    return 1
  fi
  if tools/dev/check-affected.sh "$base" "$tree" >"$log" 2>&1; then
    if [[ "$(tree_of)" == "$tree" ]]; then
      mark_affected_green "$fp"
      remember_base "$tree"
    fi
    return 0
  fi
  return 1
}

case "${1:-}" in
  fingerprint) fingerprint "${2:-}" ;;
  is-green) is_green "${2:-}" ;;
  run) run "${2:-}" ;;
  run-affected) run_affected "${2:-}" ;;
  *) echo "usage: $0 fingerprint [<commit>] | is-green <fingerprint> | run [<log>] | run-affected [<log>]" >&2; exit 2 ;;
esac
