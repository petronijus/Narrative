# ── Stage 1: builder ─────────────────────────────────────────────────────────
# Instaluje všechny deps (incl. devDeps) a kompiluje TypeScript → dist/
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

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

RUN corepack enable && corepack prepare pnpm@latest --activate

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

# Drizzle migration soubory (potřeba pro migrate.js v runtime)
COPY --from=builder /app/apps/server/drizzle apps/server/drizzle/

EXPOSE 3001 3002

# Healthcheck pro docker compose
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "apps/server/dist/index.js"]
