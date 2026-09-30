#!/usr/bin/env bash
# Stop: when the code differs from every content that passed before, run the
# fast lane (`just check`, through tools/dev/check-cache.sh, which records
# green content and lets one run at a time) before Claude may finish. A
# failure blocks the stop once (exit 2, the output goes back to Claude); if
# it still fails on the retry, the stop is allowed and the user sees the
# failure (exit 1). Without `just` on this machine it only warns.
set -uo pipefail

active="$(python3 -c 'import json, sys; print(json.load(sys.stdin).get("stop_hook_active", False))')"
cd "${CLAUDE_PROJECT_DIR:?}" || exit 1

if ! command -v just >/dev/null 2>&1; then
  echo "stop-gate: \`just\` is not installed on this machine, so \`just check\` did not run (HANDOVER.md → developer harness)." >&2
  exit 0
fi

fp="$(tools/dev/check-cache.sh fingerprint)" || exit 1
tools/dev/check-cache.sh is-green "$fp" && exit 0

log="$(mktemp "${TMPDIR:-/tmp}/check.XXXXXX")"
if tools/dev/check-cache.sh run "$log"; then
  rm -f "$log"
  exit 0
fi

{
  echo "\`just check\` fails on the current changes. Fix it before finishing (full log: $log):"
  tail -n 60 "$log"
} >&2
[[ "$active" == "True" ]] && exit 1
exit 2
