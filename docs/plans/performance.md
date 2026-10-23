# Performance programme — the whole project

Status: **in progress** (since 2026-10-18; Phase 0 built — G1–G8, the last
three 2026-10-20 — most workstream items done or measured by 2026-10-21; what
is left: "Remaining backlog" below, every number in the Log). Goal: Narrative as fast
as it can be — load, editing, big decks, presenting, the agent surface, the
workers, import/export, deploy and the developer loop — accepting months of
work. `docs/plans/canvas-performance.md` stays the detailed plan for crowded
slides (steps 1–2 done, step 3 in progress); this file is the umbrella.

## Ground rules

- **Measure first, every step before and after**, with the same probe and
  scene; a step ships when its numbers move. No number without its build mode
  (dev / prod), machine and power state.
- **Prod-build numbers are the truth.** Everything measured so far ran on the
  Vite dev server (React's dev build, 2–3× slower); calibrate before trusting
  React-side figures.
- **macOS Low Power Mode caps WebKit at 30 fps** (Safari, WKWebView/Tauri,
  Playwright WebKit; measured 2026-10-18: 33 ms → 17 ms frame interval when
  switched off). WebKit runs on the MacBook need it off; the probe should
  refuse or flag otherwise.
- Nothing changes what a slide looks like. Architecture rules (Yjs only,
  commands, SceneGraph diff, animation DSL) hold.
- Machines with baselines: Linux desktop (RTX 5090), MacBook (M3 Pro),
  Omarchy.

## Where we stand (2026-10-18, MacBook, Chromium + ANGLE Metal, dev build, 224 objects)

| Gesture                   | fps   | Longest frame | Long tasks           |
| ------------------------- | ----- | ------------- | -------------------- |
| drag rect / text / image  | 49–53 | 183–300 ms    | 1–8                  |
| typing 60 chars           | 48    | 233 ms        | 3 (225 ms)           |
| after an edit (thumbnail) | 59    | 33 ms         | 0                    |
| zoom wheel + settle       | 33    | 750 ms        | 6 (499 ms)           |
| masks removed (drag)      | 53    | 150 ms        | draw calls 44k → 810 |

Masks cost little on the M3 Pro. Software rendering (SwiftShader) is unusable
(1 fps) — irrelevant for users, relevant for the render worker (R1).

## Phase 0 — measurement (first, all small)

The items below are the first steps of the performance harness designed in
`docs/plans/perf-harness.md` (counters gated in `just ci`, a benchmark
per tool, A/B comparison of revisions, bisect). ✅ = built in step 2 of the
harness (2026-10-18, Log), unless the row gives another date; G6's WebKit
runs, waiting for a Mac with Low Power Mode off, ran on 2026-10-20 (Log).

| Id               | What                                                                                                                                                                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 ✅            | Prod-build run of the perf specs: `NODE_ENV=production vite build` + `vite preview` on :5173 (the proxies carry over), a `PW_BASE_URL` override in `playwright.config.ts`                                                                                                                                                   |
| G2 ✅            | Fix `just lighthouse`: it builds without `NODE_ENV=production` and audits `/` of a backend-less preview (the login page). Audit `/deck/:id` of a seeded deck; make it a gate                                                                                                                                                |
| G3 ✅            | Deck-size probe: `PERF_SLIDES=100` — drag/typing on slide 1, slide switch, open → first paint, open → all thumbnails, reorder                                                                                                                                                                                               |
| G4 ✅ 2026-10-20 | Collect `state/loadTimings.ts` (deckLoad → wsSynced → firstPaint), long tasks and INP from real sessions (Sentry or `/api/metrics`). Built as `POST /api/client-metrics` → `/metrics` histograms + a log line (Log; `docs/ops.md` → Client session metrics); no number from a real session until the next release           |
| G5 ✅            | Per-machine baselines and a regression gate for the browser probes (the `tests/load` pattern: gitignored `baselines.json`, ±20 %), as `just perf`                                                                                                                                                                           | <!-- docs-check: ignore --> |
| G6 ✅            | A CDP-free mode of the crowded-slide probe (rAF frames, long-task observer, a raster counter — W3) so the same scene runs in WebKit and the Tauri window                                                                                                                                                                    |
| G7 ✅ 2026-10-20 | Server-side probes with fixed inputs: command/MCP latency per phase, render job cold vs warm, PPTX import/export time and peak RSS on a real-size deck. Built: `just perf-agent` (37 layer S benches, server phases) beside `just perf-pptx` (2026-10-18); four server hotspots and the render pool's recycling fixed (Log) |
| G8 ✅ 2026-10-20 | `just load` scenario on real slide-model decks of 100 and 300 slides. Built: `tests/load/deckScale.ts` (Log)                                                                                                                                                                                                                |

## Workstreams

Ids are those of the survey (2026-10-18). [code] = visible in code;
[hyp] = to be proven by the measurement named. S = days, M = 1–2 weeks,
L = a month or more.

### A. Load and first paint

- **L1 (S–M) ✅ 2026-10-18** Vendor chunks preloaded on every route, login included: Pixi,
  Tiptap (used only by `SlideNotesPanel`/`PresenterOverlay`), Radix, Yjs. The
  catch-all `vendor` group swallows zod, Sentry, tus, tailwind-merge. Drop the
  catch-all, move Inter's registration off Pixi's `Cache` import in
  `main.tsx`, lazy-load notes/presenter/tus. Budgets per route in `just size`.
  Done (Log, 2026-10-18): login 604 → 125 kB gz, editor 912 → 708.
- **L2 (M) ✅ 2026-10-18** EditorLayout chunk (110 kB gz) has no `lazy()`: dialogs, timeline,
  table inspector, crop/path overlays. Done (Log): 100 → 64 kB gz; the
  timeline stays eager (it is on the first paint).
- **L3 (M) ✅ 2026-10-20** One `GET /api/media/:id/url` per image (several queries each), then
  always the 2560-px variant: batch the URLs per deck, add a ~1280 variant
  chosen by on-screen size × DPR × zoom. Done (Log): one `GET
/api/media/urls` per deck open (40 pictures: 44 → 1 lookup), `medium`
  (1280) drawn wherever it covers the canvas's pixels; present mode's
  picture bytes 27.0 → 3.3 MB at 1×, 9.3 MB at 2×.
- **L4 (M) ✅ 2026-10-20** No local Y.Doc persistence: every open waits for a full sync.
  IndexedDB persistence → repeat opens paint at once. Done (Log;
  [ADR 0017](../adr/0017-local-document-copies.md), `docs/auth.md` → Local
  document copies): a copy of what the server confirmed, guarded by a
  document epoch (migrations 0041, 0042); a warm 100-slide open mounts
  562 → 489 ms and its sync step 2 is empty. Open: offline opening (desktop
  D1), a journal of pending edits (D2).

### B. Editor runtime

- canvas-performance.md steps 3–5: zoom staging done 2026-10-18 (one commit
  per gesture, staging paused during it, long-task budget; Log); text
  measurement needs an upstream Pixi option; mipmaps stay (measured < 1 ms).
- **E1 (M) — done 2026-10-18** (Log): every edit deep-copied the whole deck
  ~7× per frame: `useSlides()` → `listSlides()` on an `observeDeep` of all
  slides, 14 callers, each new array defeating `SlideItem`'s memo. Now one
  shared, structurally shared deck store per document
  (`packages/slide-model/src/deckStore.ts`: invalidation by Yjs event path,
  per object / per slide snapshots reused) with selector hooks
  (`apps/web/src/state/useDeckStore.ts`); `useSlides`, `useSlideObjects`,
  `useAnimations` and the active-slide provider read it.
- **E2 (M) — faces done 2026-10-18** (Log), without patching Pixi: a text
  embeds only the faces its weights and slopes match (keys written by
  `renderer/pixiFontSink.ts`, the browser's matching in
  `renderer/fontFaceMatch.ts`), and a text with nothing to embed names no
  key, so WebKit skips Pixi's 100 ms wait for it. Open: the wait itself for
  embedded fonts (upstream, Log), the raster cache (E3).
- **E3 (M)** Slide switch re-mounts and re-rasterises everything: raster cache
  (E2) + idle pre-mount of neighbours.
- **E4 (S) — done 2026-10-18** (Log): autofit re-measured grow-down texts on
  every change, positions included (`autofitHeights.ts`); a change of
  non-layout keys only (position, rotation, compositing, editor-only keys) is
  no longer measured. The open item (reuse the on-canvas layout for
  typing) **done 2026-10-20** (Log): the canvas takes autofit's measurement
  (`renderer/htmlTextBoundsMemo.ts`), `text.measure.bounds` 123 → 63 a
  60-key run. Open: autofit's throwaway container per key; Pixi's own
  measurement inside the raster (upstream).
- **E5 (M) — done 2026-10-20/21** (Log) Tables: one HTMLText per cell. Now a
  table's cell rasters are drawn together in Chromium
  (`renderer/htmlTextGroupRaster.ts`: mount 96 → 2 rasters, font CSS 6 098 →
  131 kB, mount frame.max 283 → 83 ms). **Chromium only**: WebKit keeps
  Pixi's raster per cell (`GROUP_RASTER_SUPPORTED`), because there the shared
  SVG lost its embedded Inter face and poisoned the page's later SVGs. Every
  HTMLText uploads once instead of twice in both engines
  (`patchHTMLTextRace`), and the pre-existing stale-texel bug of pooled text
  textures (ghosts of earlier texts in thumbnails' mip levels) is fixed for
  every text (`wholeTextureCanvas`). The pixel proof
  `e2e/table-raster-pixels.spec.ts` passes exactly, Chromium 3/3 and WebKit;
  four table benches with budgets. Open: WebKit's table mount still ~1 s;
  grouping in WebKit; text boxes sharing images the same way.
- **E6 (M) — done 2026-10-18** (Log): inspector, timeline, overlays, layers and
  slides panels select by id on E1's store; EditorLayout reads objects only
  in handlers (the overlays that draw objects are `ActiveObjectOverlays`).
  The open item (the Inspector's sections of a text box rendered with every
  keystroke: a Y.Text change gives no field to compare) **done
  2026-10-20** (Log): the Inspector selects fields, not snapshots
  (`sameObjectFields`), the body's state comes from `ui/useTextRunAttrs.ts`;
  React renders a 60-key run 12 865 → 1 213. Open: the canvas overlays of the
  edited box still render once a key (~9 renders); the TableInspector
  subscribes to the selection directly.
- **E7 (L) — spike done 2026-10-20/21** (Log; [ADR 0018](../adr/0018-canvas-text-from-the-browser-layout.md),
  proposed) Text rendering without SVG foreignObject (Canvas2D glyph runs in a
  worker, or MSDF atlases) — the structural fix for zoom, WebKit and memory.
  Starts as a measured spike in both engines. Measured four ways; the
  recommendation is (a2): the browser lays out the same markup + CSS, a
  worker paints the glyph runs (121 of 121 crowded texts pixel-exact in both
  engines). The port (L, 3–5 weeks) waits for the ADR's approval.
- **E8** Heap and GPU-texture growth across slide switches — measure first.
  Not started (2026-10-21).

### C. Big decks (100+ slides)

- **B1** = E1.
- **B2 (M) — done 2026-10-18** (Log): opening queued every slide's thumbnail
  through a second Pixi app with a synchronous PNG encode, each result
  re-rendering the panel; reorder re-rendered every thumbnail. Now a
  thumbnail store keyed by content hash (`renderer/thumbnailStore.ts`): only
  a new picture renders (on reorder only slides with a slide-number leaf),
  visible first, the rest at idle, blobs instead of base64, per-row
  subscriptions, edits debounced to the end of a gesture, the live slide
  without an offscreen fallback per change.
- **B3 — done 2026-10-20, no virtualisation** (Log) Virtualise the slide panel only if 300-slide decks still show a cost
  after E1. Measured on 300 slides: the cost was every row re-rendering on a
  switch (new callbacks per row); stable row handlers
  (`ui/useStableHandler.ts`) made the panel's renders independent of the
  deck's size (switch 2356 → 1200 React renders). Open: the open still grows
  with the deck (300 rows mounted, every thumbnail drawn).
- **B4 — measured 2026-10-20** (Log) Full-snapshot stores every debounce; a redundant index per updates
  table. Watch as decks grow. The redundant indexes were gone since 0038; a
  300-slide store is 595 kB and 30.8 ms p50, off every command's path: no
  ADR 0006 change yet.

### D. Present mode

**Goal (Petr, 2026-10-18): once the presenter is ready, every advance,
transition, build animation and video runs without a hitch, a blink, a
freeze or a visibly loading slide. A long load before the first slide is
fine; smoothness is never traded for a faster start.** Measured per
advance: dropped frames, the longest frame, long tasks, rasters, uploads,
decodes and network requests after "ready" (all target 0 except frames at
the display's rate).

- **P0 ✅ 2026-10-18** Benches first: `present.*` layer I scenarios on real-size decks
  (text-heavy, photo-heavy, video, builds, every transition type) in
  Chromium and WebKit (the Tauri shell): advance forward/back, jump, the
  presenter window, with the counters above after ready. Built
  (`apps/web/e2e/perf/present.spec.ts`, seven benches, the work after ready
  budgeted at 0) with a visual spec that reads every frame of an advance
  back (`e2e/present-smooth.spec.ts`); Log. WebKit timings wait for Low
  Power Mode off on AC (taken 2026-10-20, headless and headed; the Tauri
  window 2026-10-21 — Log, W1).
- **Regression found and fixed 2026-10-21** (Log): since 23c2e004 (prepared
  slides) present mode drew no background on a slide without one (black);
  now `DEFAULT_BACKGROUND`, as the editor draws it.
- **P1 (S–M) ✅ 2026-10-18** Ready means ready: the whole deck's media fetched and
  decoded, every slide's text rasterised and its textures uploaded, before
  the first slide shows (a progress overlay is fine). Was: slide 1 waited
  for the media download only (up to 30 s), the IndexedDB copy the preload
  wrote was never read, and nothing was decoded or rasterised ahead. Now
  (ADR 0016): inputs loaded, pictures fetched, videos buffered, every slide
  prepared off stage (or a GPU-budgeted window of a big deck), the
  presenter view's pictures rendered — no timer cuts it short; the
  IndexedDB copy is gone.
- **P2 (M) ✅ 2026-10-18** Transitions mounted the incoming slide at click time: the
  slides are kept prepared (mounted, rasterised, uploaded) and an advance,
  a step back or a jump swaps a scene in (`SceneGraph.swapSlideScene`);
  builds are compiled onto the prepared slide before it shows.
- **P3 ✅ (pre-buffering) 2026-10-18** Videos pre-buffered and their first frame decoded
  before their slide (`renderer/presentVideos.ts`). **1080p rendition ✅
  2026-10-19** (Log): a source larger than 1920 × 1080 also gets
  `present.mp4` fitted into it, played when the screen shows no more pixels
  than it has (`renderer/videoRendition.ts`); the original stays for larger
  or denser screens. Open: measure the decode/upload saving in the
  `present.video` bench with a 4K source (not started, 2026-10-21).

### E. WebKit (Safari, the Tauri shell)

- **W1 — done 2026-10-21** (Log; first part 2026-10-18): Pixi waits 100 ms before every
  raster in WebKit whenever a family is named; texts in system fonts (and
  runs in fonts nobody registered) name none now. Texts in embedded fonts
  still wait: Playwright's WebKit draws them correctly without the wait, so
  the upstream option is proposed (Log; posted 2026-10-20 as
  [pixijs/pixijs#12323](https://github.com/pixijs/pixijs/issues/12323), open).
  The Tauri prototype (WKWebView, `isSafari()` true) was on `feat/desktop`
  only (as of 2026-10-18); its perf driver is now in this tree too and the
  benches run in the real window (`just perf --shell tauri`, native
  NSEvents; `apps/desktop-tauri/README.md` → Measuring it): at 1× the shell
  costs nothing against headed WebKit; the 2× misses come from MSAA (W4).
  Open: the presenter window and cold opens in Tauri, a Linux/Windows input
  driver.
- **W2 — first step done 2026-10-18**: SVG bytes per raster now follow the
  faces a text uses (E2); E7 later.
- **W3 ✅ 2026-10-18** A raster counter in the renderer (engine-neutral, feeds G6).
  Built with G6 (`text.raster.started` / `.finished`, the thumbnails' own).
- **W4 ✅ 2026-10-21** AVIF decode at 2560 px (L3), antialias at DPR 2. Measured
  (Log): AVIF stays — its decode runs in Pixi's worker, the main-thread
  cost is the upload (WebKit ~20 ms at 2560 px, ~5 ms at 1280). MSAA off at
  2× halves WebKit's drag (35 → 19 ms p50) but changes vector edges: not
  switched, Petr's call after a pixel comparison and a Chromium A/B.
- Low Power Mode: a lighter editor mode when frames are capped (fewer
  re-rasters in flight), so 30 fps holds without stalls. **Bench path ready
  2026-10-21, run pending** (Log): `PERF_LOW_POWER=1` (`packages/perf/README.md`);
  the run needs Low Power Mode switched on; the lighter mode is designed, and
  built only if that run shows stalls.

### F. Server, collab, agent surface

- **S2 / D1 (S) — done 2026-10-18** (Log; 31409061, `/decks` paging with S3) No compression at the origin (no `encode` in Caddy, no
  `@fastify/compress`); hashed `/assets/*` carry no `Cache-Control`. Add
  `encode zstd gzip`, `immutable` on hashed assets, precompressed files.
  Paginate `GET /decks` (625 kB for the dev user).
- **S3 (M)** Agent writes store a full snapshot per transaction (no debounce),
  each command re-reads tokens/fonts/style pack, atomic `ops.apply` forks the
  whole doc per batch: coalesced stores per run, per-run caches, lazy forks. **Done 2026-10-18** (Log):
  coalesced stores, a per-run folder context, kept batch forks; `GET /decks`
  paged (S2).
- **S5 — built 2026-10-20 with G4** (Log) Measure the editor's boot waterfall (G4).
  The waterfall of the last deck open is in every client session report;
  the first real numbers come after the next deploy.
- **G7's agent surface — 2026-10-20** (Log): the first write after a cold
  load no longer merges the whole document, the op log's two round trips are
  sent together, `query.slide` / `query.deck` read only what they answer.
  Open: the token lookup (~0.5 ms) and the deck role check (~0.7 ms) are now
  the largest warm phases (security checks: caching needs security-reviewer).

### G. Workers

- **R1 (M)** Render worker — **built** (see Log): two jobs at once behind a
  cgroup memory gate, a deck-agnostic warm pool (idle pages recycled across
  sessions), JPEG pages encoded in the page for PDF. Open (as of 2026-10-19):
  (R1a) the slim render entry / an in-place deck switch (touches
  `renderer/` and `state/`), (R1b) the ~0.7 s slide switch of the render
  page, (R1c) the 30-slide photo PDF measured end to end on the job API.
  **Async PDF ✅ 2026-10-19** (Log):
  a PDF is a job (`pdf-export` queue) the editor and the agent poll, so no
  request waits for it and the 95 s window is gone; the render page no
  longer re-reads `/api/decks/:id` per slide. **R1b ✅ 2026-10-20** (Log):
  a warm slide 296–329 → 200–222 ms on the dev stack (12 cores; the ~0.7 s
  was the production image on two cores, 2026-10-18, not re-measured): no
  poll, no second settle, an asynchronous read-back.
  **R1c ✅ 2026-10-20** (Log): the whole 30-slide file 12.4–14.9 → 8.6–10.5
  s on the dev stack; **on the production image under VM 103's limits
  ✅ 2026-10-23** (Log, F5): 23.8–30.8 → 12.0–13.6 s once the render page
  batches 4 textures per draw (a cold one-slide PNG 2.9 → 1.3 s).
  **R1a → [ADR 0019](../adr/0019-render-page-in-place-deck-switch.md):
  measured and closed 2026-10-23** — an in-place switch would save ~0.4 s
  of a session's first job, a slim render entry ≤ ~50 ms; neither built.
- **R2 (S)** Video worker — **built**: poster and thumbnail from one ffmpeg
  run beside the transcode, on the asset before the playback. **The editor
  shows it while processing ✅ 2026-10-19**
  (`renderer/objectRenderers/videoRenderer.ts`, Log).
- **R3 (S)** — **built**: `preview` and `display` warmed through the cache
  after an image upload (`IMGPROXY_WARM_ENDPOINT`). The open item, video posters,
  **✅ 2026-10-20** (Log): the poster's `display` and the thumbnail's
  `thumb` warmed when the video worker reports its stills
  (`media/videoStillsWarm.ts`); a 4K poster's first view 70–129 → 2–9 ms.
- Drivers: `apps/render-worker/perf/render.ts`,
  `apps/video-worker/perf/transcode.ts`, `apps/server/perf/imgproxyWarm.ts`,
  `apps/server/perf/videoStillsWarm.ts`.

### H. PPTX import/export

- **X1 (S) — done 2026-10-18** (Log): media inflated natively and lazily,
  pictures and fonts six at a time under a pixel budget for oversize ones;
  import 2–4× faster, peak RSS down 25–35 % on the real decks. The oversize
  re-encode moved from mozjpeg to libjpeg-turbo (Log).
- **X2 — measured and done 2026-10-18** (Log): `just perf-pptx` (G7's PPTX
  part); export 3–9× faster (no JS deflate of compressed media, assets
  fetched six at a time).
- **X3 — done 2026-10-19** (Log): the exporter streams the package
  (`pptx/zipWriter.ts`: native CRC-32, exact size before the first byte, no
  JSZip on export); export peak RSS halved, 20–40 % faster.

### I. Production and deploy

- **D1 — done 2026-10-18** (Log; 31409061) (with S2) compression and caching.
- **D2 — done 2026-10-20** (Log) Image sizes (570 MB server, 1.5 GB video worker on recent tags):
  `pnpm deploy --filter` per app. (The survey's sizes; measured 2026-10-20:
  server 1182 MB, video-worker 874 MB locally — 1.42 / 1.09 GB as VM 103
  reports v0.15.0.) Now `infra/docker/runtime-tree.sh`: server 1182 → 340
  MB, video-worker 874 → 345, render-worker 1369 → 900, web 99 → 74.
- **D3 — first step done 2026-10-20** (Log) Server boot-to-ready and first-request latency on VM 103.
  VM 103 read (read-only): 15 s container start → listening after a VM
  boot. jsdom loaded lazily: 2,707 → 1,609 modules at start, listening
  1391 → 1016 ms locally. Open: a timed restart on VM 103 (downtime, Petr's
  word), the MCP catalogue at build time, a bundled server.

### J. Developer loop (builds on `docs/plans/dev-speed.md`)

- **V1 (S–M) — done 2026-10-18** (Log; 43eaffe9) `tsc --noEmit` per package, no incremental, the source-aliased
  packages re-checked by each consumer; `apps/web` build typechecks again.
  Incremental/project references or tsgo; drop the typecheck from the image
  build.
- **V2 (S) — done 2026-10-18** (Log; 43eaffe9) `eslint --cache`.
- **V3** e2e: 3 min on Linux, 12.6 min on the MacBook — a test-strategy
  question, not a quick fix. The full-suite timing on the MacBook was
  cancelled on 2026-10-20 (the coordinator runs the suites at the end):
  still to measure once on a quiet machine.
- **V4 — measured 2026-10-20** (Log) Time the stop-gate's affected lane before/after V1–V2.
  One changed file: 46 s (`apps/server`), 63 s (`apps/web`); the
  typecheck is the critical path. Proposed, not done: `tsc -b` project
  references or tsgo, `vitest related` in the stop gate.

## Order

1. Phase 0: G1, G2, G3, G5 — plus the small standalone wins D1/S2, X1, E4, V2.
2. L1 (✅) and E1 (✅) — the two largest everyday wins.
3. E2 (faces done without a Pixi patch), P0–P3 (present mode smooth, see D), B2 (✅), L3.
4. R1, S3, L4.
5. E7 as a measured spike, then the port if it wins (spike done
   2026-10-21; the port waits for ADR 0018's approval).

Each step is its own commit (or small series) with before/after numbers in
the Log below; the area agents own their parts (`docs/agents.md`).

## Remaining backlog (2026-10-21)

Not started or still open after the 2026-10-20/21 round; each points at
the Log entry or ADR that holds its numbers.

- **Not started**
  - **E8** heap and GPU-texture growth across slide switches — measure first.
  - **E3** the editor's slide switch re-mounts and re-rasterises everything
    (raster cache, idle pre-mount of neighbours).
  - **P3** the 4K source in `present.video` (the 1080p rendition's
    decode/upload saving, unmeasured).
  - **V3** the full `just e2e` timing on the MacBook (cancelled
    2026-10-20).
  - **Low Power Mode run**: `PERF_LOW_POWER=1` path ready, needs Low Power
    Mode switched on for ~20 min (LPM entry); it decides whether the lighter
    editor mode is built.
- **Open, measured**
  - **WebKit present mode**: the residual single misses on the first frame
    of a swap (26–66 ms; 2026-10-20 entry), keep-warm on the canvas's path
    tried and dropped.
  - **Chromium `present.build.steps`**: the first entry's 29–40 ms gap at
    the start of `BeginMainFrame`, unexplained (2026-10-20 entry).
  - **WebKit table mount ~1 s** (E5): not the uploads; suspected the 96
    synchronous bounds measurements on mount or the 96 per-cell rasters,
    unproven without a WebKit profiler.
  - **WebKit grouping of table rasters** (E5): only if WebKit's font loading
    inside SVG images is understood (a shared image lost the embedded Inter
    face and poisoned the page's later SVGs; 2026-10-20/21 entry).
  - **Text boxes sharing one raster image like table cells, in Chromium**
    (E5): a crowded slide's ~120 texts; needs a measurement first.
  - **`present/presentation.ts`**: a store change between `prepare()` and
    `start()` replans nothing (combined verification, 2026-10-21; owners
    present / animation). **Resolved 2026-10-23** (Log): not harmless — an
    edit of the start slide during the load left present mode never ready,
    and a neighbour's edit was rebuilt after ready; the skip path had a
    sibling bug (no slide on stage, cache never idle-only).
  - **One large texture upload per frame** in the editor (W4: a `display`
    upload is a ~20 ms stall in WebKit).
  - ~~**Drag counters in display-paced runs** (W1)~~ — resolved 2026-10-23:
    no move is lost (`y.tx.local` and the observer calls are exact in every
    runtime); `sg.update` / `y.slideObjects.flush` count frames that had a
    move, so the drags mark them `perFrame`: budgeted only where a frame is
    drawn per input (headless Chromium), timed everywhere else, headless
    WebKit included (59 of 60). Awaiting a frame per move was rejected: it
    would stop measuring a mouse faster than the display. The table drag
    now budgets the same list (`packages/perf/README.md` → Statistics).
  - **Tauri**: the presenter window and the cold opens cannot run in the
    shell yet (W1); a run on an external 1× display.
  - **Linux / Windows driver input**: the Tauri perf driver's input is
    AppKit's; WebKitGTK and WebView2 are unmeasured (W1).
  - The canvas overlays of an edited text box still render once a key (E6);
    autofit's throwaway container per key (E4).
  - The warm agent phases left are security checks (G7: token lookup,
    deck role); the cold 100-slide load's 20–30 ms of Yjs decode.
  - ~~R1c's production-image run under VM 103's limits; R1a per ADR 0019~~
    — done 2026-10-23 (F5, Log): ADR 0019 closed unbuilt; the render page's
    captures halved instead.
  - D3 on VM 103: a timed `docker restart` and a VM boot (downtime, needs
    Petr's word); the MCP catalogue at build time; a bundled server.
  - V4: `tsc -b` project references or tsgo, `vitest related` in the stop
    gate (proposed).
  - G4: a Prometheus scraper (M30) and the first real session numbers after
    the next deploy.
  - B3: 300+ slide opens (rows off screen could skip mounting their
    thumbnail); B4: incremental rows with compaction if 1000+ slide decks
    appear.
- **Decisions waiting for Petr** — all decided on 2026-10-23, see "Final
  round" below; the list stays as the record of what was asked.
  - [ADR 0018](../adr/0018-canvas-text-from-the-browser-layout.md) (E7's
    port, L) and [ADR 0019](../adr/0019-render-page-in-place-deck-switch.md)
    (R1a), both proposed.
  - **MSAA at 2×** (W4): off halves WebKit's drag but changes vector-shape
    edges; first a pixel comparison of edges at 2× and a Chromium A/B.
  - **`media.url` single route** (L3 review): it still answers 403 for a
    forbidden asset and 404 for an unknown one; answering 404 for both is an
    API change (`forbidden` vs `not_found`, which agents and layouts read).
  - `tools/list` at 199,999 of 200,000 bytes in link mode (L3 review):
    raise the budget or trim descriptions before the next description grows.
  - Seen on the way, not perf work: Arabic draws unjoined in the render
    worker's image (D2, pre-existing); WebKit rasterised some Inter texts
    blank on their first rasters (E7 spike page, not confirmed in the editor).
  - [ADR 0017](../adr/0017-local-document-copies.md) (L4, proposed) and its
    AGENTS.md hard rule (whatever replaces a document's state calls
    `bumpDocumentEpoch`): approve; and whether to build a per-device "don't
    keep copies on this device" control in the account menu (editor-only).
  - Production (VM 103): a timed restart / VM boot after the next deploy
    (downtime); `METRICS_TOKEN` is unset (the `/metrics` warning in the
    server log); the old v0.13.2 / v0.14.0 images still on disk; client
    session metrics sample every session by default (G4) — keep or lower.
  - **L4 deploy note**: the production compose gains a server volume and
    `INSTANCE_MARKER_PATH`; the first `backup.sh` run writes the instance
    marker ([deploy.md → Restoring the database](../deploy.md)).
  - Local leftovers of the round: the dev `narrative-imgproxy-cache`
    container started for R3, and `~/Documents/Dev/Narrative-desktop` (a
    local merge a69f7fdc plus W1's uncommitted files, all of which are now on
    this branch) — stop / clean up.

## Final round (from 2026-10-23): finish the programme and release

Petr's decisions, 2026-10-23: ADR 0017, 0018 and 0019 accepted; the ADR 0018
port is part of this round; at the end `perf/crowded-slide` merges into
`main` and is released (bump, CHANGELOG, tag, GitHub release, `just deploy`
to VM 103); on that deploy `METRICS_TOKEN` is set and the old v0.13.2 /
v0.14.0 images are removed from VM 103. Not chosen: the render worker's Arabic
font (stays a backlog note, not perf work). Decided by the session on the
rules above (nothing changes how a slide looks; robust over quick): MSAA
stays on at 2× unless a pixel comparison of shape edges proves no difference;
`media.url` answers 404 for a forbidden asset too (existence is not leaked);
`tools/list` keeps its budget and the descriptions are trimmed; client
metrics keep sampling every session until real traffic says otherwise.

Workstreams (each with before/after numbers in the Log; status kept here):

| Id  | What                                                                                                                              | Owner                  | Status                                                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | ADR 0018 port: canvas text from the browser layout, behind a flag, pixel parity in Chromium + WebKit, then the switch             | renderer               | in progress — phase 1 units green, parity corpus written; paused 2026-10-23 ~17:00 (weekly API limit, resets 2026-10-25 02:00); log `~/.cache/narrative-perf/round-logs/F1.md`                                                                                                     |
| F2  | Present residuals: WebKit swap-frame misses, Chromium `build.steps` first-entry gap; MSAA-at-2× pixel comparison                  | renderer (present)     | in progress — build.steps gap traced, MSAA-at-2× Chromium pixel comparison done, Tauri 2× idle-turn work; paused 2026-10-23 (API limit); log F2.md                                                                                                                                 |
| F3  | E8 heap / GPU growth across slide switches (CDP heap after GC, texture counts); the +22 `react.commits` per present run (bisect)  | perf                   | in progress — +22 react.commits found (useSlideNotes double render) and fixed; memory benches built, three leak fixes measured; paused 2026-10-23 (API limit); log F3.md                                                                                                           |
| F4  | P3 the 4K source in `present.video`                                                                                               | media                  | in progress — root cause found: present mode drew the poster, not the playing video; fix not finished; paused 2026-10-23 (API limit); log F4.md                                                                                                                                    |
| F5  | ADR 0019 (slim render entry measured first) and R1c on the production image under VM 103's limits                                 | renderer (render page) | built 2026-10-23, in review (Log): ADR 0019 measured and closed; render page captures halved; R1c PDF of 30 −28 %                                                                                                                                                                  |
| F6  | `media.url` 404 for forbidden; `tools/list` trimmed under budget                                                                  | ai-integration         | done 2026-10-23: one 404 for every refusal on url / video-info / font-url / delete (readers without the role keep 403), malformed `share_token` refused at the boundary, own rate limit; `tools/list` 199,999 → 189,572 B (link); security-reviewed                                |
| F7  | E6 overlays per key, E4 autofit per key, B3 300+ slide opens                                                                      | editor-ui              | in progress — WebKit E6 A/B queued; paused 2026-10-23 (API limit); log F7.md                                                                                                                                                                                                       |
| F8  | Release prep: `METRICS_TOKEN`, compose (L4 volume, `INSTANCE_MARKER_PATH`), D3 boot timing on the deploy, old images, V4 dev loop | infra                  | done 2026-10-23: METRICS_TOKEN wired (compose + SOPS, Caddy 404 on /api/metrics), L4 marker deploy order fixed (restore-marker.sh), boot-timing / availability probes, prune --drop, V4 measured (TS7 / vitest related rejected), CHANGELOG draft; runbook docs/deploy.md → 0.16.0 |
| F9  | E3 the editor's slide switch — after F1, whose text path it depends on                                                            | renderer               | after F1                                                                                                                                                                                                                                                                           |
| F10 | Tauri presenter window + cold opens; Low Power Mode run (Petr switches LPM on); Linux / Windows driver input (handover)           | desktop                | after F1                                                                                                                                                                                                                                                                           |
| F11 | Verify, document, commit, merge, release, deploy                                                                                  | session                | last                                                                                                                                                                                                                                                                               |

## Log

- 2026-10-18: programme drafted from a read-only survey; MacBook baseline with
  Metal measured; Low Power Mode identified as WebKit's 30 fps cap.
- 2026-10-18, **D1 done** (`infra/caddy/Caddyfile`, `apps/web/scripts/precompress.mjs`):
  - the build writes `.br` (quality 11) and `.gz` (level 9) next to every
    compressible file: 66 files, 19.5 MB → 4.1 MB brotli; Caddy serves them
    with `file_server { precompressed br gzip }`;
  - `encode zstd gzip` for text responses of the API, by Content-Type, never
    `text/event-stream` (the MCP endpoint's SSE);
  - existing `/assets/*` files carry `Cache-Control: public, max-age=31536000,
immutable`;
  - a missing `/assets/*` file is now a 404 instead of `index.html` with 200
    under a `.js` name (`ui/lazyRoute.tsx` recovers from either the same way:
    a failed import and the boundary's Reload). `try_files` takes no matcher,
    so the SPA fallback is an explicit `rewrite`.
  - Checked against `caddy:2-alpine` with a production build: the entry chunk
    168 kB → 38 kB br / 45 kB gzip; documents, `/deck/:id`, the render page
    (`X-Frame-Options SAMEORIGIN`) and `/` keep `no-cache`.
- 2026-10-18, **V1, V2 done** (MacBook, a machine busy with two agents):
  - `eslint --cache --cache-strategy content` (cache in each package's
    `node_modules/.cache/eslint/`): `just lint` 58 s → 15 s warm;
  - `tsc --noEmit --incremental` (tsbuildinfo in
    `node_modules/.cache/tsc/`): `just typecheck` 132 s → 27 s warm; a type
    broken in `packages/shared` is still reported in `apps/video-worker`
    (checked);
  - the web `build` no longer runs `tsc` (`just check` and the pre-push hook
    do; it ran a second time for every image build and every `just size`).
- 2026-10-18, **G1, G2, G3, G5, G6 built** (perf harness step 2,
  `docs/plans/perf-harness.md` → Log) and the first profiling run: the
  MacBook (M3 Pro, Chromium 156 with ANGLE Metal, 1× DPR, AC power, **Low
  Power Mode on**, so no WebKit run), the machine shared with three other
  agents (load 5–35 during the runs: every result carries the "busy machine"
  warning). Medians of 10 runs; dev = the Vite dev server, prod = `vite
build`, profiling = prod with `react-dom/profiling`. Baselines and the
  details files are in `~/.cache/narrative-perf/petrs-macbook-pro/`.
  - **Prod vs dev** (input-to-pixel p50 / p90, ms): crowded drag 32.2 / 43.5
    → 28.3 / 32.6 (rect), 32.8 / 46.3 → 20.4 / 31.6 (text); light drag 27.1
    / 39.5 → 27.8 / 30.1; zoom 50.6 / 80.3 → 41.5 / 81.8, light zoom 29.7 /
    34.2 → 23.1 / 25.1; typing 28.3 / 46.9 → 20.7 / 35.4; slide switch 70.7
    → 37.3; slide add 201 → 109. A 90-move drag's wall time 5.7 → 4.4 s.
    Deck open, first paint: cold 10 slides 1404 → 860, warm 100 slides 1178
    → 486 (0.61×, 0.41×); everything settled (all thumbnails): cold 100
    slides 10.0 → 8.3 s. Pixi's own render time is the same in every mode
    (crowded drag 47.7 / 45.5 / 49.1 ms of `render` per drag): the dev
    penalty is React and the app's JavaScript, not drawing. **Profiling ≈
    prod** within the noise (input p50 20.4 vs 20.9 ms on the text drag).
    With the GPU, frames stay at 60 Hz in all three modes (frame p90 16.7 ms);
    on SwiftShader with the machine at load 30 one crowded drag took 200–340
    s — the timing benches now draw with the GPU by default.
  - **E1, measured** (work counters, the same in every mode): each pointer
    move of a drag on the crowded slide is one local transaction **and one
    remote one** (`y.tx.remote` = `y.tx.local` in every drag and keystroke —
    the server echoes or writes something per update; to find out), six
    `listSlides` deep copies of the deck (1 338 objects converted per move:
    120 420 per 90-move drag), eleven slide-object observer calls, and
    **~650–700 React component renders per move in prod** (57–63 k per drag;
    69–70 k in dev). Typing: six `listSlides` per key too. These are the
    budgets of `transform.move.*` / `text.type.inter` now (perf/budgets):
    E1 lands as a diff of them.
  - **Thumbnails** (E3, S-workstream): dragging one slide to a new place, or
    adding one, in a 100-slide deck re-renders **~102–105 thumbnails**
    offscreen — ~630 thumbnail text rasters, ~155 Mpx of texture uploads —
    and the editor is busy for 8.8 s (reorder, prod) to 14.4 s (add, prod)
    afterwards. Opening the 100-slide deck renders all 100 (~150 Mpx).
  - **An open writes**: 4 local transactions on every deck open, in every
    mode (`deck.open.*` budgets) — an open should write nothing; to find out
    which writer (autofit, a normaliser).
  - Opening copies the deck 24× in dev (StrictMode), 12–18× in prod; the
    count follows the sync's timing (so it is timed, not budgeted).
  - **Live thumbnail fallback**: when the scene does not settle within the
    live thumbnail's 1.5 s (a slow GPU, a busy machine), one nudge falls back
    to the offscreen render: 121 text rasters, 283 uploads, 26 Mpx, 4.3 s of
    long tasks for a 1-px move (SwiftShader run). And when each pointer move
    takes over 500 ms, the thumbnail debounce fires between moves: 71
    thumbnails for a 90-move drag.
  - Zoom (crowded, 40 wheel steps): 182–216 texts re-rasterised (22–40 Mpx
    uploaded, a mipmap per upload), ~430–490 ms of long tasks; the light
    slide's zoom re-rasterises nothing.
  - Slide switch to slide 2 and back: 24 mounts, 24 destroys, 12 text
    rasters (E3: no raster cache across switches).
  - **CPU profiles** (`just perf-profile <id>`, profiling build, GPU, input
    fence off; self time of one run): drag — `yMapToPlainObject` 108 ms, Yjs
    internals 95 + 56 (`createIterator`) + 19 (`findMarker`) ms, the colour
    resolver's `flush` 25 ms, React `updateProperties` 18 ms, Pixi
    `hitTestMoveRecursive` 16 ms: the deck copies of E1 lead. Zoom —
    `texSubImage2D` 295 ms, Pixi `resizeCanvas` 200 ms, `measureHtmlText` 86
    ms: uploads of re-rasterised text and the canvas resize. Typing —
    `measureHtmlText` 133 ms, `yMapToPlainObject` 72 ms, Yjs 63 + 39 ms, the
    colour resolver 32 ms. By category (drag): app 278, React 252, Yjs 214,
    native 151, Pixi 108 ms.
  - **Lighthouse** (G2, prod, a seeded ten-slide deck's `/deck/:id`, desktop
    preset, 5 runs): FCP 960 ms, LCP 1 588 ms, TBT 47 ms, Speed Index 1 613
    ms, TTI 1 749 ms, **CLS 0.122** (over the 0.1 "good" line: something
    shifts as the editor loads), score 0.87.
- 2026-10-18, **S3, B4, S2's `/decks` paging done** (state-sync; MacBook M3
  Pro, Node 24, dev Postgres in Docker, the machine shared with other agents:
  load average 34–42 during the comparison, so the baselines and the results
  were run alternately, B1 F1 B2 F2). The probe is new: `just perf-commands`
  (`apps/server/perf/commands.ts`) drives the real ServerHost against
  Hocuspocus and Postgres, no LLM — a seeded 100-slide deck (700 objects,
  195 kB snapshot, not loaded), a folder with tokens, the example style pack
  and three fonts; 200 commands (object.update / object.create /
  text.setBoxTypography / text.style.apply, every tenth slide.applyLayout),
  then 10 atomic `ops.apply` batches of 10 and of 100 ops; p50 / p95 per
  phase, database statements per command, document stores and bytes.

  | 200 commands, 100 slides                 | before (B1 / B2)           | after (F1 / F2)           |
  | ---------------------------------------- | -------------------------- | ------------------------- |
  | per command p50 / p95                    | 31.0 / 121, 23.8 / 49.1 ms | 7.8 / 19.9, 7.9 / 20.2 ms |
  | store on the command's path, p50         | 20.5, 15.2 ms              | none                      |
  | document stores during the 200 commands  | 200 (46.3 MB)              | 0                         |
  | stores, whole run (batches, final flush) | 220 (51.7 MB)              | 1 (278 kB)                |
  | DB statements / writes per command       | 9.3 / 4.0                  | 4.2 / 2.0                 |
  | folder context, slide.applyLayout p50    | 9.7, 6.9 ms                | 3.3, 3.6 ms               |
  | folder context, text.style.apply p50     | 4.6, 3.8 ms                | 2.3, 2.3 ms               |
  | `ops.apply` ×10, total p50               | 52.3, 47.7 ms              | 9.2, 11.4 ms              |
  | `ops.apply` ×10, Yjs work p50            | 22.8, 23.5 ms              | 1.6, 2.3 ms               |
  | `ops.apply` ×100, total p50              | 123, 52.1 ms               | 17.4, 12.5 ms             |
  | `ops.apply` ×100, Yjs work p50           | 81.4, 27.0 ms              | 8.3, 5.0 ms               |

  On a quiet machine earlier the same day: 15.9 / 27.4 ms per command
  before (a store of 11.1 ms p50 on every command), 4.3–4.5 / 13–19 ms
  after the store and context steps.
  - **Stores coalesced** (`agent/documents.ts`, `hocuspocus/directWrite.ts`,
    `services/runs.ts`; ADR 0011, amendment of 2026-10-18): a write is
    applied and broadcast, the sync server's debounce stores it (2 s / 10 s),
    and the document is stored at once when the run closes or is replaced,
    after a revert, when the agent host disconnects, and on shutdown. A
    crash loses at most the debounce window, as for people's edits. With an
    agent's think time between commands (`--pace 2500`) the debounce still
    stores once per command (8 stores for 8 commands, 196 kB each) — off the
    command's path now; the bytes per store are B4's.
  - **Per-run folder context** (`agent/folderReads.ts`): the target's folder
    is looked up once per command for all its readers; a run keeps the
    tokens and the style pack it read while the folder document's version
    is unchanged (a loaded document's instance and update count, else its
    newest stored row id — an index-only `max(id)`), read again after any
    change, a copy handed out on every hit; only after the per-command
    access check, never across runs, users or folders. Fonts are read every
    time: their rows have six writers, and telling whether they changed
    costs what reading them costs (≈ 1 query).
  - **Kept batch forks** (`packages/commands/src/batchForks.ts`): one fork
    per live document, kept in step by replaying its updates, dropped on a
    failed batch, after 60 s idle, past 4 MB of queued updates or 16
    documents. It also ends a defect: the fork borrowed the live document's
    client id, so Yjs re-rolled the FORK's id on every copy (`[yjs] Changed
the client-id`) and every batch added a client to the deck; a kept fork
    adds one for its life.
  - **B4**: migration `0038_drop_redundant_update_indexes` drops
    `deck_updates_deck_id_idx`, `folder_updates_folder_id_idx`,
    `component_updates_component_id_idx`. EXPLAIN on the dev database, before
    and after dropping them in a rolled-back transaction: the load, the
    compaction delete, the owner cascade and `max(id)` all plan onto the
    `(…_id, id)` composite; `pg_stat_user_indexes` showed 2 / 0 / 0 scans of
    the single-column indexes against 7164 / 2647 / 58 of the composites.
    What a store costs is the full snapshot (195–280 kB here, 11–20 ms);
    the index saving is below this probe's noise. Open: incremental rows
    with periodic compaction (an ADR 0006 change) would make a store cost
    what changed.
  - **S2, `/decks`**: `GET /decks?limit=&cursor=` (opt-in; without `limit`
    the response is unchanged) pages `list` in its own order — created, then
    id — so the pages put together are the list
    (`services/deckRecordsPage.integration.test.ts`). The dev user's 1657
    decks: the whole list 611 kB JSON, 33 ms p50 in the service; a first page
    of 60: 15 kB, 2.3 ms. The folder page (`pages/FolderDecks.tsx`) now
    paints after the first page and fetches the rest in order behind it,
    ending at the same grid. `pages/Landing.tsx` (named in the survey) is
    routed nowhere — `/` is `FoldersHome`. Paging the grid itself (load on
    scroll, newest first) changes what the page shows: a UI decision, not
    taken here.

- 2026-10-18, **R1/R2/R3 built** (MacBook M3 Pro, a machine shared with other
  agents: load average 8–55 during the runs, so single numbers swing; each
  claim below says how it was checked). Stack for R1/R3: the production web
  build behind a local Caddy with VM 103's routes, the server on its own
  Postgres database and Redis DB; the render worker as the **production
  image under VM 103's limits** (`--cpus 2`, `--memory 1200m`, no swap, the
  compose hardening, sandbox required), routed like production
  (`RENDER_UPSTREAM`). Decks: every slide a full-bleed photo of noise, a
  title, two shapes.
  - **R1, queue wait** (`apps/render-worker/perf/render.ts`, a one-slide PNG asked for 1.5 s
    into another person's 30-slide PDF, n=3): wait 47.4 s p50 / 70.1 s p95 →
    5 ms / 455 ms; the PNG's answer 52.4 / 84.6 s → 10.4 / 19.1 s. Before,
    one run's 20-slide job overran its 70 s budget, failed as a browser
    fault, and the PNG behind it timed out at 95 s too. `RENDER_CONCURRENCY`
    (default 2) with a memory gate: a second job opens its page only while
    `RENDER_PAGE_RESERVE_MB` (450) are free in the container's cgroup, idle
    pages closed first; a browser fault retires the browser (the jobs still
    in it finish) instead of closing it under them. Peak container memory
    786 MiB → 841 MiB with two jobs.
  - **R1, PDF pages as JPEG in the page**: encode 350–400 ms (PNG) → ~190 ms
    (JPEG) per slide on two cores; the server no longer decodes and
    re-encodes (it checks the JPEG's header and size, a PNG from an older
    page is still converted). Same quality: PSNR against the slide's PNG
    39.72 / 46.83 / 45.59 dB (photo / text / mixed) for both the page's JPEG
    and sharp's q85 of the PNG, sizes within 1 KB (both libjpeg-turbo).
    The 30-slide PDF still failed 1 of 3 (59.6 / 87.3 s when it finished,
    69.4 / 79.4 s before): a slide costs ~0.7 s to switch to (the render
    page re-reads `/api/decks/:id` per slide) and ~0.7 s to capture under
    SwiftShader, so 20 slides sit at the 70 s budget.
  - **R1, deck-agnostic pool**: an idle page of any session is recycled for
    another deck — old tab to `about:blank` (its document and WebSocket
    gone), the origin's storage (explicit types; **not** `shader_cache`:
    clearing it made SwiftShader recompile every shader, recycled pages
    then loaded _slower_ than new ones), cookies and HTTP cache cleared, the
    new deck in a new tab of the same context, the old tab closed after.
    Saves ~20 % of the app load: micro-benchmark (host, routed) 918–1168 ms
    for a new context vs 732–873 ms for a reused process; worker log under
    the limits 1.17 s (new page) → 0.93 s (recycled) to "app ready",
    clearing 24–70 ms. End to end, a cold one-slide job (~3–6 s) did not
    move measurably under this machine load (interleaved A/B: old 6.6 /
    3.1 s, new 3.8 / 4.6 s; the unchanged warm path itself swung 1.3–2.2 s).
    Isolation is tested with a real Chromium (`render.browser.test.ts`, "a
    recycled page"): deck A leaves its token in localStorage,
    sessionStorage, a cookie, IndexedDB, Cache Storage and `window.name`;
    deck B's page finds none of it, no session-history or
    `navigation.entries()` URL with A's token, and A's WebSocket closed
    before B's page was requested.
  - **R2** (`apps/video-worker/perf/transcode.ts`, host, `FFMPEG_THREADS=2`, 10 s testsrc2):
    the poster came with the playable file before (1080p ProRes 3.2 s, 4K
    ProRes 11.0 s p50, H.264 ≈ 0.6 / 1.0 s); now one ffmpeg run beside the
    transcode makes poster and thumbnail, uploaded and on the asset
    (`updateVideoStills`) 0.6 s after the probe. Interleaved A/B, 3 rounds:
    poster 1080p ProRes 2.9–5.1 s → 0.6–0.9 s, 4K ProRes 9.7–16.0 s →
    3.1–5.3 s (the download of the 246 MB source is most of it). Time to
    playable is the x264 encode, which swung 12–19 s under the machine's
    load either way; the tail after it shrank from ~2.0 s (two stills runs,
    three uploads) to 0.4 s (one upload).
  - **R3** (`apps/server/perf/imgproxyWarm.ts`, a 3000×2000 photo, the repo's nginx
    cache in front of imgproxy, n=4 per row): `display` first view 5 s after
    the upload 543 ms p50 / 1498 ms p95 (MISS) → 7 / 17 ms (HIT); right at
    upload 638 → 273 ms (it joins the warm-up's encode in flight);
    `preview` +5 s 116 → 6 ms. Production sets `IMGPROXY_WARM_ENDPOINT:
http://imgproxy-cache:80`; one image at a time, at most 200 waiting,
    never in the upload's way.
  - Next: an in-place deck switch on the render page (no bundle evaluation
    or Pixi start per cold job; it needs the renderer's and the state
    layer's module caches reset per deck, so it waits for their owners);
    the per-slide `/api/decks/:id` read of the render page; an async PDF
    export (the 95 s window is the hard limit for 30 photo slides on two
    cores); the editor showing a processing video's poster; warming video
    posters.
- 2026-10-18, **X1, X2 done; G7's PPTX probe** (MacBook M3 Pro, Low Power
  Mode on, a machine busy with other agents — load 15–96 on 12 cores, so
  base and optimised ran interleaved, 3 rounds each, medians; Node 24.21):
  - `just perf-pptx` (`apps/server/perf/pptx.ts`): import + export through
    the real pipeline (dev Postgres, MinIO; videos counted, not queued), one
    process per run, p50/p95 per phase from `pptx/phases.ts` marks
    (`node:diagnostics_channel`), sampled RSS, and fingerprints of the
    imported model and the exported package. Default input: a generated deck
    (`apps/server/perf/syntheticDeck.ts`: 100 slides, 200 pictures incl. two 54 MP
    photos, 2 embedded fonts, 199 MB, cached). Its statistics come from
    `@narrative/perf/stats` (R-7 quantiles), like every server and worker
    driver since the merge.
  - Profile (`--cpu-prof`) of the baseline: 40 % idle (serial sharp and
    MinIO waits), 11 s of pako deflate in export, 4 s of pako inflate and
    JSZip copies in import, 3 s in probe-image-size's stream SVG parser
    (`toString` of every whole picture).
  - Fixes: media inflated with Node's zlib from the archive JSZip already
    holds (`pptx/zipEntry.ts`) and only when uploaded
    (`ParsedEmbeddedImage.read`); pictures and fonts six at a time
    (`lib/concurrency.ts`), largest first, oversize ones under a 100 MP
    budget (`WeightedSemaphore`); `probe-image-size/sync` on the header;
    export prefetches assets and picture sizes six at a time and stores
    JPEG/PNG/GIF/WebP/video instead of deflating them (+0.3–1.6 % file
    size); two whole-buffer copies dropped.

    | deck (size)                             | import base → opt               | export base → opt | peak RSS (sampled) |
    | --------------------------------------- | ------------------------------- | ----------------- | ------------------ |
    | synthetic (199 MB)                      | 39.3 → 20.7 s                   | 49.5 → 5.4 s      | 1.40 → 1.44 GB     |
    | DesignOps, 109 slides (208 MB)          | 32.5 → 41.6 s (min 31.0 → 21.2) | 24.9 → 9.1 s      | 1.86 → 1.38 GB     |
    | Audi LIVE, 96 slides, 5 videos (821 MB) | 50.7 → 25.2 s                   | 80.3 → 15.5 s     | 4.59 → 3.02 GB     |

    On a quieter machine (load ~10) the synthetic deck runs 23.2 → 9.1 s
    import, 17.5 → 3.3 s export.

  - Same results: model and export fingerprints identical base vs optimised
    on all three decks; `just pptx-roundtrip` on four real decks (DesignOps
    32, Audi LIVE 1, Atomic 0, IIC 2 differences) identical before and
    after. The baseline's export of the 821 MB deck differed between its own
    runs (same size, different content — not chased); the optimised one is
    stable.
  - Peak RSS: lazy media saves about the deck's media size (DesignOps
    serial: 1.54 → 1.14 GB); six unbounded lanes gave 0.75 GB of it back
    by decoding five 46–96 MP photos at once (2.05 GB), hence the pixel
    budget. maxRSS on macOS reads below the input buffer itself — use the
    sampled column.
  - Open: the oversize re-encode is now DesignOps' critical path —
    `storedImageLimits.ts` writes JPEG with mozjpeg (q90, 4:4:4): 15.7 s
    for one 54 MP photo vs 2.5 s with libjpeg-turbo at the same quality,
    4.6 % larger (a media/quality decision, also for tus uploads). Export
    still runs JSZip's JS CRC32 over stored media (~1 s / 200 MB) and holds
    the package in memory; a streaming writer would fix both.
- 2026-10-18, **the remote transaction per drag move, explained**: Hocuspocus
  4.7.1 sends every update back to all connections of the document, the
  sender included (`Document.handleUpdate` → `broadcast` without a filter;
  with `flushDelay` it batches several clients' updates into one message, so
  the sender cannot be filtered out per batch). The client applies its own
  echo as a transaction that inserts nothing — `y.tx.remote` = `y.tx.local`
  in every drag and keystroke. No observer fires (no change), so the cost is
  the decode and the empty transaction; it doubles the downstream bytes of a
  gesture. Upstream behaviour, not overridden locally; an option to skip the
  origin connection for unbatched updates would be an upstream change.
- 2026-10-18, **oversize JPEG re-encode: libjpeg-turbo instead of mozjpeg**
  (`apps/server/src/media/storedImageLimits.ts`, q90 4:4:4, optimised
  Huffman tables): one 54 MP photo 15.7 s → 2.5 s for a file 4.6 % larger;
  the path runs on every oversized tus upload and PPTX picture. `just
perf-pptx --runs 3` on the synthetic deck afterwards (load average 40+):
  import p50 7.3 s (min 4.8 s; 20.7 s with mozjpeg under similar load),
  `import.images` p50 6.3 s, export p50 7.9 s, peak RSS 1.27 GB. Integration
  of the three server patches verified the same day: `just check`, `just
integration` 135/135, server 1696 / commands 1375 / render-worker 35 /
  video-worker 21 unit tests, the whole e2e suite (multi-client-collab,
  folders, pptx green; the five desktop specs and route-load-failure:72 fail
  on HEAD too), `just size` within every limit.
- 2026-10-18, **B2 done** (renderer; MacBook M3 Pro, Chromium 156 on ANGLE
  Metal, Low Power Mode on, prod builds; the machine shared with other
  agents, load 30–47 during the benches, so before and after ran
  alternately — B1 A1 B2 A2, the open benches two pairs more — from saved
  builds, 5 runs each):
  - **What changed.** `renderer/thumbnailStore.ts` decides what is rendered
    when; `state/useSlideThumbnails.ts` only feeds it. A thumbnail is keyed
    by its inputs (`renderer/thumbnailKey.ts`: objects with `Y.Text` runs as
    deltas, background, surface, the token colours and font-family versions
    it uses, the slide number only for a slide with an `isSlideNumber`
    leaf); an unchanged key renders nothing, a cached key (undo, duplicate,
    a slide moved and recreated) is shown without rendering. Visible rows
    render first (`ui/useVisibleSlideRows.ts`), the rest one per idle
    callback; edits debounce 500 ms and never fire during a pointer gesture;
    a live capture that does not settle keeps the last picture and retries at
    idle, rendering offscreen once after 3 misses of the same content (it
    used to fall back to a full offscreen render per change). PNGs are
    encoded with `toBlob` and shown as object URLs
    (`renderer/thumbnailImages.ts`; `img-src blob:` is in the CSP); the deck
    preview and the component thumbnail are converted to data URLs only for
    storage and upload. Each panel row subscribes to its own picture.

    | 100-slide deck                | before (B1 / B2)    | after (A1 / A2)     |
    | ----------------------------- | ------------------- | ------------------- |
    | reorder: thumbnails rendered  | 103 / 103           | 0 / 0               |
    | reorder: thumbnail rasters    | 618 / 618           | 0 / 0               |
    | reorder: thumbnail uploads    | 156.0 / 156.0 Mpx   | 0.08 / 0.08 Mpx     |
    | reorder: work after the input | 9.4 / 10.6 s        | 24 / 50 ms          |
    | reorder: React renders        | 3842 / 3817         | 1192 / 1192         |
    | add: thumbnails rendered      | 102 / 102           | 0 / 0 (1 reused)    |
    | add: work after the input     | 16.2 / 12.2 s       | 26 / 23 ms          |
    | add: React renders            | 4177 / 4177         | 1575 / 1575         |
    | open cold: React renders      | 7382 ×3, 8125       | 4907, 4781, 5650 ×2 |
    | open warm: React renders      | 7969, 7539, …, 8247 | 4973, 5147, …, 6783 |

  - **Opening** still renders all 99–100 thumbnails (~600 rasters, ~150
    Mpx) — by design, the hidden ones at idle. Time to all thumbnails did not
    move measurably: open.settled (cold) 12.98 / 8.96 / 12.50 / 11.06 s
    before, 9.43 / 14.86 / 11.07 / 17.47 s after, tracking the load (21–47).
  - **Nudge / add benches hit the cache**: each run restores the slide, so
    after the warm-up both states are cached (`thumb.reused` 1, `thumb.live`
    1 → 0, nudge settle 532 / 552 → 74 / 174 ms). A first nudge to a new
    position still costs one live capture (~1 ms of drawing).
  - **Slide switch** unchanged: 0 thumbnail renders before and after; its 24
    mounts / 12 text rasters are the canvas's (E3's raster cache: not done).
  - The live-capture fallback and the gesture hold are unit-tested
    (`thumbnailStore.test.ts`: 10 nudges on a canvas that never settles → no
    offscreen render until the last content's third miss, then one; 90 moves
    600 ms apart → one render at the gesture's end), not benched: a
    SwiftShader crowded drag takes minutes at this load.
  - **Budgets** unchanged: every budgeted counter of the six benches equals
    perf/budgets in the after runs; the thumbnail counters the change moved
    are timed, not budgeted. Not accepted: budgets come from dev results,
    and the harness's dev mode is the `:5173` server of the main checkout.
    After the merge: add `thumb.render` and `thumb.text.raster.started` to
    REORDER_WORK / ADD_WORK (now deterministic: 0), `just perf
slide.reorder.100 slide.add.100 --mode dev`, `just perf-accept`.
  - Next: keep pictures by key across sessions (IndexedDB) so a warm open
    renders none; render hidden rows only when they come near the viewport;
    E3's raster cache for the canvas.
- 2026-10-18, **E1, E6 done** (state-sync; MacBook M3 Pro, Chromium 156 with
  ANGLE Metal, AC power, Low Power Mode off for the final runs; the machine
  shared with other agents at load 38–71 on 12 cores, so the before and
  after prod builds ran **interleaved** A B A B on two pages in front of the
  same dev backend, 10 runs per side after 2 warm-ups, medians with the
  harness's bootstrap CI).
  - **One deck store** (`packages/slide-model/src/deckStore.ts`): a derived,
    read-only cache of the Y.Doc, one per document (`getDeckStore`). One
    `observeDeep` on the slides array; each event's target is walked up to
    its slide and classified by the key it sits under (the list, the
    objects array, one object at any depth, animations, transition /
    background, nothing for speaker notes). A read after a change rebuilds
    only what was marked — object snapshots are reused by Y.Map identity,
    slides and the list when none of their parts changed — so it always
    equals `listSlides` structurally (property test over random edits,
    undo and remote updates) while untouched objects keep their identity.
    Subscribers are told once per frame. React reads it through
    `useDeckSelector` (`apps/web/src/state/useDeckStore.ts`,
    `useSyncExternalStore`); `useSlides`, `useSlideObjects`, `useAnimations`,
    the active-slide provider, the canvas's slide number / surface and
    background, the thumbnails' backgrounds and order all read it.
  - **Selectors by id (E6)**: EditorLayout no longer subscribes to the
    objects (handlers read the store when they run; the overlays that draw
    objects are `components/ActiveObjectOverlays.tsx`, each selecting the
    objects it shows); the inspector selects its object by id and memoises
    the sections that do not show the position (stable writers); layers,
    slides panel, timeline, lock badges, peer / agent outlines, table range
    and the context menu (subscribed only while open) select what they
    show; snap guides live in their own store (`editor/snapGuidesStore.ts`).
  - **Awareness by content**: this Hocuspocus build broadcasts every flush
    to every connection, the sender included, so each local edit came back
    as a remote transaction (`y.tx.remote` = `y.tx.local`) and every remote
    awareness state as a new object with the same content — every
    `useRemotePeers` reader (and the avatar chips) re-rendered once per
    edit while the seeding agent's peer was shown. Snapshots now key on
    content. (The echo itself is upstream behaviour; left alone.)
  - **Numbers** (prod, crowded slide 224 objects, before → after):

    | per 90-move drag / 60 keys   | rect drag                 | text drag                 | typing                    |
    | ---------------------------- | ------------------------- | ------------------------- | ------------------------- |
    | `listSlides` (objects)       | 540 (120 420) → 0         | 540 (120 420) → 0         | 360 (80 280) → 0          |
    | slide-object observer calls  | 990 → 90                  | 990 → 90                  | 660 → 60                  |
    | object snapshots rebuilt     | → 90                      | → 90                      | → 60                      |
    | React renders                | 74 845 → 5 699            | 73 771 → 13 709           | 39 585 → 13 198           |
    | React commits                | 262 → 182                 | 254 → 182                 | 123 → 123                 |
    | input-to-pixel p50 / p90, ms | 20.2 / 32.4 → 15.3 / 25.2 | 19.3 / 31.0 → 17.3 / 30.5 | 19.3 / 35.7 → 17.9 / 33.5 |
    | wall, ms                     | 6 293 → 5 345             | 5 764 → 4 864             | 4 696 → 4 326             |

    Rect drag: input p50 −24 %, p90 −22 %, wall −15 % (CIs exclude zero);
    text drag p50 −10 %; typing's times moved within the noise. An earlier
    interleaved run (E1 and the overlay split, without the inspector memo,
    load 51, Low Power Mode on): rect drag p50 26.6 → 19.1 ms, renders
    80 263 → 12 067.

  - Open: a text box's inspector sections still render on every keystroke
    and move (its snapshot holds a Y.Text, so nothing tells a format change
    from a move — a per-key "what changed" from the store would); the
    remaining per-move renders are the components that show the moved
    object (handles, inspector, the agent's selection outline); the
    imperative `listSlides` calls at event time (PPTX/PDF export, the
    page-number prompt, the render page) were left as they are.
- 2026-10-18, **canvas zoom: one commit per gesture, staging paused, idle
  and long-task budgets; text alignment across a re-raster**
  (`docs/plans/canvas-performance.md` → Log). MacBook M3 Pro, prod build,
  GPU (ANGLE Metal), Low Power Mode on, load 20–77 (very busy: other agents'
  builds). Before and after builds run alternately through `just perf
--no-build`; the medians of 10 runs per invocation are listed below, one
  value per invocation.

  | `viewport.zoom.wheel` (40 steps, crowded) | before (5 invocations)      | after (5)                    |
  | ----------------------------------------- | --------------------------- | ---------------------------- |
  | input p50 / ms                            | 39, 37, 40.4, 36.6, 36.5    | 27.5, 31.1, 23.5, 29.8, 27.2 |
  | input p90 / ms                            | 104, 81.7, 114, 82.3, 83.6  | 38.5, 40.2, 35.8, 36.3, 36.5 |
  | long tasks / ms                           | 748, 868, 1463, 613, 607    | 0, 27.5, 0, 0, 0             |
  | commits · text rasters                    | 2 · 145–199                 | 0 · 0                        |
  | raster kpx · uploaded kpx · mipmaps       | 30–42 k · 59–84 k · 290–397 | 0 · 0 · 0                    |
  | settle / ms                               | 330–460                     | 16–26                        |

  | `viewport.zoom.commit` (new: in, rest, out) | before (3)       | after, final (2) |
  | ------------------------------------------- | ---------------- | ---------------- |
  | input p50 / ms                              | 26.1, 37.2, 33.4 | 28.3, 30.8       |
  | input p90 / ms                              | 101, 236, 119    | 56.1, 45.0       |
  | long tasks / ms                             | 566, 1979, 723   | 1020, 677        |
  | settle / ms                                 | 1074, 749, 752   | 655, 566         |

  Same work on both sides: 2 commits, 242 rasters, 48.6 Mpx rastered, 97
  Mpx uploaded, 484 mipmaps. `text.type.inter`: no change (the quieter
  pair: p50 19.0 → 19.9, p90 35.7 → 37.1 ms, no long tasks; 60 bounds
  measures and 60 rasters on both sides). On a busy machine its
  `net.requests` work counter varied between runs (0–2) before and after:
  the bench fails then (ran with `PERF_DISCOVER=1`).
  - **CPU profiles** (one run each, profiling build, self time): wheel
    `texSubImage2D` 321, `resizeCanvas` 320, `measureHtmlText` 185 ms →
    none of them (all Pixi code 7 ms). Commit bench: before
    `texSubImage2D` 261, `resizeCanvas` 215, `measureHtmlText` 159 ms;
    after 816 / 277 / 107. One run each: how many off-screen texts reach the
    peak resolution before the zoom back out decides `texSubImage2D` (they
    now get there in idle time during the rest). Typing `measureHtmlText`
    132 → 108 ms (the same 120 measurements).
  - **Mipmaps**: `generateMipmap` is not in any profile (< 1 ms). They stay
    on: the live thumbnail draws the editor's text rasters at ~1/8.
  - **The backbuffer**: one resolution change reallocates a 25 Mpx MSAA
    backbuffer, ~110 ms (12–25 ms without MSAA; width and height each
    reallocate) — a probe outside the app, 3 repeats each. What remains
    of the commit cost; a viewport-sized canvas is the candidate (an ADR).
  - Not accepted as baselines (`just perf-accept`): the budgeted counters
    of the zoom benches are unchanged (all 0); the time baselines are this
    machine's and shared with the main tree, so accept
    `viewport.zoom.wheel viewport.zoom.commit` after the merge.

- 2026-10-18, **E4 done; an open writes nothing** (MacBook M3 Pro, dev, on
  battery, load ~15; work counters, deterministic):
  - The crowded scene's probe text is now a growing box (`autofit:
'grow-down'`, `packages/perf/src/scenes.ts`), so the drag and typing
    benches go through the height write-back. Dragging it, before → after:
    `text.autofit.measure` 90 → 0 and `text.measure.bounds` 90 → 0 per
    90-move drag (`state/autofitHeights.ts` skips a transaction that changed
    only `x`, `y`, `rotation`, `opacity`, `name`, `locked`, `shadow`, `blur`,
    `groupId`, `hyperlink` or `aspectLocked` on the box; any other key,
    unknown ones included, is still measured). Typing into it measures once
    per key (63 per run) and writes the height three times as the text wraps
    (`y.tx.local` 60 → 63): the budget of `text.type.inter` now says so.
  - **The four local transactions of every deck open are empty**: a new
    counter `y.tx.local.empty` (and `y.tx.remote.empty`) counts transactions
    that changed nothing; on `deck.open.cold.10` it equals `y.tx.local` (4 =
    4). An open writes nothing to the document; the four are bindings'
- 2026-10-18, **L1, L2 and the editor's CLS done** (editor-ui; MacBook M3
  Pro, battery, Low Power Mode off, a machine shared with other agents, load
  6–30 during the final runs; Lighthouse before/after interleaved on two
  `vite preview`s of HEAD's and this tree's prod builds, same seeded
  ten-slide deck, medians of 5).

  | first paint, kB gz (JS + CSS, `just size`) | before | after |
  | ------------------------------------------ | ------ | ----- |
  | login `/auth/login`                        | 603.9  | 125.0 |
  | folders home `/`                           | 603.9  | 179.2 |
  | folder `/folder/:id`                       | 603.9  | 259.5 |
  | editor `/deck/:id` (and a share link)      | 912.0  | 708.4 |
  | present `/deck/:id/present`                | 822.9  | 583.9 |
  | EditorLayout chunk                         | 100.2  | 63.5  |

  | Lighthouse `/deck/:id`, desktop | FCP | LCP  | TBT | SI   | TTI  | CLS   | score |
  | ------------------------------- | --- | ---- | --- | ---- | ---- | ----- | ----- |
  | before (HEAD build)             | 990 | 1666 | 54  | 1774 | 1800 | 0.122 | 0.86  |
  | after                           | 662 | 1674 | 38  | 1550 | 1691 | 0.005 | 0.92  |
  | `just lighthouse` (after)       | 720 | 1632 | 17  | 1434 | 1647 | 0.005 | 0.92  |

  `just perf deck.open.* --mode prod` (5 runs; the stored baselines are
  HEAD's on AC with Low Power Mode on, so the harness calls them not
  comparable): first paint cold.10 860 → 416, warm.10 506 → 394, cold.100
  875 → 402, warm.100 486 → 369 ms; settled cold.100 8.3 → 7.6 s.
  - **L1, vendor chunks off routes that do not use them**: the catch-all
    `vendor` group and the Radix group are gone (each package goes with the
    code that imports it); `renderer/fontChanges.ts` no longer imports Pixi
    — Pixi's `Cache` / `FontStylePromiseCache` get the registered fonts
    through `renderer/pixiFontSink.ts`, installed by the text renderer —
    so Inter's registration in `main.tsx` stays and Pixi left the entry;
    `@narrative/slide-model` and `@narrative/commands` declare
    `"sideEffects": false` (the built-in object types are registry data now,
    `builtinObjectTypes.ts`, not top-level calls in the barrel — a first
    try that kept them in the barrel lost `rectangle` in the build); the
    folder pages are lazy routes (`routePages.ts`), the route table's path
    constants moved out of `UserMenu.tsx`; tus-js-client loads on the first
    upload (`lib/tusClient.ts`; an upload cancelled before it arrived never
    starts). `main.tsx` preloads the opened route's chunks at boot (a deck
    route's DeckShell and page at once — they loaded one after the other),
    in parallel with the session check; a preloaded lazy page renders
    without suspending (`lazyRoute.preload`).
  - **Notes and presenter** (Tiptap, 132 kB gz): `SlideNotesPanel` renders a
    stand-in with the panel's exact frame and the notes as plain text; the
    editor (`SlideNotesEditor.tsx`) loads on hover / focus / click (which it
    then takes over) or once the editor settled. The presenter view's rich
    notes are `PresenterNotes.tsx`, with the plain text as stand-in.
  - **L2**: `ui/lazyEditorParts.tsx` — crop, path-point, move-to and table
    overlays, the table inspector, the cheatsheet, share, export, component
    picker, promote, slide-number and folder-font dialogs (`lazyPart` /
    `lazyDialog`: own Suspense, preload; a dialog mounts on its first open).
    The timeline, inspector, slides panel and the text editors stay eager
    (first paint, or focus on the double-click that opens them).
  - **When the deferred code loads** (`ui/editorReady.ts`): after the
    canvas' first frame, 3 s, then idle. Started right after the first
    frame, these loads put 83 scripts before the LCP (the slide thumbnails;
    28 at HEAD) and Lighthouse's LCP went 1.61 → 1.99 s, TTI 1.68 → 2.0 s;
    with no deferred loads at all it was 1.67 s.
  - **CLS 0.122 → 0.005**: 0.11 of it was the stage — EditorLayout started
    from guessed toolbar / bottom-panel heights (40 / 56 px) and the
    ResizeObserver's correction re-centred the artboard a frame after the
    first paint; they are measured in a layout effect now. The rest: the
    notes panel grew ~55 px when the deck synced ("No slide selected" →
    the 72 px editor box); its body keeps the editor box's height in every
    state, so a slide without notes shows a taller empty panel than before.
    The 0.005 left is the toolbar's centre group shifting when its right-hand
    items load.
  - Budgets: `just size` runs `apps/web/scripts/routeSizes.mjs` after
    size-limit (the build writes its manifest with
    `NARRATIVE_BUILD_MANIFEST=1`): every route's first paint against its own
    budget (login 135, home 190, folder 275, editor 740, present 615 kB); the
    size-limit glob "total first-paint" is gone, the entry chunk's limit
    210 → 40 kB.
  - Tests: unit tests of `lazyRoute.preload`, the font sink's replay and the
    upload cancelled before tus loaded; `e2e/notes-panel.spec.ts` (a click
    into the stand-in types into the editor — it caught Tiptap's commands
    throwing before its view existed — notes reach the presenter view, the
    editor opens with CLS < 0.05). e2e ran against a dev-mode build of this
    tree behind `vite preview` (one worker): the smoke set, notes, present,
    upload, PPTX import, keyboard shortcuts, tables, access tokens, the
    component picker, the context menu, renderer-visual, inspector-flows,
    typography, text editing, animation — all green except
    `renderer-visual` "tearing down another Pixi application", which imports
    `/src/renderer/thumbnails.ts` (dev-server only), and
    `route-load-failure` (dev-server module URLs); both to run after the merge.
  - Not done: the editor route still loads 49 chunks (34 under 3 kB —
    single lucide icons shared by lazy parts); an entries-aware icon group
    cut it to 41 but cost login and present a few kB, so it was left out.
    The folder page keeps Yjs and the token schema (FolderDocProvider).
    no-op transactions, a decode and an empty `afterTransaction` each.

- 2026-10-18, **P0–P3 done: present mode only composites after ready**
  (renderer; ADR 0016, proposed — needs the tech-lead's sign-off). MacBook
  M3 Pro, Chromium 156 on ANGLE Metal, 1× DPR, 1600 × 900, **Low Power Mode
  on (AC profile)**, load 10–33; prod builds of HEAD + the instrumentation
  ("before") and of this tree ("after"), served side by side and run
  interleaved (before, after, …), 1 warm-up + 5 runs each, medians. A run
  opens the presentation, waits until ready, then advances through every
  slide and back (builds: clicks through the onClick steps; video: 3 s of
  playback each way; jump: a link to slide 9 and back, three times;
  presenter: the pop-out window drives).
  - **P0, the benches**: `apps/web/e2e/perf/present.spec.ts` (seven
    `present.*` benches, decks in `scenes.ts → present*Ops`: 12 text slides in
    a folder font with page numbers and gradients; 12 slides of 12 distinct
    3000 × 2000 photos; none / fade / push ×4 / cube / magic; four build
    slides; a 10 s 1080p H.264 video), per pass: frames missed, frames over
    two intervals, longest frame, p99, worst advance (input → incoming slide
    quiet), long tasks, GL textures gained over the pass (E8), and the work
    after ready budgeted at 0 (`perf/budgets/present.*.json`). The visual
    spec `e2e/present-smooth.spec.ts` reads every frame of each advance back
    (40-px cell means): a cut shows only the outgoing slide or the incoming
    one whole; a transition is whole from its end on. It failed on the old
    code at the first cut (frame 0 of slide 2: 193 off).
  - **What hitched, and why** (before): every advance mounted the slide
    (`sg.mount` 176 a text pass), rasterised its texts (176, 36 Mpx) and
    uploaded them and its pictures in the frames that showed it (512
    uploads, 113 Mpx, 512 mipmaps); the presenter view rendered the next
    slide's thumbnail offscreen on every advance (10–20 renders, a second
    WebGL context, PNG encodes: the 52–65 ms long tasks); photos were decoded
    on the advance (`rm.texture.load` 9 a photo pass, 30–45 requests);
    transitions mounted the incoming slide at the click; builds were applied
    after the transition had shown their objects (a blink); a video slide
    created its `<video>`, asked for its info and swapped the poster for live
    frames after the advance.
  - **Fixes**: `renderer/presentSlides.ts` (slides prepared off stage:
    mounted, warmed into a 1 × 1 render texture until every raster landed and
    every texture is uploaded, kept fresh against objects, background, page
    number, surface, token colours and font faces; a GPU-budgeted window,
    `ResourceManager.admitResident`, 1 GiB, the slide shown, its neighbours
    and its links resident always); `SceneGraph.swapSlideScene` (and the
    held-slide bookkeeping Canvas.tsx feeds, so the subscription's removal
    and first emission of a swapped slide do nothing); `playTransition`
    takes the prepared scene; `present/presentation.ts` (navigation: builds
    compiled on the prepared slide before it shows, played on arrival, clicks
    gated until then); `present/preloadMedia.ts` (pictures fetched through
    the renderer's URL resolver; the IndexedDB copy removed);
    `renderer/presentVideos.ts` (a buffered element per video, on its first
    frame, attached before ready; EditorVideoPreview plays it);
    `PresenterOverlay` asks for every slide's picture once; Pixi's GC off on
    the present canvas; `PresentLayout` gates the first slide on all of it
    (no 30 s timer).

  | Chromium, prod (before → after) | ready s     | frames missed | > 2 intervals | longest frame ms | worst advance ms | long tasks ms | work after ready                                            |
  | ------------------------------- | ----------- | ------------- | ------------- | ---------------- | ---------------- | ------------- | ----------------------------------------------------------- |
  | `present.advance.text`          | 0.71 → 1.98 | 8 → 1         | 2 → 0         | 50 → 33          | 155 → 66         | 0 → 0         | 176 rasters, 512 uploads (113 Mpx), 176 mounts → 0          |
  | `present.advance.photo`         | 0.74 → 2.10 | 3 → 1         | 1 → 0         | 50 → 33          | 192 → 66         | 52 → 0        | 53–69 uploads, 9 decodes, 30–45 requests, 132 mounts → 0    |
  | `present.transition.all`        | 0.65 → 1.43 | 0 → 0         | 0 → 0         | 17 → 17          | 888 → 865        | 0 → 0         | 32 rasters, 90 uploads (53 Mpx), 8 decodes, 14 requests → 0 |
  | `present.build.steps`           | 2.33 → 3.29 | 1 → 0         | 0 → 0         | 33 → 17          | 1839 → 1845      | 0 → 0         | 30 rasters, 65 uploads, 5 decodes, 7 requests → 0           |
  | `present.video.play`            | 0.57 → 0.73 | 3 → 0         | 1 → 0         | 50 → 17          | 3030 → 3019      | 0 → 0         | 4 rasters, 6 mounts, 1 decode, 1 thumbnail → 0              |
  | `present.jump.link`             | 0.72 → 2.05 | 2 → 0         | 1 → 0         | 50 → 17          | 259 → 90         | 0 → 0         | 12–16 uploads, 36 mounts, 3 requests → 0                    |
  | `present.presenter.window`      | 0.71 → 1.95 | 12 → 0        | 4 → 0         | 67 → 17          | 187 → 68         | 65 → 0        | 176 rasters, 512 uploads, 20 thumbnails → 0                 |

  Worst advance of the transition, build and video passes is the
  transition, the build timeline and the 3 s hold themselves. The 1 frame
  missed left in the text and photo passes is one 33 ms frame per pass
  (frame p99 16.8 ms after, 33 ms before); GL textures gained over a pass: 0
  in every bench (E8, no growth). Ready is longer by design (1–1.4 s on
  these decks; the photo deck in dev: ~10 s). The build pass's
  "before" counts and the photo/jump "before" uploads varied between runs
  (timing-dependent), so those two were compared with `PERF_DISCOVER=1`.
  - **WebKit**: not measured — Low Power Mode is on in the AC profile
    (`pmset`: AC lowpowermode 1) and the harness refuses WebKit then (30 fps
    cap). To run: switch it off, `just perf present.advance.text … --browser
webkit`.
  - **Open**: a 1080p playback rendition for 4K sources (the video worker
    keeps the source resolution: 8.3 Mpx decoded and uploaded a frame on a
    1920 × 1080 slide; server change); the editor's slide switch could use
    the same cache (E3); the `idb` dependency is unused now (dropping it
    needs a lockfile change).

- 2026-10-18, **E2 (faces), W1 (system fonts), W2 (first step)** (MacBook,
  load 10–38 from a parallel e2e run; no Pixi patch):
  - Measured first (`rasterbench`, an SVG raster built as HTMLTextSystem
    builds it, median of 15): Verdana's four TTF faces are 944 kB of
    URI-encoded SVG per text, one face 259 kB; Chromium serialise + load +
    draw 26 → 8 ms per raster, WebKit 25 → 12 ms cold, 13 → 4 ms warm. The
    bundled Inter is two variable files (upright + italic): 140 → 68 kB,
    Chromium 4.9 → 2.8 ms. Every face is decoded per raster, so the cost
    is linear in the faces a family has, not the ones a text draws with.
  - Faces: `style.fontFamily` holds keys (`nrf-<n>`), one per family a text
    uses, standing for the faces its weights × slopes × width match
    (`renderer/fontFaceMatch.ts`: CSS Fonts 4 §5.2 — width, slope, weight,
    ranges for variable faces; an angle-less `oblique` face is also matched
    as the italic slope, as Chromium and WebKit do, and both picks are
    embedded). The rules behind a key declare the real family, and the
    text's CSS stack (`cssOverrides`) is unchanged, so fallbacks, synthetic
    bold/italic and line metrics are what they were. Inter is registered
    from its bytes like a folder font. A run made bold/italic or set in
    another family re-keys the text (`syncHtmlTextFontKeys`); a face that
    lands later re-keys table cells and component leaves too
    (`refreshHtmlTextFontKeys`). Run markup writes `font-family: ` with a
    space, so Pixi's markup scan finds nothing to wait for.
  - Proof of identical pixels: `e2e/htmltext-face-subset.spec.ts` draws 78
    requests × 2 families (7 faces of 4 files under awkward descriptors; 2
    upright faces for synthesis) with the whole family and with the subset
    — equal in Chromium and in WebKit. It caught the oblique/italic tie.
  - Counters: `text.raster.fontKb` (and `thumb.…`), `text.raster.safariDelay`
    (registered, not budgeted). The bench scenes are all Arial, so Chromium
    timings cannot move; slide.switch.100 alternated before/after/before/
    after: input.p50 28.1 / 31.3 / 27.8 / 26.4 ms, settle 66–69 ms — noise.
    WebKit: `safariDelay` 12 → 0 per switch, 6 → 0 per open; input.p50 399 →
    394 ms, open.settled 3880 → 3880 ms (WebKit's frames dominate there).
    Budgets unchanged (counts identical; budgets are measured in dev).
  - Upstream (Petr to decide): an option on HTMLTextSystem to skip or
    shorten `loadSVGImage`'s fixed 100 ms Safari delay (e.g. when the
    embedded faces are already decoded in the document, or `delay: 0`),
    measured unnecessary in Playwright WebKit 27.2 for data-URL faces.
  - E3's raster cache was moved to another workstream (pre-rendered slides).
- 2026-10-19, **found while fixing a test race**: the first live-thumbnail
  capture of a slide (`captureSlideCanvas`, Pixi `extract.canvas`) spends
  ~290 ms in a synchronous `readPixels` on the main thread — a long task in
  the editor after the first edit of a slide. To do: read back
  asynchronously (a PBO / `fenceSync` read, or `createImageBitmap` of the
  canvas) or from a smaller target. `renderer-visual.spec.ts` and
  `inspector-flows.spec.ts` sampled the thumbnail after a fixed 800 ms and
  raced the 500 ms edit debounce plus this readback (failed 1 in 3 on
  e71d31d4 too); they now poll for the expected colour.

- 2026-10-19, **D: the last missed frame of an advance, and the live
  thumbnail's read-back** (renderer; MacBook M3 Pro, 18 GB, Chromium 156 on
  ANGLE Metal, prod builds; memory pressure level 2 all day — ~14 GB in the
  compressor — and load 5–74 from other work on the machine; Low Power Mode
  on for part of it, so WebKit was not measured).
  - **Where the frame went.** `present.spec.ts` now writes every frame over
    1.5 intervals to the details file (`notes.slowFrames`: the advance it
    followed, the renders and long tasks around it) and can trace a pass
    (`PERF_TRACE=<dir>`). The missed frames sat on the first frame of a
    swap (`render` 0.2–3.6 ms, 25 draws, nothing uploaded, no GC, no React
    commit, no request) — the time was the GPU process executing that
    frame's WebGL commands: 2–44 ms on an advance, 0.2 ms for the same
    textures on the next frame of a transition. A diagnostic (dev, text
    deck) put it on time off screen: a swap after 0.4 s cost 7–15 ms
    (key → GPU done), after 5–20 s 38–163 ms with a 33–150 ms frame; a
    redraw of the same slide after 5–20 s 25–113 ms, right after 11–15 ms.
    What goes cold is both the canvas's screen path and the incoming
    slide's textures: drawing the textures again (1 × 1) or presenting a
    frame again each removed only half of it.
  - **Fix: keep-warm** (`renderer/presentSlides.ts` → "Kept warm",
    `renderer/presentKeepWarm.ts`): after ready, every 500 ms in an idle
    callback (never during a transition or build, never on a hidden page),
    the slide shown and the slides one step away are drawn into a 1 × 1
    target and the canvas presents one frame (skipped while Pixi's ticker
    runs anyway). Same diagnostic with it: redraw after 5–20 s 13.5–18.8 ms,
    swap after 5 s 12–20 ms, no frame over 16.7 ms. The perf harness counts
    these draws as maintenance (`RenderKind 'keepWarm'`: no frame, no GL
    counter, not "busy"); `setKeepWarm` / `PERF_KEEP_WARM_AB=1` runs one
    build as two interleaved sides, keep-warm off and on.
  - **New bench `present.advance.paced`**: six advances, each slide held 4 s
    (a presenter's pace); the quick pass advances every ~370 ms and never
    lets a slide go cold. Budget 0 work (dev counters: ok).
  - **A/B, one prod build, 10 runs a side, interleaved** (runs with any
    missed frame / frames over 1.5 intervals at an advance):

    | bench                   | keep-warm off                 | keep-warm on                  |
    | ----------------------- | ----------------------------- | ----------------------------- |
    | `present.advance.paced` | 3 / 10 runs, 5 frames ≤ 83 ms | 1 / 10 runs, 1 frame of 33 ms |
    | `present.advance.text`  | 2 / 10, 6 frames ≤ 83 ms      | 2 / 10, 5 frames ≤ 67 ms      |
    | `present.advance.photo` | 3 / 10, 7 frames ≤ 200 ms     | 1 / 10, 1 frame of 133 ms     |

    Medians: 0 frames missed, longest frame 16.8 ms, p99 16.8 ms on every
    side; GL textures gained 0. Not zero hitches: the misses left are
    single, scattered, on frames whose own work is ≤ 3.6 ms of `render`, and
    the same runs drop frames 1.8 s into a hold, when nothing of ours draws
    at all (`present.advance.paced`, keep-warm on, run 12). The "long tasks"
    reported in those frames (50–106 ms) are the harness's own input fence
    (a 1 × 1 `readPixels` waiting on the GPU process), not the app's work.
    On this machine under this memory pressure that is the floor; a clean
    run (AC, Low Power Mode off, no memory pressure) is still to be made.

  - **The live thumbnail's read-back** (`renderer/captureSlide.ts →
captureSlideCanvasAsync`, `renderer/liveThumbnail.ts`): drawn into a
    texture as before, read into a pixel-pack buffer behind a fence, the
    pixels fetched once a timer poll sees the fence passed; the pixels and
    the canvas made exactly as Pixi's `extract.canvas` makes them (the same
    read of the resolved framebuffer, `putImageData` unchanged); WebGL1
    falls back to the synchronous read. Measured with a throwaway spec
    (crowded slide, one edit on a fresh page, 10 pages a side, HEAD vs this
    tree): on the GPU, 0 ms of long tasks on both sides — the queue is
    empty by the time the capture runs; on SwiftShader (as the e2e suite
    runs) `readPixels` was 592.5 ms of main-thread self time in the
    capture, now `getBufferSubData` 0.4 ms — but the long tasks stay
    (longTask.max median 1072–1226 → 1219–1325 ms over two runs): the
    main thread waits on the same GPU-process work at the next frame's
    flush instead. The capture no longer stalls the main thread itself; it
    does not make a software-GL editor's frames cheaper. Budgets unchanged. The
    capture lands a poll later than the synchronous one did, which exposed
    `inspector-flows.spec.ts`'s thumbnail poll: it waited for a blue
    channel over 180, which the empty slide's white picture also has; it
    now polls for the whole colour (failed 4 of 4 before, passes since).
  - **E3 (the editor's slide switch from the prepared-slide cache): not
    built.** The swap and the held-slide bookkeeping fit as they are, but
    the editor's texts are pinned to the zoom's staged resolution
    (`restageTextResolution`): a scene prepared off stage either rasterises
    again at the switch (the cost E3 removes) or every prepared slide
    rasterises again on every zoom commit. Which of the two — or a
    zoom-independent raster resolution for prepared slides — is a decision
    for ADR 0016's follow-up (tech-lead).
  - **Found on the way**: `just perf-compare` cannot build an older side on
    this MacBook — the worktree install fails on `ERR_PNPM_IGNORED_BUILDS`
    (`electron-winstaller` is not in `allowBuilds`), and without the
    decrypted `.env` its build has no `VITE_BYPASS_AUTH` and shows the
    login page; `npm_config_strict_dep_builds=false VITE_BYPASS_AUTH=true`
    in the environment works around both for a throwaway worktree.
    `transform.move.rect.light` fails on HEAD itself ("perf-r0 moved").
    Dev MinIO is at 6.0 GiB, ~5.4 GiB of it under `decks/<id>/` of 26
    decks whose rows are gone (no deck, no media row): the deck delete's second
    prefix sweep is an in-process timer (`sweepAgainAfterGrace`), lost when
    the dev server restarts — five of them (1.0 GiB) are this work's
    present photo decks.
- 2026-10-19, **X3 (streaming PPTX writer), async PDF, R2 poster while
  processing, P3 1080p rendition** (MacBook M3 Pro, Low Power Mode on, Node
  24.21, a machine shared with other agents; load and how A/B ran per item).
  - **X3** — the export is streamed instead of built in memory by JSZip.
    `pptx/zipWriter.ts` lays the archive out before its first byte: every
    entry's CRC-32 (`zlib.crc32`, native) and sizes come from a first pass
    over the media — streamed from storage, never held; pictures sized from
    their first 1 MiB where the header tells (JPEG/PNG/GIF/WebP; anything
    else, or a header that does not tell, read whole as before) — so the
    package has an exact size: the route sends `Content-Length` and streams
    with backpressure (a client that leaves stops the storage reads), the
    agent's `url` delivery is a multipart upload into the bucket
    (`media/multipartUpload.ts`, 8 MiB parts), `base64` is refused for its
    size before any work. A second read of each object writes it; a source
    that does not match its first read (size, CRC) fails the write instead
    of producing a package that lies. Format as JSZip wrote it (local
    headers with CRC and sizes, no data descriptors, DOS UTC timestamps, the
    same entry order), version needed 2.0; ZIP64 past 4 GiB or 65 535
    entries (JSZip wrote a broken file there); dates before 1980 clamped.
    Deflated parts by Node's zlib at level 6 (other bytes than pako's, the
    same content).
  - Numbers (`just perf-pptx`; the driver now exports in a fresh process
    into a file, so the export's peak RSS is its own — before, it sat on the
    import's heap):

    | deck                                | export p50 before → after | export peak RSS (maxRSS) | how                           |
    | ----------------------------------- | ------------------------- | ------------------------ | ----------------------------- |
    | synthetic (199 MB, 205 media)       | 2.68 → 2.06 s             | 720 → 370 MB             | same load (5–13), 3 runs each |
    | OHSOMO continuum (208 MB, 9 videos) | 3.53 → 2.06 s             | 747 → 388 MB             | 2 runs each, load ~8 / ~5     |

    The time moved: `export.zip` (JSZip's CRC and package, 1.1–1.3 s) is
    now 10–20 ms of layout plus `export.write` ~1.0 s (the second storage
    read, into the file); `export.assets` 1.4 → 1.0 s. A first after-run of
    OHSOMO under load 55–94 took minutes for everything, import included,
    and is not counted. Model and export fingerprints identical before and
    after on both decks; `just pptx-roundtrip`: Atomic (49 slides) 0, IIC
    Intro (166) 6, Audi LIVE (174) 1 differences — identical with HEAD's
    writer swapped back in. The 879 MB Audi deck did not go through
    `perf-pptx`: 2 GB of free disk at the time (its import stores ~0.9 GB).

  - **Async PDF** (R1) — `POST /decks/:id/export.pdf` checks the request
    (access, slides, two exports per person, 20 pending) and answers 202 with
    a job id; `GET /decks/:id/export.pdf/:jobId[?waitMs=]` reports pages done
    of total, then a fresh 15-minute link (stored as an attachment named
    after the deck) or the failure the request would have answered. The job
    runs in the server process on the BullMQ queue `pdf-export` (media
    Redis; `render/pdfExportQueue.ts`), its slides through the render queue
    as before (jobs of 20, each with its own 95 s), the file within 10
    minutes; a job a stopped process left is retried once. `deck.exportPdf`
    waits up to 50 s, else answers `status: "running"` and a `jobId`; called
    with only `jobId` it waits for that job (one tool, not two: the
    tools/list budget). The editor's server fallback polls, with progress
    in its notice. The render page re-read `/api/decks/:id` on every
    `?slide=` change (`DeckRoleContext` depended on the whole query); now on
    the share token only (unit test: 4 → 1 reads for 3 switches). Not
    measured end to end: the 30-slide photo PDF needs the production web
    build, Caddy and the render worker image under VM 103's limits (R1's
    setup), too heavy for this machine today; `apps/render-worker/perf/render.ts`
    still times the synchronous call and needs the job API first.
  - **R2, poster while processing** — the editor showed a processing video
    as grey "Processing…" until the transcode was done, although the worker
    stores the poster seconds after the probe; it now draws the poster under
    the label as soon as video-info has it (the 5 s poll), and keeps it
    without a reload when the video turns done.
  - **P3, 1080p rendition** — a source larger than 1920 × 1080 as displayed
    (rotation applied) gets `present.mp4` (libx264 crf 20, aac, fitted, even
    sides) and its size on the row (migration 0039); `video-info` hands it
    out as `presentPlayback`; present mode plays it when the video's picture
    at the presentation's device-pixel size needs no more pixels
    (`renderer/videoRendition.ts`: a 1080p screen yes, a Retina laptop or a
    4K projector no). It is its own ffmpeg run after the video is marked
    playable: one run with both outputs (split filter) made 4K ProRes
    playable 9.9 → 15.0 s on two threads, so that was dropped.
    `apps/video-worker/perf/transcode.ts` (now also time to 1080p and the
    sizes), `FFMPEG_THREADS=2`, 10 s testsrc2, new/base/new interleaved,
    n=2 each, load 7–47:

    | case            | playable base → new | 1080p ready | playback / present.mp4 |
    | --------------- | ------------------- | ----------- | ---------------------- |
    | 4K H.264 (copy) | 0.64 → 0.63–1.15 s  | 2.9–3.5 s   | 24.9 / 4.7 MB          |
    | 4K ProRes       | 11.8 → 11.3–11.7 s  | 15.4 s      | 35.2 / 5.1 MB          |
    | 1080p H.264     | unchanged           | none        | 7.2 / –                |

    A rendition frame is 2.07 Mpx instead of 8.29 (a quarter of the decode
    and the texture upload); not yet measured in the browser. Videos
    transcoded before 0039 have none until `db:backfill-video --all`
    re-runs them.

  - **Review fixes (security, code, agent parity), same day.**
    - _PDF caps:_ a person's two exports and the queue's twenty were read
      (`activeFor` / `pending`) before the job was added, so concurrent
      starts all passed. A Redis script now reserves the slot in one step
      (the person's set, everyone's set, the person's starts per minute:
      `PDF_START_LIMIT` 4, the agent's command held to it too, not only to
      the agent endpoint's 240); the slot goes back when the job ends
      (worker `completed`/`failed`, the queue's `failed` for a job failed for
      stalling), when the add fails, and — missed releases — when a refused
      reservation finds slots older than a minute whose job is gone; two
      hours is the last resort. The PDF jobs' renders stay `uncapped`
      (capped as the job). Integration-tested: ten concurrent reservations,
      two pass.
    - _Status reads:_ `waitMs` clamped to 60 s in the service (25 s on the
      route), four waiting reads per person at once, 60 reads a minute on the
      route; a finished `base64` PDF is handed out three times (each an
      8 MiB read), then 410.
    - _Waiters:_ `waitForEnd` reads the state only once the events
      connection is up, and again every 2 s — the stream is read from "now",
      so an end between the check and its first read was never heard.
    - _Shutdown:_ the PDF worker closed gracefully (up to 10 s) before
      Hocuspocus stored anything; Docker's 10 s grace could SIGKILL first.
      Now `shutdown.ts`: the worker closes with force (its job is retried by
      the next process — integration-tested, the stall retry included), HTTP
      closes beside it (8 s at most), the agent host then Hocuspocus first;
      `stop_grace_period: 30s` for the server.
    - _Uploads and storage:_ the multipart writer aborts also when destroyed
      while its upload is being created or a part is on its way (unit
      tests); MinIO refuses `AbortIncompleteMultipartUpload`, so its own
      stale-upload expiry (24 h) is pinned in compose (docs/storage.md). The
      zip writer opens a source ahead only within 1 MiB of its data, and the
      HTTP route one at a time: a slow download holds one idle storage read
      at most. A `present.mp4` finished after its asset was deleted is
      removed by the worker (the update reports no row), and a single
      asset's delete purges the keys `DELETE … RETURNING` gives. A video
      copied between `done` and its rendition gets none — documented in
      docs/storage.md, not fixed (no copy→source link, no rendition-only
      job).
    - _Agent surface:_ `deck.exportPdf` refuses `jobId` with any other
      field (defaults in the descriptions now, so a given value can be told
      from an omitted one) and names `queued`; tools/list stays under
      200,000 bytes. `just eval` not run for it (paid).

- 2026-10-20, **The second prefix sweep survives a restart** (server;
  found 2026-10-19, see the D entry's "Found on the way"). A deleted owner's
  first sweep keeps everything younger than the grace window, and a perf
  run creates and deletes its decks within minutes — so all of their media
  waited for the second sweep, an in-process timer the dev server's restart
  on every edit forgot: 5.77 GiB, 4 150 objects under 26 deleted decks
  (checked: no deck row, no media row naming a key under them), deleted
  2026-10-20, the dev bucket now 65 MiB. The deck, component and folder
  deletes now write a `media_owner_sweeps` row in their own transaction
  (migration 0040, `media/ownerSweeps.ts`), every server process runs the
  due rows each minute (taken with `FOR UPDATE SKIP LOCKED`, retried with
  back-off, a row whose owner exists dropped unswept); docs/storage.md →
  Cleanup. Integration-tested against Postgres and MinIO.

- 2026-10-20, **Baselines on a quiet machine; present mode in Chromium and
  WebKit, headless and headed** (MacBook M3 Pro, AC, Low Power Mode off,
  Chromium 156 on ANGLE Metal, Playwright WebKit 27.2, prod builds of
  2a3171c6 + this work; the Wacom tablet daemon `com.wacom.DataStoreMgr`
  stopped — it took ~50 % of a core all day — load 5–9 from the dev
  stack's Docker VM, Jamf and the desktop).
  - **Baselines re-accepted** (`just perf --mode prod`, all 28 benches,
    40 min, then `just perf-accept`; 78 baselines: Chromium prod plus the
    dev/profiling series as they stood, WebKit present). The old ones were
    taken on AC with Low Power Mode on. Counter budgets unchanged. A run
    the stop hook's `just check` overlapped (server tests at 245 s, four
    timeouts) was thrown away and run again; so was one started with the
    Wacom daemon still busy.
  - **Chromium, present mode, runs (of 10) with any missed frame:**

    | bench                      | 2026-10-19 (busy machine) | now              |
    | -------------------------- | ------------------------- | ---------------- |
    | `present.advance.text`     | 2                         | 0                |
    | `present.advance.paced`    | 1                         | 0                |
    | `present.advance.photo`    | 1                         | 3, on a rerun 0  |
    | `present.transition.all`   | —                         | 0                |
    | `present.build.steps`      | —                         | 1 (one 33–83 ms) |
    | `present.video.play`       | —                         | 0                |
    | `present.jump.link`        | —                         | 0                |
    | `present.presenter.window` | 0                         | 0                |

    Longest frame 16.8 ms in every clean run. Ready 0.65–2.7 s.

  - **The one Chromium hitch left** (`present.build.steps`): the first
    entry of slide 3 (a `scaleIn` + `rotateIn` that play on arrival), in
    the first pass of a fresh page — 3 of 4 fresh pages, one 33 ms frame —
    and once in a later pass. `present.spec.ts` now keeps the slow frames of
    every pass (`notes.slowFramesOfPasses`; the details file had the last
    pass only), and `PERF_TRACE_CATEGORIES` adds trace categories. In the
    trace the renderer's main thread sits 29–40 ms at the start of
    `WebFrameWidgetImpl::BeginMainFrame` with ~2 ms of thread time: no
    task, wait, IPC, GC or GPU work is traced on any thread, our `rAF`
    runs after it, and the compositor meanwhile reports frames without the
    main thread. The builds are compiled (and run to the end and back) at
    the key press already, so it is not their first run. Native samples
    (`sample`) of `chrome-headless-shell` carry no symbols. Not explained;
    measured in the headless shell only.
  - **WebKit, headless, runs with a missed frame:** text 1, paced 1, photo
    1, transitions 1, jump 2, video 4 (up to 66 ms), builds 4 (17 frames in
    one run, up to 99 ms). Medians 0 everywhere; ready 3.5–4.3 s (Chromium
    1.4–2.7 s).
  - **`just perf --headed`** (new): the browser draws in a window, paced by
    the display as the Tauri window is; its results are a series of their
    own (`…/webkit-browser-headed`) and never compared with a headless run
    (`fingerprint.browser.headed`, unit-tested). Headed WebKit, runs with a
    missed frame: video 1 (37 ms; headless 4), photo 1, transitions 2, text
    3, builds 5 (1–3 frames each), paced 5 — paced's large ones (up to
    402 ms) fell in holds with nothing of ours drawn, while the desktop
    was in use (WindowServer ~40 %, Chrome): a window on a shared desktop
    measures the desktop too.
  - **Keep-warm in headed WebKit** (`PERF_KEEP_WARM_AB=1`, paced, 10 runs a
    side, interleaved): off — median 4 frames missed and 2 hitches a run,
    longest frame 55 ms; on — 0 and 0, 21.5 ms. The harness now logs each
    keep-warm draw (`keepWarmLog`) next to the slow frames: the hold-time
    misses were not keep-warm's. What is left with it on are single misses
    on the first frame of a swap (26–66 ms, 1–12 ms after the key).
  - **Tried and dropped: keep-warm on the canvas's own path.** Hypothesis:
    the 1 × 1 target warms the incoming slide's textures but not the
    pipelines of the canvas's format, so the swap's first frame builds them.
    The keep-warm frame drew the slides one step away on the canvas and the
    slide shown over them in the same task (only the last is composited).
    A/B against the 1 × 1 target alone, headed WebKit, 10 runs a side:
    `present.advance.text` 0 → 2 runs with a miss (13 frames in one),
    `present.advance.paced` 2 → 2; Chromium `present.advance.text` 0 → 0.
    No gain, so not kept; the swap-frame misses in WebKit stay open.

- 2026-10-20, **L3 done: media URLs batched per deck, a 1280-px variant
  chosen by the canvas's density** (media; MacBook M3 Pro, AC, Low Power
  Mode off, Chromium 156 headless on ANGLE Metal; the machine shared with
  other agents — load 5–13 for most runs, 22 during the dev "after"
  measurement and up to 127 during the first prod bench run, whose timings
  were thrown away and re-measured as an interleaved A/B).
  - **What it was:** every picture resolved its signed URL alone — `GET
/api/media/:id/url` per (asset, variant), each a media row read and a
    deck-access query — so a deck open asked once per thumbnail and once per
    canvas picture, trickling over the first seconds as thumbnails rendered;
    and every canvas picture was the 2560-px `display` variant, whatever its
    size on screen.
  - **Batched:** `GET /api/media/urls?ids=…&variants=…` (at most 100 ids)
    answers many assets with one query (`readPlacedMedia`, the component's
    folder joined) and one access check per deck or folder behind them —
    the single route's rules (`mediaReadGate` in `services/media.ts`;
    unknown and forbidden ids alike in `unavailable`), claimed by the
    `media.url` command (ADR 0010). The client (`renderer/imageUrl.ts`)
    sends a task's worth of asks in one request, always with `preview`,
    `medium` and `display` (the slide panel's and the canvas's), caches
    every variant of the answer and the source's size, and the canvas
    prefetches the whole deck's pictures when it opens (`Canvas.tsx`,
    `renderer/deckPictures.ts`); ids are sorted, so an unchanged deck's
    prefetch is one HTTP-cacheable URL.
  - **`medium`:** `rs:fit:1280:1280:0` beside `display`, warmed after an
    upload with the others (`imgproxyWarm.ts`); the caps live in
    `@narrative/shared` `imageVariants.ts`. An image object is drawn from
    the smallest variant with a texel for every pixel of the canvas's
    backing store it covers (`renderer/imageVariant.ts`: the sprite
    `applyFit` lays out × the renderer's resolution — devicePixelRatio ×
    zoom, never below devicePixelRatio; present mode devicePixelRatio; the
    render page 1). The backing store, not the screen: the GPU never
    enlarges the smaller variant, so nothing is softer than with `display`.
    A larger variant of the same picture already on the GPU is taken
    instead of a second texture; a zoom commit (`SceneGraph.setPixelDensity`)
    or a resize past what `medium` holds loads `display` and swaps it in at
    the same drawn size, without a placeholder; never back down while
    mounted. The texture's aspect corrects the asset row's for an
    EXIF-turned photo. Present mode fetches each picture once, in the
    largest variant any slide needs, and every prepared slide draws it from
    that one texture (`picturesToFetch`, `PresentSlideCache.setVariantFloor`);
    the preload now also sees image fills (it looked for `fill.kind`, the
    fills are `fillStyle`). Backgrounds and shape/table image fills stay on
    `display` (a background covers 1920 slide units, more than `medium`
    holds at any density ≥ 1; fills: not done, below).
  - **Measured, a deck of 10 slides × 4 distinct 3000 × 2000 photos**
    (1000 × 660, 560 × 380 and two 360 × 240 per slide; a fresh context per
    run, medians of 3, dev build against the dev stack, viewport 1600 × 900;
    a one-off Playwright script, not committed, request timing from the
    browser; a repeat of an imgproxy URL, an HTTP-cache hit, not counted):

    | open, cold                      | before         | after        |
    | ------------------------------- | -------------- | ------------ |
    | editor, media-URL requests      | 44             | 1            |
    | editor, their server time (sum) | 385 ms         | 11 ms        |
    | editor, last URL answered       | 4.7 s          | 12 ms        |
    | editor, imgproxy bytes 1×       | 3.1 MB         | 0.8 MB       |
    | editor, imgproxy bytes 2×       | 3.1 MB         | 1.4 MB       |
    | present, media-URL requests     | 80             | 1            |
    | present, imgproxy bytes 1× / 2× | 27.0 / 27.0 MB | 3.3 / 9.3 MB |
    | present, ready 1× / 2×          | 7.8 / 10.7 s   | 5.5 / 10.9 s |

    Present at 2×: the 1000-unit pictures need 2000 px (`display`), the
    others `medium`. Ready at 2× did not move (the dev stack's imgproxy has
    no cache: a fresh deck's AVIFs are encoded while ready waits, at load
    11–22).

  - **The benches** (`just perf --mode prod`; deck.open as an interleaved
    A/B, `just perf-compare HEAD .`, load 8–12): `deck.open.cold.10` net
    requests 82 → 75 (the 8 URL lookups → 1), `gl.texUploadKpx` 9592 →
    3042 (the two canvas pictures `medium`); `deck.open.cold.100` the same
    lookups 8 → 1, 9592 → 3042 kpx; timings unchanged in both (first paint
    405 → 406, settled 1401 → 1319 ms, CIs include zero).
    `slide.switch.100` unchanged (URLs cached before and after).
    `present.advance.photo` unchanged by design: each of its 12 assets is
    full-bleed on one slide, so its texture is `display` everywhere
    (ready 1434 → 1513 ms, CI includes zero). `viewport.zoom.commit`,
    `editor.idle.crowded`, `transform.move.image`: no counter moved; a first
    A/B of the image drag showed `render.ms` +10 % (CI [2.1, 11.1]), the
    repeat −0.7 % (CI includes zero) with identical draw counts. No budget
    moved, nothing accepted.
  - **The harness's net buckets were blind in prod:** a build whose API base
    is `/api` asks `/api/api/media/…`, and imgproxy answers on its own origin
    in development, so `net.mediaUrl` and `net.imgproxy` read 0 and the
    lookups counted as `net.api`, the pictures as `net.other`
    (`apps/web/src/perf/measure.ts` `netBucket` now matches both).
  - Tests: server unit tests of the route (variants, sizes, one check per
    deck and per folder, unavailable ids, share links, 400s) and
    `services/mediaUrls.integration.test.ts` (Postgres: a deck guest, a
    share link and an outsider, each asset agreeing with the single read);
    web unit tests of the resolver (batching, sorting, in-flight sharing,
    chunks of 100, failures and retry, the cap), the variant choice, the
    preload's per-asset variants and the renderer's choice, floor, reuse,
    density and resize upgrades. `just check`, `just integration`, e2e
    (Chromium, one worker): renderer-visual, inspector-flows and 20 media
    specs (uploads, component media, present, render page and export,
    thumbnails, share links, clipboard, tables, PPTX into the panel) — all
    green. `tools/list` grew past its 200,000-byte budget with the longer
    `media.url` description; trimmed back under it.
  - Not done: image fills on shapes and table cells still load `display`
    (their texture maps onto the shape's own geometry, a choice of its own);
    present mode's density is the canvas's devicePixelRatio at init, so a
    window moved to a screen of another DPR keeps the variants (and the
    backing store) it started with — as the canvas itself does.
  - **Review round, same day** (code, security, agent parity; nothing
    re-measured: no counted value moves, the choices only got more
    conservative).
    - _Upgrade races:_ an upgrade cleared the "upgrading" mark by variant, so
      a stale one could clear a newer one's, and two could both swap and
      release the same medium texture (a shared texture unloaded under a
      drawn sprite, a display reference leaked). Each upgrade now holds a
      token of its own and clears only that; after its load it reads the
      node's texture again and gives its reference back when another swap
      or a new asset got there first. Unit-tested: two density commits in
      one upgrade, the node destroyed and the asset changed while one is in
      flight (references counted per URL, none below zero, none left over).
    - _Reload after an asset change by patch_ chose with the synthetic object
      (`fit` defaulted to cover): it chooses with the node's merged object.
    - _Present mode never fetches after ready:_ the preload sizes each picture
      for its source either way up (the renderer corrects an EXIF-turned
      photo's aspect after the load), and gives `display` to a picture a
      build scales up past its rest size (`zoomIn` from 2×, `popIn`, a back /
      elastic easing on `scaleIn` / `bounceIn`) and to the pictures of the
      slides a Magic Move joins (both ways, skipped slides passed over); the
      slide cache applies the build rule too. The editor does the same for
      the active slide's builds (`SceneGraph.setVariantFloor`, re-told when
      the builds change), so a build preview is never softer than before
      either. Unit tests of the rules and of the cache mounting with its
      density and floor.
    - _Cache:_ a partial answer of `GET /api/media/urls` (anything in
      `unavailable`) is `private, no-store` — an upload finishing or access
      granted must not stay missing for ten minutes under the same sorted-ids
      URL; both media URL routes send `Vary: Cookie`. The client's cache
      belongs to the page's share token: another token starts a fresh one.
    - _Server work per request:_ the decks behind a batch are checked in one
      query with one share-link lookup (`resolveDecksAccess` in
      `auth/permissions.ts`, integration-tested to agree with
      `resolveDeckAccess` deck by deck for owner, guest, outsider and share
      links), the folders four at a time; the route has a limit of its own
      (`MEDIA_URLS_RATE_LIMIT`, 300 a minute, none under BYPASS_AUTH).
    - _Images only:_ the batch and the single `url` answer image rows only; a
      video or font id is `unavailable` / 404.
    - _Not done:_ the single route still answers 403 for a forbidden asset and
      404 for an unknown one. Its unit tests, the service tests and the
      commands' error codes (`forbidden` vs `not_found`, which layouts'
      picture checks and agents read) rely on the distinction; changing it
      is an API change of `media.url`, left for a decision of its own.
      _Decided and done 2026-10-23 (F6, Final round):_ the single route and
      `media.url` answer 404 `Asset not found` for an asset the caller may
      not read, as for an unknown id; the other media routes followed —
      `/video-info` / `media.status`, `/font-url` / `media.fontUrl` (a legacy
      deck font row too) and `DELETE /api/media/:id` / `media.delete` for a
      caller who cannot read the asset (a reader without the role keeps its
      403). The reason stays server-side (`narrative_media_refusals_total
{route,reason}`, the `media refused` log line); a malformed
      `share_token` is 401 before any lookup; the single route got its own
      rate limit. Accepted residual: latency (ids ≥ 72 random bits).
    - _Parity:_ a `media.url` example with `medium`; tools/list at 199,999
      bytes in link mode (one byte left; recorded in
      `toolListBudget.test.ts`).
    - Tests: `just check`, `just integration` (23 files), e2e on Chromium with
      one worker: renderer-visual, inspector-flows, component-master-upload;
      present-layout, present-smooth, slide-transition, notes-panel,
      image-upload, component-promote-stamp, render-page.
    - _After the round, present mode_ (`just perf --mode prod --runs 3`,
      load 10–13): no work after ready in `present.advance.photo`,
      `present.transition.all` (cube and Magic Move) and `present.build.steps`
      (a `zoomIn` photo) — nothing fetched, loaded or uploaded after ready;
      ready 1451, 855, 2549 ms against the baselines' 1434, 1064, 2636. No
      budget moved, so no `just perf-counters` / `perf-accept`. The two e2e
      failures of one run (render-page with a render token, Magic Move in
      slide-transition) were the dev server restarting under another agent's
      edit (`ERR_CONNECTION_REFUSED` on the API and the sync socket); both
      passed on the re-run.

- 2026-10-20, **L4 done: local copies of documents in IndexedDB** (state-sync;
  [ADR 0017](../adr/0017-local-document-copies.md); MacBook M3 Pro, AC, Low
  Power Mode off, Chromium 156 with ANGLE Metal, prod build, `just perf
deck.open.* --mode prod`, 10 runs, medians; a machine shared with other
  agents: before at load 7–12, after at load 6–8):

  | deck open, ms from navigation    | before     | after                             |
  | -------------------------------- | ---------- | --------------------------------- |
  | warm.10 mounted / settled        | 452 / 1022 | 402 / 977                         |
  | warm.100 mounted / settled       | 562 / 6243 | 489 / 5980                        |
  | cold.10 mounted / settled        | 538 / 1324 | 534 / 1328                        |
  | cold.100 mounted / settled       | 586 / 6296 | 545 / 5927                        |
  | warm.100 first paint / synced    | 373 / 515  | 394 / 531                         |
  | warm opens: server's sync step 2 | full state | empty (`y.tx.remote.empty` 0 → 1) |

  A repeat open mounts the first slide 50–75 ms sooner on the local stack:
  the copy is applied before the server answers, and the sync that follows
  carries only what changed (nothing, here). On a real network the full
  transfer it saves grows with the deck (G8: 370 kB at 100 slides, 1.1 MB at
  300). Cold opens are unchanged (no copy indexed → the connection starts
  exactly as before). Writing a copy costs the main thread the encode
  (Node, the G8 decks: a base 1.5 ms at 100 slides, 6.7 ms at 300; an
  increment 0.03–0.13 ms), at idle.
  - **What is stored**: only states the server confirmed (provider synced,
    every local update acknowledged, the connection's epoch known), so a
    copy is always a subset of the server's document — a read-only
    connection's rejected writes never persist (property test over random
    interleavings, `state/localDocCopy.test.ts`; it fails when the
    acknowledgement condition is removed). One IndexedDB database, a base
    plus increments per `<user sub> NUL <document>`, a synchronous
    `localStorage` index so an open without a copy never waits for
    IndexedDB. Not `y-indexeddb`: it records unconfirmed updates (ghost
    edits on read-only connections), one database per document, no failure
    handling (ADR 0017 → Alternatives).
  - **Opening**: the WebSocket opens at once; the copy is read (≤ 1.5 s) and
    applied as one remote update (`LOCAL_COPY_ORIGIN`, outside undo); then
    the provider joins the socket, so its auth frame and first sync step
    carry the copy's epoch and state vector and the copy is never uploaded.
    Deck, folder tokens and component masters alike. A first version
    connected only after the read and showed it: synced +50–75 ms on warm
    opens, mounted barely better on 10 slides. Another first version wrote
    the first copy after the 1 s debounce, which moved a counter after
    everything else and made `open.settled` 950 ms later on cold.10 — the
    first write after a sync now goes at the next idle moment.
  - **Data migrations and replaced documents, proven over a real WebSocket**
    (`hocuspocus/documentEpoch.sync.test.ts`): a copy from before a CRDT edit
    on the server (what `dataMigrations.ts`, token propagation and agents
    do) merges harmlessly — removed slides stay removed, on the server and
    in the client; a copy from before a **replaced** document (new state, new
    identities) puts its old slides back. Guard: a server-issued document
    epoch (`doc_epoch` on decks, folders, components, migration 0041), told
    to every connection (`narrative.documentEpoch`) and claimed in the auth
    frame (`cookie;epoch=n`) for whatever the Y.Doc holds; a stale claim is
    refused with `stale-document` before any of the connection's messages is
    processed (not counted as a failed attempt), and the browser drops the
    copy and reopens empty. Whatever replaces a document must call
    `bumpDocumentEpoch` (AGENTS.md hard rule).
  - **Access**: copies only for signed-in users; none for share-link visits
    or the render pages. Any refused connection deletes the copy; refused
    before the first sync while showing one → the document is rebuilt empty
    (a revoked deck shows nothing once the server says no). Sign-out and a
    401 clear every copy; signing in as someone else deletes the previous
    person's; 30 days without a server confirmation deletes a copy; at most
    64 documents / 256 MB per user, oldest first, half of the rest on a full
    disk; IndexedDB or localStorage failing (private window) turns copies
    off for the page. `docs/auth.md` → Local document copies.
  - Tests: store (fake-indexeddb), session (fake provider + the property),
    shared wire format, onAuthenticate's epoch cases, the real-socket proof,
    a Postgres integration test of the epoch, e2e `local-doc-copies.spec.ts`
    (the deck paints from its copy with the sync server's socket held; a
    revoked deck shows nothing and its copy is gone; a share link keeps
    none; another person's sign-in deletes the first one's copies) — green
    in Chromium.
  - Open: offline opening (desktop D1) and a journal of pending edits (D2);
    the folder and component documents' copies are not benched separately.
  - **Security review, same round** (security-reviewer; all 7 findings
    fixed): the epoch survives a database restore (an instance generation,
    `instance_generation`, migration 0042, advanced by every `backup.sh`
    dump and written to a marker file mounted read-only into the server,
    `INSTANCE_MARKER_PATH` — `docs/deploy.md` → Restoring the database); a copy from another instance is detected and dropped;
    sign-out and a session change in another tab stop the writes; pruning;
    no copy on the render pages; a byte cap; ADR 0017's at-rest section.
    e2e `local-doc-copies.spec.ts` gained the cross-tab case (5 tests, green
    in Chromium in the combined run of 2026-10-21).

- 2026-10-20, **B3 measured on 300 slides; no virtualisation — the cost was
  every row re-rendering on a switch** (state-sync; MacBook M3 Pro, AC, Low
  Power Mode off, Chromium 156 with ANGLE Metal, prod build, 5 runs,
  medians; a machine shared with other agents, load 6–21, so the
  millisecond columns are indicative and the render counts are the
  measure). `PERF_SLIDES=300` now sizes the `deck.open.*.100` benches too
  (printed, not stored, like the slide benches):

  | 300 slides (100 for comparison)    | before                            | after (stable row handlers)                |
  | ---------------------------------- | --------------------------------- | ------------------------------------------ |
  | slide.switch React renders         | 2356 (100: 1592)                  | 1200 (100: 1200)                           |
  | slide.switch input p50 / frame p90 | 34.8 / 33.3 ms (100: 19.8 / 16.7) | 33.5 / 16.8 ms (load 21; 100: 20.2 / 16.7) |
  | slide.reorder React renders        | 1068 (100: 668)                   | 478 (100: 478)                             |
  | slide.reorder input p50            | 29.6 ms (100: 28.0)               | 26.6 ms (100: 27.8)                        |
  | slide.add React renders            | 1146 (100: 746)                   | 548 (100: 548)                             |
  | deck.open cold / warm mounted      | 695 / 603 ms (100: ~576 / 480)    | —                                          |
  | deck.open cold / warm settled      | 19.7 / 22.8 s (100: ~6.3 s)       | —                                          |
  - The O(slides) part was two components per row (`SlideItem`'s memo and
    its body) on every switch, reorder and add: `handleActivate` depends on
    the active slide, and `actionTargets` (so `handleDuplicate`,
    `handleDelete`, `handleExportPng`) on the selection, so every switch
    handed every memoised row new callbacks. The rows now get stable
    handlers that run the latest ones (`ui/useStableHandler.ts`, in
    `ui/SlidesPanel.tsx`); the panel's renders no longer depend on the deck's
    size.
  - Virtualising the panel is not needed for switch/reorder/add. What still
    grows with the deck is the open: mounting 300 rows (~120 ms more to
    `open.mounted` than 100) and drawing every thumbnail (settled 20 s vs
    6 s — B2/E3's thumbnail work, ~3× with the slides), and long tasks on
    open (240–340 ms vs ~55). If 300+ decks become common, rows off screen
    could skip mounting their thumbnail (they already render at idle) before
    any virtualisation — the panel's drag-reorder, range selection,
    scroll-into-view and the e2e row locators all assume every row exists.

- 2026-10-20, **G8 built: `just load` on real slide-model decks**
  (state-sync; MacBook M3 Pro, AC, Node 24, dev stack, load ~13–20, a
  machine shared with other agents). New scenario `tests/load/deckScale.ts`
  (in `runAll.mjs`, `pnpm load:deckscale`): decks of 100 and 300 slides
  written with the slide model's own writers, 12 objects a slide (six rich
  texts, four rectangles, two ellipses, like the perf benches); per size the
  encoded size, the initial sync of 5 fresh clients, an edit round (3
  editors × 100 `updateObject` moves on slide 1, every other editor timing
  each arrival) and `listSlides()` convergence. Thresholds: sync avg
  < 3000 ms, edit latency avg < 50 ms, every edit arrives, convergence.

  | deck                         | 101 slides (1212 objects) | 301 slides (3612 objects) |
  | ---------------------------- | ------------------------- | ------------------------- |
  | encoded size                 | 370 kB                    | 1118 kB                   |
  | initial sync avg / max       | 57 / 84 ms                | 181 / 267 ms              |
  | bytes per fresh client       | 370 kB                    | 1119 kB                   |
  | edit arrival avg / p95 / max | 0.64 / 0.84 / 5.2 ms      | 0.90 / 1.13 / 14.7 ms     |
  | edits delivered              | 600 / 600                 | 600 / 600                 |
  | convergence                  | yes                       | yes                       |

  The initial sync scales with the document (3× the bytes, 3.2× the time)
  — what L4's local copies take off a repeat open; an edit's fan-out does
  not (0.6 → 0.9 ms). `runAll.mjs` tracks `initial_sync_largest_ms`,
  `edit_latency_largest_avg_ms`, `doc_size_largest_bytes` and
  `initial_sync_100_ms` against a local `baselines.json`. (The first run
  failed on the harness itself: `listSlides()` returns rich text as live
  Yjs types, which the canonical JSON recursed into; replicas are compared
  on their JSON projection now.)

- 2026-10-20, **B4 measured on 300 slides** (state-sync; MacBook M3 Pro, AC,
  Low Power Mode off, Node 24, dev Postgres in Docker, a machine shared with
  other agents, load ~10–14). `just perf-commands --slides N --commands 10
--pace 2500 --batches 0`: the server probe's deck (7 objects a slide,
  stored as one snapshot, not loaded), each command stored on its own by the
  sync server's debounce (`--pace` 2.5 s > the 2 s debounce):

  | per debounced store             | 100 slides (700 objects) | 300 slides (2100 objects) |
  | ------------------------------- | ------------------------ | ------------------------- |
  | snapshot written                | 196 kB                   | 595 kB                    |
  | store p50 / p95                 | 16.9 / 23.7 ms           | 30.8 / 40.7 ms            |
  | on a command's path             | 0 of 10                  | 0 of 10                   |
  | command p50 / p95 (first excl.) | 13.9 / 23.1 ms           | 10.9 / 24.7 ms            |
  | first command (loads the deck)  | 57 ms                    | 157 ms                    |
  - The full-snapshot store grows linearly with the deck (3× the bytes,
    1.8× the time) and stays off every command's and every editor's path
    (S3's coalescing); an editor typing into a 300-slide deck costs the
    server ~31 ms and ~600 kB of Postgres writes per debounce window (2 s,
    at most every 10 s while typing). Not worth an ADR 0006 change yet;
    incremental rows with periodic compaction stay the open option if
    decks of 1000+ slides or multi-MB pictures-as-data appear.
  - Indexes: after 0038 each updates table has its primary key and one
    `(…_id, id)` composite; nothing redundant left. On the dev database
    (1685 rows): `deck_updates` 2.3 MB in all (1.3 MB heap + TOAST),
    `deck_updates_deck_id_id_idx` 128 kB with 27 201 scans, the pkey 168 kB
    (8 593 scans); folder and component tables 16 kB per index.

- 2026-10-20, **G4 / S5 built — the editor's boot waterfall, long tasks and INP from real sessions**
  (no number from a real session yet: it ships with the next release; how to read them below).
  - What the repo had: `state/loadTimings.ts` stamps a deck open (route mount → WebSocket
    connected → synced → Pixi ready → first paint) for the perf HUD only; client Sentry is
    wired but no production build sets `VITE_SENTRY_DSN`; the server has `/metrics`
    (Prometheus text, token-gated) and no scraper yet. So `/metrics` + the server's logs.
  - Browser (`apps/web/src/observability/sessionMetrics.ts`, started in `main.tsx`): one draw
    per page session against `VITE_CLIENT_METRICS_SAMPLE_RATE` (build time, 0–1, default 1 —
    a handful of users; lower it as they grow, 0 = off). A `longtask` and an `event`
    (`durationThreshold` 40 ms, per `interactionId`) observer, buffered; when the page is first
    hidden (`visibilitychange` or `pagehide`) it sends ONE report with `fetch(keepalive)`:
    navigation (TTFB, FCP, DOMContentLoaded), the last deck open's waterfall with the
    long-task time between its mount and first paint, `cold` = the deck the page landed on,
    the session's long tasks (count, total, longest), INP as web-vitals estimates it (the
    worst, the (n/50)-th worst from 50 interactions; `performance.interactionCount` where the
    browser has it). Never reported: the render page (the render worker), share-link
    visitors, the sign-in pages, automated browsers (`navigator.webdriver`: e2e, perf harness).
  - Privacy: durations and counts only, bounded (0–600 000 ms, integers), a coarse route kind
    (`editor | present | home | other`) — no deck, user, URL or content; the zod schema is
    `.strict()` (`packages/shared/src/clientMetrics.ts`), shared by both sides.
  - Server: `POST /api/client-metrics` (`apps/server/src/routes/clientMetrics.ts`): a session
    only (`authPreHandler` refuses tokens — an agent cannot write here; AGENT_ALLOWLIST entry),
    `requireSameOrigin`, 30 reports per user per minute, 4 kB body limit. A report becomes
    histograms on `/metrics` (`narrative_client_*`, labels `route` and `load`;
    `apps/server/src/metrics/clientMetrics.ts`, in memory) and one structured log line
    `client session metrics` (persists with the container's logs).
  - Reading: `infra/scripts/client-metrics.py` prints n / p50 / p75 / p95 per metric from the
    server's logs (exact; `--since`) or from `/metrics` (interpolated in the buckets);
    `docs/ops.md` "Client session metrics" has the commands for the VM.
  - Tests: web `observability/sessionMetrics.test.ts` (20: page kinds, sampling, INP estimate,
    long-task clipping, cold vs warm, one send per session, bounds, browsers without the
    observers; every report checked against the shared schema); server
    `routes/clientMetrics.test.ts` (10: histogram buckets and sums, routes and cold/warm kept
    apart, missing marks skipped, schema refusals incl. unknown fields and paths, anonymous /
    token / foreign origin refused, 413 over 4 kB); `metrics/collectors.test.ts` adjusted.
  - Open: a Prometheus scraper (M30) to keep the histograms across restarts; the first real
    numbers after the next deploy (`client-metrics.py` on the VM's logs).

- 2026-10-20, **G7's agent surface and render probes; four server hotspots and the render pool's recycling fixed**
  (MacBook M3 Pro, AC, Low Power Mode off, Node 24.21, the dev server under
  `tsx watch` (dev build), dev Postgres/Redis/MinIO in Docker; a machine busy
  with other agents, Jamf Protect's system extension at ~100 % CPU and a rustc
  build alongside: load 7–21 on 12 cores. So the before/after is an
  interleaved A/B on the one dev server — the "before" files swapped in and
  out, B A B A B A, 3 × 15 warm runs and 3 × 8 cold copies per bench pooled,
  bootstrap CI of the median difference; render's fix is in the worker and was
  isolated by experiment instead.)
  - **The probe** — `just perf-agent` (`apps/server/perf/agentLatency.ts`): a
    fixed set (query.deck, query.slide, object.update, object.create,
    ops.apply ×10, query.render) over real HTTP against the running server,
    through the command API and MCP (streamable HTTP, the SDK's client), with
    a personal access token made for the run and revoked after, on
    SCENES.deck10 / deck100 (deckOps, the six harness photos). Cold = a
    `deck.duplicate` copy nobody has loaded (a stored row); a cold write is
    followed until its snapshot row is in Postgres (`durable`). Warm decks get
    one write first and the render queue is waited on until quiet, so their
    card pictures are drawn before the measurement. Interleaved per round
    across surfaces and commands. Stored as 37 layer S benches
    (`packages/perf/src/catalog/server.ts`:
    `command.{api,mcp}.<command>.{warm,cold}.{10,100}`,
    `command.mcp.session.open`) in the harness store, fingerprinted, compared
    with a baseline when one is accepted (none yet); `PERF_VERBOSE=1` prints
    every call's phases.
  - **Server phases** (`apps/server/src/observability/phases.ts`): a request
    with `x-narrative-timing: 1` is timed when `SERVER_TIMING` allows it (on
    outside production by default). Laps (`http.limit` — the rate limiter's key,
    which resolves the token; `http.receive`, `http.auth`, `http.parse`,
    `mcp.dispatch`/`args`/`confirm`, `host`, `mcp.result`, `http.serialize`) add
    up to the server's time; spans inside them: `host.admit`, `confirm`, `run`,
    `context`, `load` (the document from Postgres), `validate`, `apply`,
    `execute`, `settle`, `audit`; for a look `render.live`, `render.job`,
    `render.read`, the job's `render.queueWait` and `render.worker` (read off
    the job record by the server), and the worker's own steps
    (`RenderJobResult.timings`: `render.worker.page`, `render.page.sync`,
    `ready`, `settle`, `extract`, `encode`/`compose`, `render.worker.upload`).
    Command API: `Server-Timing`; MCP: the tool result's
    `_meta["narrative/serverTiming"]` (the SSE response's headers are out before
    the tool runs). Untimed: one header read per request, a boolean check per
    mark until the process's first timed request.
  - Baseline (before the fixes), medians: warm calls 3.4–5 ms on 10 slides
    (`host.audit` the largest phase, ~1.1–1.5 ms, reads too; `host.admit`
    0.7–0.9 ms — the deck role query; the token lookup ~0.6 ms), query.deck
    9.9 ms and query.slide 7.2 ms on 100 slides; cold 6.6–11 ms (10 slides),
    35–47 ms (100: `host.load` 20–30 ms); `durable` 2.02 s (the 2 s debounce +
    the store); a new MCP session 3.9 ms initialize + 4.1 ms tools/list
    (195 kB); query.render warm 1.66–1.83 s, cold 1.84–2.21 s.
  - **Fixes**, each with its test:
    1. _The first write after a cold load merged the whole document._ The
       persistence load applies the stored rows to the live `Document`, whose
       own `update` listener buffers them for the next `setImmediate`
       broadcast; an agent's first write lands before that tick, so Hocuspocus
       ran `Y.mergeUpdates(snapshot, write)` — 8–12 ms on 100 slides,
       blocking the loop (found with a CPU profile of the live server windowed
       on the write). `hocuspocus/persistence.ts` now `flush()`es the buffer
       at the end of the load, while no connection is attached (nothing is
       encoded), and takes the DOS-1 size baseline from the row when there is
       one (no `encodeStateAsUpdate` per load, ~3 ms on 100 slides).
    2. _The op log was two sequential round trips._ `agent_ops` insert and the
       run's `last_activity_at` update are independent: sent together
       (`agent/serverHost.ts`).
    3. _query.slide copied the whole deck_ (`listSlides` to read one slide's
       fields): now `readSlideMeta` of that slide (new slide-model export).
    4. _query.deck copied every object and normalised every text body_: the
       outline reads each slide's Y.Map (the same malformed-record rules as
       `listSlides`) and reads a text body only when its box would be the title
       (largest, then topmost) — an oracle test against the old computation.
    5. _Warm looks were cold when two sessions take turns._ A job with no page
       of its own recycled the oldest idle page of any session even with room
       in the pool, so two decks looked at alternately (two agents, an agent on
       two decks — the probe's two surfaces) recycled each other's page on
       every job: every "warm" look paid a page load (worker.page 0.5–1.4 s +
       app ready 0.8–1.5 s). `apps/render-worker` now recycles a spare only
       when the pool is full (`WarmPages.full`, within RENDER_WARM_PAGES).

    | A/B medians (ms)                            | before → after                       |
    | ------------------------------------------- | ------------------------------------ |
    | warm writes, 10 slides, total               | 9.6–11.3 → 4.6–6.6                   |
    | warm, `host.audit`                          | 1.5–3.8 → 1.0–1.5                    |
    | query.slide warm 100, total / execute       | 8.2–8.8 / 2.5 → 4.0–4.6 / 0.17       |
    | query.deck warm 100, total / execute        | 9.6–10.4 / 3.9 → 5.6–6.0 / 0.85–0.96 |
    | query.deck cold 100, execute                | 6.4–8.4 → 1.4–1.6                    |
    | object.update cold 100, total / audit       | 80–110 / 15–24 → 51–59 / 3.2–3.4     |
    | query.render warm, two sessions alternating | 1.7–2.7 s → 0.24–0.47 s              |

    (The warm 10-slide totals of "before" include the machine's drift — the
    first runs saw load 13–15 — the per-phase rows are the cleaner measure.)
    Warm looks after the fix: 240–540 ms — `render.page.extract` ~90 ms,
    `ready` ~50 ms, `compose` ~55 ms, the upload 15–30 ms; cold 1.8–2.8 s, of
    which 0.55–0.85 s open a page and 0.85–1.4 s until the app is ready (the
    worker's SwiftShader page, R1's open slim render entry).

  - Open: the token lookup (~0.5 ms, a DB query per request) and the deck role
    check (~0.7 ms, per command) are now the largest warm phases — both
    security checks; caching either needs security-reviewer. `durable` is the
    debounce by design. A cold 100-slide load is 20–30 ms of Yjs decode and
    integrate. A cold look's app load (R1). Results stored on this machine,
    no baselines accepted yet (`just perf-accept command.…`).

- 2026-10-20, **E6: typing no longer renders the Inspector** (editor-ui;
  MacBook M3 Pro, Chromium 156 + ANGLE Metal, AC power, Low Power Mode
  off, a machine shared with other agents, load 8–15 on 12 cores; before
  and after are the same tree with HEAD's copies of the four changed files
  swapped in, run back to back A B A B in prod and A B in dev, 10 runs
  after 2 warm-ups each; E4 measured in the same runs, its own entry).
  - **Why the sections rendered**: a text box's snapshot holds its Y.Text,
    so a typed key rebuilds the snapshot with every field the same by
    identity. The Inspector selected the object by snapshot identity, and
    the memo comparator gave up on any Yjs field. On top of that, Typography
    subscribed to the active text selection, which moves with every key.
    So each key rendered the whole single-object Inspector twice.
  - **Fields, not snapshots**: `useActiveSlideObjectFields` /
    `useSlideObjectFields` (`state/useDeckStore.ts`, `state/useSlideObjects.ts`)
    select the object with `sameObjectFields`: same keys, each value the same
    by identity, so a Yjs type compares as the same live instance. The store
    hands out each Y.Map value by reference, so an unchanged key keeps its
    identity. A change inside the Y.Text (typing, an inline format, a list
    indent) is not a change of the fields, but any write of a key is. The
    Inspector and its memo comparator (`sameObjectButPosition`) use it.
  - **What shows the body follows the body**: Typography's run state
    under the caret and the paragraphs' list state come from
    `ui/useTextRunAttrs.ts`. It recomputes on a deck-store change or a
    selection change and re-renders only when the values differ. No other
    section reads the body. Same values as before: it runs the same two
    reads (`readActiveSelectionAttrs`, `currentParagraphAttrs`).
  - **Numbers** (per 60-key run, before → after):

    | `text.type.inter`  | prod                                              | dev                       |
    | ------------------ | ------------------------------------------------- | ------------------------- |
    | React renders      | 12 865 → 1 213                                    | 12 866 → 1 214            |
    | React commits      | 123 → 63                                          | 123 → 63                  |
    | input p50 / p90 ms | 16.2, 16.0 / 34.0, 32.6 → 15.3, 14.8 / 32.5, 33.5 | 17.1 / 34.8 → 15.6 / 34.7 |
    | frame.max ms       | 33.4, 33.4 → 16.8, 16.8                           | 41.7 → 16.8               |
    | wall ms            | 3 375, 3 476 → 3 348, 3 403                       | 3 458 → 3 360             |

    In both prod pairs the slowest frame drops from two vsyncs to one. p50
    moves by about −1 ms, p90 within the noise. The budgeted counters are
    unchanged, so nothing to accept. `gl.thumb.texUpload` 60 → 100 against
    the stored baseline shows up on **both** sides (from elsewhere in the
    tree since this morning's baseline, not from this change).

  - Open: the canvas overlays that draw the edited box (SelectionHandles,
    TransformHandles and its handles, PeerSelectionOverlays, ObjectEditors,
    TextEditOverlay) still render once per key, ~9 renders a key. The handles
    read the drawn bounds from the scene graph during render, so moving them
    off the object snapshot needs the scene graph's per-object layout
    notification first. The TableInspector still subscribes to the selection
    directly (tables, E5).

- 2026-10-20, **E4 open item done: the canvas reuses the autofit's layout
  while typing** (editor-ui; the same machine, runs and conditions as the
  E6 entry of this date: MacBook M3 Pro, AC, Low Power Mode off, load
  8–15, before/after back to back on the same tree).
  - **The second measurement**: the autofit write-back
    (`state/autofitHeights.ts`) must measure a person's growing box in the
    tick of the keystroke, so the height joins the keystroke's undo step.
    The canvas is not current then (it draws on the next frame), so autofit
    lays the box out on a node of its own. A frame later the canvas's node
    lays out the same markup and CSS again: two synchronous
    `measureHtmlText` layouts per key, and a third on each wrap, where the
    height write is measured again.
  - **Shared measurements** (`renderer/htmlTextBoundsMemo.ts`; a minimal
    change in the renderer's file, it is the measurement both sides go
    through): Pixi's measurement reads only the node's markup and style
    (`measureHtmlText(this.text, this._style)`). So the memo now also keeps
    the last 256 measurements keyed by anchor, CSS and markup, cleared with
    the face generation. A node that misses its own memo takes a matching
    one before it measures. The canvas's node takes autofit's layout, and
    the height write's re-measure hits too, because `height` is not in the
    CSS. A hit returns the very bounds the measurement produced, so the
    stored height and the drawn one cannot differ (unit tests: a second
    node gets the first's bounds, identical to a fresh measurement; no
    sharing across anchor, CSS or faces; bounded and most recent kept).
  - **Numbers** (per 60-key run, before → after, prod and dev):
    `text.measure.bounds` 123 → 63 (one layout per key; it now equals
    `text.autofit.measure`), `text.autofit.measure` 63 → 63, rasters 60 → 60. Timing is in the E6 table of this date (the same runs). Both
    changes shipped together, so the time is not split between them.
  - Open: autofit still mounts a throwaway container per key (style,
    markup, mask) around its one measurement. The raster's own measurement
    inside Pixi is still upstream.

- 2026-10-20/21, **E7 spike: text without SVG foreignObject — measured,
  recommendation (a2), ADR 0018 proposed** (MacBook M3 Pro, AC, Low Power
  Mode off; Vite dev server — the spike page has no React, Pixi is the same
  code; Chromium 156 headless on ANGLE Metal (the perf driver's GPU flags),
  Playwright WebKit 27.2; machine shared with other agents, every timing run
  alone under the measure lock; median of 3 fresh pages).
  - **Built** (dev-only, nothing on a user path):
    `apps/web/src/renderer/experimental/textEngine/` and the page
    `/text-engine-spike.html` (not a build input). Same Pixi setup as the
    editor (WebGL, antialias, mipmaps, `patchHTMLTextRace`, Inter registered
    by `registerBundledFonts`). Four ways to draw the same TextObjects:
    `html` (today's `textRenderer.mount`), **(a2) `dom`** — the markup and
    CSS HTMLText would rasterise, laid out by the browser in a contained host
    (`svg > foreignObject > div`, as Pixi measures), read as glyph runs
    (range rects per line fragment, computed styles, one baseline probe per
    font) and painted with `fillText` on an OffscreenCanvas in a worker pool
    (2 workers), `ImageBitmap` back; **(a1) `block`** — computed styles in a
    `display:none` host (style pass, no layout) → a serialisable block model,
    line breaking + placement + paint in the worker; **(b) `sdf`** — tiny-sdf
    glyph atlases made in the worker (`@mapbox/tiny-sdf`, new devDependency),
    drawn by Pixi's BitmapText SDF shader at (a2)'s positions. Fonts reach
    the workers as `FontFace` from the same bytes and descriptors (matching
    by the engine's own §5.2 over the same faces).
  - **Fidelity** (each text by HTMLText and by the candidate, extracted over
    white at the same resolution, pixels differing by > 32 of 255 in ink;
    scenes: the crowded slide's 121 texts, 24 Inter texts of
    `presentTextOps`, 21 feature boxes):

    | candidate     | crowded 1× / 2× (exact) | features 1× / 2× (exact; differing ink)         | present 1×            |
    | ------------- | ----------------------- | ----------------------------------------------- | --------------------- |
    | (a2) Chromium | 121 / 121 of 121        | 20 / 18 of 21; 0.07 / 0.13 %                    | 21 of 24 (titles 1 %) |
    | (a2) WebKit   | 121 / 121 of 121        | 19 / 19 of 21; 0.88 / 0.46 %                    | 21 of 24 (3 near)     |
    | (a1) Chromium | 121 / 121               | 15 / 14; 5.3 / 4.8 % (line breaks equal in all) | 21 of 24              |
    | (a1) WebKit   | 121 / 121               | 17 / 16; 1.0 / 5.9 %                            | 21 of 24              |
    | (b) SDF       | 0                       | 0; ~33 % (Chromium), ~45 % (WebKit)             | 0                     |

    What it took to be exact, all found by the diff: Chromium's line layout
    kerns across spaces (Arial "A ", " A": 1.3 px at 24 px) while its Canvas2D
    shapes word by word and never does — (a2) reads word positions where the
    layout and the pen disagree by more than 2/64 px (WebKit agrees with its
    canvas; its range rects are pixel-snapped, so it skips them); a baseline
    is rounded to a whole CSS pixel before the SVG's `scale(r)` (2×: line 2
    of a 27.6 px line height was 1 device px off); decorations snap the same
    way. Left: underline geometry (no API gives a font's `post` metrics; the
    spike's estimate matches Arial in Chromium only), WebKit's text stroke
    (sub-pixel), sub-1/64 px kerning residues. (a1) cannot learn Chromium's
    space kerning from a canvas at all, and re-implements inline layout
    (UAX #14 subset; Chromium floors the half-leading to a pixel and line
    heights to 1/64, WebKit uses floats — measured, both modelled).
    SDF: another rasteriser (no hinting, gamma, dilation at 160 px, no
    stroke, pair kerning only) — rejected on looks.

  - **Cost** (ready = start to the frame showing every text; blocked = Σ
    frame time over 16.7 ms; HTMLText includes the frames that upload its
    last textures):

    | Chromium, ms                     | crowded mount  | zoom 1→2        | zoom 2→1       | switch          | present mount | present zoom 1→2 |
    | -------------------------------- | -------------- | --------------- | -------------- | --------------- | ------------- | ---------------- |
    | html ready / blocked / max frame | 196 / 126 / 68 | 359 / 267 / 103 | 197 / 118 / 91 | 242 / 159 / 100 | 149 / 96 / 73 | 285 / 209 / 119  |
    | (a2)                             | 66 / 17 / 30   | 48 / 0 / 17     | 52 / 2 / 18    | 47 / 3 / 19     | 55 / 4 / 20   | 50 / 1 / 17      |
    | (a1)                             | 67 / 16 / 27   | 49 / 0 / 17     | 49 / 0 / 17    | 47 / 0 / 17     | 60 / 3 / 19   | 114 / 46 / 48    |
    | (b) SDF                          | 119 / 60 / 65  | 32 / 5 / 21     | 34 / 2 / 18    | 64 / 27 / 36    | 75 / 16 / 33  | 35 / 0 / 17      |

    | WebKit, ms                   | crowded mount   | zoom 1→2        | zoom 2→1        | switch          | present mount   | present zoom 1→2 |
    | ---------------------------- | --------------- | --------------- | --------------- | --------------- | --------------- | ---------------- |
    | html                         | 988 / 946 / 766 | 859 / 816 / 824 | 330 / 291 / 299 | 569 / 530 / 398 | 361 / 251 / 109 | 672 / 596 / 468  |
    | (a2)                         | 531 / 410 / 291 | 611 / 530 / 239 | 144 / 57 / 43   | 317 / 272 / 220 | 123 / 42 / 59   | 278 / 225 / 131  |
    | (a2), bitmap → canvas upload | 434 / 329 / 199 | 545 / 476 / 214 | 172 / 100 / 64  | 350 / 312 / 193 | 213 / 126 / 66  | 337 / 272 / 141  |
    | (a1)                         | 296 / 178 / 144 | 480 / 389 / 178 | 143 / 52 / 40   | 230 / 190 / 135 | 197 / 123 / 58  | 275 / 216 / 139  |
    | (b) SDF                      | 259 / 202 / 172 | 126 / 92 / 109  | 34 / 7 / 24     | 178 / 142 / 150 | 133 / 59 / 59   | 155 / 133 / 150  |

    Per text, (a2)'s main thread in Chromium: style 0.08 ms, DOM layout
    0.12, run extraction 0.06 (crowded); worker paint 0.5 ms. WebKit: layout
    1.7 ms a text (our markup in a foreignObject host), and `texImage2D` of
    an ImageBitmap ~13 µs/kpx (444 ms of the zoom's 32.7 Mpx) — WebKit's
    remaining cost. Texture pixels: HTMLText 17.3 Mpx at 1×, 66.3 at 2×
    (Pixi's power-of-two pool), the canvas engines 8.2 / 32.7 (exact size),
    SDF 0.07 (atlases). JS heap (Chromium): html 40–47 MB, (a2) 37, (a1)
    35–42, SDF 68–139 (glyph data kept).

  - **Seen on the way**: WebKit's HTMLText rasterised some texts in an
    embedded face (Inter) as nothing — 5 of 24 present texts in one run, 1 in
    another, the first rasters of the face, after Pixi's 100 ms wait; not yet
    confirmed in the editor (W1).
  - **Recommendation**: port (a2) — the browser's own layout of the same
    markup + CSS, Canvas2D glyph runs in workers: pixel-identical where it
    matters today, 3–7× less wall time and near-zero blocked frames in
    Chromium, 1.5–2× in WebKit, half the texture memory, no `data:` fonts,
    no SVG, no 100 ms wait, zoom = repaint without layout. Not (a1) (Chromium
    kerning across spaces cannot be exact; a second layout definition), not
    SDF (looks). Plan and open items: ADR 0018 (proposed): a `RunText` node
    behind a renderer flag in text boxes, cells and leaves; the run cache and
    realignment; fonts to the workers from `fontChanges.ts`; decorations from
    font metrics; WebKit stroke, bidi, `font-stretch` by face; the fidelity
    spec as the gate over features and the deck corpus; L (3–5 weeks).
  - Tests: `blockLayout.test.ts`, `textEngine.test.ts` (26, green);
    `e2e/text-engine-spike.spec.ts` (fidelity gates in Chromium/WebKit; the
    bench with `TEXT_SPIKE_BENCH=1`) — written, not run in the suite yet.

- 2026-10-20/21, **E5: a table's cells rasterised together (Chromium)** (renderer;
  MacBook M3 Pro, AC, Low Power Mode off, Chromium 156 + ANGLE Metal and
  Playwright WebKit 27.2, prod build unless noted, medians of 10 runs; the
  machine shared with other agents, load 5–21 during the runs). New benches on
  a new scene (`scenes.ts → tableSlideOps`: one styled 12 × 8 table in Inter —
  dark bold header, banded rows, a bold first column, a wrapping italic
  summary column, right-aligned figures, a gradient totals row, cells centred
  vertically): `table.mount.styled` (switch to the slide), `table.cell.type`
  (24 keys into one cell), `transform.move.table` (60-move drag),
  `viewport.zoom.commit.table` (`apps/web/e2e/perf/table-slide.spec.ts`,
  budgets accepted).
  - **Measured before**: showing the slide was 96 SVG rasters, one per cell,
    each embedding the same Inter `@font-face` CSS — **6 098 kB of font CSS for
    one slide** — and **192 texture uploads** (1 448 kpx) for 724 kpx of text:
    every HTMLText raster in the app was uploaded twice (Pixi uploads its
    pooled `<img>`, `patchHTMLTextRace` then copies it to a canvas and uploads
    that). A zoom commit (in and out): 192 rasters, 12 196 kB of font CSS, 384
    uploads. Typing rasters one cell per key and dragging rasterises nothing:
    both already at 60 fps. ~290 draw calls a frame, no stencil.
  - **Done**:
    - `renderer/htmlTextGroupRaster.ts` — the rasters a table's cells ask for
      in one task wait a microtask and are drawn together: per set of embedded
      faces one SVG (the faces once), each cell at a whole-pixel place of its
      own with Pixi's own markup, measurement and sizing, its CSS scoped to its
      element, then copied 1:1 out and given the texture Pixi would have made.
      A single changed cell is a group of one and goes through Pixi's path.
      **Chromium only**: in WebKit a shared image lost its embedded face (Arial
      instead of Inter) and from then on no SVG image in that page used it,
      Pixi's own per-cell SVG included (bisected in-app: measuring is
      harmless, loading the shared image is the trigger; the same SVGs drawn
      in a fresh page use the face; no waiting, `decode()`, Pixi's image
      attributes or loading the face in the document first avoided it). WebKit
      (Safari, WKWebView/Tauri — whose agent `isSafari()` misses) keeps Pixi's
      raster per cell (`GROUP_RASTER_SUPPORTED`).
    - `patchHTMLTextRace`: Pixi's upload of the pooled image is held back —
      one upload per raster, every text, both engines.
    - Every text raster's canvas covers its whole pooled power-of-two texture,
      transparent beyond the raster (`wholeTextureCanvas`). A reused pooled
      texture kept the previous text's texels outside the uploaded rectangle;
      the editor (mip level 0) never reads them, but a thumbnail (~8× smaller)
      averaged them in through the mip levels: faint ghosts of other texts
      under table cells, different with each pool history (found by the pixel
      spec). Uploads grow to the texture's size (mount 724 → 1 318 kpx, still
      below the 1 448 of before).
  - Counters (dev = prod, Chromium): mount 96 → **2** rasters, fontKb 6 098 →
    **131**, uploads 192 → **96** (1 448 → 1 318 kpx); zoom commit 192 → **4**
    rasters, fontKb 12 196 → **262**, uploads 384 → **192** (kpx 7 405); typing
    2 → 1 upload a key. WebKit: rasters and font CSS unchanged (96, 6 098 kB),
    uploads 192 → 96.
  - Chromium, before → after: mount **frame.max 283 → 83 ms**, long tasks 276
    → 72 ms, input→pixel 41.8 → 37.8 ms, wall 1 362 → 1 025 ms (settle 16 →
    73 ms: the shared image lands after the first frame instead of 96 rasters
    inside it); zoom commit **long tasks 782 → 250 ms**, frame.max 450 → 158
    ms, settle 831 → 481 ms; typing (input p50 19.1 → 15.7 ms) and drag (13.4 /
    13.1 ms) unchanged. Dev: mount frame.max 408 → 100 ms, zoom long tasks 789
    → 265 ms.
  - WebKit, before → after (per-cell rasters, single uploads): mount frame.max
    1 214 → 1 170 ms, input→pixel 1 048 → 986 ms; zoom commit frame.max 1 336 →
    1 216 ms; typing and drag unchanged. **The second in WebKit is open**: not
    the uploads; likely the 96 synchronous bounds measurements on mount
    (`text.measure.bounds` 96) or the 96 rasters, unproven without a WebKit
    profiler.
  - Pixels: `e2e/table-raster-pixels.spec.ts` opens the table twice — as the
    app runs and with grouping off (`__narrative_noGroupRaster`) — and compares
    the renderer's pixels exactly (the editor chrome hidden for the shots: each
    page shows its own presence avatar): the artboard at the fitted zoom, 100 %,
    after a zoom commit and after a cell edit, and the table's thumbnail after
    an edit made while the other slide is shown (drawn offscreen in both; the
    shown slide's thumbnail is the live or the offscreen drawing, by timing).
    Chromium 3/3 repeats pass, WebKit passes (no grouping there, both pages
    per cell); `renderer-visual|inspector-flows|table` 25/25.
  - Open: the WebKit mount second; grouping in WebKit if the engine's face
    loading in SVG images is ever understood; text boxes could share images
    the same way in Chromium (a crowded slide's 120 texts — measure first); the
    per-cell masks (290 draws a frame) cost nothing measurable on the M3 Pro.

- 2026-10-20, **R1b: the render page's slide switch cut by a third; R1c: the 30-slide
  photo PDF measured on the job API** (renderer; MacBook M3 Pro, AC, Low
  Power Mode off; dev stack (Vite dev build) with the dev render worker
  (`chrome-headless-shell` 1248, SwiftShader, host, no CPU limit); machine
  shared with other agents, load 5–13; every measurement alone under the
  shared lock).
  - **Where the switch went** (trace of `__narrativeRenderSlidePng` slide
    after slide, 8 photo slides, CPU profile + Chromium trace, a one-off
    script): of ~300 ms per slide on a warm page, the main thread was idle
    a third of the time, waiting for (1) a 50 ms poll in `showAndWait` to
    notice `ready` (avg ~25 ms), (2) a second full `settleScene` in the
    capture — two quiet frames, 17–33 ms, on a scene the page had just
    settled — and (3) the capture itself: `readPixels` waited 114 ms on
    SwiftShader rasterising the slide, then Pixi's `extract.canvas` handed
    back a GPU-backed 2D canvas, so `canvasToJpeg`'s `drawImage`/`toBlob`
    read the whole slide back through SwiftShader a second time (38–57 ms).
    The `/api/decks/:id` re-read the 2026-10-18 entry blamed was already gone.
  - **Cut** (`pages/DeckRender.tsx`, `renderer/captureSlide.ts`,
    `renderer/settleScene.ts`): the page tells its own waits about a new
    status instead of polling; the capture reads back asynchronously
    (`captureSlideCanvasAsync`, PBO + fence) into a CPU-backed canvas
    (`cpuCanvas`, `willReadFrequently`); `settleScene({ quick })` confirms
    a scene with one draw and no frames when no document update reached the
    page since the settle behind `ready` began and nothing is pending,
    mounted-missing or newly rastering (raster promises a settle saw land
    are remembered across calls; anything else settles as before).
  - Per slide, before → after (dev, 8 slides, 3 photos cycling):

    | step                   | before  | after   |
    | ---------------------- | ------- | ------- |
    | warm slide, wall       | 296–329 | 200–222 |
    | slide with a new photo | 608–651 | 442–470 |
    | show → ready           | 101–104 | 68–74   |
    | second settle          | 17–33   | 0       |
    | extract (GPU read)     | 91–113  | 94–106  |
    | encode (JPEG + base64) | 59–82   | 29–37   |

    CPU profile of 4 switches: 1481 → 831 ms; `readPixels` 467 ms of main
    thread blocked → 0 (`getBufferSubData` 13 ms). Same pictures: the
    capture path is the one `liveThumbnail.ts` already used, only the 2D
    canvas differs (CPU instead of GPU backing).

  - **PDF of 30 photo slides on the job API**
    (`apps/render-worker/perf/render.ts`, now `POST /decks/:id/export.pdf`
    → 202, polled `GET …/:jobId?waitMs=2000`; peak RSS sampled every 250 ms
    over the worker's and the server's process trees, perf/rss.ts — a sum
    over Chromium's processes, so an upper bound), n=3 each:

    | PDF of 30                | before      | after      |
    | ------------------------ | ----------- | ---------- |
    | 202 answered             | 25–64 ms    | 20–26 ms   |
    | first pages (job of 20)  | 8.1–10.2 s  | 6.1–8.1 s  |
    | whole file (POST → done) | 12.4–14.9 s | 8.6–10.5 s |
    | pages/min p50            | 130         | 206        |
    | peak RSS render worker   | 882 MiB     | 829 MiB    |
    | peak RSS server          | 264 MiB     | 204 MiB    |
    | with a PNG behind: total | 10.6–12.3 s | 8.8–11.4 s |
    | PNG behind: queue wait   | 1–3 ms      | 1–2 ms     |

    3/3 finished each, 25.1 MB files, no failed loads. Not under VM 103's
    limits (`--cpus 2`, prod image): this host has 12 cores and the dev
    build; the 2026-10-18 production-image numbers (59.6–87.3 s, 1 of 3
    failed) were the synchronous call, which no longer exists. The
    production-image run under the limits is still to do.

  - **In-place deck switch: not built** — ADR 0019 (proposed): the pool
    hands spare pages to other people; an in-place switch keeps the JS heap,
    which holds the last deck in ~30 module-level caches across renderer/,
    state/, lib/ (one of them: signed media URLs keyed by asset id — a
    cross-tenant read if missed). Needs a page-wide session reset, a guard
    test and the extended isolation test, tech-lead + state-sync +
    security-reviewer; measure the production bundle's load split first
    (the slim render entry may give the gain with a fresh document).

- 2026-10-20, **R3: video posters warmed through the imgproxy cache**
  (renderer; MacBook M3 Pro, AC, Low Power Mode off; dev stack with the
  repo's nginx `imgproxy-cache` in front of imgproxy; load 5–13).
  - The video worker reports `{ stage: 'stills', assetId }` on the job's
    progress once poster and thumbnail are on the asset
    (`VideoTranscodeProgress`, @narrative/shared); the server listens to the
    transcode queue's events (`media/videoStillsWarm.ts`, started in
    `index.ts`, off without `IMGPROXY_WARM_ENDPOINT`), reads the keys from
    the asset row (never from the queue) and asks the cache for exactly
    what `video-info` hands out: the poster's `display` JPEG and the
    thumbnail's `thumb` JPEG. A job's `completed` covers a missed report;
    an asset once; one request at a time, 200 waiting at most, 30 s each.
    Its own small queue beside `imgproxyWarm.ts` (that file was mid-L3);
    one queue for both once the image warmer takes variants per key.
  - `apps/server/perf/videoStillsWarm.ts` (2 s H.264 with grain, upload →
    poster on the asset → +2.5 s → first GET through the cache), n=3 per
    size; "after" runs the module in the driver against the cache (the dev
    server runs without `IMGPROXY_WARM_ENDPOINT`):

    | first view +2.5 s | before (MISS) | after (HIT) |
    | ----------------- | ------------- | ----------- |
    | 1080p poster      | 36–62 ms      | 4–14 ms     |
    | 1080p thumb       | 6–14 ms       | 1–3 ms      |
    | 4K poster         | 70–129 ms     | 2–9 ms      |
    | 4K thumb          | 4–12 ms       | 1–11 ms     |

    Small on this machine (a JPEG re-encode, not an AVIF); on VM 103's four
    shared cores the miss is the larger part of a poster's first paint.

- 2026-10-20, **D2 done — the images** (MacBook M3 Pro, AC, Low Power Mode off; Docker
  Desktop 2 GB VM, `--platform linux/amd64` as `build-push.sh` builds; HEAD 967c3667 vs the
  same tree with the change, each built from a clean worktree). Size = the sum of the
  uncompressed layers (`docker history`), what a classic store's `docker images` shows:

  | image         | before  | after  | what went                                                                        |
  | ------------- | ------- | ------ | -------------------------------------------------------------------------------- |
  | server        | 1182 MB | 340 MB | pnpm metadata cache 392 + store 270 MB, node_modules 287 → 150                   |
  | video-worker  | 874 MB  | 345 MB | cache 405 + store 62 MB, node_modules 68 → 31                                    |
  | render-worker | 1369 MB | 900 MB | the 499 MB install layer (store, cache) → 24 MB; Chromium + fonts (~600 MB) stay |
  | web           | 99 MB   | 74 MB  | 24.5 MB of hidden source maps (+ their .br/.gz) out of /srv/web                  |

  (Prod reported 1.42 / 1.09 / 1.8 GB / 114 MB for v0.15.0 — the VM's store counts
  differently; the ratios are what to expect there.)
  - Cause: every runtime stage ran `corepack prepare` + `pnpm install --prod` itself, which
    left pnpm's package store (`packageImportMethod: copy` — node_modules is a copy of it)
    and the registry metadata cache in the image, beside dev-dependency-free node_modules
    still carrying declarations, maps and Markdown.
  - Now (`infra/docker/runtime-tree.sh`, used by the server, video-worker and render-worker
    Dockerfiles): the builder installs with the store on a BuildKit cache mount (never a
    layer), compiles, and `pnpm deploy --prod --filter <app>` assembles `/out`: the app's
    production dependencies, each `@narrative/*` package replaced by the JS the app's tsc
    emitted (`main`/`exports` → `.js`; only `package.json`, `src/`, the commands playbooks
    kept — the build fails if a workspace package has no compiled copy or TS is left), and
    `.d.ts`/`.ts`/`.map`/`.md` pruned from third-party packages. The runtime stage is the
    base image (+ ffmpeg / Chromium) and `COPY /out` — no pnpm, no corepack. Entry points
    and the migrator path unchanged. The render worker's Chromium layer is now installed
    from a copy of `playwright-core` alone, so it is rebuilt when Playwright changes, not
    with every source change. `.dockerignore` gains `**/.stryker-tmp` (a local mutation
    sandbox was being copied into the server's node_modules by `pnpm deploy`).
  - Web: the hidden maps were served publicly next to each chunk (`/assets/x.js.map`) and
    nothing uploads them; the image drops them and `deploy.sh` deletes the ones earlier
    releases left in the `web_static` volume.
  - Checked: each image starts; the server reaches "listening" (MCP catalogue + playbooks
    loaded) and `db/migrate.js` resolves its modules (gets to the DB connect); the video
    worker's compiled processor transcodes a 3 s 1080p ProRes source from the dev MinIO
    with the image's ffmpeg (poster + playback, identical sizes before/after); the render
    worker's own `BrowserHolder` launches the image's headless shell in the compose file's
    box (cap_drop ALL, read-only root, tmpfs /tmp) and draws a 1920 × 1080 page with
    Latin/CJK/Arabic/emoji text, SVG and WebGL2 — the PNG is **byte-identical** before and
    after (fonts and Chromium unchanged).
  - Side note: Arabic in that page draws as unjoined glyphs in both images (no Arabic
    shaping font among Playwright's deps) — unchanged, worth knowing for decks in Arabic.
  - Not checked here: a full render job through the queue against the prod-like stack, and
    the images on the build host (`just deploy`'s first build is the check; the server's
    tsc needs `--build-arg NODE_OPTIONS=--max-old-space-size=1536` only on a 2 GB Docker VM).
  - **Security review of D2 / G4, same round** (all fixed): a failure of the
    SVG sanitizer discards the upload, and the server image sanitizes one
    SVG at build time and fails the build if it cannot; the server and video-worker images run as `USER node`; client
    metrics ids are per session; nested `.env` files are ignored by
    `.dockerignore`.

- 2026-10-20, **D3 — server boot-to-ready, first step** (MacBook M3 Pro, AC, Low Power Mode
  off, machine shared with other agents, load 8–25; the production build: `tsc` output +
  `pnpm deploy --prod` tree, `NODE_ENV=production`, `node apps/server/dist/apps/server/src/index.js`).
  - Prod (VM 103 notes): 15 s container start → listening after a VM boot, 13 s of it before
    the first log line. In production nothing runs before that line but module loading:
    migrations are a deploy step, data migrations run after `listen`, Sentry is off without a
    DSN, `pg`/BullMQ connect lazily. So the 13 s are the static import graph.
  - Profile (`--cpu-prof`, a module-load hook): a start loaded **2,707 modules, 23.3 MB** of
    JS before the first line. **jsdom's graph was ~1,100 of them / ~8.5 MB** (jsdom 649 files,
    css-tree, parse5, undici, whatwg-url, mdn-data, @asamuzakjp …), imported statically by
    `media/svgSanitize.ts` for SVG uploads only. Next biggest are needed at start (bullmq,
    zod, our own 194 files, @narrative/commands). After the first line: the MCP tool
    catalogue (zod → JSON schema + compaction for every command) is ~2/3 of the
    first-log → "MCP server ready" gap (1.8 s on prod).
  - Fix: `svgSanitize.ts` requires jsdom and DOMPurify on the first `sanitizeSvg` call
    (synchronous `createRequire`, the caller unchanged; the first SVG upload after a start
    pays the load). Modules at start **2,707 → 1,609, bytes 23.3 → 13.4 MB**. A guard test
    (`apps/server/src/bootImports.test.ts`) fails on any static value import of jsdom in
    the server.
  - Local, warm disk, 7 interleaved runs, medians: first log **1120 → 763 ms**, listening
    **1391 → 1016 ms** (−32 % / −27 %).
  - Docker (the images, linux/amd64 under emulation, load 13–20, 3 runs per mode — noisy):
    pooled over warm / cold page cache / cold with `--cpus 1`, medians of 9: first log
    **7.3 → 4.9 s**, listening **9.3 → 6.4 s**. Node's compile cache (`NODE_COMPILE_CACHE`
    in the container, the VM-reboot case: the same container restarted with the page cache
    dropped) did not separate from the noise (listening 12.3 vs 11.1 s, medians of 3) — not
    adopted.
  - Open: (1) the MCP catalogue at start (~1–1.8 s on prod): built at start on purpose (a
    command whose schema cannot become a tool fails the boot) — generating it at build time
    would keep that guarantee and drop the work (mcp/ owners); (2) a VM check after the
    next deploy: `docker restart narrative-server` + the same StartedAt → first log →
    listening read (needs Petr's word — downtime), and once after a VM boot; on a VM boot
    the Docker daemon restarts all nine containers at once (restart policy, `depends_on`
    is not honoured then), so CPU and a cold disk are shared — the module count is what we
    control; (3) bundling the server into one file would cut the remaining ~1,600 file
    reads/resolutions on a cold disk — a larger change (native deps, `import.meta.url`
    paths for migrations, playbooks and the version lookup).
  - **VM 103, read-only** (Petr's consent for VM 103; 2026-10-20 ~21:20
    CEST; 4 vCPU, 2.6 GB RAM, no swap, load 0.05; v0.15.0, 9 containers up
    41 h). The last server start, container StartedAt
    2026-10-19T02:06:48.10Z after the VM booted (every container started at
    once): first app log line (the METRICS_TOKEN warning) +12.95 s, MCP
    server ready +14.77 s, Hocuspocus ready +14.90 s, Fastify listening
    +15.08 s, first `/health` 200 (responseTime 14.9 ms) +16.66 s. Start
    command `node apps/server/dist/apps/server/src/index.js`, node_modules
    287 MB. External latency (MacBook → Cloudflare tunnel → Caddy → server),
    5 × `/api/health`: TTFB 0.15–0.30 s, one 1.22 s; `/` (index.html, 2.6
    kB) TTFB 0.195 s. `METRICS_TOKEN` is unset in production (the warning
    above). Old image tags v0.13.2 / v0.14.0 are still on the VM's disk.

- 2026-10-20, **V4 measured — the stop gate's affected lane** (MacBook M3 Pro, AC, Low Power
  Mode off, other agents at work: load 12–20; warm caches — eslint `--cache`, tsc
  `--incremental` from the V1/V2 work; `tools/dev/check-affected.sh <base> <tree>` with
  one changed file):

  | one file in   | wall | typecheck | lint | unit tests |
  | ------------- | ---- | --------- | ---- | ---------- |
  | `apps/server` | 46 s | 44 s      | 9 s  | 46 s       |
  | `apps/web`    | 63 s | 62 s      | 20 s | 53 s       |

  (Both lanes failed on tests other agents had mid-edit — tus SVG tests, since fixed in
  this change; web `FillTokenTab.test.tsx` — the timings are of complete runs.)
  - The typecheck is the critical path even incremental: a one-file change re-checks the
    whole package (and `apps/web` its 60 s). Proposed, not done: `tsc -b` project
    references for the source-aliased packages (shared, slide-model, commands are
    re-checked by every consumer), or tsgo (TypeScript 7 native) once it type-checks this
    repo — measure both on the web lane; and `vitest related <changed files>` in the stop
    gate only (pre-push keeps the full lane), which would cut the 46–53 s test step to the
    tests that import the change.

- **V3 not measured**: the full `just e2e` timing on the MacBook was cancelled (Petr: the
  coordinator runs the e2e suites at the end). Still to do once on a quiet machine.

- 2026-10-20/21, **W1: measured in the real Tauri window** (desktop; MacBook
  M3 Pro 14", AC, Low Power Mode off, macOS 27.0.1, system WebKit 22625.1.29.11.28
  = Safari 27.0.1, prod build of `feat/desktop` a69f7fdc + this work against the
  dev backend; Playwright WebKit 27.2 for comparison; 5 runs + 1 warm-up a side
  unless noted; the machine shared with other agents — load 4–10 during the
  runs, the desktop in use).
  - **`feat/desktop` brought up to date**: `perf/crowded-slide` merged into
    it in the `Narrative-desktop` worktree (a69f7fdc, `--no-ff`; the branch
    was an ancestor, so the merge's tree is 967c3667's; `just check` green on
    it in a clean worktree; not pushed).
  - **`just perf <ids…> --shell tauri`** (new): the benches run in the Tauri
    window. A debug shell with the `perf-driver` cargo feature
    (`apps/desktop-tauri/src-tauri/src/perf_driver.rs`; refuses to compile
    into a release build, inert without `NARRATIVE_PERF_DRIVER_PORT`) loads the
    side's build (`--server=http://localhost:<port>`, a debug build only);
    `apps/web/e2e/perf/lib/tauriPage.ts` stands in for Playwright's `Page`:
    scripts evaluated in the page over a WebSocket on 127.0.0.1 (not fetch:
    Resource Timing would count it), native input on the app's stdin turned
    into NSEvents (trusted, system timestamps, through WebKit's UI process),
    each input awaited until the page dispatched it (WebKit queues keys and
    the mouse apart; without the wait a click overtook the keys before it).
    Playwright still seeds the scene. tauri-driver was not an option: it has
    no macOS backend (WKWebView has no WebDriver). Fingerprint shell `tauri`,
    the system WebKit's version, and the device scale: a new `deviceScale`
    field (absent = 1) keeps a 2× page in a series of its own
    (`…/webkit-tauri-2x`) and never compares it with a 1× one.
    `--device-scale N` sets it (Playwright's `deviceScaleFactor`; in Tauri
    WebKit's `_setOverrideDeviceScaleFactor:`). Cannot run in Tauri (skipped
    with the reason): `present.presenter.window`, the cold opens.
  - **What it took to make the input real** (each found by a smoke page
    logging every event): `+[NSEvent pressedMouseButtons]` answered by the
    driver (WebKit reads the hardware's buttons, so a synthesised drag had
    `buttons: 0`, which ends an undo gesture — WebKitTestRunner does the
    same); Quartz-made events (wheel, modifier keys) stamped with the uptime
    clock (they arrived 0.6–1.3 s "old"); the wheel's location is the window
    point itself (AppKit gives the event no window); the window borderless,
    always on top and `ignoresMouseEvents` (the person's cursor crossing it
    added real `pointermove`s), with mouse events then handed to the
    WKWebView directly (a window ignoring mouse events drops `sendEvent:`'s
    button events too).
  - **Present mode, runs (of 5) with any missed frame, and frames missed a
    pass** (text and photo: 22 advances a pass; paced 6 with 4 s holds;
    builds 9 steps; transitions 14):

    | bench          | Tauri 2× (the window's own) | Tauri 1×                | Playwright WebKit headed 1× (2026-10-20, of 10) |
    | -------------- | --------------------------- | ----------------------- | ----------------------------------------------- |
    | advance.text   | 4/5, 0–7 (max 23–40 ms)     | **0/5** (max 20–24 ms)  | 2/10, 0–13                                      |
    | advance.paced  | 5/5, 1–3 (max 29–45 ms)     | 5/5, 1 (max 26–38 ms)   | 2/10, 0–3                                       |
    | advance.photo  | 4/5, 0–2 (max 24–42 ms)     | 2/5, 0–3 (max 20–37 ms) | 1/10, 0–2                                       |
    | transition.all | 3/5, 0–4 (max 21–34 ms)     | —                       | 2/10, 0–1                                       |
    | build.steps    | 3/5, 0–7 (one 113 ms)       | 3/5, 0–2 (max 23–49 ms) | 5/10, 0–3                                       |
    | jump.link      | 3/5, 0–1                    | —                       | 0/10                                            |
    | video.play     | **0/5** (max 19–23 ms)      | —                       | 1/10                                            |

    Refresh interval 17 ms everywhere (WKWebView paces rAF at 60 Hz on the
    120 Hz ProMotion screen). No long task, no work after ready in any run
    (every work counter 0). Ready: Tauri 2× text 3.4–3.8 s, photo 2.3–2.5 s,
    transitions 1.9 s, video 0.8 s; at 1× text 2.3–2.5 s, photo 2.1 s.
    **The shell itself costs nothing**: at 1× the Tauri window is as smooth
    as Playwright's headed WebKit (text better: 0/5). The extra single-frame
    misses at 2× are the 4× pixels — MSAA at 2× (W4: with it off,
    `advance.photo` at 2× dropped 0 frames, median, longest 24 ms). The paced
    bench's misses fall in the holds (0.1–3.7 s after the key) with no editor
    render and no keep-warm draw beside them: the window server, not our
    work — as in headed Playwright on 2026-10-20.

  - **Editor gestures, medians of 5** (input-to-pixel p50 / p90, frame p90,
    ms):

    | gesture                   | Tauri 2×                  | Tauri 2×, MSAA off   | Tauri 1×    | headed WebKit 1× (same hour)       |
    | ------------------------- | ------------------------- | -------------------- | ----------- | ---------------------------------- |
    | transform.move.rect       | 34 / 38, 28               | —                    | 17 / 24, 19 | 15 / 22, 21                        |
    | transform.move.image      | 35 / 49, 28 (max 113)     | 19 / 31, 20 (max 62) | 19 / 24, 19 | 15 / 21, 20                        |
    | viewport.zoom.wheel       | 18 / 34, 19               | 18 / 33, 19          | 17 / 32, 19 | 18 / 21, 19                        |
    | viewport.zoom.commit      | 20 / 39, 19; settle 2.9 s | —                    | —           | 18 / 36, 19; settle 5.1 s          |
    | text.type.inter (60 keys) | 89 / 131, 97              | 59 / 105, 88         | 50 / 76, 67 | 86 / 178, 124                      |
    | slide.switch.100          | 211 / 231, 19             | —                    | —           | (339 / 355 — throttled, see below) |

    The drags ran with `PERF_DISCOVER=1` (nothing stored): in any display-
    paced WebKit — headed Playwright and Tauri alike — pointer moves coalesce
    per frame, so `sg.update` / `y.slideObjects.flush` vary by a few (85–90
    of 90) and the bench refuses its work counts. Open: those two counters
    should be `time` metrics in paced runs (or the drag should await a frame
    per move).

  - **Thrown away**: the headed Playwright present runs of 2026-10-20 23:52–
    2026-10-21 00:24 UTC (and that hour's headed `slide.switch.100`): the
    Playwright window was covered and WebKit drew it every 765–781 ms. They
    are in this machine's `results.jsonl` (`…/webkit-browser-headed`) — not to
    be accepted as a baseline. `present.spec.ts` now refuses a page whose
    refresh interval is over 40 ms ("covered or hidden and throttled").
  - **Not measured / open**: the presenter window in Tauri (a second
    webview window the driver would have to drive); cold opens (a fresh
    WKWebView data store per run); WebKitGTK on Linux and WebView2 (the
    driver's input is AppKit's; `perf_driver.rs` says so); a run on an
    external 1× display.
  - **Ported into this tree**: the perf driver and the harness's Tauri
    side came over from the `Narrative-desktop` worktree as a patch (applied
    clean; the perf unit tests 76/76, `tsc` clean).
  - **Upstream**: Pixi's fixed 100 ms Safari font wait (W1's first part,
    2026-10-18) is now
    [pixijs/pixijs#12323](https://github.com/pixijs/pixijs/issues/12323)
    ("HTMLText: allow skipping the fixed 100 ms Safari font delay in
    loadSVGImage", posted 2026-10-20, open).

- 2026-10-21, **W4: a picture's decode and upload in WebKit at 2560 and 1280
  px; MSAA at 2×** (MacBook M3 Pro, AC, Low Power Mode off, load 4–7;
  Chromium 156 headless on ANGLE Metal, Playwright WebKit 27.2 headless and
  headed, the Tauri window = system WebKit 22625.1.29.11.28 at 2×).
  - **Decode and upload** (a one-off in-page measurement, not a catalog
    bench: one 3000 × 2000 photo — the present deck's generated
    `present01.jpg`, plasma noise, not a camera photo — uploaded, imgproxy's
    AVIF of `medium` 1280 × 853 and `display` 2560 × 1707, the same pixels
    re-encoded by Chromium as WebP q0.8 and JPEG q0.85; medians of 15 after 3
    warm-ups, p90 in brackets; WebKit's timer has 1 ms steps). `worker` is
    `createImageBitmap(blob)` in a worker — Pixi's path (`loadTextures`,
    `preferWorkers`), off the main thread; `upload` is `texImage2D` of that
    bitmap, fenced — on the main thread:

    | ms                    | Chromium worker / upload | WebKit (headless, headed, Tauri) worker / upload |
    | --------------------- | ------------------------ | ------------------------------------------------ |
    | AVIF display (247 KB) | 33 / 6                   | 48–49 (51) / 20–22 (26–33)                       |
    | WebP display (209 KB) | 19 / 6                   | 23–25 / 18–22                                    |
    | JPEG display (544 KB) | 10 / 6                   | 14–16 / 16–28                                    |
    | AVIF medium (36 KB)   | 4.3 / 0.9                | 7–8 / 5                                          |
    | WebP medium (44 KB)   | 4.7 / 0.9                | 6 / 5                                            |
    | JPEG medium (101 KB)  | 2.8 / 1.1                | 3–4 / 6                                          |

    The three WebKits agree within a millisecond or two. Decoding an
    `<img>` and uploading the element costs WebKit the decode again (AVIF
    display `uploadImg` 53–55 ms): the bitmap path Pixi takes is the right
    one.

  - **Decided: AVIF stays.** In WebKit the main-thread cost of a picture is
    its upload — ~20 ms at 2560 (more than a 60 Hz frame), ~5 ms at 1280 —
    and it depends on the pixels, not the format. The decode is 2× WebP's and
    3× JPEG's but runs in Pixi's worker: it delays a picture's arrival (present
    mode's ready: ~50 ms a `display` picture, serial in one worker), never a
    frame. What helps WebKit is fewer pixels: `medium` (L3) cuts the upload
    4× and the decode 6×; present mode already uploads before ready. Open: in
    the editor a `display` upload (a zoom commit's upgrade, an opened slide's
    big picture) is a 20 ms stall in WebKit — one upload per frame (Pixi's
    `textureGC`-free upload queue, or our own) is the next lever, not the format.
  - **MSAA at 2×** (`PERF_ANTIALIAS=off`, new: an init script makes every
    WebGL context without `antialias`, nothing in the renderer touched;
    printed, never stored), the Tauri window at its own 2×:

    | bench                 | MSAA on (as shipped)                   | MSAA off                            |
    | --------------------- | -------------------------------------- | ----------------------------------- |
    | transform.move.image  | input 35 / 49, frame p90 28, max 113   | input 19 / 31, frame p90 20, max 62 |
    | text.type.inter       | input 89 / 131, frame p90 97           | input 59 / 105, frame p90 88        |
    | viewport.zoom.wheel   | input 18 / 34                          | input 18 / 33                       |
    | present.advance.photo | 4/5 runs missed (median 1), longest 30 | median 0 missed, longest 24         |

    At 1× the Tauri drag is 19 / 24 with MSAA on: multisampling at 2× is
    what makes WebKit's 2× drag twice as slow, not the shell.

  - **Not decided — Petr's call:** MSAA off at devicePixelRatio ≥ 2 would
    halve a drag's input-to-pixel in WebKit, but it changes the edges of
    vector shapes (Pixi tessellates Graphics without AA of its own; texts and
    pictures are textures, unaffected), against the ground rule "nothing
    changes what a slide looks like". Before switching: a pixel comparison of
    shape edges at 2× (rect corners, circles, paths, strokes) with and
    without, and the same A/B in Chromium (not measured here). The switch
    itself is one line in `renderer/Canvas.tsx` (`antialias`), owned by the
    renderer's agents: not made.

- 2026-10-21, **Low Power Mode: bench prepared, the run pending** (MacBook
  M3 Pro, AC; Low Power Mode was **off** all session — `pmset -g`
  `lowpowermode 0` — and only Petr switches it).
  - **Prepared:** `PERF_LOW_POWER=1` lets a WebKit run in Low Power Mode
    through (`refuseToRun` refuses it otherwise), prints it and stores
    nothing (its 30 fps cap is the subject, not a series); it fails at once
    if Low Power Mode is in fact off. The run to take, with Low Power Mode on:

    ```
    PERF_LOW_POWER=1 just perf transform.move.text transform.move.image \
      viewport.zoom.wheel viewport.zoom.commit text.type.inter \
      present.advance.text present.advance.photo --shell tauri
    PERF_LOW_POWER=1 just perf <the same> --browser webkit --headed
    ```

    (the drags with `PERF_DISCOVER=1`, W1). A stall is a frame over 2
    intervals at the capped rate (> 67 ms) or input-to-pixel over ~100 ms.

  - **The lighter mode, designed, not built** (it ships only if that run
    shows stalls): a frame-cap detector (median rAF delta over the last
    second ≥ 1.6 × the display's interval → capped) that the renderer reads
    to (1) give `BatchStager` (`renderer/textResolutionStaging.ts`) half its
    per-frame raster budget and one batch in flight, so a zoom commit's
    restaging spreads over more frames instead of stalling fewer; (2) hold
    the thumbnail store's idle work (`thumbnailStore.ts`) until the gesture
    and a second of quiet are over; (3) upload at most one large texture per
    frame (W4: a 2560 picture is ~20 ms in WebKit); and in present mode
    leave keep-warm as it is (it draws into a 1 × 1 target, no frame of its
    own). Leaves the cap when the median returns. All renderer files —
    their owners' to build.

- 2026-10-21, **Regression found and fixed: present mode drew slides
  without a background black** (renderer; found by Petr). Since 23c2e004
  (prepared slides, P2) a prepared slide whose `background` is unset got no
  background at all; the editor draws `DEFAULT_BACKGROUND` there. Present
  mode now does the same (`apps/web/src/renderer/presentSlides.ts`:
  `background: spec.slide.background ?? DEFAULT_BACKGROUND`), with a unit
  test in `presentSlides.test.ts`.

- 2026-10-21, **Perf store: 8 throttled headed-WebKit results
  quarantined** (MacBook M3 Pro; W1's "Thrown away"). The headed Playwright
  runs of 2026-10-20 23:52 – 2026-10-21 00:24 UTC were taken with the
  Playwright window covered: WebKit drew it every 765–781 ms a frame. The
  8 results (`present.advance.text`, `present.advance.paced`,
  `present.advance.photo`, `present.build.steps`, `viewport.zoom.wheel`,
  `viewport.zoom.commit`, `text.type.inter`, `slide.switch.100`) were moved
  out of the store into
  `~/.cache/narrative-perf/petrs-macbook-pro/results.quarantined-throttled-window.jsonl`;
  no baseline came from them. `apps/web/e2e/perf/present.spec.ts` now
  refuses a page whose refresh interval is over 40 ms ("its window is
  covered or hidden and throttled; keep it in front"). It is the only perf
  spec with that guard (2026-10-21): four of the quarantined results were
  editor benches (zoom, typing, slide switch), which a covered window would
  still throttle unnoticed.

- 2026-10-21, **Combined verification of the round** (MacBook M3 Pro; the
  whole 2026-10-20/21 working tree on `perf/crowded-slide`, uncommitted).
  - `just check`: green after formatting 7 files and fixing 2 unit-test
    mocks (`FillTokenTab.test.tsx`'s mock lacked `useSlideObjectFields`;
    `thumbnails.test.ts`'s Pixi mock met E5's import chain and now mocks
    `patchHTMLTextRace`).
  - `just integration`: 155/155. `cargo check` of the Tauri shell, with and
    without the `perf-driver` feature: ok.
  - Full `just e2e` (Chromium + Electron projects): **246 passed, 9 failed**
    (12.9 min) — 6 Electron specs (`desktop-menu`, `desktop-present`,
    `desktop-shell`, 3 × `desktop-sign-in`; the Electron app is not run or
    fixed by rule, the desktop is Tauri) and 3 real, all fixed:
    - **`notes-panel.spec.ts`: a real L4 bug.** `useSlideNotes` read the
      notes one commit before it subscribed; a server sync that landed in
      that gap after a local copy had painted was missed, and the panel
      showed "No notes." for good. Fixed: `state/useSlideNotes.ts` re-reads
      after subscribing. An audit of the same read-then-subscribe class
      across `apps/web/src` (state-sync agent) found and fixed 3 more, each
      test failing on the old code: `useSlideNotes`'s slide lookup (a slide
      arriving after mount, or the slide map replaced by a move),
      `useAwareness`'s snapshot cache (the `useSyncExternalStore` re-check
      got the stale cache), and `TextEditOverlay` (its observer subscribed
      in a passive effect after the layout-effect build; a replaced `Y.Text`
      kept the old DOM). ~30 other sites inspected, no gap. Tests:
      `useSlideNotes.test.tsx` (5), `useAwareness.test.tsx` (+1),
      `TextEditOverlay.test.tsx` (2), and 2 e2e in `local-doc-copies.spec.ts`:
      notes changed on the server while away (a regression guard; the gap is
      too narrow to hit on the dev stack) and presenter notes follow a slide
      moved by someone else (fails 3/3 on HEAD, passes 3/3).
    - **`route-load-failure.spec.ts:72`**: Chrome 156 (Playwright
      `chromium-1248`) no longer caches a failed module fetch (shown against
      Chrome 153), so Retry recovered where the spec expected "needs a
      reload". The spec now keeps the dependency unreachable during Retry;
      the comment in `ui/lazyRoute.tsx` updated.
    - **`table-raster-pixels.spec.ts`**: the four causes in the E5 entry
      above (the presence avatar in the shots, the pre-existing stale texels
      of pooled text textures, the shown slide's thumbnail drawn by one of
      two pipelines by timing, WebKit's lost Inter face in shared SVGs).
  - After the fixes: the audit batch (notes, present, local copies, collab,
    text edit, tables, shortcuts) 78/78 in Chromium;
    `renderer-visual|inspector-flows|table` 25/25; `table-raster-pixels`
    Chromium 3/3 repeats and WebKit; WebKit `text-engine-spike` 4/4.
  - Final pass over the whole tree (04:12–04:24): `just check` green; full
    `just e2e` 252 passed, 20 skipped in Chromium (13.8 min); the 6 failures
    are the Electron project's desktop specs only, which this round neither
    runs nor fixes (the desktop app is Tauri). One server unit test
    (`editor.test.ts`, "tolerates editors that do not publish an active
    slide yet") timed out once at 30 s, only while the stop hook's check ran
    alongside the queued one; alone it passes 3/3.
  - **Trap**: two Playwright runs started in parallel share
    `apps/web/test-results/` and wiped each other's artefacts (ENOENT on the <!-- docs-check: ignore -->
    other run's traces and screenshots). The session's queue now serialises
    e2e runs; run one Playwright suite at a time per checkout.

- 2026-10-23, **Present mode: the deck edited during the upfront load, and
  the skip** (MacBook; unit tests only — e2e and perf pending, Docker down).
  - **Cause 1:** before `start()` the store subscriber of
    `present/presentation.ts` replanned around nothing (`waitingFor ??
shownId`, both null), so the cache's plan kept the deck of `prepare()`
    and `isPrepared` judged scenes against it. An edit of the start slide
    (its objects, background, page number) then made `start()`'s own
    replan mark it stale: `take` failed, `start` returned false and
    PresentLayout never reached `ready`. A neighbour's edit, an added,
    removed or reordered slide were rebuilt after ready, in idle time — a
    first advance that could wait. The layout also checked readiness only
    before the thumbnail, render-work and font waits.
  - **Fix 1:** the plan follows the deck from `prepare()` on, around the
    slide the presentation will start on (`Presentation.startSlide`; the
    slide after it when an edit deleted it); `isPrepared` replans first when
    the store's snapshot moved, announced or not. PresentLayout checks
    `isPrepared` once more right before `start()` and waits again when an
    edit left work.
  - **Cause 2 (the skip):** `skipPreparation` ran `start(activeSlideId)`;
    on a slide not prepared it set `waitingFor`, so the `follow()` after it
    returned early. The presenter saw the slide as the canvas mounted it,
    but nothing was on stage for the controller (its onClick builds dead),
    the cache never switched to idle-only building (it built during
    transitions and builds) nor kept slides warm, and when the scene landed
    it was swapped in and its builds started over. A skip during the media
    phase also let the later `prepare()` replan around the original start.
  - **Fix 2:** `Presentation.startNow` — the prepared scene when there is
    one, otherwise the mounted slide followed with its builds compiled on it
    and played; idle-only either way. `prepare()` after a start plans
    nothing, and the load stops after the media when skipped.
  - Tests: `present/presentation.test.ts` +11 (5 kinds of edit, the
    unannounced change, the deleted start slide, the plan after start, 3 for
    the skip); the 8 on the two bugs fail on the old code. To run: `just e2e -g
"present"`, `just perf present` (`e2e/perf/present.spec.ts`).
- 2026-10-23, **F5: ADR 0019 measured and closed; R1c on the production image
  under VM 103's limits; the render page's captures halved** (renderer; MacBook
  M3 Pro, a machine shared with other agents, load 6–14 during the runs
  quoted, every timed run alone under the shared lock). Stack: the production
  web bundle (built like the image: no env-file `VITE_*`, precompressed) behind
  `caddy:2-alpine` with the repo's Caddyfile (upstream host names pointed at
  this stack's ports, CSP and routes unchanged); the server from the working
  tree on its own database and Redis, with production's public origin; the
  render worker as the **production image** under the compose limits
  (`--cpus 2 --memory 1200m --memory-swap 1200m`, cap_drop ALL, read-only,
  tmpfs, pids 512, `RENDER_REQUIRE_SANDBOX=1`, `RENDER_CONCURRENCY=2`), on an
  internal network with only Caddy and Redis. Docker Desktop's VM had 1.9 GiB
  (VM 103: 4 GB); the container's own 1200 MB limit is the one that applies.
  - **The load split** (`apps/render-worker/src/loadSplit.ts`, new: the
    worker logs it for every page it loads and returns it as
    `worker.load.{html,scripts,boot,inputs,pixi}` steps; a probe in a
    container of the image ran the worker's own `recyclePage`): "app ready"
    of a recycled page p50 ~480 ms (292–574), a new one ~550 ms (397–621);
    recycled: HTML 3–8, scripts 60–130, boot 220–310, deck inputs 47–140
    (Pixi 27–100 inside); the session check answered at 46–206 ms, never the
    gate. CPU profile of a load: vendor-pixi ~100 ms, vendor-react 18–52,
    the entry chunk 12–18, Yjs 4–18. The render route is 1.6 MB raw / 469 kB
    gz (the worker's routing fetches it raw).
  - **ADR 0019 closed, nothing built**: an in-place switch would save ~0.4 s
    (HTML + scripts + boot) on a session's first job only, a slim entry
    ≤ ~50 ms — neither worth the cross-tenant risk or a second HTML entry
    (ADR 0019 → Outcome).
  - **The cold job's real cost was the page's first capture**: extract
    1.4–1.8 s on every new or recycled page, later captures 0.38–0.48 s
    (decomposed: the same slide again, the next slide with another photo,
    that one again — all ~0.4 s; a warm-up draw into a tiny render texture
    absorbed the 1.1 s whatever its size). Cause: Pixi's batch shader has
    one branch per texture slot and SwiftShader reports 32 —
    compiled on the first draw, and paid per pixel ever after. With the
    render page at 4 slots (`renderer/batchTextures.ts`, Canvas
    `batchTextures`, `limits.maxBatchableTextures` only — `maxTextures` for
    filters and masks unchanged): first capture 259–389 ms, later 152–257.
    **Pictures byte-identical**: PNG hashes of a rich deck (4 photos,
    gradients, a shadow filter, a table, 30 texts with diacritics) equal at
    32 / 8 / 4 / 2 / 1 slots and with the shipped code. 4 ≈ 2 ≈ 1 in time;
    4 keeps picture-heavy slides to fewer draws. The worker also polls for
    the hooks every 10 ms (was 50: ~20 ms of every cold job).
  - **R1c, before → after** (`apps/render-worker/perf/render.ts`, one worker
    for png, pdf, behind): first job 3.8 → 1.2 s; cold one-slide PNG p50 2935
    → 1324 ms (p95 4033 → 1508); warm 1276 → 673; PDF of 30 23.8–30.8 →
    12.0–13.6 s (73 → 141 pages/min); per slide extract p50 457 → 210, page
    total 663 → 382; 3/3 finished each, 25.1 MB, no failed loads. The before
    run had load ~14, the after ~8, so an **interleaved A/B** of the PDF alone
    (fresh worker each, two rounds, load 9–11): 21.3 / 24.9 / 21.6 / 24.7 s →
    16.9 / 17.6 / 16.2 / 16.3 s (p50 ~23.1 → ~16.6, −28 %).
  - **Memory**: cgroup `memory.peak` (exact, includes ~200 MB of page cache)
    with a PDF and a PNG beside it 1100 → 1098 MiB of 1200; a PDF alone
    739–773 → 754–807 MiB; oom_kill 0 throughout. `docker stats` sampling
    (perf/rss.ts) misses peaks by ~100–200 MiB.
  - **Pool recycling**: spare cleared in p50 27 ms (24–37) when nothing else
    runs, 127 ms beside a PDF; recycled pages app ready p50 483 ms.
  - `just perf-agent --only queryRender` on the dev stack (12 cores, the
    tree with the fix) against the stored 2026-10-20 run at the same load:
    cold medians 2279–2799 → 988–1073 ms, warm 301–472 → 158–194 ms, extract
    ~90 → ~52 ms warm (other round changes in between: supporting, not an A/B).
  - Open: a PNG behind a PDF still waits at the memory gate (2.9–17.0 s
    total; queue wait 3–59 ms) — one PDF's render job holds most of the
    1200 MB; scheduling a PDF to leave room for another session's job is a
    server-side decision, not measured here. The same batch limit would
    help the editor and present mode on machines whose Chrome falls back to
    SwiftShader (no GPU) — not done: it touches every page, so a decision
    with a measurement of its own.
