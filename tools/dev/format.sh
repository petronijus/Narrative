#!/usr/bin/env bash
# Format (or, with --check, verify) files by type. The single formatter entry
# point for `just fmt`, the lefthook pre-commit hook and the Claude Code
# PostToolUse hook, so all three agree.
#
#   tools/dev/format.sh [--check] <file>...
#   tools/dev/format.sh [--check] --all
#   tools/dev/format.sh --edit <file>...   (the Claude Code hook, after every edit)
#
# TypeScript: `eslint --fix` then Prettier (what lint-staged did before
# 2026-09-30). --edit runs Prettier only: ESLint costs ~5 s per call, and an
# edit hook runs after every edit; `just check` (the Stop hook and pre-push)
# still lints everything. Other files Prettier handles: Prettier only.
#
# ESLint needs Node's TypeScript loader for its config
# (packages/commands/src/parity/slideModelExports.ts): Node builds without
# type stripping (Ubuntu 26.04's) get it through tsx.
#
# Exit 1 when --check finds unformatted files or ESLint reports an error it
# cannot fix. Plain bash 3.2 (macOS /bin/bash) compatible.
set -uo pipefail

root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$root" || exit 1

check=false mid_edit=false
case "${1:-}" in
  --check) check=true; shift ;;
  --edit) mid_edit=true; shift ;;
esac

globs=('*.ts' '*.tsx' '*.js' '*.cjs' '*.mjs' '*.json' '*.md' '*.yaml' '*.yml')
files=()
if [[ "${1:-}" == "--all" ]]; then
  while IFS= read -r f; do files+=("$f"); done < <(git ls-files --cached --others --exclude-standard "${globs[@]}")
else
  files=("$@")
fi

script=() prettier=()
for f in ${files[@]+"${files[@]}"}; do
  [[ -f "$f" ]] || continue
  case "$f" in
    pnpm-lock.yaml | */dist/* | */node_modules/* | private/*) ;; # generated / not ours
    *.ts | *.tsx) script+=("$f"); prettier+=("$f") ;;
    *.js | *.cjs | *.mjs | *.json | *.md | *.yaml | *.yml) prettier+=("$f") ;;
  esac
done

status=0
run() { "$@" || status=1; }

if [[ ! -x node_modules/.bin/prettier ]]; then
  echo "format.sh: node_modules missing — run \`just setup\`" >&2
  exit 1
fi

if ((${#script[@]})) && ! $check && ! $mid_edit; then
  if [[ "$(node -p 'process.features.typescript ?? false' 2>/dev/null)" == false ]]; then
    export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import=tsx"
  fi
  run node_modules/.bin/eslint --fix --quiet --no-warn-ignored "${script[@]}"
fi

if ((${#prettier[@]})); then
  if $check; then run node_modules/.bin/prettier --check --cache --log-level warn "${prettier[@]}"
  else run node_modules/.bin/prettier --write --cache --log-level warn "${prettier[@]}"; fi
fi

exit $status
