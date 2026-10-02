# Faster test loops

Status: **done** 2026-10-02 (started 2026-09-30).
Started because the loops of folder-sharing step 1 took far too long.

## Why

Measured on the Linux desktop (24 threads) on 2026-09-30:

- The full e2e suite (68 spec files, 175 tests) ran serially
  (`workers: 1`) in **12.9 min**; every `--repeat-each` multiplied it.
- `just check` ran its steps one after another: fmt-check 2 s, typecheck
  15 s, lint 15 s, the unit tests 28 s, the manifest 2 s — about a minute.
- Most lost time was process, not tools: code written first and its tests
  rewritten by a later sub-agent round, then review findings forcing a
  second round; the full e2e suite run repeatedly instead of the specs a
  change needs.

## Done

- **`just check` runs side by side** (`tools/dev/run-parallel.sh`):
  fmt-check first (seconds, the commonest failure), then typecheck, lint,
  the docs check, the unit tests and the manifest check in parallel, each
  logged separately; a failure prints that step's full log. `pnpm -r
--no-sort` lets the packages run concurrently. ~39 s, measured with an
  e2e run loading the machine.
- **`just e2e-affected`** (`tools/dev/e2e-affected.py`): the specs the
  working tree (or `--base REF`) needs, from an `AREAS` table — AGENTS.md
  "When to run what" as code. A shared package, the schema or an app entry
  point runs the whole suite; so does a source file no area claims, and it
  is named so the table can learn it. `just lint-docs` fails when the table
  names a spec that does not exist.

- **Parallel Playwright** (2026-10-02): `fullyParallel`, `PW_WORKERS`
  workers (default 6), and a `serial` project that runs the `@serial` specs
  alone after the parallel ones (`apps/web/playwright.config.ts`; the rule
  for new specs is in `.claude/rules/e2e.md`). The full suite takes
  **2.8 min instead of 12.9** — two green runs in a row, 175 tests, no
  retries. Measured: 4 workers 3.7 min, 6 workers 2.8–3.0 min, 8 workers
  2.6 min but not reliably green on this desktop.

## What running in parallel found

Running the suite in parallel made specs slower and concurrent, and that
exposed real problems besides test isolation:

- **Undo split a slow drag** (editor bug): every drag relied on the undo
  manager's 500 ms capture window to be one step, so a pause mid-drag split
  it and a quick second gesture merged into the first. A pointer gesture is
  now one undo step by its boundaries: slide-model `beginUndoGesture` /
  `endUndoGesture`, web `state/undoGestures.ts`.
- **A late token list hid a new token** (Access tokens page): the first
  list answer overwrote tokens created or revoked meanwhile
  (`pages/accessTokenList.ts`).
- **10 tokens an hour** for the shared e2e identity: POST /access-tokens is
  not rate limited under BYPASS_AUTH (`http/rateLimit.ts`
  `tokenCreateRouteConfig`); production keeps 10 an hour.
- Test bugs: specs counted rows of user-wide lists (connected apps), named
  things by `Date.now()`, waited for a list row behind a modal that
  aria-hides it, waited 5 s for an editor after a reload, and filtered a
  console error by a URL Chrome does not put in the message text.

Open, found on the way, not fixed:

- The sync server logs `FAILED to store snapshot` (foreign key on
  `deck_updates` / `component_updates`) when a deck or component is deleted
  while its document is still loaded: the debounced store runs after the
  delete. Harmless (nothing is lost — the row is gone on purpose), but it is
  logged as an ERROR; the store should skip a document whose deck no longer
  exists, and deleting a deck should unload its document.

## How to work (applies to every change)

- Tests are written with the code, per sub-step — not in a later round.
- Code review and security review run on the first diff, before any test
  rework.
- While working: `just e2e-affected`; the full `just e2e` once at the end.
- Say up front when a step will take long, and why.
