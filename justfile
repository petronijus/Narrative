# Narrative task runner — https://just.systems. `just` lists the recipes.
# The fast lane (`just check`, ~40 s) is what the pre-push hook and the
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

# ── fast lane (~40 s, no dev stack) ────────────────────────────────────

# Formatting, types, lint, the docs check, every unit test (contract, parity, eval replays) and the capability manifest;
# formatting first (seconds, the commonest failure), then the rest side by side (tools/dev/run-parallel.sh)
check: fmt-check
    tools/dev/run-parallel.sh typecheck lint lint-docs test capabilities-check

# Format every file in place (ESLint --fix + Prettier; tools/dev/format.sh)
fmt:
    tools/dev/format.sh --all

# Fail if any file is not formatted
fmt-check:
    tools/dev/format.sh --check --all

# TypeScript in every package; `just typecheck web` (workspace filters) for some
typecheck *filters:
    #!/usr/bin/env bash
    set -euo pipefail
    if (($# == 0)); then exec pnpm -r --no-sort typecheck; fi
    args=()
    for f in "$@"; do args+=(--filter "$f"); done
    exec pnpm "${args[@]}" --no-sort typecheck

# ESLint in every package (incl. the one-door rule); `just lint web` (workspace filters) for some
lint *filters:
    #!/usr/bin/env bash
    set -euo pipefail
    export NODE_OPTIONS="{{ eslint_node_options }}"
    if (($# == 0)); then exec pnpm -r --no-sort lint; fi
    args=()
    for f in "$@"; do args+=(--filter "$f"); done
    exec pnpm "${args[@]}" --no-sort lint

# The fast lane narrowed to what changed since the last content that passed (what the Claude Code Stop hook runs;
# tools/dev/check-affected.sh); pre-push still runs `just check`
check-affected:
    tools/dev/check-cache.sh run-affected

# Docs name only recipes, files, headings and imports that exist; the e2e map names only specs that exist
lint-docs:
    tools/dev/docs-check.py
    tools/dev/e2e-affected.py --check

# Unit tests; `just test server web` (workspace filters) for some packages
test *filters:
    #!/usr/bin/env bash
    set -euo pipefail
    # Worker budget: pnpm runs up to four packages at once and each vitest
    # would start a worker per core, so the tests asked for four times the
    # machine; beside tsc and ESLint in `just check` that timed out tests on
    # the 12-thread MacBook (load 85, 2026-10-07). Each vitest gets its share
    # of the cores instead; an explicit VITEST_MAX_WORKERS wins.
    concurrency=4
    if (($# > 0 && $# < concurrency)); then concurrency=$#; fi
    cores=$(node -p 'require("os").availableParallelism()')
    export VITEST_MAX_WORKERS="${VITEST_MAX_WORKERS:-$((cores / concurrency > 1 ? cores / concurrency : 1))}"
    # --no-sort: the packages' tests read each other's sources, not builds, so none waits for another
    if (($# == 0)); then exec pnpm -r --no-sort --workspace-concurrency="$concurrency" test; fi
    args=()
    for f in "$@"; do args+=(--filter "$f"); done
    exec pnpm "${args[@]}" --workspace-concurrency="$concurrency" test

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

# The e2e specs in WebKit — Safari's and macOS WKWebView's engine, what a Tauri shell would draw with (`just e2e-webkit -g "x"`).
# macOS runs Playwright's WebKit natively (`pnpm exec playwright install webkit` once); Linux runs it in Playwright's
# own image, whose Ubuntu has the libraries that WebKit build needs, against the dev stack on the host.
e2e-webkit *args: _stack
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ "$(uname)" == Darwin ]]; then
      PW_WEBKIT=1 exec pnpm --filter web test:e2e --project=webkit "$@"
    fi
    version="$(node -p "require('./node_modules/@playwright/test/package.json').version")"
    exec docker run --rm --network host --ipc host --user "$(id -u):$(id -g)" \
      -e HOME=/tmp -e PW_WEBKIT=1 -e CI= -v "$PWD:$PWD" -w "$PWD/apps/web" \
      "mcr.microsoft.com/playwright:v$version-noble" \
      node ../../node_modules/@playwright/test/cli.js test --project=webkit "$@"

# The smoke set: does the app boot, paint and present at all (~10 s; tools/dev/e2e-affected.py SMOKE)
e2e-smoke *args:
    tools/dev/e2e-affected.py --smoke {{ args }}

# The e2e specs the current change needs (tools/dev/e2e-affected.py: `--base REF`, `--list`; other args go to Playwright)
e2e-affected *args:
    tools/dev/e2e-affected.py {{ args }}

# The dev `.env` sets NODE_ENV=development, which Vite would otherwise build
# with (React's development bundle, ~75 kB more first paint).
# Bundle budgets (size-limit) on a production build
size:
    NODE_ENV=production pnpm size

# Agent eval: headless Claude Code against the dev stack — costs subscription usage (`--filter`, `--record`, `--keep`)
eval *args: _stack
    #!/usr/bin/env bash
    set -euo pipefail
    eval "$(tools/dev/playwright-env.sh)"
    exec pnpm agent:eval "$@"

# Load tests; warns on drift from tests/load/baselines.json when that local file exists
load:
    pnpm load:all

# Core Web Vitals of the built preview
lighthouse:
    pnpm lighthouse

# Stryker mutation run on slide-model (slow; AGENTS.md has its state)
mutate:
    pnpm --filter @narrative/slide-model mutate

# PowerPoint round trip of a real deck (target: 0 differences); the path is absolute or relative to where you run just
pptx-roundtrip deck:
    cd apps/server && npx tsx src/scripts/pptxRoundtrip.ts "{{ absolute_path(join(invocation_directory(), deck)) }}"

# A brand's style pack (or all), built from its sources by the brands the private overlay defines (private/bootstrap), written to private/packs (A4.7)
style-pack brand="all" sources="":
    cd apps/server && npx tsx src/stylePacks/bootstrap/cli.ts {{ brand }} "{{ sources }}"

# Put a bootstrapped pack into a folder through the command API (NARRATIVE_TOKEN: a personal access token, scope api); api defaults to the dev stack
style-pack-import pack folder api="":
    cd apps/server && npx tsx src/stylePacks/bootstrap/importPack.ts "{{ absolute_path(join(invocation_directory(), pack)) }}" {{ folder }} "{{ api }}"

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
    # minio pulls from a private GHCR mirror (docs/storage.md → MinIO image);
    # minio-perms runs before it on its own (depends_on).
    if ! docker compose --env-file ../.env up -d --wait postgres minio imgproxy media-redis; then
      echo "services: if the MinIO image failed to pull, log in once: docker login ghcr.io -u petronijus (a token with read:packages)" >&2
      exit 1
    fi
    # minio-init creates the bucket; `up` reports success whatever the job's exit code.
    docker compose --env-file ../.env up minio-init --no-log-prefix | tail -n 1
    code="$(docker inspect --format '{{{{.State.ExitCode}}' narrative-minio-init)"
    [[ "$code" == 0 ]] || { echo "services: minio-init exited $code (docker compose logs minio-init)" >&2; exit 1; }

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
    # The README's release badge (perl: the same in-place edit on GNU and BSD).
    perl -pi -e 's#(img\.shields\.io/badge/release-)\d+\.\d+\.\d+#${1}{{ version }}#' README.md
    grep -q "badge/release-{{ version }}-" README.md || { echo "bump: the README release badge was not updated" >&2; exit 1; }
    echo "Versions set to {{ version }}. Next: CHANGELOG section, commit, tag v{{ version }}, push, just gh-release v{{ version }}, just deploy v{{ version }} (docs/deploy.md)."

# GitHub release for a pushed tag, titled and described by its CHANGELOG.md section (edits it if it exists)
gh-release tag:
    #!/usr/bin/env bash
    set -euo pipefail
    title="$(tools/dev/release-notes.py {{ tag }} --title)"
    notes="$(tools/dev/release-notes.py {{ tag }})"
    if gh release view {{ tag }} >/dev/null 2>&1; then
      gh release edit {{ tag }} --title "$title" --notes "$notes"
    else
      gh release create {{ tag }} --verify-tag --title "$title" --notes "$notes"
    fi

# The build host (infra/release.env) fetches the tag, builds, pushes and deploys; this machine only checks
# and orders, so its uplink, CPU and env files do not matter. Claude Code asks before running it.
# Release a pushed tag to production: images to GHCR, the tagged tree to the VM, deploy, verify (docs/deploy.md)
deploy tag:
    infra/scripts/ship.sh "$1"

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
