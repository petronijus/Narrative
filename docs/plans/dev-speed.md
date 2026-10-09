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
- **A worker budget for the unit tests** (2026-10-07): `just test` gives
  each vitest a quarter of the cores (`VITEST_MAX_WORKERS`, four packages
  at once). Unbudgeted, four vitests started a worker per core each, and on
  the 12-thread MacBook `just check` took 117–177 s at a load of 85 and
  timed out property and web tests (0.2 s alone, over 5 s there). Budgeted,
  the MacBook's `just check` is green in ~70 s.
- **`just e2e-affected`** (`tools/dev/e2e-affected.py`): the specs the
  working tree (or `--base REF`) needs, from an `AREAS` table — AGENTS.md
  "When to run what" as code. A shared package, the schema or an app entry
  point runs the whole suite; so does a source file no area claims, and it
  is named so the table can learn it. `just lint-docs` fails when the table
  names a spec that does not exist.

- **Parallel Playwright** (2026-10-02): `fullyParallel`, `PW_WORKERS`
  workers (default 6 here; see below), and a `serial` project that runs the `@serial` specs
  alone after the parallel ones (`apps/web/playwright.config.ts`; the rule
  for new specs is in `.claude/rules/e2e.md`). The full suite takes
  **2.8 min instead of 12.9** — two green runs in a row, 175 tests, no
  retries. Measured: 4 workers 3.7 min, 6 workers 2.8–3.0 min, 8 workers
  2.6 min but not reliably green on this desktop.
  Since 2026-10-07 the default is a worker per four hardware threads (still
  6 there): on the 12-thread MacBook 6 workers ran the suite at a load of 60
  in 27 min with 83 tests failing, mostly timeouts; 3 workers took 12.6 min
  with 171 passing. Of the 14 that failed there: the specs pressed Linux
  caret keys (`Control+Home`, `End`, `Control+z` — now `e2e/fixtures/keys.ts`
  and `ControlOrMeta`); the OAuth consent spec's `page.route` missed the
  callback redirect on Playwright's own Chromium (now a real loopback
  listener); the pixel-budget spec needs ~25 s a zoom level there (its own
  timeout); `slide-clipboard` needs an absolute `IMGPROXY_ENDPOINT`, which
  the overlay's dev env lacks (HANDOVER); the other seven passed alone, i.e.
  load.

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

Also fixed on the way (2026-10-02): the sync server logged
`FAILED to store snapshot` (a foreign-key error) whenever a deck or
component was deleted while its document was still loaded — the debounced
store ran after the delete. A store now locks its owner row `FOR KEY SHARE`
and stores nothing when it is gone (`hocuspocus/persistence.ts`,
`persistence.integration.test.ts`); deleting a component or a folder now
also closes the connections on its documents, as deleting a deck does.

Seen only while another build loaded the machine (load 25–42: a Gradle
build, then an ARM kernel cross-compile) on 2026-10-02; the full suite on
the quiet machine right after was green, 175/175 — load artefacts, not
bugs. Watch for them; a run on a loaded machine proves little:

- `folder-tokens` "a colour token changed while the deck is open…" and
  `htmltext-texture-isolation` "rapid invalidations…": the Pixi canvas
  painted nothing at all for 15–20 s (objects mounted, canvas blank) — the
  headless GPU path starving, not token logic.
- `component-promote-stamp`: the cleanup `DELETE /folders/:id` timed out at
  90 s (also seen once on 2026-09-30).
- `layer-reorder` once failed with "no live deck document (the provider is
  between mounts)" right after a cold start of the stack; not reproduced in
  22 repeats.

## Test tiers

- `just check` (~40 s) on every change — the Stop and pre-push hooks run it.
- `just e2e-affected` while working: the specs of the areas the change
  touches. The page shell, static files and styles get the smoke set.
- `just e2e-smoke` (~10 s, five specs): the app boots, paints, presents and
  opens a share link.
- `just e2e` (~3 min) once — before a release, after a change to a shared
  package or the schema, or when e2e-affected asks for it.

## How to work (applies to every change)

- Tests are written with the code, per sub-step — not in a later round.
- Code review and security review run on the first diff, before any test
  rework.
- While working: `just e2e-affected`; the full `just e2e` once at the end.
- Say up front when a step will take long, and why.
