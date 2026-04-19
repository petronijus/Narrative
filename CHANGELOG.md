# Changelog

All notable changes to Narrative follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

---

## M1 — Scene graph + resource manager (2026-04-19)

### Added

- **`pixi.js` v8** — PixiJS v8 přidán jako production dependency do `apps/web` (WebGL/WebGPU renderer, hoistován přes pnpm workspace)
- **`vitest` + `jsdom`** — Test runner a browser environment pro unit testy renderer vrstvy
- **`apps/web/src/renderer/Canvas.tsx`** — React komponenta pro mount/unmount Pixi Application; StrictMode safe (ref guard), ResizeObserver, HiDPI (resolution=DPR, autoDensity=true), Pixi v8 API (`app.canvas`, `app.init()`)
- **`apps/web/src/renderer/SceneGraph.ts`** — Scene graph wrapper; ID-based diff reconciler (add/update/remove); žádné přímé Pixi mutace mimo renderer modulů
- **`apps/web/src/renderer/ResourceManager.ts`** — Centrální správce GPU zdrojů; ref counting pro textury; `acquireTexture` / `releaseTexture` / `destroyAll`
- **`apps/web/src/renderer/types.ts`** — `SlideObjectData` discriminated union; `RectangleObject`; `BaseSlideObject`; připraveno na rozšíření v M2
- **`apps/web/src/renderer/coords.ts`** — DPR-aware coordinate transforms; `worldToScreen` / `screenToWorld`; dokumentuje povinnou DPR compensation (Spike C nález)
- **`apps/web/src/renderer/objectRenderers/rectangleRenderer.ts`** — První object renderer; Pixi Graphics fill; pivot na středu objektu pro správnou rotaci
- **`apps/web/src/renderer/objectRenderers/index.ts`** — Renderer registry (Map<type, renderer>); připravena na rozšíření v M2
- **`apps/web/src/data/demoSlide.ts`** — Hardcoded demo data: dva obdélníky (modrý + červený, různá opacity a rotace)
- **`apps/web/src/renderer/ResourceManager.test.ts`** — 10 unit testů: ref counting, acquire/release, destroyAll, textureCount
- **`apps/web/src/renderer/SceneGraph.test.ts`** — 9 unit testů: ID diff add/update/remove, destroy, edge cases
- **`docs/adr/0002-renderer-architecture.md`** — ADR pro renderer architekturu (PixiJS v8, SceneGraph, ResourceManager, DPR transforms, StrictMode safety)

### Changed

- **`apps/web/src/components/EditorLayout.tsx`** — Canvas placeholder nahrazen `<Canvas slideData={demoSlide} />` — center pane nyní mountuje živý Pixi canvas
- **`apps/web/vite.config.ts`** — Přidán `build.target: 'esnext'` (top-level await pro Pixi v8 `app.init()`); přidána `test` sekce pro vitest s jsdom environment

### Technical decisions

- Vitest spouštěn přes `node ../../node_modules/vitest/vitest.mjs run` (Windows pnpm hoisting nenechá `.bin/vitest` fungovat bez full path)
- `rectangleRenderer` ukládá Graphics referenci přes Symbol property na Container — `any` cast s komentářem; vylepšeno v M2
- `objectRenderers/index.ts` registry Map používá `any` pro generické varianty ObjectRenderer — nutné pro heterogenní registry; vylepšeno v M2
- ResourceManager testován s Pixi Assets mock — testy nepotřebují GPU ani browser

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
