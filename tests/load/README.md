# Narrative — Synthetic Load Harness

Persistentní stress test harness pro `apps/server` (Hocuspocus + Fastify).

## Prerekvizity

- Node.js v22
- Běžící server: `pnpm --filter server dev`
- Případně lokální Postgres (pro dev server)

## Spuštění

```bash
# Z rootu monorepa — jeden scénář
pnpm load:hotedit
pnpm load:awareness
pnpm load:growth

# Všechny scénáře sekvenčně
pnpm load:all
```

Nebo přímo:

```bash
cd tests/load
npm install
node --loader ts-node/esm hotEdit.ts
node --loader ts-node/esm awarenessFlood.ts
node --loader ts-node/esm docGrowth.ts
node runAll.mjs
```

## Scénáře

### hotEdit — 5 concurrent editors

5 klientů provádí 200 mutací každý (celkem 1000 ops) na jednom dokumentu.
Měří observer latency a CRDT konvergenci.

**Thresholds** (ze spike B verdictu):

- Observer latency avg < 20ms
- Konvergence = true

### awarenessFlood — 15 peers × 30 Hz

15 klientů posílá awareness updates po dobu 30s na frekvenci 30 Hz.
Měří awareness latency.

**Threshold**:

- Awareness latency avg < 100ms

### docGrowth — Large doc bootstrap

Generuje velký dokument (50 slidů × 20 objektů = 1000 objektů)
a měří initial sync time pro 5 klientů.

**Thresholds**:

- Initial sync avg < 3000ms
- Encoded size < 1 MB

## Výstup

Každý scénář vypíše JSON summary na stdout. `runAll.mjs` vypíše souhrnný JSON.
Debug log jde na stderr.

## Prostředí

Env vars:

- `NARRATIVE_SERVER_HTTP` (default: `http://localhost:3001`)
- `NARRATIVE_SERVER_WS` (default: `ws://localhost:3002`)

## Referenční hodnoty

Ze spike B (2026-04-19, localhost, Node v22.22.2):

- Hot edit observer latency avg: 0.02ms (p95: 0.04ms)
- Awareness latency avg: 4.49ms (p95: 8.54ms)
- Doc sync (1000 obj): avg 18ms, size 228KB

Produkční WAN latence bude vyšší (5–50ms) — pořád v rámci thresholdů.
