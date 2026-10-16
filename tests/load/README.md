# Narrative — synthetic load harness

Stress scenarios for the sync server in `apps/server` (Hocuspocus 4 behind
Fastify), driven by a hand-written Yjs client (`yjsClient.ts`) that counts
every message and byte.

## Running

```bash
just dev     # the dev stack, BYPASS_AUTH on (the default .env)
just load    # every scenario, one after another (runAll.mjs)
```

One scenario: `pnpm load:hotedit`, `pnpm load:awareness`, `pnpm load:growth`
from the repo root.

`tests/load` is not a workspace package: its `package.json` lists what the
harness imports, all of it hoisted to the root `node_modules` by the apps
that depend on it, and `tsx` runs the TypeScript. Typecheck it by hand after
a change: `node node_modules/typescript/bin/tsc -p tests/load/tsconfig.json
--noEmit` (no lane covers it).

## What a client does

1. Connects, sends an Auth message (the editor's sentinel token `cookie` —
   under BYPASS_AUTH the server admits it as `dev-user`) and waits for
   Authenticated. The server queues everything else until then; a
   PermissionDenied, a close or no answer within 10 s fails the scenario
   with the reason.
2. Syncs (step 1 / step 2), then sends its updates and awareness states.

Each scenario creates its own deck through the API (`POST /decks`) and
deletes it at the end, pass or fail, so it reads nobody's data and leaves
nothing behind. Its objects live under a root type of the harness's own
(`load:objects`, `load:slides`), never the slide model's.

## Scenarios

### hotEdit — 5 concurrent editors

5 clients make 200 mutations each (1000 in all) on one document. Measures
observer latency (receive → applied) and convergence.

Thresholds (spike B): observer latency avg < 20 ms; every replica ends with
the same content (compared structurally — encoded Yjs updates are not
canonical).

### awarenessFlood — 15 peers × 30 Hz

15 clients send awareness states at 30 Hz for 30 s. Each state carries the
time it was sent; every other client records how long it took to arrive
(~185k deliveries a run).

Threshold: delivery latency avg < 100 ms (and at least one delivery).
Node's setInterval reaches only part of the target rate under load (~442 of
450 states/s here); that is not a failure.

### docGrowth — large document bootstrap

Builds a document of 50 slides × 20 objects (1000 objects), then measures
the initial sync of 5 fresh clients.

Thresholds: initial sync avg < 3000 ms; encoded size < 1 MB; every client
converges.

## Output

Each scenario prints a JSON summary on stdout, its log on stderr;
`runAll.mjs` prints the summary of all three and exits 1 when one fails.

Environment: `NARRATIVE_SERVER_HTTP` (default `http://localhost:3001`),
`NARRATIVE_SERVER_WS` (default `ws://localhost:3002`).

## Baselines

`runAll.mjs` warns (without failing) when a headline metric drifts more than
20% the bad way from `tests/load/baselines.json` — a local, per-machine file
(gitignored). Create it from `baselines.example.json` after a clean run on a
quiet machine, with that machine's numbers.

MacBook, 2026-10-15 (two runs, load ~5–7, Node 24.21, dev stack):

| Metric                       | Run 1          | Run 2          |
| ---------------------------- | -------------- | -------------- |
| hotEdit observer latency avg | 0.05 ms        | 0.03 ms        |
| hotEdit ops/s                | 75             | 76             |
| awareness latency avg / p95  | 1.74 / 4.32 ms | 1.20 / 1.76 ms |
| awareness states sent/s      | 442            | 442            |
| docGrowth initial sync avg   | 71 ms          | 47 ms          |
| docGrowth encoded size       | 187 kB         | 187 kB         |

Throughput and sizes repeat; the millisecond latencies spread 30–40% from
run to run, so the example baseline takes the worse run, and a single drift
warning on a latency means little — run again before reading it as a
regression.

Spike B (2026-04-19, localhost, Node 22, before auth): hot edit 0.02 ms
(p95 0.04), awareness 4.49 ms (p95 8.54; then measured send-to-send, not
delivery), doc sync 18 ms at 228 KB. Production WAN latency adds 5–50 ms,
still well inside the thresholds.
