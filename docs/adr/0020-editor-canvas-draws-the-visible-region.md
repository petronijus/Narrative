# ADR 0020 — The editor canvas draws the region the window shows

**Status**: Proposed by the renderer agent (2026-10-27), built on
`perf/crowded-slide` at the coordinator's request (F1 follow-up); needs the
tech-lead's review — it is the render-architecture change the renderer's
"Zoom commits" note named.
**Scope**: `apps/web/src/renderer/Canvas.tsx`, `CanvasInstanceContext.tsx`, `canvasRegion.ts`,
`canvasRegionController.ts`, `stageRender.ts`, `RenderScheduler.ts`, the text
staging in `SceneGraph.ts` (`restageTextResolution`'s off-screen cap);
present mode's density switch (`components/PresentLayout.tsx`,
`present/presentation.ts`, `present/densityHandover.ts`) and the grid its
standby set is placed on (`runText/placement.ts → setProspectivePage`,
`runText/runTextSystem.ts`).
**Related**: [ADR 0018](0018-canvas-text-from-the-browser-layout.md) →
Placement (text on the device grid), ADR 0002 (renderer architecture),
[`plans/performance.md`](../plans/performance.md) → zoom commits.

## Context

The editor canvas covered the artboard and its bleed (2720 × 1880 CSS px for
a 1920 × 1080 slide) inside the zoomed artboard, at `dpr × zoom`. Two costs
followed:

- **A long frame after every zoom gesture.** A commit changed the backing
  store's pixel count, and Pixi reallocated it (`CanvasSource.resizeCanvas`:
  101 ms over the two commits of `viewport.zoom.commit`, profile 2026-10-27).
  Since ADR 0018 → Placement made the resolution follow the zoom below 100 %
  as well, zooming back out committed too: `frame.max` 33 → 83 ms.
- **A pixel cap.** 2720 × 1880 at `dpr × zoom` passes 25 Mpx at ≈2.2× (DPR 1)
  and 1.1× (DPR 2); above it the resolution was capped and the compositor
  resampled the canvas — text ~1 device px off the edit overlay there.

## Decision

1. **The backing store is the stage's viewport and a quarter of it on each
   side, at the device pixel ratio** (`canvasRegion.ts` → `backingFor`), fixed
   while the window keeps its size. A zoom changes the renderer's
   resolution, not the pixel count: Pixi keeps the backbuffer
   (`TextureSource.resize` returns early), so a commit reallocates nothing.
2. **The canvas draws a region of the world** (`regionAround`): `backing /
resolution` CSS px around what the window shows, its corner a whole
   device px from the world's origin. The stage is drawn through a render
   transform (`stageRender.ts`, Pixi's `render({ container, transform })`):
   world coordinates — `toGlobal`, `getBounds`, the hit test, the overlays,
   the slide captures — do not move. The canvas element sits at the region
   inside the artboard's container: its box at whole CSS px of the zoomed
   artboard (Chrome snaps a replaced element's box to its own coordinates —
   a canvas at `top: 1092.5px` at 400 % was drawn 2 device px off, a
   fractional width was resampled), a `translate() scale()` about its corner
   taking it the rest of the way, so its backing store lands texel for
   device px on a whole device px. Text rasters snap to that texel grid,
   whose phase in world px × resolution `setPageOrigin` carries
   (`runText/placement.ts` → `gridPhaseOf`); the overlay root is not moved.
3. **The region follows the view** (`CanvasRegionController.follow`): a
   scroll that leaves it moves it (a new transform and one render); a
   zoom-out gesture that shows more of the world than the region holds
   lowers the resolution at once — no reallocation, texts pinned to their
   rasters — and the commit after the gesture gives everything the zoom's
   own resolution. A window resize or a new pixel ratio
   (`devicePixelRatioWatch.ts`) lays it out again — in present mode the new
   ratio is the density handover's to apply (see Present mode below).
4. **No pixel cap on the resolution** (`dpr × zoom`, at most 8): the canvas
   is never resampled by the compositor. Texts in view get that resolution;
   texts out of view are held to 2.2 (what the old cap gave every text, so
   text memory stays where it was) and get the full resolution when a
   settled scroll brings them into view (`restageTextResolution`'s
   `offscreenCap`).

## Consequences

- Scrolling within the region costs nothing, as before; leaving it costs one
  render. The region's margin (25 % a side) bounds how often.
- Specs that mapped world coordinates through the canvas element's rect map
  them through its container now (the canvas covers only the region).
- More pixels at the fitted zoom than before (the viewport and its margin
  rather than the artboard at 0.54×); fewer at high zoom. The clear and the
  fill are the GPU's; no CPU cost follows the pixel count.

## Measured

2026-10-30, MacBook M3 Pro on AC, Low Power Mode off, production builds,
`just perf-compare HEAD .` (HEAD 10c9e044 against the working tree that holds
this ADR, the ADR 0018 run-text engine as the default and its placement on
the device grid), 10 runs a side interleaved, load 2.7–4.7; medians (IQR).
The comparison is the whole tree, not this ADR alone.

| Chromium 156 (ANGLE Metal)             | HEAD             | tree          |
| -------------------------------------- | ---------------- | ------------- |
| `viewport.zoom.commit` frame.max       | 133 ms (117–150) | 58 ms (50–83) |
| `viewport.zoom.commit` long tasks      | 144 ms           | 0             |
| `viewport.zoom.commit` settle          | 501 ms           | 382 ms        |
| `viewport.zoom.commit.table` frame.max | 92 ms (83–100)   | 16.8 ms       |
| `viewport.zoom.wheel` settle           | 21 ms            | 331 ms        |
| `viewport.zoom.wheel` frame.max        | 16.8 ms          | 33 ms (17–67) |
| `viewport.zoom.wheel.light` settle     | 21 ms            | 333 ms        |
| `deck.open.cold.100` all settled       | 5736 ms          | 2366 ms       |

| WebKit (Playwright, headless)          | HEAD      | tree          |
| -------------------------------------- | --------- | ------------- |
| `viewport.zoom.commit` frame.max       | 1591 ms   | 72 ms (67–80) |
| `viewport.zoom.commit` frame.p90       | 19 ms     | 49 ms         |
| `viewport.zoom.commit.table` frame.max | 1172 ms   | 55 ms         |
| `viewport.zoom.wheel` settle           | 26 ms     | 288 ms        |
| `deck.open.cold.100` all settled       | 53 961 ms | 2475 ms       |

- **The reallocation is gone** (decision 1): the CPU profile of a commit
  has no `resizeCanvas`, and no long task is left in either zoom-commit
  bench. The target of a commit's longest frame at 33 ms is **not met** in
  `viewport.zoom.commit` (58 ms): the long frames carry no main-thread work.
  A per-frame trace shows the 121 run rasters of a commit landing within
  two frames (55–80 Mpx of uploads and mipmaps per frame, ~127 Mpx a commit:
  2.5× HEAD's, as decision 4 lifts the pixel cap), and the frames two or
  three later taking 33–100 ms — the GPU digesting them. The restage budget
  (`restageBudget.ts`) shrinks on long tasks only and never sees it. Open:
  a per-frame upload cap for run-text textures, or the budget fed by frame
  gaps as well.
- **A zoom gesture that ends where it started now re-rasterises every text
  twice** (`viewport.zoom.wheel`: 0 → 242 rasters, settle 21 → 331 ms) with
  no resolution change (`text.restage.texts` 0, the renderer at 0.1 from
  start to end): the region following the live zoom (decision 3) moves the
  render transform, and `runText/placement.ts`'s watch repaints texts whose
  raster no longer sits where it was painted. The gesture ends on the start
  phase, so the rasters are wasted. On the light slide (no text) the settle
  grows by the commit's quiet window and one render. Open (renderer).
- Scrolling within the region renders nothing, as before; the wheel benches
  render 43–64 times per gesture now (the region following the zoom), 14–42
  ms in total.

### Fixed after the measurement (2026-10-30, renderer)

The three open points above had causes of their own, none of them the
region itself (log `~/.cache/narrative-perf/round-logs/regress-fix-2026-10-30.md`):

- **The commit's long frames** were the zoom staging never staging: its job
  skipped a text "nothing draws" by Pixi v7's `worldVisible`, which v8 does
  not have — every text read as hidden and got the new resolution in the
  commit's first batch (since 2026-10-18; HEAD's 144–273 ms commit tasks
  were the same). `SceneGraph → drawnOnStage` checks visible, renderable and
  alpha up to the stage; a batch is 24 texts or the pixel budget, and the
  budget also halves on a missed frame (`restageBudget.ts → FrameGapWatch`:
  run-text uploads land on the GPU, not in a long task; WebKit has no Long
  Tasks API). Per-frame probe: 0 frames over 20 ms in 4 commits (were
  33–233 ms, 3–5 a commit). `viewport.zoom.commit` frame.max 125 → 16.8 ms.
  A page that draws slower than 66 ms a frame whatever the batch (software
  GL, a starved machine) gets the rest of a staging at once — spreading
  cannot smooth its frames and only multiplies them (a dev page on
  Playwright's GL at 400 %: a text a frame at a frame a second, > 2 min);
  a long task counts against a batch only when it is longer than 1.5 of
  the page's frames.
- **The no-op gesture's rasters** were the placement watch comparing places
  while the region followed the live zoom: the zoom gesture now holds it
  until its commit (ADR 0018 → Placement). 0 rasters.
- **The no-op gesture's settle** was one frame drawn at the commit:
  `CanvasRegionController.layout()` compared `renderer.screen` with
  backing / resolution, and Pixi keeps the screen at its texture frame's old
  size when the pixel count does not change — at any resolution but the
  first, every layout resized, dropped the canvas's placement and drew. The
  controller now remembers what it sized for. Also: a settled scroll's text
  restage with nothing to hand out no longer counts or draws. Renders per
  gesture 61 → 30, none after the input ends.

### Measured after the fixes (2026-10-31, renderer)

The same setup as above (MacBook M3 Pro on AC, Low Power Mode off,
production builds, `just perf-compare HEAD .`, 10 runs a side interleaved),
the tree with the fixes above and the WebKit upload fix below; Chromium at
load 2.9–5.6, WebKit at 3.3–5.0. Medians; CI is the bootstrap interval of the
difference (log `~/.cache/narrative-perf/round-logs/verify-2026-10-31.md`).

| Chromium 156 (ANGLE Metal)             | HEAD    | tree    | CI of the change |
| -------------------------------------- | ------- | ------- | ---------------- |
| `viewport.zoom.commit` frame.max       | 133 ms  | 16.8 ms | −125 … −100      |
| `viewport.zoom.commit` long tasks      | 261 ms  | 0       | −278 … −249      |
| `viewport.zoom.commit` settle          | 522 ms  | 442 ms  | −89 … −62        |
| `viewport.zoom.commit.table` frame.max | 100 ms  | 16.8 ms | −125 … −75       |
| `viewport.zoom.commit.table` settle    | 481 ms  | 385 ms  | −101 … −87       |
| `viewport.zoom.wheel` settle           | 27.5 ms | 27.2 ms | −1.4 … 1.6       |
| `viewport.zoom.wheel` text rasters     | 0       | 0       |                  |
| `viewport.zoom.wheel.light` settle     | 22.4 ms | 22.0 ms | −2.0 … 3.7       |
| `viewport.zoom.wheel.light` input.max  | 24.5 ms | 37.8 ms | 6.4 … 14.3       |
| `transform.move.multi` text rasters    | 0       | 0       |                  |
| `present.advance.text` ready           | 1196 ms | 943 ms  | −276 … −216      |
| `present.build.steps` ready            | 2913 ms | 2491 ms | −434 … −413      |
| `deck.open.cold.100` all settled       | 5774 ms | 2388 ms | −3415 … −3323    |

| WebKit (Playwright, headless)    | HEAD      | tree    | CI of the change  |
| -------------------------------- | --------- | ------- | ----------------- |
| `viewport.zoom.commit` frame.max | 1641 ms   | 53 ms   | −1658 … −1539     |
| `viewport.zoom.commit` frame.p90 | 19 ms     | 21 ms   | 1 … 2.5           |
| `viewport.zoom.commit` settle    | 1618 ms   | 887 ms  | −786 … −701       |
| `viewport.zoom.wheel` settle     | 26 ms     | 26 ms   | −2.5 … 3.5        |
| `viewport.zoom.wheel` frame.max  | 39 ms     | 48.5 ms | 5.5 … 17.5        |
| `table.cell.type` settle         | 1573 ms   | 52 ms   | −1552 … −1473     |
| `table.cell.type` input.max      | 120 ms    | 38 ms   | −87 … −75         |
| `deck.open.cold.100` all settled | 54 350 ms | 2472 ms | −52 021 … −51 777 |

- **Targets**: a zoom commit's longest frame ≤ 33 ms is met in Chromium
  (16.8 ms, both benches) and not quite in WebKit (53 ms, one frame a run;
  frame.p90 21 ms, was 49 ms before the fixes). A gesture that ends where it
  started settles as on HEAD and rasterises nothing. Present mode: no raster,
  upload or mipmap after ready in either bench, ready 15–21 % sooner.
- **What the region costs during a gesture** (decision 3, not a defect of the
  fixes): 30 renders per `viewport.zoom.wheel` gesture (15 ms in all; HEAD
  drew none, the compositor scaled), so an input occasionally waits for one —
  `viewport.zoom.wheel.light` input.max +13 ms, `viewport.zoom.commit.table`
  input.p90 23 → 37 ms in Chromium, WebKit `viewport.zoom.wheel` frame.max
  39 → 48.5 ms and input.p50 +2 ms. input.p50 is unchanged in Chromium.
- **WebKit drew no canvas text from 2026-10-30 to 2026-10-31**: the WebKit
  upload path's extension (ADR 0018 → The residue, "WebKit uploads a bitmap
  straight") was registered in a shape Pixi does not read, and every run
  raster stayed an empty texture. Fixed before the WebKit numbers above were
  taken (`runText/runRasterUpload.ts`); the earlier WebKit numbers in this
  ADR predate that change and are unaffected.
- **Texture memory at a high zoom on a crowded slide, fixed 2026-10-31**
  (decision 4's "text memory stays where it was" held for a slide with few
  texts in view, not for this one). The crowded slide (120 texts, 40
  pictures, 60 shapes; 1600 × 1000 at DPR 2) after eight wheel steps in held
  1.86 GB of textures in the editor's GL context: every run raster sat in
  Pixi's pooled power-of-two texture (301 Mpx of texture for 152 Mpx of
  raster), with mipmaps (+⅓), and every texture a staging handed back
  stayed on the GPU in Pixi's `TexturePool` until Pixi's collector found it
  unused for a minute (and only after a render) — 1.7 GB of it at the
  fitted zoom right after the zoom out. Three causes, three fixes:
  - **Exact-size textures** (`runText/runTextSystem.ts → RunTextureShape`):
    where the canvas draws the page and not in HTMLText-compatible mode, a
    run raster gets a texture of its own, its exact size, destroyed (its GPU
    texture deleted) the moment the pipe hands it back. ADR 0018's decision
    4 kept the pool's size for parity with HTMLText's sampling; placed
    rasters are held to the edit overlay instead (`text-edit-parity`), and
    the thumbnails and the compatible mode keep the pool (ADR 0018,
    amended).
  - **Mipmaps only where a raster is drawn resampled** (`mipmapsFor`; the
    editor's `Canvas textMipmaps="resampled"`): a raster on the device grid
    is drawn texel for device pixel; one off it gets them when it is drawn
    smaller than painted (a text in a group scaled down). Present mode and
    the render page keep them on every raster (builds, transitions and
    captures draw texts smaller). A zoom-out gesture draws the editor's
    rasters minified until the commit's staging, as the compositor drew the
    whole canvas before this ADR.
  - **A budget for full resolution beyond the view**
    (`textResolutionStaging.ts → planTextResolutions`, `Canvas.tsx →
FULL_RESOLUTION_TEXT_BUDGET_PX`, 64 Mpx): the texts meeting the
    viewport always get the zoom's resolution; those only the region's
    margin meets get it, nearest first, while the full-resolution rasters
    stay within the budget, and texts a scroll left keep theirs within it
    and come down to the 2.2 cap beyond it. Past the budget a text in the
    margin is shown at 2.2 until a settled scroll brings it into view. Idle
    pooled textures (Pixi's own HTMLText fallbacks, filters) are freed
    once a staging has landed (`ResourceManager →
releaseIdlePooledTextures`): an idle render target (a filter's) is
    destroyed and leaves the pool — Pixi keeps the framebuffer it built for
    one until the texture is destroyed, and until 2026-11-01 an unloaded
    one handed out again drew every filter into a framebuffer without its
    GL texture (after a zoom, a drop shadow redrawn vanished:
    `folder-tokens.spec.ts`); an idle raster is unloaded and kept whole —
    Pixi hands an HTMLText's texture back while the text still draws it
    (destroyed, the next batch threw: `text-import-parity.spec.ts`).

  Measured with the GL residency probe (`perf/glResidency.ts`) and the
  harness's `textureMemory()` (`renderer/perfProbes.ts →
textTextureMemory`), MacBook M3 Pro, Chromium on ANGLE Metal and WebKit
  (log `~/.cache/narrative-perf/round-logs/texmem-2026-10-31.md`):

  | Editor GL textures            | HEAD (prod) | before (dev) | after (prod) |
  | ----------------------------- | ----------- | ------------ | ------------ |
  | Chromium, opened (r 2.0)      | 387 MB      | 389 MB       | 166 MB       |
  | Chromium, 8 steps in (r 5.44) | 571 MB      | 1927 MB      | 563 MB       |
  | Chromium, fitted again        | 580 MB      | 1965 MB      | 178 MB       |
  | WebKit, opened (r 2.0)        | 387 MB      | 389 MB       | 166 MB       |
  | WebKit, 8 steps in (r 8.0)    | 575 MB      | 1785 MB      | 688 MB       |
  | WebKit, fitted again          | 581 MB      | 1822 MB      | 178 MB       |

  Zoomed in, the run rasters are 97 Mpx (Chromium) / 128 Mpx (WebKit, at
  8.0) with no padding and no mipmaps, the pool holds nothing; 81 / 100 Mpx
  of it are the texts the viewport meets. WebKit's 688 MB against HEAD's
  575 is the visible texts at 8.0 where HEAD drew them at 2.2, resampled.
  `memory.zoom.cycle` budgets the padding, the mipmaps and the pool at 0
  (`MEMORY_TEXT_WORK`) and reports the zoomed MB and Mpx
  (`MEMORY_TEXT_METRICS`). Timing (`just perf-compare HEAD .`, prod, 10
  runs a side): nothing slower than the tree before these fixes; WebKit
  `viewport.zoom.commit` settle 887 → 626 ms and frame.max 53 → 35 ms (HEAD
  1671 / 1765), the commits upload 30–55 % fewer kilopixels and no mipmaps.

- **Open — rasters of texts the view only partly shows**: a text the
  viewport meets is rasterised whole, at the zoom's resolution; at 544 % the
  67 texts the region meets hold 129.7 Mpx of which 55.7 Mpx lie inside the
  region (`textTextureMemory → inRegionShownPx`). Cutting every such raster
  to the region (as `cutToRegion` does for rasters over the texture limit)
  would take the rest, but a zoom-out gesture then shows the cut texts'
  missing parts until the commit's staging paints them again; it needs a
  low-resolution whole raster under the cut one, or painting during the
  gesture. Not done.
  Under SwiftShader (the e2e `chromium` project has no GPU flags) the zoom
  before these fixes kept the GPU process busy for minutes: rAF stopped for
  over a minute (the main thread idle, timers running — the staging's frame
  fallback, `textResolutionStaging.ts → FRAME_FALLBACK_MS`, is for that).
  `text-edit-parity` at DPR 2 passes there now in 21.7 min.
- **A slow page's staging, fixed 2026-10-31**: "the page draws slower than
  66 ms a frame, hand the rest out at once" read the _shortest_ recent frame
  interval, and one quick frame among second-long ones (software GL) kept
  the per-frame budget — the off-screen tail of the crowded slide went at a
  text every 1.5 s and `text-runs-artboard` timed out at 400 %. It reads the
  median now (`restageBudget.ts → FrameGapWatch.typicalInterval`; the
  shortest stays the measure of a missed frame). `text-edit-parity` at DPR 2
  then passes on the crowded slide under SwiftShader as well.
- **A reallocated backbuffer is drawn in the same task, fixed 2026-10-31**:
  a layout that resized the canvas (a new pixel ratio, a window resize)
  asked for a frame, and from a ResizeObserver or an animation-frame
  callback that frame came after the compositor had shown the empty
  backbuffer — present mode's density change composited a blank frame
  (`e2e/present-density-change.spec.ts`). `CanvasRegionController`
  counts its reallocations and `Canvas.tsx → drawAfterLayout` draws at once
  after one.
- **Present mode: one owner of the canvas's density, decided 2026-11-01
  (Petr, option B); see "Present mode" below.** Until then present mode's
  density had two owners under the region: `Canvas.tsx`'s pixel-ratio watch
  committed the new resolution at once and restaged the presenting slide's
  texts on stage while the `DensityHandover` prepared a set for the new
  density off stage (the first advance after a change rasterised 8 texts),
  and without that watch the handover's `setCanvasResolution` (the screen
  size kept, the resolution changed) was wrong under a region (screen =
  backing / resolution) and drew an empty frame.

## Present mode (decided 2026-11-01)

Present mode's canvas is a `Canvas` on screen, so it draws through the
region as the editor's does: its backing store is the viewport and its
margins at the pixel ratio (2400 × 1350 at 1600 × 900 and DPR 1, 4800 × 2700
at DPR 2; the slide-sized 1920 / 3840 before this ADR), the region what that
store covers at `dpr × 1` around the slide (shown fitted by the CSS scale of
`PresentLayout`). **One render path stays** — rejected: a slide-sized canvas
for present mode without the region (option A), a second way of drawing
every slide to keep in step with the editor's.

What differs is **who owns the density** (Petr, option B). Present mode
prepares every slide before it starts and does no work after ready
(ADR 0016): a new pixel ratio is the `DensityHandover`'s
(`present/densityHandover.ts`), which prepares a set of slides for it off
stage while the old set presents and swaps it in on a still slide or at the
next advance. The canvas does not follow the ratio by itself there:

- `Canvas` → `followPixelRatio` (default true, the editor): the canvas's own
  pixel-ratio watch commits the zoom's resolution on the new grid and
  restages the texts. `PresentLayout` passes false: no watch, and the
  region controller lays out for the ratio the canvas **owns**
  (`CanvasRegionController(…, 'owned')` → `pixelRatio`), not the window's —
  a window resize between the change and the swap lays the canvas out for
  the ratio it draws at, not for one nothing is prepared for yet.
- `CanvasInstance.setPixelRatio(ratio)` is the one operation that changes
  it (`CanvasRegionController.switchPixelRatio`): the texts on stage are
  pinned to the resolution they were drawn at first (a text following the
  renderer would rasterise again at its next draw, on stage), then the
  canvas is laid out through the region for the ratio — the backing store
  for the viewport at it (reallocated), the region that store covers at the
  new resolution, the device-grid shift — and nothing is restaged: what is
  shown at the new ratio was prepared for it. It is drawn before the task
  ends (`RenderScheduler.renderBeforeTaskEnds`: a microtask draws unless the
  caller drew in the same task — the presentation swaps the incoming slide
  in and draws it, one draw, never the reallocated backbuffer empty).
  Pictures choose their variants for the ratio when the presentation says
  so (`settleDensity` → `setPixelDensity`, after the swap). On a canvas that
  follows the window the operation throws.
- The handover calls it from `Presentation.adoptStandby` (`apply`), in the
  task the standby set takes over.
- **The standby set's texts are placed for the grid the canvas will have**
  (2026-11-01). They are rasterised while the canvas still draws at the old
  ratio, and a run raster is put on the device grid only when it is painted
  at the canvas's resolution (ADR 0018 → Placement): pinned at the new one,
  they were painted unplaced, and present mode's held placement watch kept
  them so after the swap — up to a device px off where a presentation
  opened at the new ratio (and the editor) puts them (134 680 px of a
  3200 × 1800 slide differed). `CanvasInstance.preparePixelRatio(ratio)`
  (`CanvasRegionController.prepareFor`) publishes the page the canvas will
  draw after `switchPixelRatio(ratio)` — the region and the texel grid's
  phase, computed by the same code as that switch's layout — as the
  renderer's prospective page (`runText/placement.ts →
setProspectivePage`), and the run-text system plans a raster at that
  resolution on it (`pageGridFor`). Every layout before the swap computes
  it again; when it moves (a resize recentring the slide), the handover
  prepares the set again (`DensityHandover.restart`), off stage. Verified:
  the slide after the swap is pixel for pixel the presentation opened at 2×
  (`present-density-change.spec.ts` → "texts on the new device grid":
  fractional boxes, 11–72 px, three alignments; 0 px differ).

Verified (`e2e/present-density-change.spec.ts`, Chromium, CDP 1× → 2× on
the text deck): the canvas ends at the region's backing store for the
viewport at 2 (`backingFor`, read from the controller's viewport); the texts
on stage keep their rasters from the change to the swap; from the swap on,
through the settle and three advances, no text raster and no texture upload;
one reallocation, drawn in its task, no empty frame among 51; the slide after
the swap equals a presentation opened at 2× (mean difference 0.00, edge
energy 1.000). With the canvas's watch on in present mode the spec fails
(work after the swap). Units: `canvasRegionController.test.ts` (the owned
ratio, the switch through the region, pinned before the resize, no restage),
`RenderScheduler.test.ts` (`renderBeforeTaskEnds`); the prospective page
(`canvasRegionController.test.ts`: the page prepared for a ratio is the one
the switch draws, a layout that moves it tells its owner; `placement.test.ts`
→ `pageGridFor`; `densityHandover.test.ts` → `restart`).
