# @narrative/perf

The performance harness core — the design is `docs/plans/perf-harness.md`.

| Entry                  | What                                                                                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@narrative/perf`      | `defineBench` and the bench registry, statistics, fingerprint types and comparability, counter budgets, the `PERF …` reporter. Pure: no I/O, no side effects at import time — the web app may pull it into a lazily loaded chunk. |
| `@narrative/perf/node` | The machine half of a fingerprint (git, OS, CPU, load, `pmset` on macOS), the result store under `~/.cache/narrative-perf/<machine>/`, the budget files in `perf/budgets/`.                                                       |
| `src/coverage.ts`      | Every user action and command, benched or exempted with a reason; `coverage.test.ts` is the guard (in `just check`).                                                                                                              |
| `src/catalog/`         | The benches: `interaction.ts` (layer I, driven from `apps/web/e2e/perf`), `system.ts` (layer S: `deck.open.lighthouse`). `benches.ts` lists them all.                                                                             |
| `src/scenes.ts`        | The seeded scenes as command-API ops (`ops.apply`): the crowded slide, the light slide, an N-slide deck. Pure.                                                                                                                    |
| `src/cli/main.ts`      | `just perf`, `just perf-compare`, `just perf-bisect`, `just perf-profile` (`cli/run.ts`), `just lighthouse` (`cli/lighthouse.ts`), `just perf-counters`, `just perf-accept <id…>`.                                                |

## Statistics

Each bench warms up (3 runs), then runs 15 times. A time metric is summarised
by median, p90 and MAD; two samples are compared by a percentile bootstrap of
the median difference (10 000 resamples, seeded — the same samples always give
the same interval). The verdict is a regression or an improvement only when
the 95 % CI excludes zero **and** the relative change of the medians exceeds
the threshold (5 % unless the bench or metric says otherwise).

Work metrics (`kind: 'work'`: rasters, uploads, renders) must not vary between
runs; they form the counter snapshot compared exactly with
`perf/budgets/<id>.json`.

## Comparability

Results compare only on the same machine and build mode (`dev`, `prod`,
`profiling` — never across modes), browser, shell, GL renderer and power
state. A local build vs a deployed origin, or two deployed versions, compare
only in an explicit A/B (`comparability(a, b, { ab: true })`).

## Machine name and store location

The machine directory is the host name without its domain, lowercased
(`NARRATIVE_PERF_MACHINE` overrides it). The store is
`$XDG_CACHE_HOME/narrative-perf` (default `~/.cache/narrative-perf`);
`NARRATIVE_PERF_HOME` replaces it. Baselines are kept per bench, build mode
and runtime (`fill.solid.mount@prod/chromium-browser`); an accept moves the
replaced baseline to `baselines.history.jsonl`.

## Running the benches

`just perf [ids…] [--mode prod|dev|profiling] [--layer I|C] [--runs N]
[--warmup N] [--browser chromium|webkit] [--swiftshader] [--headed] [--no-build]` (the
dev stack must be up). Chromium draws with the machine's GPU unless
`--swiftshader`; counts do not depend on it, timings do.
`--headed` draws in a window on the screen, paced by the display as the
Tauri app's window is (a headless WebKit or Chromium paces itself); its
results are a series of their own (`…/webkit-browser-headed`), never
compared with a headless run.

- **prod** (default) builds `apps/web` with NODE_ENV=production and
  production's relative endpoints (`VITE_API_URL=/api`,
  `VITE_HOCUSPOCUS_URL=/ws`) into `apps/web/dist-perf-prod`, serves it with
  `vite preview` on a free port — its proxies (`apps/web/vite.config.ts` →
  `preview.proxy`) route `/api`, `/ws`, `/imgproxy`, `/storage` to the dev
  backend the way production's Caddyfile routes them — and points Playwright
  at it (`PW_BASE_URL`, `apps/web/playwright.config.ts`);
- **profiling** is the same build with `react-dom/profiling` and kept
  function names (`vite build --mode profiling`): React render times and a
  readable CPU profile on a prod-like build;
- **dev** runs against the Vite dev server of `just dev`.

The scenarios (`apps/web/e2e/perf/*.spec.ts`, the `perf` / `perf-webkit`
Playwright projects) seed their scenes through the command API, open the deck
with `?perf=1` (which loads the in-page harness, `apps/web/src/perf/`), and
measure each run: settle, zero the counters, record, gesture, settle again.
Per run they report input-to-pixel (event `timeStamp` → the GPU-fenced
editor frame that showed it), rAF frame times, long tasks (Chromium), the
editor's render time, the time the gesture's work went on after the last
input (`settle`), and every counter. Layer I benches warm up twice and run 10
times per side (`--runs` / `--warmup`). Results are fingerprinted, appended
to this machine's store and compared with its baseline; `PERF_VERBOSE=1`
prints each run, `PERF_DISCOVER=1` treats every counter as a time metric and
prints which ones varied (how a bench's budgeted `work` list is chosen).

A scene knob of the old probes (`PERF_TEXTS`, `PERF_IMAGES`, `PERF_RECTS`,
`PERF_PHOTOS`, `PERF_SLIDES`, `PERF_NO_MASK`) still works, but such a run is
printed and never stored: it is not that bench's scene.

`--layer C` runs every bench with work counters twice in dev; then `just
perf-counters` compares them with `perf/budgets/` (`just ci` does both).
Budgets are measured in dev (`BUDGET_MODE`): work counts do not depend on the
GPU, but code requests and React's StrictMode renders differ by mode.

`just perf-compare <revA> <revB> [ids…]` checks each revision out as a
detached worktree under `~/.cache/narrative-perf/worktrees/` (`.` is this
working tree, uncommitted changes included), installs it from the pnpm store,
builds and serves both, and runs them interleaved A B A B on two pages;
verdicts per time metric (bootstrap CI and threshold) and the counter diff
are printed, and the exit code is 1 on a regression or a changed counter.
Both revisions must have the harness (step 2 onwards); the old side talks to
the current dev backend. `just perf-bisect <id> <good> <bad>` searches
`good..bad` (first parent) for the first commit that regresses against
`good`, never touching this checkout. `just perf-profile <id>` runs once with
a CDP CPU profile (profiling build by default) and prints the top self-time
functions; the `.cpuprofile` lands in `details/` next to the results.

Each result also writes a details file (`~/.cache/narrative-perf/<machine>/
details/<id>@<mode>-…json`): requests by route, React renders by component,
input latencies by path (canvas / DOM), long tasks, slow events.
