#!/usr/bin/env bash
# The affected lane: `just check` narrowed to what changed between two
# trees — the Claude Code Stop hook's check (through tools/dev/check-cache.sh
# run-affected, which passes the last tree that passed and the working tree).
#
#   check-affected.sh <base-tree> <tree>
#
# - formatting: the changed files only;
# - typecheck, lint, unit tests: the workspace packages a changed file
#   belongs to and every package that depends on them (pnpm `...{dir}`);
# - the docs check: always (seconds);
# - the capability manifest and the plugin: when a package under packages/,
#   the playbooks, the plugin or the eval scenarios changed.
#
# Anything no package owns — the justfile, tools/, root config, the
# lockfile, infra/, a directory that is not a workspace package — runs the
# whole `just check`: those reach every package. Docs and agent briefs are
# covered by formatting and the docs check. pre-push still runs the whole
# lane once per push (check-cache.sh `run`). bash 3.2 compatible.
set -uo pipefail

if (($# != 2)); then
  echo "usage: $0 <base-tree> <tree>" >&2
  exit 64
fi
base="$1" tree="$2"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$root" || exit 1

if ! changed="$(git diff --name-only --no-renames "$base" "$tree")"; then
  echo "check-affected: cannot diff $base..$tree; running \`just check\`"
  exec just check
fi
if [[ -z "$changed" ]]; then
  echo "check-affected: nothing changed since the last tree that passed"
  exit 0
fi

full="" dirs=() files=() manifest=""
add_dir() {
  local d
  for d in "${dirs[@]+"${dirs[@]}"}"; do [[ "$d" == "$1" ]] && return; done
  dirs+=("$1")
}

while IFS= read -r f; do
  [[ -e "$f" ]] && files+=("$f")
  case "$f" in
    apps/*/* | packages/*/*)
      dir="$(echo "$f" | cut -d/ -f1-2)"
      if [[ ! -f "$dir/package.json" ]]; then
        full="$f"
        break
      fi
      add_dir "$dir"
      [[ "$dir" == packages/* ]] && manifest=1
      # The perf coverage guard reads the action catalog by path (an app is
      # not a dependency of a package, so pnpm's dependents miss it).
      [[ "$f" == apps/web/src/actions/catalog.ts ]] && add_dir packages/perf
      ;;
    # The committed counter budgets are checked by the perf package's tests.
    perf/budgets/*) add_dir packages/perf ;;
    # The eval recordings are replayed by the commands package's tests.
    tests/agent-eval/*)
      add_dir packages/commands
      manifest=1
      ;;
    claude-plugin/*) manifest=1 ;;
    docs/* | *.md | .claude/agents/* | .claude/rules/* | .claude/skills/*) ;;
    *)
      full="$f"
      break
      ;;
  esac
done <<<"$changed"

if [[ -n "$full" ]]; then
  echo "check-affected: $full is shared by every package; running \`just check\`"
  exec just check
fi

echo "check-affected: $(echo "$changed" | wc -l | tr -d ' ') changed file(s) since ${base:0:12}"
if ((${#files[@]} > 0)); then
  tools/dev/format.sh --check "${files[@]}" || exit 1
fi

recipes=(lint-docs)
if ((${#dirs[@]} > 0)); then
  filters=""
  for d in "${dirs[@]}"; do filters+=" ...{./$d}"; done
  echo "check-affected: packages ${dirs[*]} and their dependents"
  recipes+=("typecheck$filters" "lint$filters" "test$filters")
fi
[[ -n "$manifest" ]] && recipes+=(capabilities-check)
exec tools/dev/run-parallel.sh "${recipes[@]}"
