# M6 Phase 2b — Observability Baseline Handoff

**Datum**: 2026-04-19
**Agent**: infra
**Status**: DONE — všechny deliverables implementovány, testy zelené

---

## Co bylo implementováno

### 1. Sentry integrace (dev-gated)

**Client** (`apps/web`):

- `apps/web/src/main.tsx` — lazy `import('@sentry/react')` jen pokud `VITE_SENTRY_DSN` je set
- `browserTracingIntegration` + `release: __BUILD_VERSION__` (Vite define plugin)
- `apps/web/src/vite-env.d.ts` — typy pro nové env vars + `__BUILD_VERSION__` global

**Server** (`apps/server`):

- `apps/server/src/observability/sentry.ts` — `initSentry(app)` funkce
- `apps/server/src/index.ts` — volá `initSentry(app)` před routes
- `setupFastifyErrorHandler` — zachytí unhandled route errors

**Bez DSN = tiché. Dev-friendly.**

### 2. Client metrics modul (`apps/web/src/observability/`)

| Soubor                 | Obsah                                                                 |
| ---------------------- | --------------------------------------------------------------------- |
| `fpsTracker.ts`        | rAF-based FPS + frame time p95/p99, rolling 60-frame window           |
| `yjsMetrics.ts`        | Update rate counter (sent/received), byte counters, awareness changes |
| `metricsDashboard.tsx` | `FpsOnlyDashboard` overlay + full `MetricsDashboard` (pro M8 s Yjs)   |
| `useDevMetrics.ts`     | Hook: FPS tracker lifecycle + Ctrl+Shift+M toggle                     |
| `index.ts`             | Public exports                                                        |

Dashboard integrovaný v `EditorLayout.tsx` jako `<DevMetricsOverlay />` (DEV-only, tree-shaken v prod).

**Ctrl+Shift+M** → toggle overlay.

### 3. Server Prometheus endpoint

- `apps/server/src/metrics/collectors.ts` — in-process counters (connections gauge, updates counter, bytes counter)
- `apps/server/src/metrics/index.ts` — `registerMetricsEndpoint(app)` + re-exportuje `metrics`, `formatPrometheus`
- Hocuspocus hooks v `apps/server/src/hocuspocus/index.ts` — `onConnect`/`onDisconnect`/`onStoreDocument`
- Endpoint: `GET /metrics` → `text/plain; version=0.0.4`
- TODO(M29): auth na endpoint

### 4. Synthetic load harness (`tests/load/`)

| Soubor              | Obsah                                                    |
| ------------------- | -------------------------------------------------------- |
| `yjsClient.ts`      | Hocuspocus-kompatibilní Node.js klient (ze spike B)      |
| `hotEdit.ts`        | 5 clients × 200 mutations, threshold: latency avg < 20ms |
| `awarenessFlood.ts` | 15 clients × 30 Hz × 30s, threshold: latency avg < 100ms |
| `docGrowth.ts`      | 1000 objects, threshold: sync < 3s, size < 1MB           |
| `runAll.mjs`        | Sekvenční runner, JSON summary                           |
| `package.json`      | Vlastní deps (ws, yjs, lib0, y-protocols, ts-node)       |
| `README.md`         | Jak spustit, referenční hodnoty                          |

Root `package.json` scripts: `load:all`, `load:hotedit`, `load:awareness`, `load:growth`.

### 5. CI — weekly load test

`.github/workflows/load-test.yml` — spouští se jen na `workflow_dispatch` nebo neděle 4:00 UTC. Neblokuje normální PR CI.

### 6. Runbook

`docs/ops.md` — health checks, metrics interpretace, Sentry setup, load harness, incident response stub (M29).

### 7. Tests

| Test file                                         | Počet testů |
| ------------------------------------------------- | ----------- |
| `apps/web/src/observability/fpsTracker.test.ts`   | 5           |
| `apps/web/src/observability/yjsMetrics.test.ts`   | 6           |
| `apps/server/src/metrics/collectors.test.ts`      | 7           |
| `apps/server/src/metrics/metricsEndpoint.test.ts` | 4           |

Celkem **22 nových testů**. Server: 23/23 pass. Web: 217/217 pass.

---

## Závislosti přidané

| Balíček               | Kde                | Justifikace                        |
| --------------------- | ------------------ | ---------------------------------- |
| `@sentry/react ^8.51` | `apps/web` deps    | Client error tracking, lazy-loaded |
| `@sentry/node ^8.51`  | `apps/server` deps | Server error tracking, lazy-loaded |

Load harness má vlastní `package.json` v `tests/load/` — nezávislý na monorepo deps.

---

## Env vars přidané

Viz `.env.example`:

- `VITE_SENTRY_DSN` — client Sentry DSN (optional)
- `SENTRY_DSN` — server Sentry DSN (optional)
- `VITE_BUILD_VERSION` — git sha pro Sentry release (optional, default: `dev`)

---

## Klíčové soubory

- `apps/server/src/metrics/collectors.ts` — metric state
- `apps/server/src/metrics/index.ts` — endpoint registration
- `apps/server/src/observability/sentry.ts` — server Sentry init
- `apps/server/src/hocuspocus/index.ts` — metrics hooks přidány
- `apps/server/src/index.ts` — Sentry + metrics endpoint registrace
- `apps/web/src/observability/` — celý modul
- `apps/web/src/components/EditorLayout.tsx` — DevMetricsOverlay přidán
- `apps/web/src/main.tsx` — Sentry lazy init
- `apps/web/vite.config.ts` — `__BUILD_VERSION__` define
- `tests/load/` — load harness
- `.github/workflows/load-test.yml` — weekly CI job
- `docs/ops.md` — runbook

---

## Blockers / TODO

- **Yjs metrics v dashboardu**: `FpsOnlyDashboard` v EditorLayout zatím nezobrazuje Yjs metriky, protože Y.Doc + HocuspocusProvider nejsou v context snadno dostupné. Full `MetricsDashboard` (s Yjs) je připravená — napojit v M8 při awareness implementaci, kdy budou provider data dostupná výše v tree.
- **Source maps**: Sentry funguje bez source maps (stack traces jsou minified). Source maps setup vyžaduje `@sentry/vite-plugin` + CI upload krok — odloženo na M29.
- **Metrics auth**: `GET /metrics` nemá auth — TODO(M29) Bearer token nebo IP allowlist.
- **Load harness deps**: `tests/load/` má vlastní `package.json` — před spuštěním je nutné `cd tests/load && npm install`.
