# Performance harness — benchmarks for every tool, precise regressions

Status: **in progress** (2026-10-18): steps 1–4 built (Log); the `/bench`
route (step 5) and the rest of the catalogue are next. Companion to
`docs/plans/performance.md` (the programme; this is its Phase 0 grown into a
system) and `docs/plans/canvas-performance.md`.

## Why a harness of its own

The probes so far (`e2e/perf-heavy-slide.spec.ts`, `perf-zoom-drag.spec.ts`,
`just load`, `just size`, `just lighthouse`) each answer one question on one
scene, print numbers nobody stores, and cannot tell a 4 % regression from
noise. Narrative has ~146 commands and ~90 user actions — gradient fills,
resize handles, custom fonts, tables, paths, components, animations,
presenting — and each can get slower without anything noticing.

The goal: **every tool has a benchmark, every benchmark has a baseline, and a
regression is caught at the commit that caused it, with the function that
grew.**

## Design principles

1. **Count before you time.** Most regressions show first as _more work_:
   more text rasters, more texture megapixels, more draw calls, more React
   renders, more Yjs observer calls, more requests. These counts are
   deterministic — the same on the 5090, the M3 Pro and SwiftShader — so they
   can be **exact budgets committed to the repo and gated in `just check`**.
   Timings come second, compared only against the same machine.
2. **Coverage is guarded like agent parity.** Every entry of
   `actions/catalog.ts` and every command of the registry names its
   benchmark, or says why it has none (`packages/perf/src/coverage.ts`, a guard test). A
   new tool cannot ship without one.
3. **Same scene, same everything.** Scenes are generated from a seed and
   committed fixtures (fonts, photos, decks); viewport, DPR and zoom are
   pinned; each result carries a fingerprint of the environment.
4. **A/B beats baselines.** The precise answer to "did this commit make X
   slower" is to run both revisions interleaved on the same machine in the
   same minute, not to compare against last week's number.
5. **Engine-neutral where it matters.** The browser layers run in Chromium,
   WebKit and inside the Tauri/Electron shells; CDP-only data is an extra,
   never the only signal.

## Layers

| Layer | What runs                                                                                                                                                       | Where                                            | Signal                                                    | Gate                               |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------- | ---------------------------------- |
| **C** | Counters on the scenarios of B and I                                                                                                                            | browser (any GPU, SwiftShader fine)              | exact counts                                              | `just check` (fast set), `just ci` |
| **M** | Micro: slide-model mutations, `listSlides`, command handlers, `ops.apply`, geometry, `fillStyleToPixi`, animation compile, PPTX parse/write, style-pack compile | Node, `vitest bench`                             | ns/op, allocations                                        | none — trend + A/B                 |
| **B** | Renderer bench: a dev-only `/bench` route mounts a scene into the real SceneGraph/Pixi without the editor UI and runs scripted operations through a bench API   | Chromium, WebKit, Tauri, Electron                | ms per op (GPU-fenced), frames, counters                  | per-machine baseline (warn)        |
| **I** | Interaction: the full editor driven by real pointer and key events, one scenario per action                                                                     | Playwright (Chromium; WebKit with CDP-free mode) | input-to-pixel latency, frame times, long tasks, counters | per-machine baseline (warn)        |
| **S** | System: deck open (cold/warm), 100/300-slide decks, API boot waterfall, MCP/command latency per phase, render jobs, video, PPTX import/export, `just load`      | Node + dev stack / prod build                    | p50/p95 per phase, peak RSS                               | per-machine baseline (warn)        |

### The counters (layer C)

A single `perfCounters` registry in the web app (stripped from production
unless `?perf=1`; a no-op function call otherwise), incremented at the
points that matter:

- renderer: HTMLText rasters started/finished and their megapixels, texture
  uploads (count, Mpx), mipmap generations, draw calls and stencil toggles per
  frame, procedural textures created vs cache hits (gradients —
  `ResourceManager`), filters applied, SceneGraph mounts/updates/destroys per
  object type;
- state: Yjs transactions, `observeDeep` callbacks, `listSlides` calls and
  objects converted, `subscribeToSlideObjects` flushes, autofit measures,
  `measureHtmlText` calls;
- React: commits and renders per component (React Profiler, dev and
  profiling builds);
- network: requests by route (`/api/media/:id/url` per image is a count).

Each scenario's counts are a JSON snapshot in `perf/budgets/<id>.json`. A
change fails `just check` and is accepted with `just perf-accept <id>` — the
diff of the snapshot is the review: "dragging a gradient rectangle now
rasterises 120 texts" is visible in the commit itself.

### Measuring time precisely (layers B, I, S)

- **GPU fence**: an operation is done when the frame that shows it has been
  drawn — measured to a 1-px `readPixels` after the frame (forces the GPU to
  finish), not to the end of the JS call.
- **Input-to-pixel**: `event.timeStamp` of the pointer/key event to that fenced
  frame — the latency a person feels (INP-like), per event, p50/p90/max.
- **Statistics**: warm-up, then N runs (default 15); median, p90, MAD. A
  difference is reported only when the bootstrap 95 % CI of the median
  difference excludes zero _and_ exceeds the bench's own threshold (default
  5 %, per bench override).
- **Fingerprint** on every result: git sha + dirty flag, build mode
  (dev/prod/profiling), browser + version, GL renderer string, OS, CPU,
  power source and Low Power Mode (macOS), load average at start. A WebKit run
  in Low Power Mode is refused (30 fps cap); a dev-build number is never
  compared with a prod-build one.

## Commands

| Command                                   | What it does                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `just perf [ids…] [--mode …] [--layer …]` | run benches (prod build by default), compare with this machine's baseline, print and store results             |
| `just perf-counters`                      | layer C only, against the committed budgets (part of `just check`)                                             |
| `just perf-accept <id…>`                  | rewrite counter budgets / this machine's baseline after an intended change                                     |
| `just perf-compare <revA> <revB> [ids…]`  | build both revisions in worktrees, run them interleaved (ABAB…), report differences with CIs and counter diffs |
| `just perf-bisect <id> <good> <bad>`      | binary search of `good..bad` (first parent) with perf-compare against `good` as the predicate                  |
| `just perf-profile <id>`                  | one run with a CPU profile (CDP), profiling build by default; the `.cpuprofile` and the top functions          |
| `just lighthouse`                         | Lighthouse on a seeded deck of a prod build in front of the dev backend, against this machine's baseline       |
| `just perf-report`                        | a local HTML report: trend per bench per machine, last A/B, coverage                                           | <!-- docs-check: ignore --> |

Results go to `~/.cache/narrative-perf/<machine>/results.jsonl` (append-only),
baselines to `~/.cache/narrative-perf/<machine>/baselines.json` — local,
like `tests/load`. Counter budgets are the only committed numbers.

A release runs `just perf-compare v<previous> HEAD` on the MacBook and the <!-- docs-check: ignore -->
Linux desktop; a regression beyond threshold blocks it unless the CHANGELOG
names it.

## Code layout

```
packages/perf/            bench registry (defineBench), stats, fingerprint, result store, reporters
  src/defineBench.ts      { id, area, layer, actions?, commands?, scene, run, metrics, threshold? }
  src/coverage.ts         actions/commands ↔ benches, exemptions with reasons (guard test)
perf/scenes/              seeded scene generators + fixtures (fonts incl. a custom variable font, photos, decks)
perf/budgets/             committed counter snapshots (layer C)
packages/perf/src/catalog/ the benches' definitions (layer I: interaction.ts, layer S: system.ts)
packages/perf/src/scenes.ts seeded scenes as command-API ops (crowded slide, light slide, N-slide deck)
packages/shared/src/perfCounters.ts the counter registry every site calls (a no-op while off)
apps/web/src/perf/        activation (eager, tiny), the harness chunk: GL/network counters, GPU fence,
                          input-to-pixel, frames, long tasks, settle; later the /bench route
apps/web/e2e/perf/        layer I scenarios and their driver (the old perf-heavy-slide / perf-zoom-drag)
apps/server/perf/         layer S drivers (command API, render queue, import endpoint)
```

`apps/web/src/renderer/applyChanges.bench.ts` (comments in Czech, results in a
handoff note) is rewritten as a layer M bench.

## The benchmark catalogue

Each row is a scenario; most run at several sizes (the scene matrix).
Ids are `area.tool.operation`.

### Fills, strokes, effects

| Id                              | Scene / operation                                        | Watch                                              |
| ------------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| `fill.solid.mount`              | 200 shapes, solid fill — mount                           | baseline for the rest                              |
| `fill.linear.mount` / `.radial` | 200 shapes × 2 / 8 / 32 stops — mount                    | procedural textures created vs cache hits, ms      |
| `fill.gradient.edit-stop`       | drag a stop in the inspector's gradient editor, 60 moves | textures recreated per move (should be 1), latency |
| `fill.gradient.angle`           | rotate the gradient angle                                | same                                               |
| `fill.gradient.resize`          | resize a gradient-filled shape                           | is the texture regenerated per move or scaled      |
| `fill.image.mount`              | image fills on shapes                                    | variant fetched, texture Mpx                       |
| `fill.token.recolour`           | change a folder colour token used by 200 objects         | objects updated, frames                            |
| `stroke.dashed`                 | 200 dashed strokes, then resize                          | geometry rebuilds                                  |
| `effect.shadow` / `.blur`       | filters on 50 objects, then drag one                     | filter passes per frame                            |
| `object.opacity` / `.blend`     | many semi-transparent objects                            | draw calls                                         |

### Transform tools

| Id                                             | Operation                                         | Watch                                       |
| ---------------------------------------------- | ------------------------------------------------- | ------------------------------------------- |
| `transform.move.{rect,text,image,table,group}` | drag 90 moves, per object type                    | input-to-pixel, renders, rasters (expect 0) |
| `transform.resize.{corner,edge,locked}`        | resize by handle; text with autofit; image; table | autofit measures, rasters per move          |
| `transform.resize.multi`                       | resize 20 / 200 selected                          | per-move cost vs selection size             |
| `transform.rotate`                             | rotate handle, 90 moves                           | as move                                     |
| `transform.flip`, `transform.nudge`            | key repeats                                       | latency per key                             |
| `transform.snap`                               | move with snapping on, 224 objects                | snap ms per move                            |
| `select.marquee`, `select.all`                 | marquee over 224 objects; select all on 400       | handles/overlay mount                       |

### Text and fonts

| Id                                  | Operation                                                                                 | Watch                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------- |
| `text.type.{inter,custom,variable}` | type 120 chars in a box with the bundled font / an uploaded custom font / a variable font | input-to-pixel per key, rasters per key |
| `text.type.long`                    | type into a 2 000-word box                                                                | layout ms per key                       |
| `text.paste`                        | paste 10 kB of rich text                                                                  | ms to settled                           |
| `text.font.switch`                  | switch the font of 50 texts                                                               | rasters, font CSS bytes embedded        |
| `font.custom.first-use`             | upload a font to the folder → first text drawn with it                                    | ms, requests                            |
| `font.custom.deck-open`             | open a deck whose 120 texts use 4 custom fonts                                            | font loads, rasters, time to settled    |
| `text.autofit.grow`                 | type until a grow-down box grows over 3 lines                                             | autofit measures per key                |
| `text.spans`                        | bold/colour a selection in a 500-span text                                                | mutation + raster                       |
| `text.edit.enter-exit`              | enter and leave text editing on 50 boxes                                                  | overlay mount, rasters                  |

### Objects and tools

| Id                                  | Operation                                        |
| ----------------------------------- | ------------------------------------------------ |
| `image.insert`, `image.crop`        | insert 10 photos; crop drag                      |
| `image.replace`                     | replace a photo used 20×                         |
| `video.mount`, `video.scrub`        | 5 videos; poster → playing                       |
| `path.edit.points`                  | drag a point on paths of 50 / 500 points         |
| `path.draw`                         | pen tool, 200 points                             |
| `shape.polygon`, `line.arrow`       | mount + resize                                   |
| `table.cell.type`                   | type in a cell of a 10×10 / 30×10 table          |
| `table.row.add`, `table.col.resize` | add rows; drag a column border                   |
| `component.instance.mount`          | 50 instances of a component                      |
| `component.master.edit`             | edit the master → propagate to 50 instances      |
| `layout.apply`, `style.restyle`     | apply a layout / a style pack to 20 / 100 slides |

### Slides, decks, viewport, collaboration

| Id                                     | Operation                                                        |
| -------------------------------------- | ---------------------------------------------------------------- |
| `deck.open.{cold,warm}.{10,100,300}`   | open → first paint → all thumbnails                              |
| `slide.switch`                         | switch between two crowded slides                                |
| `slide.add` / `.duplicate` / `.delete` | in a 100-slide deck                                              |
| `slide.reorder`                        | drag a slide in a 100-slide deck (thumbnails re-rendered: count) |
| `viewport.zoom.{wheel,pinch}`          | 40 / 120 / 300 texts                                             |
| `viewport.pan`                         | pan a crowded slide                                              |
| `history.undo.big`                     | undo a 200-object paste                                          |
| `collab.remote.edits`                  | apply 50 remote edits/s from a second client while dragging      |
| `collab.awareness.peers`               | 15 peers' cursors moving                                         |

### Animation and presenting

| Id                                | Operation                                                                                                                                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `animation.compile`               | layer M: compile a 50-step timeline                                                                                                                                                                            |
| `animation.timeline.scrub`        | scrub the timeline                                                                                                                                                                                             |
| `animation.play`                  | play 30 concurrent animations: frame times                                                                                                                                                                     |
| `present.advance.{text,photo}` ✅ | a pass through 12 slides and back after ready (present.spec.ts): frames missed, longest frame, long tasks, time to ready; rasters, uploads, mounts, decodes, requests and thumbnails after ready budgeted at 0 |
| `present.transition.all` ✅       | the same over none, fade, push ×4, cube and magic                                                                                                                                                              |
| `present.build.steps` ✅          | afterPrevious chains, onClick steps (clicked), withPrevious groups, moveTo                                                                                                                                     |
| `present.video.play` ✅           | a 10 s 1080p video slide played 3 s, there and back                                                                                                                                                            |
| `present.jump.link` ✅            | slide links to a slide far away and back, three times                                                                                                                                                          |
| `present.presenter.window` ✅     | the pop-out presenter window drives the pass; its own work is counted too                                                                                                                                      |

### Agent surface, workers, import/export (layer S)

| Id                                        | Operation                                                                                                                   |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `command.<id>`                            | each command through the command API, p50/p95 per phase (admit, load, transact, store, audit) — generated from the registry |
| `ops.apply.{10,100}`                      | atomic batch                                                                                                                |
| `deck.build`                              | the deck builder playbook's command sequence, recorded (no LLM)                                                             |
| `render.png.{cold,warm}`, `render.pdf.30` | render worker jobs; queue wait under a PDF                                                                                  |
| `video.transcode.{copy,x264}`             | 1080p / 4K sources; time to poster                                                                                          |
| `pptx.import.{small,real}`, `pptx.export` | time, peak RSS                                                                                                              |
| `server.boot`, `api.editor-boot`          | boot-to-ready; the editor's boot waterfall                                                                                  |

## Build order

1. ✅ `packages/perf` core (defineBench, stats, fingerprint, store, compare
   output) and `perfCounters` with the renderer and state counters.
2. ✅ Port `perf-heavy-slide` and `perf-zoom-drag` into it as the first layer I
   scenarios; add the GPU fence and input-to-pixel.
3. ✅ Counter budgets for the first ~20 scenarios — in `just ci`, not `just
check` (they need the dev stack; Log); the coverage guard with today's
   gaps listed as exemptions ("not yet benched").
4. ✅ `perf-compare` (worktrees, prod builds, interleaving, CIs) and
   `perf-bisect`.
5. The `/bench` route (layer B) and the fills/transform/text catalogue rows.
6. Layer S drivers; then the rest of the catalogue, area by area, alongside
   the programme's workstreams — each optimisation lands with its bench.
7. The HTML report; WebKit/Tauri runs of layers B and I.

## Decisions

- **The bench ships in production too** (Petr, 2026-10-18), so a deployed
  build — in a browser, the Tauri and the Electron shell — can be benched
  against production. Conditions:
  - `/bench` and `perfCounters` are a lazily loaded chunk: nothing of the
    harness is in the editor's bundle, and with `?perf=1` absent each counter
    site costs one call to a no-op (checked by `just size` and a counter-off
    run of the probes).
  - `/bench` draws synthetic scenes from its own fixtures in the browser; it
    reads and writes no deck, folder or media of the user, needs a signed-in
    session like any route, and adds no server route of its own. Results stay
    in the page (copy/download) unless the local harness drives it.
  - The `security-reviewer` agent reviews it before it ships.
- **A third build mode, `profiling`** (Petr, 2026-10-18): a production build
  with `react-dom/profiling`, so React render counts are measured on a
  prod-like build. `just perf` builds dev / prod / profiling; results of <!-- docs-check: ignore -->
  different modes are never compared with each other.

## Open questions

- Exact counter budgets vs a small tolerance: exact is the strongest signal
  but some counts (frames during a timed gesture) are not deterministic —
  only work counts are budgeted, never frame counts.

## Log

- 2026-10-18, step 1 (core, not committed yet): `packages/perf`
  (`@narrative/perf`, README there). Delivered:
  - `defineBench` + registry (`src/defineBench.ts`): ids `area.tool.operation`
    validated, area = first segment; metrics declare unit, direction and kind
    — `work` (deterministic counts, budgeted exactly; `runBench` refuses one
    that varies between runs) or `time` (per-machine baselines).
    `src/benches.ts` is the one list of benches — empty until step 2.
  - Stats (`src/stats.ts`): warm-up + N runs, median / p90 / MAD, a seeded
    (mulberry32) percentile bootstrap of the median difference, and
    `compare`: regression / improvement only when the 95 % CI excludes 0
    **and** the relative change of the medians exceeds the threshold (the
    point estimate against the threshold, not the CI's near bound).
  - Fingerprint (`src/fingerprint.ts` types and comparability;
    `@narrative/perf/node` collects it): git sha + dirty, build mode
    `dev | prod | profiling` plus its source (a local build, or a deployed
    origin + its `/version.json` version), OS, CPU, load, Node, macOS power
    source and Low Power Mode; `browser` / `gl` fields for the browser layers.
    Never comparable across machines or modes (not even in an A/B), browsers,
    shells, GL renderers or power states; local vs deployed and two deployed
    versions only with `{ ab: true }`. `refuseToRun` refuses WebKit in Low
    Power Mode.
  - Result store (`src/node/store.ts`): `results.jsonl` (append-only),
    `baselines.json` keyed `<bench>@<mode>/<runtime>`, the replaced baseline
    kept in `baselines.history.jsonl`.
  - Counter budgets (`src/budgets.ts`, `src/node/budgetFiles.ts`):
    `perf/budgets/<id>.json`, exact diff ("text.rasters: 0 → 120 (+120)"),
    a check that budgets and benches agree (in `just check`).
  - Coverage guard (`src/coverage.ts` + `coverage.test.ts`, in `just check`):
    all 93 user actions and 146 commands seeded as "not yet benched", grouped
    by catalog section / command domain; a new action or command fails until
    listed, an exemption for a benched or vanished id fails too. The step 3
    item "the coverage guard with today's gaps listed" is therefore done.
  - Reporter (`src/report.ts`): aligned `PERF …` lines for results,
    comparisons, budget diffs and the fingerprint.
  - `just perf-counters` (coverage summary, budget check, budgets vs this
    machine's latest counters) and `just perf-accept <id…>` (latest result →
    budget and/or baseline).
  - The browser-safe core imports nothing of Node (a test enforces it), so the
    `/bench` chunk can carry it (Decisions).
- Left for step 2 (done below): `perfCounters` in the web app, the layer I
  ports, the GPU fence, input-to-pixel, the `perf` recipe, the first budgets.
- 2026-10-18, **steps 2–4** (not committed yet). Delivered:
  - **Counters** (`packages/shared/src/perfCounters.ts`): `perfCount(key)` /
    `perfCountFor(key, sub)` write into `globalThis[Symbol.for('narrative.perf.counts')]`
    (a symbol since 2026-10-18: a string-named global can be shadowed by a
    page element's `id` through named access on `window`);
    while it is unset (every page without `?perf=1` in a production build,
    the server, the workers, the unit suites) a site is a call that returns at
    once. On globalThis rather than in a module variable: the boot code sets
    it without importing the module, which Rolldown otherwise split into a
    chunk of its own, modulepreloaded on every page. Sites: HTMLText rasters
    started / finished / kpx, editor (`text.*`) and thumbnails (`thumb.text.*`,
    `patchHTMLTextRace.ts`); Pixi's `measureHtmlText` through
    `HTMLText.updateBounds` (`renderer/htmlTextMeasureCounter.ts`); SceneGraph
    mount / update / destroy per object type; procedural textures created vs
    cache hits; filters; text resolution restages; thumbnails rendered, live
    and live-unsettled; autofit measures; Yjs transactions local / remote
    (`SlideDocProvider`, attached only when counting); `listSlides` calls and
    objects converted; the slide-model observers (`observeDeep` callbacks per
    subscription kind, slide-object flushes).
  - **Activation** (`apps/web/src/perf/activation.ts`, eager): `?perf=1` in
    any build starts the counters before the app renders, loads the harness
    chunk, and makes the canvas wait for it before Pixi starts (so its GL
    counters see the first frame); dev counts always, and
    `window.__narrative_perf_load()` loads the harness on demand. The
    selection hooks the specs use (`SelectionContext`) answer in dev and with
    `?perf=1`. The canvas registers app, scene graph, scheduler and the
    renderer's pending loads (`registerPerfCanvas`).
  - **The harness chunk** (`apps/web/src/perf/harness.ts`, lazy, 8.1 kB / 3.5
    kB gz; Pixi-side helpers in `renderer/perfProbes.ts`, pure parts in
    `apps/web/src/perf/measure.ts` with unit tests): the WebGL prototypes wrapped as the
    old probe did (draw calls, stencil, mipmaps, texture uploads and kpx with
    the overloads read correctly, buffers, framebuffer binds; editor context
    vs `gl.thumb.*`), resources by route and bucket, long tasks and Event
    Timing where they exist, a rAF frame recorder, the editor's
    `renderer.render` timed; **the GPU fence** — a 1-px `readPixels` right
    after the editor frame that follows an input or a `fence()` call — and
    **input-to-pixel**: pointer, wheel and key events from `event.timeStamp`
    to that fenced frame, or to the next painted frame when no canvas frame
    followed (a DOM-only input); `settle()` (nothing moved for 800 ms: no
    counter, frame, raster, restage or load). React render counts come from
    a DevTools hook the Playwright driver installs before the page loads
    (`e2e/perf/lib/reactHook.ts`): React reads the hook while its chunk
    evaluates, before any lazy code could, and `<Profiler>` only times
    subtrees — so a hand-opened `?perf=1` page has no React counts.
  - **Build modes**: `vite build --mode profiling` aliases `react-dom/client`
    to `react-dom/profiling` and keeps function names; `vite preview` gets
    production's Caddy routes as proxies (`/api` stripped, `/ws`,
    `/imgproxy`, `/storage`) and perf builds use production's relative
    endpoints, so a preview on any port talks same-origin to the dev backend
    (`packages/perf/src/node/webBuild.ts`). `PW_BASE_URL` overrides
    Playwright's base URL (G1).
  - **Layer I** (`packages/perf/src/catalog/interaction.ts`, driven by
    `apps/web/e2e/perf/`): 17 benches — `editor.idle.crowded`,
    `transform.nudge.rect`, `transform.move.{rect,text,image,multi}`,
    `viewport.zoom.wheel`, `text.type.inter` (the old crowded-slide probe),
    `viewport.zoom.wheel.light`, `transform.move.rect.light` (the old
    zoom-drag probe; both old specs are gone), `deck.open.{cold,warm}.{10,100}`,
    `slide.{switch,reorder,add}.100` (G3). Scenes are command-API ops
    (`packages/perf/src/scenes.ts`) — the same seeding for dev, prod and both
    sides of an A/B — and photos generated once with fixed seeds. Every
    bench reports the gesture metrics and every counter; its `work` list is
    budgeted exactly, the rest are timed counters. The old knobs work
    (`PERF_TEXTS/IMAGES/RECTS/PHOTOS/SLIDES/NO_MASK/GPU`); a changed scene is
    printed, never stored. CDP-free except `perf-profile`; WebKit refuses to
    run in Low Power Mode (checked: it does). Each prod/profiling side first
    opens its deck without `?perf=1` and asserts no harness chunk is fetched
    and nothing counts (the counter-off probe).
  - **Commands**: `just perf` (default prod; `--layer C`, `--browser webkit`,
    `--swiftshader`, `--runs`), `just perf-compare` (worktrees under the
    cache, ABAB through `runInterleaved`, exit 1 on a regression or a counter
    change; an A/A run of the working tree against itself: no change, counters
    equal), `just perf-bisect` (binary search over `good..bad` first-parent
    commits, compare against `good`; nothing touches this checkout),
    `just perf-profile` (CDP CPU profile, the input fence off — under the
    profiler a `readPixels` per frame stalled a drag to 107 s), `just
lighthouse` (G2: `deck.open.lighthouse`, layer S). `PERF_DISCOVER=1` prints
    which counters varied — how the `work` lists were chosen.
  - **Budgets**: 17 files in `perf/budgets/`, measured in dev
    (`BUDGET_MODE`). `just perf-gate` (`just perf --layer C` + `just
perf-counters`) takes **8.2 minutes** on the MacBook (it needs the dev
    stack and seeds three scenes), far over the ~20 s a `just check` step may
    take, so it is part of **`just ci`**, not `just check`; `just check` keeps
    the static half (budgets vs benches, coverage). Coverage: 5 actions and 4
    commands are benched now.
  - **Size** (`just size`): the main chunk 44.66 → 44.91 kB gz, the first
    paint 623.40 → 623.66 kB (the counter sites, the activation module); no
    budget is near its limit and no new chunk is preloaded; the harness chunk
    is fetched only with `?perf=1`.
  - **First baselines** on this MacBook in dev, prod and profiling (10 runs
    - 2 warm-ups each; results, baselines and details files in
      `~/.cache/narrative-perf/petrs-macbook-pro/`); numbers and findings in
      `docs/plans/performance.md` → Log.
- Open after step 2:
  - WebKit (G6's other half) and the Tauri window: not run — Low Power Mode
    was on. On Linux `just perf --browser webkit` would need the Playwright
    container `just e2e-webkit` uses; not wired.
  - The baselines were taken on a busy machine; re-accept on a quiet one
    before trusting a 5 % verdict.
  - `perf-compare` needs the harness on both sides: revisions before this
    step cannot be measured, and an old side talks to today's dev backend.
  - The drag budgets assume one transaction per pointer move (Playwright paces
    them); if Chromium coalesces moves on a slower machine they would move.
  - The old probe's CDP `Performance.getMetrics` breakdown (script / layout /
    style ms) was not ported; the CPU profile replaces it.
  - The `security-reviewer` review of the `?perf=1` surface (Decisions) is
    still to happen, as are `/bench` (step 5), `perf-report` and the layer M
    rewrite of `renderer/applyChanges.bench.ts`.
