# Performance programme — the whole project

Status: **in progress** (since 2026-10-18; Phase 0 built, the first
workstreams done — see Log). Goal: Narrative as fast
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
harness (2026-10-18, Log); G6's WebKit runs wait for a Mac with Low Power
Mode off.

| Id    | What                                                                                                                                                                         |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 ✅ | Prod-build run of the perf specs: `NODE_ENV=production vite build` + `vite preview` on :5173 (the proxies carry over), a `PW_BASE_URL` override in `playwright.config.ts`    |
| G2 ✅ | Fix `just lighthouse`: it builds without `NODE_ENV=production` and audits `/` of a backend-less preview (the login page). Audit `/deck/:id` of a seeded deck; make it a gate |
| G3 ✅ | Deck-size probe: `PERF_SLIDES=100` — drag/typing on slide 1, slide switch, open → first paint, open → all thumbnails, reorder                                                |
| G4    | Collect `state/loadTimings.ts` (deckLoad → wsSynced → firstPaint), long tasks and INP from real sessions (Sentry or `/api/metrics`)                                          |
| G5 ✅ | Per-machine baselines and a regression gate for the browser probes (the `tests/load` pattern: gitignored `baselines.json`, ±20 %), as `just perf`                            | <!-- docs-check: ignore --> |
| G6 ✅ | A CDP-free mode of the crowded-slide probe (rAF frames, long-task observer, a raster counter — W3) so the same scene runs in WebKit and the Tauri window                     |
| G7    | Server-side probes with fixed inputs: command/MCP latency per phase, render job cold vs warm, PPTX import/export time and peak RSS on a real-size deck                       |
| G8    | `just load` scenario on real slide-model decks of 100 and 300 slides                                                                                                         |

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
- **L3 (M)** One `GET /api/media/:id/url` per image (several queries each), then
  always the 2560-px variant: batch the URLs per deck, add a ~1280 variant
  chosen by on-screen size × DPR × zoom.
- **L4 (M)** No local Y.Doc persistence: every open waits for a full sync.
  IndexedDB persistence → repeat opens paint at once.

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
  no longer measured. Open: reuse the on-canvas layout for typing.
- **E5 (M)** Tables: one HTMLText per cell.
- **E6 (M) — done 2026-10-18** (Log): inspector, timeline, overlays, layers and
  slides panels select by id on E1's store; EditorLayout reads objects only
  in handlers (the overlays that draw objects are `ActiveObjectOverlays`).
  Open: the Inspector's sections of a text box still render with every
  keystroke (a Y.Text change gives no field to compare).
- **E7 (L)** Text rendering without SVG foreignObject (Canvas2D glyph runs in a
  worker, or MSDF atlases) — the structural fix for zoom, WebKit and memory.
  Starts as a measured spike in both engines.
- **E8** Heap and GPU-texture growth across slide switches — measure first.

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
- **B3** Virtualise the slide panel only if 300-slide decks still show a cost
  after E1.
- **B4** Full-snapshot stores every debounce; a redundant index per updates
  table. Watch as decks grow.

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
  Power Mode off on AC.
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
  `present.video` bench with a 4K source.

### E. WebKit (Safari, the Tauri shell)

- **W1 — partly done 2026-10-18** (Log): Pixi waits 100 ms before every
  raster in WebKit whenever a family is named; texts in system fonts (and
  runs in fonts nobody registered) name none now. Texts in embedded fonts
  still wait: Playwright's WebKit draws them correctly without the wait, so
  the upstream option is proposed (Log). The Tauri prototype (WKWebView,
  `isSafari()` true) lives on `feat/desktop`, not on this branch: still to
  measure there.
- **W2 — first step done 2026-10-18**: SVG bytes per raster now follow the
  faces a text uses (E2); E7 later.
- **W3** A raster counter in the renderer (engine-neutral, feeds G6).
- **W4** AVIF decode at 2560 px (L3), antialias at DPR 2.
- Low Power Mode: a lighter editor mode when frames are capped (fewer
  re-rasters in flight), so 30 fps holds without stalls.

### F. Server, collab, agent surface

- **S2 / D1 (S)** No compression at the origin (no `encode` in Caddy, no
  `@fastify/compress`); hashed `/assets/*` carry no `Cache-Control`. Add
  `encode zstd gzip`, `immutable` on hashed assets, precompressed files.
  Paginate `GET /decks` (625 kB for the dev user).
- **S3 (M)** Agent writes store a full snapshot per transaction (no debounce),
  each command re-reads tokens/fonts/style pack, atomic `ops.apply` forks the
  whole doc per batch: coalesced stores per run, per-run caches, lazy forks. **Done 2026-10-18** (Log):
  coalesced stores, a per-run folder context, kept batch forks; `GET /decks`
  paged (S2).
- **S5** Measure the editor's boot waterfall (G4).

### G. Workers

- **R1 (M)** Render worker — **built** (see Log): two jobs at once behind a
  cgroup memory gate, a deck-agnostic warm pool (idle pages recycled across
  sessions), JPEG pages encoded in the page for PDF. Open: the slim render
  entry / an in-place deck switch (touches `renderer/` and `state/`), the
  ~0.7 s slide switch of the render page. **Async PDF ✅ 2026-10-19** (Log):
  a PDF is a job (`pdf-export` queue) the editor and the agent poll, so no
  request waits for it and the 95 s window is gone; the render page no
  longer re-reads `/api/decks/:id` per slide. Open: the 30-slide photo PDF
  measured end to end on the job API.
- **R2 (S)** Video worker — **built**: poster and thumbnail from one ffmpeg
  run beside the transcode, on the asset before the playback. **The editor
  shows it while processing ✅ 2026-10-19**
  (`renderer/objectRenderers/videoRenderer.ts`, Log).
- **R3 (S)** — **built**: `preview` and `display` warmed through the cache
  after an image upload (`IMGPROXY_WARM_ENDPOINT`). Open: video posters.
- Drivers: `apps/render-worker/perf/render.ts`,
  `apps/video-worker/perf/transcode.ts`, `apps/server/perf/imgproxyWarm.ts`.

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

- **D1** (with S2) compression and caching.
- **D2** Image sizes (570 MB server, 1.5 GB video worker on recent tags):
  `pnpm deploy --filter` per app.
- **D3** Server boot-to-ready and first-request latency on VM 103.

### J. Developer loop (builds on `docs/plans/dev-speed.md`)

- **V1 (S–M)** `tsc --noEmit` per package, no incremental, the source-aliased
  packages re-checked by each consumer; `apps/web` build typechecks again.
  Incremental/project references or tsgo; drop the typecheck from the image
  build.
- **V2 (S)** `eslint --cache`.
- **V3** e2e: 3 min on Linux, 12.6 min on the MacBook — a test-strategy
  question, not a quick fix.
- **V4** Time the stop-gate's affected lane before/after V1–V2.

## Order

1. Phase 0: G1, G2, G3, G5 — plus the small standalone wins D1/S2, X1, E4, V2.
2. L1 (✅) and E1 (✅) — the two largest everyday wins.
3. E2 (faces done without a Pixi patch), P0–P3 (present mode smooth, see D), B2 (✅), L3.
4. R1, S3, L4.
5. E7 as a measured spike, then the port if it wins.

Each step is its own commit (or small series) with before/after numbers in
the Log below; the area agents own their parts (`docs/agents.md`).

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
