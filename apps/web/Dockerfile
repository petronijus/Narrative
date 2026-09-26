# ── Stage 1: builder ─────────────────────────────────────────────────────────
# Sestaví Vite produkční build (výstup do apps/web/dist/)
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Workspace manifesty pro cache
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json               apps/web/package.json
COPY packages/shared/package.json        packages/shared/package.json
COPY packages/slide-model/package.json   packages/slide-model/package.json
COPY packages/animation/package.json     packages/animation/package.json
COPY packages/commands/package.json      packages/commands/package.json

# --ignore-scripts skips esbuild's postinstall (just verifies platform binary
# exists — not needed since @esbuild/* platform packages bundle the binary).
# Also silences pnpm 10's ERR_PNPM_IGNORED_BUILDS when build scripts aren't
# whitelisted in package.json's `pnpm.onlyBuiltDependencies`.
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY apps/web/    apps/web/
COPY packages/    packages/
COPY tsconfig.base.json ./

# Vite build — VITE_* env vars musí být přítomny při build time.
# Note: VITE_OIDC_* args removed in 2026-05 — auth is now server-driven
# via /api/auth/{start,callback,me,logout} and an opaque session cookie.
ARG VITE_API_URL=http://localhost:3001
ARG VITE_HOCUSPOCUS_URL=ws://localhost:3002
ARG VITE_IMGPROXY_URL=
# No .git in the build context, so the version resolver in vite.config.ts would
# fall back to `v<pkg>+build` — identical for every build of a given version,
# which would make the client-side version guard blind. build-push.sh passes
# the real tag + sha in here.
ARG VITE_BUILD_VERSION=

ENV VITE_BUILD_VERSION=$VITE_BUILD_VERSION
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_HOCUSPOCUS_URL=$VITE_HOCUSPOCUS_URL
ENV VITE_IMGPROXY_URL=$VITE_IMGPROXY_URL

RUN pnpm --filter @narrative/web build

# ── Stage 2: runtime (Caddy static file server) ───────────────────────────────
# Caddy je v produkci externě — web service nepoužíváme v compose.
# Tento Dockerfile existuje pro standalone testování web image.
# V compose (prod) Caddy mountuje /srv/web volume z builder stage.
FROM caddy:2-alpine AS runtime

COPY --from=builder /app/apps/web/dist /srv/web/

EXPOSE 80 443

CMD ["caddy", "file-server", "--root", "/srv/web", "--listen", ":80"]

# Link this GHCR package to its source repo (auto-connects on push)
LABEL org.opencontainers.image.source=https://github.com/petronijus/Narrative
