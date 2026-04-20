# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace manifests first to maximise Docker layer cache hits.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/video-worker/package.json   apps/video-worker/package.json
COPY packages/shared/package.json     packages/shared/package.json

# --ignore-scripts skips "prepare: husky" in root package.json.
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy source
COPY apps/video-worker/  apps/video-worker/
COPY packages/           packages/
COPY tsconfig.base.json  ./

# Compile TypeScript
RUN pnpm --filter @narrative/video-worker build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine

# ffmpeg (~80 MB) — the only system dep needed by the worker.
# Pinned to whatever alpine:3.x provides in the node:22-alpine base.
RUN apk add --no-cache ffmpeg

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace manifests for prod install
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/video-worker/package.json   apps/video-worker/package.json
COPY packages/shared/package.json     packages/shared/package.json

# Production deps only
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# Compiled output from builder. The TS compile emits:
#   dist/apps/video-worker/src/*.js
#   dist/packages/shared/src/*.js
# baseUrl spans the repo root so @narrative/shared can resolve.
COPY --from=builder /app/apps/video-worker/dist   apps/video-worker/dist/

# Compiled shared JS replaces the TS source for runtime resolution.
# The symlink created by pnpm install points packages/shared → here.
COPY --from=builder /app/packages/shared/package.json   packages/shared/package.json
COPY --from=builder /app/apps/video-worker/dist/packages/shared/src   packages/shared/src/

# Retarget shared's main/exports to the compiled .js entry.
RUN sed -i 's|./src/index.ts|./src/index.js|g' packages/shared/package.json

CMD ["node", "apps/video-worker/dist/apps/video-worker/src/index.js"]
