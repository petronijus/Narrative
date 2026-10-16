#!/usr/bin/env bash
# Stop: when the code differs from every content that passed before, run the
# affected lane (`just check-affected`: formatting of the changed files, the
# docs check, and typecheck, lint and unit tests of the workspace packages
# the change reaches — tools/dev/check-affected.sh, through
# tools/dev/check-cache.sh, which records what passed and lets one run at a
# time) before Claude may finish. pre-push still runs the whole `just check`.
# A failure blocks the stop once (exit 2, the output goes back to Claude); if
# it still fails on the retry, the stop is allowed and the user sees the
# failure (exit 1). Without `just` on this machine it only warns.
#
# Skipped while background agents of this session are still working
# (`background_tasks` in the hook input: a subagent, teammate or workflow):
# their half-finished edits would fail the check and spend minutes of CPU on
# every turn. The turn in which the last of them reports back ends with an
# empty list, and the check runs then.
set -uo pipefail

read -r active busy < <(python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except ValueError:
    data = {}
tasks = data.get("background_tasks") or []
busy = sum(1 for t in tasks if isinstance(t, dict) and t.get("type") in ("subagent", "teammate", "workflow"))
print(data.get("stop_hook_active", False), busy)
')
cd "${CLAUDE_PROJECT_DIR:?}" || exit 1

[[ "${busy:-0}" -gt 0 ]] && exit 0

if ! command -v just >/dev/null 2>&1; then
  echo "stop-gate: \`just\` is not installed on this machine, so \`just check\` did not run (private/HANDOVER.md → developer harness)." >&2
  exit 0
fi

log="$(mktemp "${TMPDIR:-/tmp}/check.XXXXXX")"
if tools/dev/check-cache.sh run-affected "$log"; then
  rm -f "$log"
  exit 0
fi

{
  echo "The affected lane of \`just check\` fails on the current changes. Fix it before finishing (full log: $log):"
  tail -n 60 "$log"
} >&2
[[ "$active" == "True" ]] && exit 1
exit 2
