# ADR 0006 — Yjs persistence: snapshot-compaction (PERF-2)

**Status**: Accepted (2026-06-16).
**Supersedes**: the M4 append-only persistence strategy documented in
`apps/server/src/db/schema.ts` and the original
`apps/server/src/hocuspocus/persistence.ts` module header.
**Scope**: `apps/server/src/hocuspocus/persistence.ts` only — the storage
strategy for `deck_updates`, `folder_updates`, and `component_updates`. No
CRDT / wire-protocol / awareness change.

## Context

Every Hocuspocus-backed document (`deck:<id>`, `folder:<id>`,
`component:<id>`) is persisted to Postgres by `PostgresPersistence`. The
original M4 strategy was an **append-only log**:

- `onStoreDocument` called `Y.encodeStateAsUpdate(data.document)` with **no
  target state vector** and `INSERT`ed the result as a new row. With no state
  vector, `encodeStateAsUpdate` encodes the **entire document state** — i.e.
  **every row is already a full, self-contained snapshot**, not a diff.
- Hocuspocus debounces `onStoreDocument` (`debounce: 2000`, `maxDebounce:
10000`), so during an active editing session a fresh full-doc snapshot was
  appended every ≤10 s, and **nothing was ever deleted**.
- `onLoadDocument` `SELECT`ed **all** rows for the doc and replayed each via
  `Y.applyUpdate`.

Consequences (verified by the PERF-2 audit):

- **Write amplification ≈ quadratic per session.** A 1 MB doc edited for an
  hour writes ~360 rows of ~1 MB each (~360 MB) even though the live state is
  1 MB.
- **Cold-load is `O(total-edits × doc-size).`** Loading replays the entire
  history of full snapshots, even though the newest row alone is sufficient.

## Decision

Adopt **snapshot-compaction** (strategy A from the audit). Because every row
is already a full snapshot, we do not need a diff chain — we just prune
superseded rows.

### Store (`onStoreDocument`)

Inside a **single `db.transaction`**:

1. `INSERT` the new full snapshot (`Y.encodeStateAsUpdate(doc)`, unchanged)
   with `RETURNING id`.
2. `DELETE` every row for that doc with `id < <the id just returned>`.

The new snapshot fully supersedes all older rows, so after a successful commit
the table holds exactly **one** row per doc.

### Load (`onLoadDocument`)

Unchanged in spirit: `SELECT` all rows `ORDER BY id` and `Y.applyUpdate` each
(corrupt rows are still skipped individually). Normally there is exactly one
row, but applying _all_ remaining rows is deliberately retained — see
backward-compat below.

### Why A over B (true incremental diffs)

Strategy B (store `encodeStateAsUpdate(doc, lastSV)` diffs keyed off an
in-process state-vector map) is more complex and fragile: the SV map is lost
on every server restart, forcing a full-snapshot fallback, and a single
corrupt diff breaks the whole chain. Strategy A keeps every row
self-contained, needs no in-process state, survives restarts trivially, and
has a far smaller blast radius. The only "cost" is that a store always writes
a full snapshot — which is exactly what the old code already did, so this is
strictly better with no regression.

## Atomicity argument

The insert-new + delete-old pair runs in one transaction, and the `DELETE` is
bounded by `id < newId`:

- It can **never delete the row written in the same transaction** (that row's
  id equals `newId`, and the predicate is strictly `<`). This holds even for
  the first-ever store of a doc that previously had zero rows.
- The commit is **all-or-nothing**. On rollback (crash, deadlock, connection
  drop) the prior row set is left fully intact and Hocuspocus retries on the
  next debounce window.
- There is therefore **no window in which a doc has zero rows or an unloadable
  state**: a reader either sees the full prior row set (tx not committed) or
  the single compacted snapshot (tx committed).

If the `INSERT … RETURNING` yields no id (should never happen), the store
throws _before_ issuing any delete, so compaction is skipped and the row just
written is preserved. `onStoreDocument` swallows and loudly logs DB errors
(as before) so a transient failure never tears down the WebSocket.

## Backward compatibility / migration

- **No schema change.** The three `*_updates` tables keep their existing
  append-shaped columns (`id serial`, FK id, `update bytea`). The composite
  `(<fk>_id, id)` indexes already present serve both the load `SELECT … ORDER
BY id` and the compaction `DELETE … WHERE id < ?`.
- **Existing decks load unchanged.** Decks written by the old code hold many
  full-snapshot rows today. Because each row is a full snapshot and Yjs
  updates are idempotent and commutative, replaying N full snapshots yields
  exactly the same state as replaying only the newest. `onLoadDocument` keeps
  applying all rows, so old multi-row docs load correctly.
- **Lazy compaction.** The **first** store after deploy inserts a new snapshot
  and deletes all older rows for that doc — collapsing historical bloat to a
  single row with no migration job. Docs that are never reopened keep their
  old rows harmlessly until first edit.

## Consequences

- Storage and cold-load drop to `O(doc-size)` per doc.
- Loaded state is **byte-for-state identical** to the old behavior (verified by
  round-trip and OLD-style-many-rows tests in `persistence.test.ts`).
- Version-history (`TODO(M22)`) will need an explicit retention policy
  (keep-N-snapshots or periodic checkpoints) since compaction now discards
  intermediate states; the single-row default is intentional for PERF-2.

## Tests

`apps/server/src/hocuspocus/persistence.test.ts` (rewritten against an
in-memory single-table fake that models the serial id, transaction
commit/rollback, and the delete predicate) covers:

- bounded row count (=1) across repeated store cycles;
- a new-strategy doc round-trips to an identical `objects` state;
- an OLD-style many-row deck loads correctly, then compacts to one row on the
  next store;
- atomicity: a simulated mid-transaction failure rolls back, leaving the prior
  rows intact (no empty/unloadable window) and the doc still loading the last
  good state;
- the same-transaction delete never removes the just-inserted row (first-ever
  store).

`lifecycle.test.ts` (the `unloadImmediately:false` / `debounce` regression
guard) and `auth.test.ts` (viewer write-blocking) had their mock DBs updated to
model the transactional store path and stay green.
