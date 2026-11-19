# apps/video-worker — ffmpeg transcoding (BullMQ).
#
# Two stages (performance plan D2): the builder installs the workspace,
# compiles, and assembles the runtime tree in /out
# (infra/docker/runtime-tree.sh: a production install filtered to the app, compiled workspace
# packages, no declarations, sources or maps); the runtime stage is Node,
# ffmpeg and /out — no Bun, no package cache, no dev dependencies.

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

# Bun (package.json `packageManager`) installs the workspace and runs the
# build; the tools themselves run on Node.
COPY --from=oven/bun:1.4.5-alpine /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Workspace manifests first, so a source change keeps the install layer.
# bunfig.toml carries `linker = "hoisted"` so
# packages/shared (which type-imports yjs without declaring it as its
# own dep) can resolve modules from the root node_modules.
# bunfig.toml carries the install settings (the hoisted linker), package.json
# the patches (patchedDependencies), which the install refuses to go without.
COPY bun.lock bunfig.toml package.json ./
COPY patches ./patches
# Every workspace these depend on, dev dependencies included (@narrative/perf
# and what it needs): Bun refuses a pruned workspace that misses one.
COPY apps/video-worker/package.json   apps/video-worker/package.json
COPY packages/shared/package.json     packages/shared/package.json
COPY packages/slide-model/package.json packages/slide-model/package.json
COPY packages/commands/package.json   packages/commands/package.json
COPY packages/perf/package.json       packages/perf/package.json

# Bun's package cache is a build cache, never a layer (pnpm's store doubled
# every image). --ignore-scripts: no lifecycle scripts of the workspace or its
# dependencies in the image build.
ENV BUN_INSTALL_CACHE_DIR=/bun-cache
RUN --mount=type=cache,id=narrative-bun-cache-musl,target=/bun-cache,sharing=locked \
  bun install --frozen-lockfile --ignore-scripts

COPY apps/video-worker/  apps/video-worker/
COPY packages/           packages/
COPY tsconfig.base.json  ./
COPY infra/docker/runtime-tree.sh /usr/local/bin/runtime-tree

# Compile TypeScript (dist/apps/video-worker/src/*.js, dist/packages/shared/src/*.js).
RUN bun run --cwd apps/video-worker build

RUN --mount=type=cache,id=narrative-bun-cache-musl,target=/bun-cache,sharing=locked \
  sh /usr/local/bin/runtime-tree video-worker /out

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:24-alpine

# ffmpeg — the only system dependency of the worker (alpine's build in the
# node:24-alpine base).
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY --from=builder /out ./

# Not root: ffmpeg's inputs and outputs go to TRANSCODE_TMP_DIR
# (/tmp/narrative-transcode by default), which any user may create.
USER node

CMD ["node", "apps/video-worker/dist/apps/video-worker/src/index.js"]

# Link this GHCR package to its source repo (auto-connects on push)
LABEL org.opencontainers.image.source=https://github.com/petronijus/Narrative
