# Changelog

All notable changes to Narrative follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

---

## M0 — Foundation (2026-04-19)

### Added

- **Monorepo** — pnpm workspaces with `apps/web`, `apps/server`, and four `packages/*` shells (`shared`, `slide-model`, `animation`, `ui`)
- **`apps/web`** — React 18 + Vite 6 + TypeScript strict + Tailwind CSS v3; 3-pane editor layout shell (Slides sidebar, Canvas center, Inspector sidebar)
- **`apps/server`** — Fastify 5 + TypeScript ESM skeleton; `GET /health` endpoint with pino structured logging on port 3001
- **`tsconfig.base.json`** — Shared strict TypeScript config (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`)
- **`eslint.config.js`** — Flat ESLint 9 config with `@typescript-eslint/recommended`, `react-hooks/recommended` for web, `@typescript-eslint/no-explicit-any: error`
- **`.prettierrc`** — `singleQuote: true`, `semi: false`, `printWidth: 100`
- **`.github/workflows/ci.yml`** — CI pipeline: lint → typecheck → build → test on every push/PR to `main`; Node 22 + pnpm 10; dependency caching
- **`infra/docker-compose.yml`** — Postgres 16 Alpine with named volume, health check, `POSTGRES_PASSWORD` required from env
- **`.env.example`** — Env var template with comments for all current and future variables
- **Husky v9 + lint-staged** — Pre-commit hooks: ESLint + Prettier on staged `.ts`/`.tsx` files
- **`docs/adr/0001-monorepo-layout.md`** — ADR for monorepo structure, why pnpm workspaces (not Turborepo yet), why single `apps/server` app

### Technical decisions

- `shamefully-hoist=true` in `.npmrc` to resolve Windows pnpm symlink issues (documented in spike-A handoff)
- `concurrently` for parallel dev startup (`pnpm dev` starts both web and server)
- Server uses `--experimental-strip-types` for dev (no separate tsc compile step in dev mode); production build is separate
- No PixiJS in M0 — canvas placeholder only; PixiJS mounts in M1
