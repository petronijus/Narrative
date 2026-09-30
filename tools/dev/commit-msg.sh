#!/usr/bin/env bash
# commit-msg hook: Conventional Commits (https://www.conventionalcommits.org).
#   type(scope)!: summary     e.g. `feat(agentic): A2.12a — folder tokens on the server`
# No length limit: this repo's release subjects are long by habit.
# `autosync(<branch>): <host> <time>` is the ai-config project autosync
# (scripts/project-sync.sh), which commits the working tree with hooks on.
set -euo pipefail

subject="$(head -n1 "$1")"
types="feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert"

if [[ "$subject" =~ ^(Merge|merge|Revert|fixup!|squash!|amend!|autosync\() ]]; then exit 0; fi
if [[ "$subject" =~ ^($types)(\([a-z0-9,/._-]+\))?!?:\ .+ ]]; then exit 0; fi

cat >&2 <<MSG
commit-msg: "$subject"
is not a Conventional Commit. Use  type(scope)!: summary
  types:  ${types//|/, }
  scopes: the area touched, e.g. agentic, pptx, editor, renderer, server, infra, release (optional)
MSG
exit 1
