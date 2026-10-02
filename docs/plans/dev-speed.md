# Faster test loops

Status: started 2026-09-30, **in progress** — see "Where it stopped".
Petr stopped the work: the loops of folder-sharing step 1 took far too long,
and this is to be finished next time before new feature work.

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

## Not done: parallel Playwright

Work in progress on branch `wip/e2e-parallel` (one commit on top of the
folder-sharing step 1 commit). What it has:

- `playwright.config.ts`: `fullyParallel`, `PW_WORKERS` (default 6), a
  `parallel` project and a `serial` project (tag `@serial`) that runs after
  it with one worker;
- isolation fixes in `folder-font-preview.spec.ts` and
  `htmltext-texture-isolation.spec.ts`; `idle-cpu-measurement.spec.ts`
  tagged `@serial`;
- the rule for new specs in `.claude/rules/e2e.md` and the
  `playwright-e2e` skill.

Where it stopped: at 6 workers two tests failed; one is in
`slide-transition.spec.ts`, the other was not identified before the run was
stopped. Neither worker counts 4 and 8 nor the stability runs were done.

Next time, in this order:

1. Start the dev stack yourself (`just dev` in a terminal): a background
   task in Claude Code is killed after 2 h and took the stack down mid-run.
2. Check out `wip/e2e-parallel`, run the full suite once at 6 workers,
   fix or tag `@serial` whatever fails (read the failures' traces; no
   retries — `retries: 0` stays).
3. Measure 4 / 6 / 8 workers once each, keep the fastest fully green one.
4. Two green full runs in a row, then merge into `main`.

Target: the full suite in 2–3 min, `just e2e-affected` in well under a
minute for a typical change.

## Where it stopped (2026-10-02, interrupted for a restart)

Uncommitted in the working tree:

- Parallel Playwright (the WIP above, applied): 6 workers green once
  (175 tests, 3.0 min vs 12.9 min), then 2/3 runs failed
  `table-commands` "column boundary … one undo step"; 8 workers 2.6 min,
  4 workers 3.7 min green.
- Root cause found — a real editor bug, not a test problem: every drag
  relied on Yjs' 500 ms undo capture window, so a pause mid-drag (or a
  busy machine) split one gesture into several undo steps. Fix written:
  `beginUndoGesture` / `endUndoGesture` in slide-model `undo.ts` (+
  `undo.gesture.test.ts`), the window-level hook `usePointerUndoGestures`
  in web `state/undoGestures.ts` (+ test), wired into both providers in
  `SlideDocProvider.tsx`; exports classified in
  `parity/slideModelExports.ts`; comments in `EditorLayout.tsx` and
  `TableChrome.tsx`. Unit tests green.
- Last run, 8 workers with the fix: the two drag tests passed; two others
  failed and are not investigated yet — `access-tokens` "create shows the
  token once; revoke kills it" and `object-context-menu` "Duplicate from the
  menu is one undo step" (the latter likely the undo fix: a menu click is
  a pointer gesture — check whether the duplicate lands after the
  gesture closed, or merges with the right-click that opened the menu).

Next: investigate those two, then `just check`, two green full runs at the
chosen worker count, review, commit.

## How to work (applies to every change)

- Tests are written with the code, per sub-step — not in a later round.
- Code review and security review run on the first diff, before any test
  rework.
- While working: `just e2e-affected`; the full `just e2e` once at the end.
- Say up front when a step will take long, and why.
