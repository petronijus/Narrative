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

- **L1 (S–M)** Vendor chunks preloaded on every route, login included: Pixi,
  Tiptap (used only by `SlideNotesPanel`/`PresenterOverlay`), Radix, Yjs. The
  catch-all `vendor` group swallows zod, Sentry, tus, tailwind-merge. Drop the
  catch-all, move Inter's registration off Pixi's `Cache` import in
  `main.tsx`, lazy-load notes/presenter/tus. Budgets per route in `just size`.
- **L2 (M)** EditorLayout chunk (110 kB gz) has no `lazy()`: dialogs, timeline,
  table inspector, crop/path overlays.
- **L3 (M)** One `GET /api/media/:id/url` per image (several queries each), then
  always the 2560-px variant: batch the URLs per deck, add a ~1280 variant
  chosen by on-screen size × DPR × zoom.
- **L4 (M)** No local Y.Doc persistence: every open waits for a full sync.
  IndexedDB persistence → repeat opens paint at once.

### B. Editor runtime

- canvas-performance.md steps 3–5 (zoom staging — in progress; text
  measurement; mipmaps).
- **E1 (M)** Every edit deep-copies the whole deck ~7× per frame: `useSlides()`
  → `listSlides()` on an `observeDeep` of all slides, 14 callers, each new
  array defeats `SlideItem`'s memo. One shared, structurally shared deck store
  with selector hooks; one shared object subscription (≈11 `useSlideObjects`
  consumers).
- **E2 (M)** Pixi HTMLText embeds every face of the family as base64 into each
  text's SVG and waits a fixed 100 ms per raster in Safari
  (`HTMLTextSystem.mjs:107`). Via `pnpm patch pixi.js`: embed only used faces,
  revisit the delay, pre-decode, an LRU raster cache across slide switches.
- **E3 (M)** Slide switch re-mounts and re-rasterises everything: raster cache
  (E2) + idle pre-mount of neighbours.
- **E4 (S)** Autofit re-measures grow-down texts on every change, positions
  included (`autofitHeights.ts`): filter by layout keys, reuse the on-canvas
  layout.
- **E5 (M)** Tables: one HTMLText per cell.
- **E6 (M)** Inspector (45 components, one memo), timeline, overlays: selectors
  by id on E1's store.
- **E7 (L)** Text rendering without SVG foreignObject (Canvas2D glyph runs in a
  worker, or MSDF atlases) — the structural fix for zoom, WebKit and memory.
  Starts as a measured spike in both engines.
- **E8** Heap and GPU-texture growth across slide switches — measure first.

### C. Big decks (100+ slides)

- **B1** = E1.
- **B2 (M)** Opening queues every slide's thumbnail through a second Pixi app
  with a synchronous PNG encode, each result re-rendering the panel; reorder
  re-renders every thumbnail. Visible-first, idle for the rest; on reorder
  only slides with a slide-number leaf; blobs instead of base64; a cache by
  content hash.
- **B3** Virtualise the slide panel only if 300-slide decks still show a cost
  after E1.
- **B4** Full-snapshot stores every debounce; a redundant index per updates
  table. Watch as decks grow.

### D. Present mode

- **P1 (S–M)** Slide 1 waits for the whole deck's media (up to 30 s overlay);
  the IndexedDB copy the preload writes is never read. Start at slide 1–2,
  preload in order with bounded concurrency, drop or use the cache.
- **P2 (M)** Transitions mount the incoming slide at click time: pre-mount the
  next slide while the current one shows.
- **P3** A 1080p playback rendition for 4K videos.

### E. WebKit (Safari, the Tauri shell)

- **W1** = E2's Safari delay — check whether the Tauri WKWebView matches
  `isSafari()`.
- **W2** SVG foreignObject with embedded fonts is slow in WebKit: E2 now, E7
  later.
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
  whole doc per batch: coalesced stores per run, per-run caches, lazy forks.
- **S5** Measure the editor's boot waterfall (G4).

### G. Workers

- **R1 (M)** Render worker: `concurrency: 1`, SwiftShader, warm pages tied to a
  token, the full editor bundle. Deck-agnostic warm pool, concurrency sized to
  the VM, a slim render entry, JPEG in the page for PDF.
- **R2 (S)** Video worker: poster/thumbnail after the full transcode, in
  sequence — poster first, in parallel.
- **R3 (S)** Pre-warm imgproxy variants on upload.

### H. PPTX import/export

- **X1 (S)** Images and fonts are downscaled and uploaded one at a time;
  bounded parallelism, stream large media out of the zip.
- **X2** Measure export (G7).

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
2. L1 and E1 — the two largest everyday wins.
3. E2 (pixi patch), P1, B2, L3.
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
