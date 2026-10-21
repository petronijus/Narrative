# apps/video-worker — ffmpeg transcoding (BullMQ).
#
# Two stages (performance plan D2): the builder installs the workspace,
# compiles, and assembles the runtime tree in /out
# (infra/docker/runtime-tree.sh: `pnpm deploy --prod`, compiled workspace
# packages, no declarations, sources or maps); the runtime stage is Node,
# ffmpeg and /out — no pnpm, no package store, no dev dependencies.

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@12.11.2 --activate

WORKDIR /app

# Workspace manifests first, so a source change keeps the install layer.
# pnpm-workspace.yaml carries `nodeLinker: hoisted` + `shamefullyHoist: true` so
# packages/shared (which type-imports yjs without declaring it as its
# own dep) can resolve modules from the root node_modules.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# pnpm-workspace.yaml names patches (patchedDependencies); install refuses without them
COPY patches ./patches
COPY apps/video-worker/package.json   apps/video-worker/package.json
COPY packages/shared/package.json     packages/shared/package.json

# The package store is a build cache, never a layer (it doubled every image).
# --ignore-scripts: no lifecycle scripts of the workspace or its dependencies in the image build.
ENV PNPM_STORE=/pnpm/store
RUN --mount=type=cache,id=narrative-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm install --frozen-lockfile --ignore-scripts --store-dir "$PNPM_STORE"

COPY apps/video-worker/  apps/video-worker/
COPY packages/           packages/
COPY tsconfig.base.json  ./
COPY infra/docker/runtime-tree.sh /usr/local/bin/runtime-tree

# Compile TypeScript (dist/apps/video-worker/src/*.js, dist/packages/shared/src/*.js).
RUN pnpm --filter @narrative/video-worker build

RUN --mount=type=cache,id=narrative-pnpm-store,target=/pnpm/store,sharing=locked \
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
