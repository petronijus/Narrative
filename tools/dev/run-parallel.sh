#!/usr/bin/env bash
# Run just recipes side by side: `tools/dev/run-parallel.sh typecheck lint test`.
#
# `just check` uses it for its independent steps, which otherwise add up
# (typecheck, lint, the unit tests and the manifest check share no state).
# Each recipe's output goes to its own log; a line per recipe says how it
# ended and how long it took, and every failed recipe's log is printed in
# full afterwards, so the Stop hook and the pre-push hook still show what
# broke. Exits non-zero when any recipe failed. bash 3.2 compatible.
set -uo pipefail

if (($# == 0)); then
  echo "usage: $0 <recipe>..." >&2
  exit 64
fi

logs="$(mktemp -d "${TMPDIR:-/tmp}/narrative-check.XXXXXX")"
trap 'rm -rf "$logs"' EXIT

started=$(date +%s)
pids=()
for recipe in "$@"; do
  (
    t0=$(date +%s)
    just "$recipe" >"$logs/$recipe.log" 2>&1
    rc=$?
    echo "$rc $(($(date +%s) - t0))" >"$logs/$recipe.status"
    exit "$rc"
  ) &
  pids+=("$!")
done

for pid in "${pids[@]}"; do wait "$pid" || true; done

failed=()
for recipe in "$@"; do
  read -r rc secs <"$logs/$recipe.status"
  if [[ "$rc" == 0 ]]; then
    printf '  ok    %-20s %4ss\n' "$recipe" "$secs"
  else
    printf '  FAIL  %-20s %4ss\n' "$recipe" "$secs"
    failed+=("$recipe")
  fi
done
echo "  ($(($(date +%s) - started))s in parallel)"

if ((${#failed[@]} > 0)); then
  for recipe in "${failed[@]}"; do
    echo
    echo "── just $recipe ──────────────────────────────────────────────"
    cat "$logs/$recipe.log"
  done
  exit 1
fi
