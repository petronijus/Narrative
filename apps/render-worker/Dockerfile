# apps/render-worker — headless Chromium on the real web app (agentic A3,
# docs/plans/a3-render-worker.md). Debian, not Alpine: Playwright's Chromium
# builds are glibc-only. Only the headless shell is installed (no full
# browser), with the system libraries and fonts Playwright lists for it.
#
# Two stages (performance plan D2): the builder installs the workspace,
# compiles, and assembles the runtime tree in /out
# (infra/docker/runtime-tree.sh: `pnpm deploy --prod`, compiled workspace
# packages, no declarations, sources or maps); the runtime stage is Node,
# Chromium and /out — no pnpm, no package store, no dev dependencies.

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS builder

RUN corepack enable && corepack prepare pnpm@12.11.2 --activate

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# pnpm-workspace.yaml names patches (patchedDependencies); install refuses without them
COPY patches ./patches
COPY apps/render-worker/package.json  apps/render-worker/package.json
COPY packages/shared/package.json     packages/shared/package.json

# The package store is a build cache, never a layer (it doubled every image).
# --ignore-scripts: no lifecycle scripts of the workspace or its dependencies in the image build.
ENV PNPM_STORE=/pnpm/store
RUN --mount=type=cache,id=narrative-pnpm-store-glibc,target=/pnpm/store,sharing=locked \
  pnpm install --frozen-lockfile --ignore-scripts --store-dir "$PNPM_STORE"

COPY apps/render-worker/  apps/render-worker/
COPY packages/            packages/
COPY tsconfig.base.json   ./
COPY infra/docker/runtime-tree.sh /usr/local/bin/runtime-tree

RUN pnpm --filter @narrative/render-worker build

RUN --mount=type=cache,id=narrative-pnpm-store-glibc,target=/pnpm/store,sharing=locked \
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
