# Changelog

All notable changes to Narrative follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

---

## Audit + test debt cleanup (2026-05-09)

Multi-stage codebase audit and test-suite consolidation. Eight commits
on `main`: `1e53cf5` (Tier 1 security/leaks/bundle), `7081697`
(Tier 2 render storms / animation lifecycle / observer race), `229658d`
(centralised Pixi mock), `778bab1` (web suite cleanup + e2e migration),
`d8ed687` (testing strategy doc), `d026e68` (Tier A), `7edebd9`
(Tier B), `d504f83` (Tier C).

### Added

- **`/CLAUDE.md`** — project guide telling Claude sessions which test commands to auto-run for which kinds of changes (renderer, mutations, auth, etc.) and the architecture invariants not to violate.
- **`docs/testing-strategy.md`** — strategy + roadmap doc, all three tiers (A/B/C) marked complete.
- **`packages/slide-model/src/convergence.property.test.ts`** — fast-check property-based CRDT convergence (3 properties, 400 random op sequences per run): disjoint+sync, three-client star topology, offline-then-reconnect.
- **`apps/server/src/hocuspocus/lifecycle.test.ts`** — server doc-cache leak guard (cache returns to 0 after debounce, 50× open/close stays bounded, reopen reuses cached entry).
- **`apps/web/e2e/keyboard-shortcuts.spec.ts`** — replaces 14 jsdom-misplaced unit tests; covers Toolbar (R/O/T/V), input-focus suppression, present-mode entry, slide nav, present-layout exit.
- **`apps/web/e2e/renderer-visual.spec.ts`** — sampled-thumbnail visual regression (always-on) + opt-in pixel-perfect baselines (`RUN_VISUAL_BASELINES=1`).
- **`apps/web/e2e/destructive-flows.spec.ts`** — deck delete + cascade, share-link revoke happy + IDOR guard, folder cascade, Drafts protection.
- **`apps/web/e2e/multi-client-collab.spec.ts`** — three browser contexts converging through real Hocuspocus + offline/online catch-up via `setOffline`.
- **`apps/web/e2e/inspector-flows.spec.ts`** — full Inspector e2e replacing deleted DOM-presence component tests.
- **`apps/web/src/test/pixiMock.ts`** + **`apps/web/src/test/renderWithProviders.tsx`** — single-source-of-truth mock factory and provider wrapper (replaces ~20 inline copies).
- **`tests/load/runAll.mjs`** — load-test harness with absolute thresholds + 20% drift warnings vs `tests/load/baselines.example.json`.
- **`.lighthouserc.json`** + `pnpm lighthouse` script — Core Web Vitals on the editor route (warn-level FCP/LCP/TBT/CLS/TTI).
- **`packages/slide-model/stryker.config.json`** + `pnpm --filter @narrative/slide-model mutate` — Stryker mutation-testing pilot targeting `mutations.ts` + `slides.ts`.
- **`pnpm size`** — size-limit budgets per chunk + total first-paint ≤ 800 KB gz (currently 747).
- Vite `manualChunks` split — main app chunk down from 836 KB gz to 189 KB gz.

### Fixed

- **Tier 1**: security blockers (auth bypass paths, IDOR on share-link revoke, missing rate-limits on auth endpoints), server resource leaks (Hocuspocus doc-cache eviction with `unloadImmediately:false` + `debounce:2000`), bundle hygiene.
- **Tier 2-A**: render storms — memoised `SelectionContext`, `SlideDocProvider`, `EditorLayout` array refs.
- **Tier 2-B**: server-side leaks — Hocuspocus lifecycle settings, doc cache returns to 0 after disconnects.
- **Tier 2-C**: animation lifecycle — Magic Move `onComplete` chained via `eventCallback('onComplete')` instead of overwriting; `playTransition` snap-final-state guard restored.
- **Tier 2-E**: `subscribeToSlides` race — `slideObserve` no longer fires partial state during transactions.
- **`InputBridge`** listener leak — single-overwrite replaced with `Set<cb>` broadcast.
- **`videoRenderer`** shared `containerRegistry` race — registry keyed by node id, cleared on unmount.
- **`useMediaUpload` tests** — switched mock from `getHeader` to `getBody` (server moved metadata to JSON body because browser CORS strips custom headers).

### Changed

- **Web test suite**: 102 failures → 0; 61 skipped → 23 (all remaining skips have rationale comments in-file). Total across all packages: 1,219 unit + integration tests pass, 0 fail.
- **`pnpm dev`** — now starts web + server + video-worker (was only web + server). Added `pnpm dev:no-worker` for the old behaviour.
- **`hls.js`** — moved back to static import after lazy-import broke video rendering on first play; vendor-hls chunk split kept.
- **`bullmq` + `ioredis`** — Node 25 ESM compat fix: default-import + destructure named exports.

### Removed

- ~80 DOM-presence component tests (`getByText('Fill')`, `expect(button).toBeInTheDocument()`) — replaced by e2e or deleted as no-signal.
- 6 `objectRenderers/*.test.ts` files asserting Pixi mock-call shapes — replaced by sampled-thumbnail e2e.
- 14 jsdom keyboard-shortcut tests — moved to `apps/web/e2e/keyboard-shortcuts.spec.ts` (real focus model required).
- 6 `FillTokenTab.test.tsx` skips for retired UX (Token tab folded into colour-picker popover during M16-P8).
- Empty `describe` blocks left over after deletions.

### Technical decisions

- `Y.encodeStateAsUpdate` is **not** canonical (clock entries serialise in insertion order). Property-based convergence asserts structural deep-equality of `listSlides()` output (with `JSON.parse(JSON.stringify(slide))` to strip live `Y.Text` / `Y.XmlFragment` refs).
- Visual regression is two-tier: sampled-thumbnail tests run always (cross-platform robust); pixel-perfect baselines opt-in via env var (avoid baseline-churn from font-rendering differences).
- Lighthouse + Stryker are NOT on every PR — `pnpm size` and `pnpm load:all` are. Slow gates run nightly / pre-release.
- Sub-agents in this repo MUST run on Opus (memory-noted): Sonnet output needed reviewer rework on M16 P5/P6.

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
