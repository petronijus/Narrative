# @narrative/perf

The performance harness core — the design is `docs/plans/perf-harness.md`.

| Entry                  | What                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@narrative/perf`      | `defineBench` and the bench registry, statistics, fingerprint types and comparability, counter budgets, the `PERF …` reporter. Pure: no I/O, no side effects at import time — the web app may pull it into a lazily loaded chunk.                                                    |
| `@narrative/perf/node` | The machine half of a fingerprint (git, OS, CPU, load, `pmset` on macOS), the result store under `~/.cache/narrative-perf/<machine>/`, the budget files in `perf/budgets/`.                                                                                                          |
| `src/coverage.ts`      | Every user action and command, benched or exempted with a reason; `coverage.test.ts` is the guard (in `just check`).                                                                                                                                                                 |
| `src/catalog/`         | The benches: `interaction.ts` (layer I, driven from `apps/web/e2e/perf`), `system.ts` (layer S: `deck.open.lighthouse`), `server.ts` (layer S: the agent surface's `command.*` benches, run by `just perf-agent` — `apps/server/perf/agentLatency.ts`). `benches.ts` lists them all. |
| `src/scenes.ts`        | The seeded scenes as command-API ops (`ops.apply`): the crowded slide, the light slide, an N-slide deck. Pure.                                                                                                                                                                       |
| `src/cli/main.ts`      | `just perf`, `just perf-compare`, `just perf-bisect`, `just perf-profile` (`cli/run.ts`), `just lighthouse` (`cli/lighthouse.ts`), `just perf-counters`, `just perf-accept <id…>`.                                                                                                   |

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

A work metric marked `perFrame` counts work the page does once a frame
rather than once an input: a drag's slide-object flush (`y.slideObjects.flush`,
rAF-batched) and the scene updates it applies (`sg.update`). It equals the
moves only where the runtime draws a frame for every input, which is headless
Chromium (`drawsFramePerInput`). WebKit paces its own frames: headless, headed
and in the Tauri window two moves can share a frame and one flush (59 of 60,
85–90 of 90). Every move still arrives there, so `y.tx.local` and the observer
calls stay exact. So `metricsFor(metrics, fingerprint)` turns a `perFrame`
count into a time metric in any other runtime. There it is summarised and
compared like a time and left out of the counter snapshot. The budget check
of such a run covers the per-input counts only (`diffBudget`). A budget is
taken from (`just perf-accept`) and checked against (`just perf-counters`)
the newest dev result that counts every work metric (`budgetResult`), which
for a drag is a headless Chromium run. The drags do not wait for a frame per
move: they would then stop measuring a pointer faster than the display, the
case the batching exists for.

### Run validity: network changes

A network change under the browser invalidates a sample: Chrome aborts every
request in flight, `localhost` included, with `net::ERR_NETWORK_CHANGED`
whenever the OS reports one, and a dropped WebSocket reconnects and
re-syncs — the sample then measured a re-fetch or a reconnect, not the
gesture (SETUP.md → Common first-run failures: a USB-tethered phone
re-attaching ~106 times an hour on the MacBook). The layer I driver
(`apps/web/e2e/perf/lib/driver.ts`, with `apps/web/e2e/fixtures/networkChange.ts`)
watches three things from the first browser context on:

- the host: `os.networkInterfaces()` polled every 100 ms (~50 µs a call; no
  root, no subprocess, every OS) — an interface that comes, goes or changes
  its addresses (`node/networkWatch.ts`; AWDL / LLW churn ignored);
- every context's failed requests whose error text means a network change or
  a network gone (`isNetworkChangeError`: `ERR_NETWORK_CHANGED`,
  `ERR_INTERNET_DISCONNECTED`, `ERR_NETWORK_IO_SUSPENDED`, WebKit's "network
  connection was lost" / "appears to be offline");
- a WebSocket that dropped: its CloseEvent says no close frame (1006,
  `wasClean` false) and page code did not call `close()` on it. Playwright's
  `close` event carries no code, so an init script wraps `WebSocket` in every
  page of a side's context and reports each close (code, `wasClean`, whether
  the page closed it) through a binding. A close the page asked for, or one
  the other end sent a close frame for (1000, 1001, 1011, a server's 4xxx),
  is the app's doing and never counts; a close with no code reported counts
  only next to a host or request signal (`classifySocketClose`,
  `socketCloseDisturbs`). Before this rule, `just perf-compare HEAD .
present.*` (2026-10-23) discarded 9 samples of `present.jump.link` and
  failed `present.build.steps`: present mode closes the slide documents'
  sockets on every jump, with no network event anywhere. With the rule the
  same compare (`--runs 5`) discarded nothing from present mode; it did
  discard one sample whose every socket, on both sides, dropped with 1006 in
  the same millisecond: the dev server restarting (`tsx watch`, an edit of
  `packages/commands` in that second) — a dropped connection that re-syncs,
  which is what the rule is for.

An attempt (warm-up or recorded) that any of them touched — from 3 s before
it started to 0.5 s after it ended (`TOUCH_MARGIN`) — is discarded, whether it
returned values or threw; the driver waits until the network has been quiet
for 2 s and every dropped socket has reconnected, then runs it again in the
same side's turn (`guarded`, `runInterleaved({ guard })`). Each discard prints
a `PERF note <id>: discarded … run N attempt K — <time> <source> <what>` line,
the result a `PERF note <id>: N samples discarded and re-run` line, and the
stored result carries them in `discarded` (attempt, times, the events), as
does the details file. A comparison with a baseline that had discards says so.
After `PERF_NETWORK_RETRIES` (3) extra attempts of one run the bench fails
(`DisturbedRunError`) instead of storing tainted samples, as it does when the
network does not settle within 60 s. `discarded` is optional — results stored
before it are format 1 all the same and read as "none discarded".

The Tauri window has no request events: there the host watcher alone guards
the run. `PERF_SIMULATE_NETWORK_CHANGE=3[,…]` takes the side's context
offline for 300 ms with a request in flight in the given attempts of each
bench (warm-ups count) — Playwright cannot produce a real
`ERR_NETWORK_CHANGED`, but `ERR_INTERNET_DISCONNECTED` travels the same
detection path; such a run is printed, never stored.

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
[--warmup N] [--browser chromium|webkit] [--swiftshader] [--headed] [--shell tauri]
[--device-scale N] [--no-build]` (the
dev stack must be up). Chromium draws with the machine's GPU unless
`--swiftshader`; counts do not depend on it, timings do.
`--headed` draws in a window on the screen, paced by the display as the
Tauri app's window is (a headless WebKit or Chromium paces itself); its
results are a series of their own (`…/webkit-browser-headed`), never
compared with a headless run. In a headed or WebKit run the `perFrame` counts
are time metrics (Statistics above; the run prints a `PERF note` saying so).

`--shell tauri` measures in the Tauri desktop window instead (macOS, the
system WKWebView; `apps/desktop-tauri/README.md` → Measuring it): the same
build and backend, the scene seeded by Playwright, native input; a series of
its own (`…/webkit-tauri`, `…/webkit-tauri-2x` on a Retina screen — a page
at a device scale other than 1 never compares with a 1× one). It cannot run
`present.presenter.window` (a second window) or the cold opens (a fresh
profile per run): those are skipped with the reason. `--device-scale N` sets
the page's devicePixelRatio, in a Playwright context or the Tauri window.
Two diagnostics print without storing: `PERF_ANTIALIAS=off` (WebGL without
MSAA, through an init script) and `PERF_LOW_POWER=1` (WebKit in macOS Low
Power Mode on purpose; otherwise refused).

- **prod** (default) builds `apps/web` with NODE_ENV=production and
  production's relative endpoints (`VITE_API_URL=/api`,
  `VITE_HOCUSPOCUS_URL=/ws`) into `apps/web/dist-perf-prod`, serves it with
  `vite preview` on a free port — its proxies (`apps/web/vite.config.ts` →
  `preview.proxy`) route `/api`, `/ws`, `/imgproxy`, `/storage` to the dev
  backend the way production's Caddyfile routes them — and points Playwright
  at it (`PW_BASE_URL`, `apps/web/playwright.config.ts`);
  A build takes its client variables (`VITE_*`, `VITE_BYPASS_AUTH` among
  them) from this checkout's env files; `NARRATIVE_PERF_CLIENT_ENV_DIR`
  names another checkout's (a git worktree such as `feat/desktop`'s has no
  decrypted `.env`, and without the bypass its build shows the sign-in page);
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
the current dev backend. A worktree's install runs the build scripts its own
`allowBuilds` allows and ignores the rest (`--config.strict-dep-builds=false`:
a revision older than its decline of a script would otherwise fail today's
pnpm); a marker in its `node_modules` says the install finished.
`just perf-bisect <id> <good> <bad> [--runs N] [--warmup N] [--metric m[,m…]]`
searches `good..bad` (first parent) for the first commit that regresses
against `good`, never touching this checkout. Without `--metric` any time
metric's regression or any changed counter stops it there; with it, only the
named metrics count (`--metric react.commits` — a bench reports dozens of
time metrics, and one landing outside its interval by chance would send the
search the wrong way). `just perf-profile <id>` runs once with
a CDP CPU profile (profiling build by default) and prints the top self-time
functions; the `.cpuprofile` lands in `details/` next to the results.

### Growth benches (E8)

`memory.*` (`apps/web/e2e/perf/memory.spec.ts`) measure what a long session
leaves behind. One run is one session in a page of its own: the scene
opened, a pass, the same pass again, a snapshot after each (the scene
settled; in Chromium two full collections through CDP, then the retained
heap — `usedSize + embedderHeapUsedSize + backingStorageSize` of
`Runtime.getHeapUsage` — and `Memory.getDOMCounters`; in every engine the
harness's `memory()`: the GL context's textures and their bytes, the WebGL
contexts alive, the elements, the object URLs not revoked). A pass that ends
where the first ended must leave nothing new: `mem.leak.*`, the second pass's
growth (never below 0), is budgeted exactly, the heap as whole MB over its
noise bound (`MEMORY_HEAP_BOUND_MB`). The time metrics (`mem.heapMB`,
`mem.heap.firstMB`, `mem.heap.growMB`, `mem.textures.first`, …) keep the
signed numbers. The texture bytes are an estimate (4 bytes a pixel, every
mip level; `apps/web/src/perf/glResidency.ts`), followed only on pages that
ask for it before the harness loads (`window.__narrative_perf_residency`):
the wraps on every `bindTexture` stay out of the other benches. A bench may
name its own default runs (`BenchDef.runs`; the growth benches 1 + 3), which
`--runs` / `--warmup` override. Never `performance.memory`: Chromium buckets
it and caches it for 20 minutes.

Each result also writes a details file (`~/.cache/narrative-perf/<machine>/
details/<id>@<mode>-…json`): requests by route, React renders by component,
input latencies by path (canvas / DOM), long tasks, slow events.
