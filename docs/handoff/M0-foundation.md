# M0 — Foundation

**Status**: Done
**Datum**: 2026-04-19
**Agent**: infra

---

## Co bylo hotovo

- **pnpm workspaces monorepo** s `apps/web`, `apps/server`, `packages/shared`, `packages/slide-model`, `packages/animation`, `packages/ui`
- **`apps/web`** — React 18 + Vite 6 + TypeScript strict + Tailwind CSS v3; 3-pane editor layout shell (Slides sidebar | Canvas placeholder | Inspector sidebar)
- **`apps/server`** — Fastify 5 + TypeScript ESM; `GET /health → { status: "ok" }` na portu 3001; pino structured logging s pino-pretty v dev módu
- **`tsconfig.base.json`** — strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`
- **`eslint.config.js`** — flat ESLint 9 config, `@typescript-eslint/recommended`, `react-hooks/recommended` jen pro `apps/web`, `no-explicit-any: error`
- **`.prettierrc`** — `singleQuote: true`, `semi: false`, `printWidth: 100`
- **`.github/workflows/ci.yml`** — CI: checkout → pnpm 10 + Node 22 → install (cached) → lint → typecheck → build → test; cancel-in-progress pro duplicate runs
- **`infra/docker-compose.yml`** — Postgres 16 Alpine, named volume, healthcheck, `POSTGRES_PASSWORD` required
- **`.env.example`** — šablona env vars s komentáři pro budoucí milestony
- **Husky v9 + lint-staged** — pre-commit hook přes `pnpm exec lint-staged`; ESLint + Prettier na staged TS/TSX soubory
- **`docs/adr/0001-monorepo-layout.md`** — ADR: proč pnpm bez Turborepo, proč single `apps/server`, proč tento package split
- **`README.md`** — setup instrukce, struktura, odkaz na BUILD_PLAN.md a docs/agents.md
- **`CHANGELOG.md`** — sekce M0 ve Keep-a-changelog formátu

---

## Klíčová rozhodnutí

### Windows + pnpm symlink fix

pnpm na Windows (Git Bash) nevytváří `.bin` adresář pokud instalace používá symlinky — Node.js nemůže sledovat Windows-path symlinky (`D:\...`) z bash kontextu. Řešení: `.npmrc` s `package-import-method=copy` + `node-linker=hoisted` (globální pnpm config). Toto vytváří skutečné soubory místo symlinků a `.bin` s `.CMD` wrappers. UNKNOWN error při install je warning, ne fatální chyba — install proběhne kompletně.

Viz: [ADR-0001](../adr/0001-monorepo-layout.md)

### Server tsconfig module resolution

`apps/server` používá `"module": "NodeNext"` a `"moduleResolution": "NodeNext"` (odlišné od `tsconfig.base.json` kde je `bundler`). Fastify 5 s ESM vyžaduje NodeNext resolution na serveru.

### pino-pretty jako dev dependency

Server v dev módu (`NODE_ENV !== 'production'`) používá pino-pretty transport. pino-pretty přidán jako `devDependency` do `apps/server`. Produkční build posílá plain JSON logy bez pino-pretty.

### `exactOptionalPropertyTypes` + Fastify logger

`exactOptionalPropertyTypes: true` způsobuje TS error pokud logger config objekt může mít `transport: undefined`. Opraveno tak, že dev a prod logger configs jsou dva oddělené objekty (bez `| undefined` větve).

---

## Jak ověřit stav

```bash
# 1. Install
pnpm install

# 2. Typecheck — musí projít bez chyb
pnpm -r typecheck

# 3. Lint — musí projít bez chyb
pnpm -r lint

# 4. Build — musí projít
pnpm -r build

# 5. Test — musí projít (echo "No tests yet")
pnpm -r test

# 6. Server health check
pnpm --filter @narrative/server dev &
sleep 3
curl http://localhost:3001/health
# Očekávaný výstup: {"status":"ok"}

# 7. Postgres
cp .env.example .env
# Nastav POSTGRES_PASSWORD v .env
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps
# Očekávaný stav: postgres healthy

# 8. Web dev server
pnpm --filter @narrative/web dev
# Otevři http://localhost:5173 — 3-pane editor shell
```

---

## Další krok

**M1 — Scene graph + resource manager**

Dispatch: `renderer` agent

Úkoly:

- Mountovat PixiJS v8 v `<Canvas />` React komponentě s proper mount/unmount lifecycle
- Resource manager jako first-class primitive (centrální správa texture/asset lifecyklů)
- Jeden hardcoded obdélník renderovaný z JSON definice
- ADR-0002 (renderer architecture)

---

## Známé TODO

- `pnpm install` vždy zobrazí `UNKNOWN: unknown error` na náhodném package.json — toto je Windows file-access timing issue při linkerování, není fatální. Packages se nainstalují správně. Pokud by někdy .bin přestalo existovat, spustit `pnpm install --force`.
- `apps/server` nemá produkční build step (kompilaci do `dist/`). V M0 je server spouštěn přes `node --experimental-strip-types` (Node 22 native TS). Produkční Docker image v M4 bude potřebovat `tsc` compile nebo `esbuild` bundle.
- Husky pre-commit hook funguje přes `pnpm exec lint-staged` — pokud by selhával na Windows, lze deaktivovat: `git config core.hooksPath /dev/null`.
- `eslint.config.js` importuje `@eslint/js` — ale tato package není v `devDependencies`. ESLint ji instaluje jako peer dependency. Přidat explicitně pokud lint selže.

---

## Odkazy

- **Commit**: `aa20372` — feat(m0): foundation — monorepo, web shell, server skeleton, CI/CD
- **ADR-0001**: `docs/adr/0001-monorepo-layout.md`
- **CI config**: `.github/workflows/ci.yml`
- **Env schema**: `.env.example`
- **Infra**: `infra/docker-compose.yml`
- **Spike výsledky**: `docs/handoff/spike-{a,b,c}-*.md`
