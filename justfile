# Narrative task runner — https://just.systems. `just` lists the recipes.
# The fast lane (`just check`, ~1 min) is what the pre-push hook and the
# Claude Code Stop hook run; `just ci` is the full gate. There is no hosted
# CI: these recipes are the CI, run on the Linux desktop, the MacBook or the
# Omarchy desktop. The recipes only wrap the pnpm scripts in package.json and
# the per-package scripts, adding what each machine needs to run them (the
# tsx loader, the browser for Playwright), so there is one way to run each.

set shell := ["bash", "-euo", "pipefail", "-c"]
# Recipe arguments reach the commands as "$@", quoted as given
# (`just e2e -g "three clients converge"` stays one argument).
set positional-arguments

# Node builds without type stripping (Ubuntu 26.04's) load the TypeScript
# parity table in the ESLint config through tsx (SETUP.md → Troubleshooting).
# Only ESLint gets it: the loader breaks the one-door lint test under vitest.
node_ts := `node -p 'process.features.typescript ?? false' 2>/dev/null || echo false`
eslint_node_options := if node_ts == "false" { "--import=tsx" } else { "" }

# List the recipes
default:
    @just --list --unsorted

# ── setup ────────────────────────────────────────────────────────────────

# One-time setup of a clone on a new machine (idempotent)
setup:
    pnpm install
    # husky (until 2026-09-30) pointed git at .husky/_; lefthook installs into .git/hooks.
    if [[ "$(git config --get core.hooksPath || true)" == .husky* ]]; then git config --unset core.hooksPath; fi
    lefthook install
    tools/dev/doctor.sh

# Check this machine against the pinned toolchain
doctor:
    tools/dev/doctor.sh

# ── fast lane (~1 min, no dev stack) ─────────────────────────────────────

# Formatting, types, lint, every unit test (contract, parity, eval replays) and the capability manifest
check: fmt-check typecheck lint test capabilities-check

# Format every file in place (ESLint --fix + Prettier; tools/dev/format.sh)
fmt:
    tools/dev/format.sh --all

# Fail if any file is not formatted
fmt-check:
    tools/dev/format.sh --check --all

# TypeScript in every package
typecheck:
    pnpm -r typecheck

# ESLint in every package (incl. the one-door rule)
lint:
    NODE_OPTIONS="{{ eslint_node_options }}" pnpm -r lint

# Unit tests; `just test server web` (workspace filters) for some packages
test *filters:
    #!/usr/bin/env bash
    set -euo pipefail
    if (($# == 0)); then exec pnpm -r test; fi
    args=()
    for f in "$@"; do args+=(--filter "$f"); done
    exec pnpm "${args[@]}" test

# Fail if the capability manifest or the plugin is stale (fix: `just capabilities`)
capabilities-check:
    pnpm --filter @narrative/commands capabilities --check
    pnpm --filter @narrative/commands skill --check

# ── full gate ────────────────────────────────────────────────────────────

# Everything that needs no paid service: fast lane, stores against Postgres, e2e (needs `just dev`).
# `size`, `eval`, `load`, `lighthouse` run when a change calls for them (AGENTS.md → When to run what).
ci: check integration e2e

# Drizzle stores and migrations against the dev Postgres (writes rows there)
integration: _services
    pnpm --filter server test:integration

# Playwright against the running dev stack; args go to Playwright (`just e2e -g "folder-tokens"`)
e2e *args: _stack
    #!/usr/bin/env bash
    set -euo pipefail
    eval "$(tools/dev/playwright-env.sh)"
    exec pnpm --filter web test:e2e "$@"

# Bundle budgets (size-limit)
size:
    pnpm size

# Agent eval: headless Claude Code against the dev stack — costs subscription usage (`--filter`, `--record`, `--keep`)
eval *args: _stack
    #!/usr/bin/env bash
    set -euo pipefail
    eval "$(tools/dev/playwright-env.sh)"
    exec pnpm agent:eval "$@"

# Load tests; compares with tests/load/baselines.json
load:
    pnpm load:all

# Core Web Vitals of the built preview
lighthouse:
    pnpm lighthouse

# Stryker mutation run on slide-model (slow; AGENTS.md has its state)
mutate:
    pnpm --filter @narrative/slide-model mutate

# PowerPoint round trip of a real deck (target: 0 differences); the path is relative to where you run just
pptx-roundtrip deck:
    cd apps/server && npx tsx src/scripts/pptxRoundtrip.ts "{{ absolute_path(invocation_directory() / deck) }}"

# ── everyday ─────────────────────────────────────────────────────────────

# Web :5173 + server :3001 (WebSocket :3002) + video worker (the docker services must be up: `just services`)
dev: _services
    pnpm dev

# The dev stack without the video worker (faster start)
dev-lite: _services
    pnpm dev:no-worker

# Start the docker services the dev stack needs (Postgres, MinIO + its bucket, imgproxy, Redis)
services:
    #!/usr/bin/env bash
    set -euo pipefail
    cd infra
    docker compose --env-file ../.env up -d --wait postgres minio imgproxy media-redis
    # minio-init creates the bucket. MinIO's images can no longer be pulled
    # (Docker Hub and quay deny them, 2026-09); where the pinned client image
    # is missing, any minio/mc image already on this machine does the same job.
    mc_image="$(docker compose --env-file ../.env config --images minio-init)"
    if docker image inspect "$mc_image" >/dev/null 2>&1; then
      docker compose --env-file ../.env up minio-init --no-log-prefix | tail -n 1
      exit 0
    fi
    fallback="$(docker images --format '{{{{.Repository}}:{{{{.Tag}}' 'minio/mc' | head -n 1)"
    if [[ -z "$fallback" ]]; then
      echo "services: no MinIO client image here ($mc_image cannot be pulled); create the bucket narrative-media by hand (SETUP.md → Troubleshooting)" >&2
      exit 1
    fi
    docker run --rm --network host --env-file ../.env --entrypoint sh "$fallback" -c \
      'MC_HOST_local="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@127.0.0.1:${MINIO_API_PORT:-9100}" mc mb --ignore-existing local/narrative-media'

# Regenerate the capability manifest and the Claude Code plugin after a command change
capabilities:
    pnpm capabilities
    pnpm --filter @narrative/commands skill

# Set every workspace version (and the plugin's) for a release: `just bump 0.10.15`
bump version:
    #!/usr/bin/env bash
    set -euo pipefail
    [[ "{{ version }}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "bump: want X.Y.Z, got {{ version }}" >&2; exit 1; }
    for f in package.json apps/*/package.json packages/*/package.json; do
      node -e 'const fs=require("fs"),f=process.argv[1],p=JSON.parse(fs.readFileSync(f));p.version=process.argv[2];fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")' "$f" "{{ version }}"
    done
    pnpm --filter @narrative/commands skill
    echo "Versions set to {{ version }}. Next: CHANGELOG section, commit, tag v{{ version }}, push, just deploy v{{ version }} (docs/deploy.md)."

# Host: the `narrative` ssh alias, or NARRATIVE_SSH=<user@host>; Claude Code asks before running it.
# Release a pushed tag to production: images to GHCR, the tagged tree to the VM, deploy, verify (docs/deploy.md)
deploy tag:
    #!/usr/bin/env bash
    set -euo pipefail
    tag="$1" host="${NARRATIVE_SSH:-narrative}"
    [[ "$(git describe --exact-match --tags HEAD 2>/dev/null)" == "$tag" ]] ||
      { echo "deploy: HEAD is not tagged $tag — commit, tag and push the release first" >&2; exit 1; }
    [[ -z "$(git status --porcelain --untracked-files=no)" ]] ||
      { echo "deploy: tracked files have uncommitted changes; the images are built from this tree" >&2; exit 1; }
    git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null ||
      { echo "deploy: $tag is not on origin — push it first (git push origin main $tag)" >&2; exit 1; }
    NARRATIVE_TAG="$tag" infra/scripts/build-push.sh
    # The VM gets the tagged tree itself, never the working directory (gitignored
    # local files — fixtures, the private overlay — must not travel). --delete
    # spares what lives only on the VM: its env files and the backups.
    tree="$(mktemp -d "${TMPDIR:-/tmp}/narrative-deploy.XXXXXX")"
    trap 'rm -rf "$tree"' EXIT
    git archive "$tag" | tar -x -C "$tree"
    rsync -az --delete --exclude /.env --exclude infra/.env.prod --exclude backups/ "$tree/" "$host:/opt/narrative/"
    ssh "$host" "chmod +x /opt/narrative/infra/scripts/*.sh && cd /opt/narrative && USE_SHARED_TUNNEL=1 NARRATIVE_TAG=$tag ./infra/scripts/deploy.sh prod"
    served="$(curl -fsS https://narrative.bastla.com/version.json)"
    echo "$served"
    [[ "$served" == *"\"$tag+"* ]] || { echo "deploy: production does not serve $tag" >&2; exit 1; }

# ── guards (private; fail with the fix) ──────────────────────────────────

# Postgres reachable where .env points (POSTGRES_URL), whichever compose project started it
_services:
    #!/usr/bin/env bash
    url="$(grep -E '^POSTGRES_URL=' .env 2>/dev/null | cut -d= -f2- || true)"
    hostport="${url##*@}"; hostport="${hostport%%/*}"
    host="${hostport%%:*}"; port="${hostport##*:}"
    [[ "$hostport" == *:* ]] || port=5432
    if ! (exec 3<>"/dev/tcp/${host:-127.0.0.1}/${port:-5432}") 2>/dev/null; then
      echo "Postgres is not reachable at ${host:-127.0.0.1}:${port:-5432}: just services" >&2; exit 1
    fi

_stack:
    @curl -sf -o /dev/null http://localhost:3001/health && curl -sf -o /dev/null http://localhost:5173 || { echo "the dev stack is not running: just dev (in another terminal)" >&2; exit 1; }
