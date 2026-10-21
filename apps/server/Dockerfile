# apps/server — Fastify API, Hocuspocus, the MCP server.
#
# Two stages (performance plan D2): the builder installs the workspace,
# compiles, and assembles the runtime tree in /out
# (infra/docker/runtime-tree.sh: `pnpm deploy --prod`, the workspace packages
# as compiled JavaScript, no declarations, sources or maps); the runtime
# stage is Node and /out plus the migrations — no pnpm, no package store, no
# dev dependencies.

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@12.11.2 --activate

WORKDIR /app

# Workspace manifests first, so a source change keeps the install layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# pnpm-workspace.yaml names patches (patchedDependencies); install refuses without them
COPY patches ./patches
COPY apps/server/package.json            apps/server/package.json
COPY packages/shared/package.json        packages/shared/package.json
COPY packages/slide-model/package.json   packages/slide-model/package.json
COPY packages/commands/package.json      packages/commands/package.json

# The package store is a build cache, never a layer (it doubled every image).
# --ignore-scripts: no lifecycle scripts of the workspace or its dependencies in the image build
ENV PNPM_STORE=/pnpm/store
RUN --mount=type=cache,id=narrative-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm install --frozen-lockfile --ignore-scripts --store-dir "$PNPM_STORE"

COPY apps/server/   apps/server/
COPY packages/      packages/
COPY tsconfig.base.json ./
COPY infra/docker/runtime-tree.sh /usr/local/bin/runtime-tree

# tsc peaks at ~1.3 GB for the server: a small build machine (Docker
# Desktop's default 2 GB VM) passes --build-arg NODE_OPTIONS=--max-old-space-size=1536.
ARG NODE_OPTIONS
# tsc emits with workspace-root rootDir (cross-package imports pull files from
# outside apps/server): dist/apps/server/src/*.js and dist/packages/<pkg>/src/*.js.
RUN pnpm --filter @narrative/server build

# /out: apps/server/{package.json,dist} and node_modules with the production
# dependencies; @narrative/{shared,slide-model,commands} compiled, the
# commands package with its playbooks (Markdown the MCP server serves; the
# compiled loader reads them from ../../playbooks).
RUN --mount=type=cache,id=narrative-pnpm-store,target=/pnpm/store,sharing=locked \
  sh /usr/local/bin/runtime-tree server /out

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:24-alpine AS runtime

WORKDIR /app

COPY --from=builder /out ./

# Drizzle migration files (migrate.js runs them before every deploy).
# Compiled migrate.js sits at dist/apps/server/src/db/migrate.js and resolves
# migrationsFolder as `path.resolve(__dirname, '../../drizzle')` =
# dist/apps/server/drizzle/ — so we mirror the source layout under dist/.
COPY --from=builder /app/apps/server/drizzle apps/server/drizzle/
COPY --from=builder /app/apps/server/drizzle apps/server/dist/apps/server/drizzle/

# SVG uploads load jsdom and DOMPurify on their first use, not at start
# (media/svgSanitize.ts, performance plan D3), so a start would not notice
# them missing: sanitize one SVG here, and an image that cannot fails its
# build instead of a user's upload.
RUN node --input-type=module -e "\
  const { sanitizeSvg } = await import('./apps/server/dist/apps/server/src/media/svgSanitize.js'); \
  const out = sanitizeSvg(Buffer.from('<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"x()\"><script>x()</script><rect width=\"1\" height=\"1\"/></svg>')); \
  if (out === null || /script|onload/i.test(out.toString()) || !/<rect/.test(out.toString())) { console.error('SVG sanitizer check failed:', String(out)); process.exit(1) } \
  console.log('SVG sanitizer check ok')"

# Not root: the server writes only to the system temp directory (URL
# downloads, PPTX work files) and reads everything else.
USER node

EXPOSE 3001 3002

# Healthcheck pro docker compose
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "apps/server/dist/apps/server/src/index.js"]

# Link this GHCR package to its source repo (auto-connects on push)
LABEL org.opencontainers.image.source=https://github.com/petronijus/Narrative
