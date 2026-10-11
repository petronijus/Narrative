#!/usr/bin/env bash
# PreToolUse (Edit|Write|NotebookEdit|Bash): enforce what AGENTS.md can only ask for.
#   deny  key material written by an edit tool anywhere (its content would
#         come from the model), or by the shell inside the repo
#   deny  a shell command that prints key material (cat, grep, git diff, …),
#         which would put the secret into the conversation
#   deny  generated files and lockfiles in the repo
#   ask   files that must be changed with a tool, not by hand
# Piping a secret from 1Password into a file outside the repo for a command
# to consume (`op read … > "$tmp/key.p8"`) stays allowed: nothing is printed.
# tool_paths.py resolves which files a call writes or reads, including shell
# redirections, sed -i, tee, cp/mv, heredocs, wrappers (`sudo -u x cat …`) and
# recursive searches (`grep -r`, `rg`, `find -exec cat`); its docstring has the
# limits. If it fails, the call is denied: a guard that cannot read a command
# must not wave it through.
set -uo pipefail

root="${CLAUDE_PROJECT_DIR:?}"
input="$(cat)"

deny_json() {
  python3 -c 'import json, sys
print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
      "permissionDecision": sys.argv[1], "permissionDecisionReason": sys.argv[2]}}))' "$@"
}

if ! paths="$(printf '%s' "$input" | python3 "$(dirname "$0")/tool_paths.py" 2>/dev/null)"; then
  deny_json deny "guard-edits.sh could not parse this call (tool_paths.py failed); rephrase it."
  exit 0
fi

verdict="" reason=""
# The most restrictive answer wins: deny > ask.
decide() {
  [[ "$verdict" == deny || ("$verdict" == ask && "$1" == ask) ]] && return
  verdict="$1" reason="$2"
}

key_material() {
  case "$1" in
    *.example | *.example.* | *.sample | *.template | *.dist) return 1 ;; # committed templates
    # .env (dev) and infra/.env.prod come from SOPS (scripts/secrets-decrypt.sh);
    # age identities are the SOPS private key.
    .env | .env.* | *.p8 | *.pem | *.key | *.agekey | age-key*.txt | service-account*.json) return 0 ;;
  esac
  return 1
}

while IFS=$'\t' read -r kind path; do
  [[ -n "$path" ]] || continue
  rel="${path#"$root/"}"
  base="${rel##*/}"
  inside=false
  [[ "$path" == "$root/"* ]] && inside=true
  if key_material "$base"; then
    case "$kind" in
      E) decide deny "$rel holds key material. Secrets live in 1Password and SOPS and never pass through the model." ;;
      W) $inside && decide deny "$rel holds key material. Materialise it with \`scripts/secrets-decrypt.sh [dev|prod]\` (SOPS, key from 1Password); change it with \`scripts/secrets-edit.sh\`." ;;
      R) decide deny "$rel holds key material; printing it would put the secret into the conversation. Let the command that needs it read it (\`source\`, \`--env-file\`, \`op read\` piped into it). A recursive search reaches it too: use \`rg\` or \`git grep\` (they skip gitignored and hidden files) or name the paths you mean." ;;
    esac
    continue
  fi
  # Everything below guards the repo's own files against being written.
  if [[ "$kind" == R ]] || ! $inside; then continue; fi
  case "$base" in
    pnpm-lock.yaml | package-lock.json | *.lock)
      decide deny "$rel is a lockfile; change the package.json and let \`pnpm install\` rewrite it." ;;
  esac
  # Leading slash so top-level directories match too.
  case "/$rel" in
    */dist/* | */build/* | */node_modules/* | */test-results/* | */playwright-report/* | /apps/desktop/release/*)
      decide deny "$rel is generated; change its source instead." ;;
    /packages/commands/capabilities.json | /docs/capabilities.md)
      decide deny "$rel is generated from the command registry; run \`just capabilities\`." ;;
    /claude-plugin/narrative/skills/* | /claude-plugin/narrative/.claude-plugin/plugin.json)
      decide deny "$rel is generated from packages/commands/playbooks and the package version; edit those, then \`just capabilities\` (\`just bump\` for the version)." ;;
    /tests/agent-eval/recordings/*)
      decide deny "$rel is a recording of a live agent run; refresh it with \`just eval --filter <id> --record\`." ;;
    /apps/server/drizzle/*.sql)
      # Hand-written by design (apps/server/drizzle/README.md); a new file is
      # fine, but an applied migration must never change — prod tracks
      # migrations by the hash of their SQL.
      if [[ -f "$path" ]]; then
        decide ask "$rel is an existing database migration; an applied one must never change (apps/server/drizzle/README.md). Write a new migration instead."
      fi ;;
  esac
done <<<"$paths"

# Prints every variable of .env resolved into the compose file: the same
# secrets as `cat .env`, which tool_paths.py cannot see through.
shell_command="$(printf '%s' "$input" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("tool_input", {}).get("command", ""))' 2>/dev/null)"
if [[ "$shell_command" =~ docker[[:space:]-]+compose.*[[:space:]]config([[:space:]]|$) ]] &&
  ! [[ "$shell_command" =~ config[[:space:]]+--(services|images|volumes|profiles)([[:space:]]|$) ]]; then
  decide deny "\`docker compose config\` prints the resolved .env — key material. Inspect the compose files instead, or \`config --services\` / \`--images\`."
fi

[[ -n "$verdict" ]] || exit 0
deny_json "$verdict" "$reason"
