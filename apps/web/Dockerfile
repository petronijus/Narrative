# ── Stage 1: builder ─────────────────────────────────────────────────────────
# Sestaví Vite produkční build (výstup do apps/web/dist/)
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Workspace manifesty pro cache
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json               apps/web/package.json
COPY packages/shared/package.json        packages/shared/package.json
COPY packages/slide-model/package.json   packages/slide-model/package.json
COPY packages/animation/package.json     packages/animation/package.json
COPY packages/ui/package.json            packages/ui/package.json

RUN pnpm install --frozen-lockfile

COPY apps/web/    apps/web/
COPY packages/    packages/
COPY tsconfig.base.json ./

# Vite build — VITE_* env vars musí být přítomny při build time
ARG VITE_API_URL=http://localhost:3001
ARG VITE_HOCUSPOCUS_URL=ws://localhost:3002

ENV VITE_API_URL=$VITE_API_URL
ENV VITE_HOCUSPOCUS_URL=$VITE_HOCUSPOCUS_URL

RUN pnpm --filter @narrative/web build

# ── Stage 2: runtime (Caddy static file server) ───────────────────────────────
# Caddy je v produkci externě — web service nepoužíváme v compose.
# Tento Dockerfile existuje pro standalone testování web image.
# V compose (prod) Caddy mountuje /srv/web volume z builder stage.
FROM caddy:2-alpine AS runtime

COPY --from=builder /app/apps/web/dist /srv/web/

EXPOSE 80 443

CMD ["caddy", "file-server", "--root", "/srv/web", "--listen", ":80"]
