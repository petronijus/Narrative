# ── Stage 1: builder ─────────────────────────────────────────────────────────
# Instaluje všechny deps (incl. devDeps) a kompiluje TypeScript → dist/
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Kopírujeme workspace manifesty (využití Docker layer cache)
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json            apps/server/package.json
COPY packages/shared/package.json        packages/shared/package.json
COPY packages/slide-model/package.json   packages/slide-model/package.json
COPY packages/animation/package.json     packages/animation/package.json
COPY packages/ui/package.json            packages/ui/package.json

# --ignore-scripts přeskočí "prepare: husky" v root package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

# Kopírujeme zdrojové kódy
COPY apps/server/   apps/server/
COPY packages/      packages/
COPY tsconfig.base.json ./

# Build (tsc emit do apps/server/dist/)
RUN pnpm --filter @narrative/server build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
# Minimální image — node_modules z builderu (prod-only deps via prune), dist, drizzle
FROM node:22-alpine AS runtime

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Zkopírujeme workspace manifesty
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json            apps/server/package.json
COPY packages/shared/package.json        packages/shared/package.json
COPY packages/slide-model/package.json   packages/slide-model/package.json
COPY packages/animation/package.json     packages/animation/package.json
COPY packages/ui/package.json            packages/ui/package.json

# Instalace jen prod deps, bez lifecycle scripts (husky není potřeba v runtime)
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# Zkompilovaný server
COPY --from=builder /app/apps/server/dist  apps/server/dist/

# Drizzle migration soubory (potřeba pro migrate.js v runtime).
# Compiled migrate.js sits at dist/apps/server/src/db/migrate.js and resolves
# migrationsFolder as `path.resolve(__dirname, '../../drizzle')` =
# dist/apps/server/drizzle/ — so we mirror the source layout under dist/.
COPY --from=builder /app/apps/server/drizzle apps/server/drizzle/
COPY --from=builder /app/apps/server/drizzle apps/server/dist/apps/server/drizzle/

# Workspace packages: pnpm install symlinks node_modules/@narrative/*
# at packages/<pkg>/, where package.json says `main: ./src/index.ts`. The
# runtime Node can't load .ts, so we replace the TS sources with compiled JS
# (emitted by the server's tsc into dist/packages/<pkg>/src/*.js) and rewrite
# the package.json main/exports to point at .js. Mirrors the video-worker
# Dockerfile pattern at apps/video-worker/Dockerfile.
COPY --from=builder /app/packages/shared/package.json       packages/shared/package.json
COPY --from=builder /app/apps/server/dist/packages/shared/src       packages/shared/src/
COPY --from=builder /app/packages/slide-model/package.json  packages/slide-model/package.json
COPY --from=builder /app/apps/server/dist/packages/slide-model/src  packages/slide-model/src/
RUN sed -i 's|./src/index.ts|./src/index.js|g' \
      packages/shared/package.json packages/slide-model/package.json

EXPOSE 3001 3002

# Healthcheck pro docker compose
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

# tsc emits with workspace-root rootDir (cross-package imports pull files from
# outside apps/server), so the actual entry is dist/apps/server/src/index.js.
CMD ["node", "apps/server/dist/apps/server/src/index.js"]
