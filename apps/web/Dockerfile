# ── Stage 1: builder ─────────────────────────────────────────────────────────
# Sestaví Vite produkční build (výstup do apps/web/dist/)
FROM node:24-alpine AS builder

# Bun (package.json `packageManager`) installs the workspace and runs the
# build; the tools themselves run on Node.
COPY --from=oven/bun:1.4.5-alpine /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Workspace manifesty pro cache
# bunfig.toml carries the install settings (the hoisted linker), package.json
# the patches (patchedDependencies), which the install refuses to go without.
COPY bun.lock bunfig.toml package.json ./
COPY patches ./patches
# Every workspace these depend on, dev dependencies included (@narrative/perf
# and what it needs): Bun refuses a pruned workspace that misses one.
COPY apps/web/package.json               apps/web/package.json
COPY packages/shared/package.json        packages/shared/package.json
COPY packages/slide-model/package.json   packages/slide-model/package.json
COPY packages/animation/package.json     packages/animation/package.json
COPY packages/commands/package.json      packages/commands/package.json
COPY packages/perf/package.json          packages/perf/package.json

# --ignore-scripts skips esbuild's postinstall (just verifies platform binary
# exists — not needed since @esbuild/* platform packages bundle the binary),
# and every other lifecycle script with it. Bun's package cache is a build
# cache, never a layer.
ENV BUN_INSTALL_CACHE_DIR=/bun-cache
RUN --mount=type=cache,id=narrative-bun-cache-musl,target=/bun-cache,sharing=locked \
  bun install --frozen-lockfile --ignore-scripts

COPY apps/web/    apps/web/
COPY packages/    packages/
COPY tsconfig.base.json ./

# Vite build — VITE_* env vars musí být přítomny při build time.
# Note: VITE_OIDC_* args removed in 2026-05 — auth is now server-driven
# via /api/auth/{start,callback,me,logout} and an opaque session cookie.
ARG VITE_API_URL=http://localhost:3001
ARG VITE_HOCUSPOCUS_URL=ws://localhost:3002
# No .git in the build context, so the version resolver in vite.config.ts would
# fall back to `v<pkg>+build` — identical for every build of a given version,
# which would make the client-side version guard blind. build-push.sh passes
# the real tag + sha in here.
ARG VITE_BUILD_VERSION=

ENV VITE_BUILD_VERSION=$VITE_BUILD_VERSION
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_HOCUSPOCUS_URL=$VITE_HOCUSPOCUS_URL

RUN bun run --cwd apps/web build

# The build's hidden source maps (vite.config.ts `sourcemap: 'hidden'`, kept
# for a Sentry upload from the builder) stay out of the served files: nothing
# uploads them, and served next to each chunk they would publish the source.
RUN find apps/web/dist \( -name '*.map' -o -name '*.map.br' -o -name '*.map.gz' \) -delete

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
