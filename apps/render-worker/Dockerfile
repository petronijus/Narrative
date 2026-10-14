# apps/render-worker — headless Chromium on the real web app (agentic A3,
# docs/plans/a3-render-worker.md). Debian, not Alpine: Playwright's Chromium
# builds are glibc-only. Only the headless shell is installed (no full
# browser), with the system libraries and fonts Playwright lists for it.

# ── Stage 1: builder ─────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS builder

RUN corepack enable && corepack prepare pnpm@12.11.2 --activate

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/render-worker/package.json  apps/render-worker/package.json
COPY packages/shared/package.json     packages/shared/package.json

# --ignore-scripts: no lifecycle scripts of the workspace or its dependencies in the image build.
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY apps/render-worker/  apps/render-worker/
COPY packages/            packages/
COPY tsconfig.base.json   ./

RUN pnpm --filter @narrative/render-worker build

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:24-bookworm-slim

RUN corepack enable && corepack prepare pnpm@12.11.2 --activate

WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/render-worker/package.json  apps/render-worker/package.json
COPY packages/shared/package.json     packages/shared/package.json

RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# Chromium's headless shell at the revision this playwright-core expects, its
# system libraries and fonts (--with-deps runs apt), into a path every user
# can read.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN node node_modules/playwright-core/cli.js install --with-deps --only-shell chromium \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/apps/render-worker/dist   apps/render-worker/dist/
COPY --from=builder /app/packages/shared/package.json   packages/shared/package.json
COPY --from=builder /app/apps/render-worker/dist/packages/shared/src   packages/shared/src/
RUN sed -i 's|./src/index.ts|./src/index.js|g' packages/shared/package.json

# Not root: Chromium's sandbox needs no privileges and the worker needs none.
USER node

CMD ["node", "apps/render-worker/dist/apps/render-worker/src/index.js"]

LABEL org.opencontainers.image.source=https://github.com/petronijus/Narrative
