# Handoff M4 — State Sync: Hocuspocus Server + Postgres Persistence

**Status:** done (fáze 1 — state-sync vrstva)
**Date:** 2026-04-19
**Agent:** state-sync
**Fáze 2:** infra agent (docker-compose rozšíření, deploy script)

---

## Co bylo dokončeno

### 1. Hocuspocus WebSocket server (`apps/server/src/hocuspocus/`)

**`index.ts`** — factory `createHocuspocusServer({ port, db })`:

- Běží na portu 3002 (separátní od Fastify HTTP na 3001)
- `onConnect`: hardcoded `userId = 'demo-user'`, TODO(M10) komentář pro JWT
- `onDisconnect`: log
- Extensions: `PostgresPersistence`

**`persistence.ts`** — `PostgresPersistence implements Extension`:

- `onLoadDocument`: načte všechny `deck_updates` rows pro deck (ORDER BY id), aplikuje `Y.applyUpdate` sekvenčně
- `onStoreDocument`: `Y.encodeStateAsUpdate(doc)` → insert do `deck_updates`
- Strategy: append-only; TODO(M29) kompakce

### 2. Drizzle ORM schema a migrace (`apps/server/src/db/`)

**`schema.ts`** — dvě tabulky:

- `decks`: id (text PK), title, owner_user_id, created_at, updated_at
- `deck_updates`: id (serial PK), deck_id (FK → decks ON DELETE CASCADE), update (bytea), created_at
- Index: `deck_updates_deck_id_idx`
- Custom `bytea` type pro Uint8Array ↔ Buffer konverzi

**`client.ts`** — Drizzle `db` nad `pg.Pool`, connection string z `POSTGRES_URL` env

**`migrate.ts`** — CLI script pro `db:migrate`; v dev modu voláno automaticky ze `src/index.ts`

**`apps/server/drizzle/`** — migration soubory (ručně vytvořené, odpovídají schema):

- `0000_initial_schema.sql`
- `meta/_journal.json`, `meta/0000_snapshot.json`

### 3. REST API `/decks` (`apps/server/src/routes/decks.ts`)

```
GET    /decks      → list all decks (owner='demo-user')
POST   /decks      → body { title? } → 201 { id, title, ownerUserId, createdAt, updatedAt }
DELETE /decks/:id  → 204 (cascade deck_updates) | 404
```

Hardcoded `DEMO_USER_ID = 'demo-user'`, TODO(M10) pro JWT.

### 4. Fastify server rozšíření (`apps/server/src/index.ts`)

- Paralelní start Fastify (3001) + Hocuspocus (3002)
- CORS: `CORS_ORIGIN` env (default `http://localhost:5173`)
- Graceful shutdown: SIGTERM/SIGINT → `app.close()` + `hocuspocus.destroy()` + `pool.end()`
- Dev mode: automatické migrace při startu

### 5. Web — HocuspocusProvider (`apps/web/src/state/SlideDocProvider.tsx`)

Refactored z in-memory Y.Doc na `HocuspocusProvider`:

- `deckId` prop → `name` param pro Hocuspocus
- Y.Doc sdílena s `MutationContext`
- `VITE_HOCUSPOCUS_URL` env (default `ws://localhost:3002`)
- Lifecycle: connect na mount, destroy na unmount
- Loading state: zobrazí "Connecting…" dokud není `value` ready

### 6. React Router + Landing page

**`apps/web/src/App.tsx`** — `BrowserRouter` s routes:

- `/` → `Landing`
- `/deck/:id` → `DeckEditor`

**`apps/web/src/pages/Landing.tsx`** — minimalistická landing:

- `GET /decks` → list s DeckCard komponenty
- "New Deck" → `POST /decks` → navigate na `/deck/:id`
- Klik na deck → navigate
- Delete icon → `DELETE /decks/:id` → refetch

**`apps/web/src/pages/DeckEditor.tsx`** — wrapper:

- Extrahuje `:id` z URL params
- Renderuje `SlideDocProvider > SelectionProvider > ToolProvider > EditorLayout`

### 7. Vite env typy (`apps/web/src/vite-env.d.ts`)

Přidán `/// <reference types="vite/client" />` pro `ImportMeta.env` TypeScript support.

### 8. Testy

**`apps/server/src/hocuspocus/persistence.test.ts`** — 5 testů:

- Empty deck → void (žádná aplikace)
- Deck s 1 update → aplikuje na Y.Doc
- Deck s N updates → aplikuje v pořadí
- onStoreDocument → insert s Uint8Array
- Store → rehydrate → identický state

**`apps/server/src/routes/decks.test.ts`** — 7 testů:

- GET empty, GET with data
- POST default title, POST custom title
- DELETE existing (204), DELETE nonexistent (404)
- Route registration smoke test

Mock strategy: mock Drizzle DB objekt — žádný real Postgres dependency v unit testech.

### 9. `apps/server/vitest.config.ts`

Vitest config — exclude `*.integration.test.ts` z normálního test runu.

---

## Dependencies přidány

### `apps/server`

| Package                          | Verze    | Justifikace                                                               |
| -------------------------------- | -------- | ------------------------------------------------------------------------- |
| `@hocuspocus/server`             | ^2.15.0  | WebSocket sync server — core M4 deliverable                               |
| `@hocuspocus/extension-database` | ^2.15.0  | Persistence extension interface (používáme vlastní impl)                  |
| `drizzle-orm`                    | ^0.43.1  | Type-safe SQL ORM; lehčí než Prisma, výborný pro long-running self-hosted |
| `pg`                             | ^8.14.1  | Postgres driver — PostgreSQL ekosystém standard                           |
| `nanoid`                         | ^5.0.9   | Deck ID generation (bez kolizí, URL-safe)                                 |
| `@types/pg`                      | ^8.11.11 | TypeScript typy pro pg                                                    |
| `drizzle-kit`                    | ^0.31.1  | Schema migrations CLI                                                     |
| `vitest`                         | ^3.1.2   | Test runner (konzistentní s ostatními packages)                           |

### `apps/web`

| Package                | Verze   | Justifikace                             |
| ---------------------- | ------- | --------------------------------------- |
| `@hocuspocus/provider` | ^2.15.0 | Browser WebSocket provider pro Y.Doc    |
| `react-router-dom`     | ^7.5.2  | Routing pro Landing + DeckEditor routes |

---

## Environment variables (přidány do `.env.example`)

```
API_PORT=3001
HOCUSPOCUS_PORT=3002
POSTGRES_URL=postgres://narrative:password@localhost:5432/narrative
VITE_HOCUSPOCUS_URL=ws://localhost:3002
VITE_API_URL=http://localhost:3001
```

---

## Jak ověřit stav

```bash
pnpm -r typecheck   # zelená
pnpm -r lint        # zelená (0 errors, 0 warnings)
pnpm -r test        # 224 testů zelených (47 slide-model + 165 web + 12 server)
pnpm -r build       # zelená

# Smoke test (postgres musí běžet):
docker compose -f infra/docker-compose.yml up -d postgres
# .env soubor s POSTGRES_URL musí existovat
pnpm --filter @narrative/server db:migrate
pnpm dev

# 1. Otevři http://localhost:5173 → Landing page
# 2. Klikni "+ New Deck" → vytvoří deck, naviguje do editoru
# 3. Vytvoř objekt (toolbar → rectangle → klikni na canvas)
# 4. Otevři druhý tab → naviguj na stejné /deck/:id → objekty jsou vidět
# 5. Vytvoř objekt v druhém tabu → první tab vidí změnu (realtime sync)
# 6. Restart serveru (Ctrl+C, pnpm dev znovu)
# 7. Refresh tabu → objekty tam jsou (persistence funguje)
```

---

## Architektonická rozhodnutí

### Dva porty místo jednoho (Fastify + Hocuspocus)

Hocuspocus defaultně vyžaduje vlastní HTTP server pro WebSocket upgrade. Kombinace s Fastify na jednom portu by vyžadovala raw `http.Server` sharing, což komplikuje Fastify plugin lifecycle. Pragmatické rozhodnutí: 2 porty v dev, Caddy routuje oba přes jednu doménu v produkci.

### Append-only persistence (ne snapshot)

`onStoreDocument` ukládá nový update row při každé Hocuspocus debounced store (default 2s). Pro M4 s malými decky je loadDocument O(N) updates — OK. TODO(M29): kompakce — merge N starých updates do 1 snapshot row.

### Server-side migrace v dev modu

`src/index.ts` volá `migrate(db, { migrationsFolder })` při startu pokud `NODE_ENV !== 'production'`. Usnadňuje dev workflow (žádný manuální krok). V produkci migrace jsou manuální deploy krok (infra agent fáze 2).

### Mock DB v unit testech

Real Postgres v unit testech by vyžadoval Docker (testcontainers) nebo pg-mem (omezené API). Mock Drizzle objekt testuje business logiku persistence extension bez DB dependency. Real integration test označen jako future work — spustit manuálně s running Postgres.

---

## Soubory změněné / přidané

### Nové soubory

| Soubor                                           | Popis                                |
| ------------------------------------------------ | ------------------------------------ |
| `apps/server/src/db/schema.ts`                   | Drizzle schema (decks, deck_updates) |
| `apps/server/src/db/client.ts`                   | Drizzle DB klient (pg Pool)          |
| `apps/server/src/db/migrate.ts`                  | Migration CLI script                 |
| `apps/server/src/hocuspocus/index.ts`            | Hocuspocus server factory            |
| `apps/server/src/hocuspocus/persistence.ts`      | PostgresPersistence extension        |
| `apps/server/src/routes/decks.ts`                | REST /decks endpoints                |
| `apps/server/src/hocuspocus/persistence.test.ts` | 5 persistence testů                  |
| `apps/server/src/routes/decks.test.ts`           | 7 decks API testů                    |
| `apps/server/vitest.config.ts`                   | Vitest config pro server             |
| `apps/server/drizzle.config.ts`                  | Drizzle Kit config                   |
| `apps/server/drizzle/0000_initial_schema.sql`    | Initial migration SQL                |
| `apps/server/drizzle/meta/_journal.json`         | Migration journal                    |
| `apps/server/drizzle/meta/0000_snapshot.json`    | Schema snapshot                      |
| `apps/web/src/pages/Landing.tsx`                 | Landing page (list + create decks)   |
| `apps/web/src/pages/DeckEditor.tsx`              | Deck editor page wrapper             |
| `apps/web/src/vite-env.d.ts`                     | Vite ImportMeta.env typy             |

### Upravené soubory

| Soubor                                    | Změna                                                    |
| ----------------------------------------- | -------------------------------------------------------- |
| `apps/server/src/index.ts`                | Přidán Hocuspocus, CORS, graceful shutdown, auto-migrate |
| `apps/server/package.json`                | Nové dependencies + scripts                              |
| `apps/server/tsconfig.json`               | Drobná úprava include                                    |
| `apps/web/src/App.tsx`                    | React Router, Landing + DeckEditor routes                |
| `apps/web/src/state/SlideDocProvider.tsx` | HocuspocusProvider místo in-memory Y.Doc                 |
| `apps/web/package.json`                   | @hocuspocus/provider, react-router-dom                   |
| `.env.example`                            | Přidány M4 env vars                                      |

---

## Co infra agent potřebuje (fáze 2)

1. **docker-compose.yml rozšíření** — přidat `server` service:

   ```yaml
   server:
     build: ./apps/server
     ports:
       - '3001:3001'
       - '3002:3002'
     environment:
       POSTGRES_URL: postgres://narrative:${POSTGRES_PASSWORD}@postgres:5432/narrative
       API_PORT: 3001
       HOCUSPOCUS_PORT: 3002
     depends_on:
       postgres:
         condition: service_healthy
   ```

2. **Deploy script** — spustit `db:migrate` jako pre-start step v produkci

3. **Caddy config** — routovat `/ws` na port 3002, ostatní na 3001 nebo web

4. **.env pro docker** — `POSTGRES_URL` jako compose secret nebo `.env` file

---

## Blokery / Omezení

**Windows symlink error při pnpm install** — `UNKNOWN: unknown error, open '...\@narrative\shared\package.json'` — způsobeno Windows junction/symlink problémem v pnpm. Error se opakuje ale závislosti jsou správně v root `node_modules` (hoisting). Nebrání funkčnosti. Workaround: opakovat `pnpm install` dokud neprojde, nebo použít `--shamefully-hoist`.

**drizzle-kit generate nenaspoušten** — migration soubory vytvořeny ručně (ekvivalentní výstup). Pokud DB běží: `pnpm --filter @narrative/server db:generate` pro regeneraci z live schema.

**Žádný auth (M10)** — komentáře `TODO(M10)` na všech místech kde přijde JWT.
