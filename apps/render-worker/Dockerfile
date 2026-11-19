# apps/render-worker — headless Chromium on the real web app (agentic A3,
# docs/plans/a3-render-worker.md). Debian, not Alpine: Playwright's Chromium
# builds are glibc-only. Only the headless shell is installed (no full
# browser), with the system libraries and fonts Playwright lists for it.
#
# Two stages (performance plan D2): the builder installs the workspace,
# compiles, and assembles the runtime tree in /out
# (infra/docker/runtime-tree.sh: a production install filtered to the app, compiled workspace
# packages, no declarations, sources or maps); the runtime stage is Node,
# Chromium and /out — no Bun, no package cache, no dev dependencies.

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS builder

# Bun (package.json `packageManager`) installs the workspace and runs the
# build; the tools themselves run on Node.
COPY --from=oven/bun:1.4.5-debian /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# bunfig.toml carries the install settings (the hoisted linker), package.json
# the patches (patchedDependencies), which the install refuses to go without.
COPY bun.lock bunfig.toml package.json ./
COPY patches ./patches
# Every workspace these depend on, dev dependencies included (@narrative/perf
# and what it needs): Bun refuses a pruned workspace that misses one.
COPY apps/render-worker/package.json  apps/render-worker/package.json
COPY packages/shared/package.json     packages/shared/package.json
COPY packages/slide-model/package.json packages/slide-model/package.json
COPY packages/commands/package.json   packages/commands/package.json
COPY packages/perf/package.json       packages/perf/package.json

# Bun's package cache is a build cache, never a layer (pnpm's store doubled
# every image). --ignore-scripts: no lifecycle scripts of the workspace or its
# dependencies in the image build.
ENV BUN_INSTALL_CACHE_DIR=/bun-cache
RUN --mount=type=cache,id=narrative-bun-cache-glibc,target=/bun-cache,sharing=locked \
  bun install --frozen-lockfile --ignore-scripts

COPY apps/render-worker/  apps/render-worker/
COPY packages/            packages/
COPY tsconfig.base.json   ./
COPY infra/docker/runtime-tree.sh /usr/local/bin/runtime-tree

RUN bun run --cwd apps/render-worker build

RUN --mount=type=cache,id=narrative-bun-cache-glibc,target=/bun-cache,sharing=locked \
  sh /usr/local/bin/runtime-tree render-worker /out

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:24-bookworm-slim

# Chromium's headless shell at the revision this playwright-core expects, its
# system libraries and fonts (--with-deps runs apt), into a path every user
# can read. playwright-core has no dependencies, so its CLI runs from a copy
# of the package alone: this layer is rebuilt when Playwright changes, not
# with every dependency or source change.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=builder /out/node_modules/playwright-core /tmp/playwright-core
RUN node /tmp/playwright-core/cli.js install --with-deps --only-shell chromium \
  && rm -rf /var/lib/apt/lists/* /tmp/playwright-core

WORKDIR /app

COPY --from=builder /out ./

# Not root: Chromium's sandbox needs no privileges and the worker needs none.
USER node

CMD ["node", "apps/render-worker/dist/apps/render-worker/src/index.js"]

LABEL org.opencontainers.image.source=https://github.com/petronijus/Narrative
