# Canvas performance on crowded slides

Status: **in progress** — steps 1–3 done, 4–5 open (branch `perf/crowded-slide`, started 2026-10-16).
Started because dragging, zooming and typing felt slow on slides with many
text boxes, pictures and shapes (and slowest on the MacBook).

## What was measured

`apps/web/e2e/perf-heavy-slide.spec.ts` (opt-in, `PERF_PROBE=1`): a slide of
120 texts, 40 pictures (6 photos of 3200×2133) and 60 rectangles, driven by
real pointer and key events. It records frame times, WebGL work (draw calls,
texture uploads), main-thread time by CDP, the self time of the hottest
functions, React commits and renders per component, and the long tasks that
follow a gesture. Run it with the machine's GPU:

```
PERF_PROBE=1 PERF_GPU=1 [PERF_REACT=1] [PERF_ONLY=drag-rect,zoom-wheel] \
  [PERF_TEXTS=120 PERF_IMAGES=40 PERF_RECTS=60] \
  just e2e --project=serial --no-deps e2e/perf-heavy-slide.spec.ts
```

Measured 2026-10-16 on the Linux desktop (RTX 5090, 1× DPR), against the Vite
dev server — React's development build, which is roughly 2–3× slower than
production, so absolute milliseconds are inflated; the ratios between
findings are not. Playwright's own tracing must be off (the spec does it): its
DOM snapshots per mouse move doubled the layouts and hid the real picture.

| Finding                                                                                                                                              | Evidence (224 objects)                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One pointer move commits React ~3 times and renders ~850 components: all 224 rows of the Layers panel (row + icon) and 26 toolbar tooltips each time | 278 commits and 77 000 renders for a 91-move drag; React ≈ 3.5 of 5.5 s script; the Layers panel ≈ a third of it. Script time grows with objects: 4.6 s (104), 5.6 s (224), 7.8 s (404)                    |
| The sidebar thumbnail of the edited slide is rebuilt from scratch 500 ms after the last edit: every object re-mounted, every text re-rasterised      | Long tasks after a gesture: 111 ms (104 objects), 305 ms (224), 491 ms (404); the longest single task 363 ms. It lands exactly when the user pauses or carries on                                          |
| A zoom re-rasterises every text, visible or not                                                                                                      | Texture upload 1 → 61 → 182 → 415 Mpx for 0 / 40 / 120 / 300 texts; fps 34 → 22, longest task 91 → 584 ms. With a slow main thread the 150 ms debounce fired 8 times per gesture instead of 1–2            |
| Text measurement inserts DOM into the page body                                                                                                      | `measureHtmlText` in every profile; layouts per gesture grow with the text count, and a style recalculation covers the whole app DOM (the Layers panel has a `li` per object)                              |
| Ruled out                                                                                                                                            | Pixi's `render()` costs 0.3–0.7 ms per frame. Masks on texts and pictures multiply draw calls by ~25 (≈500 per frame) but change no frame time on this GPU. The app's own snap/drag code is ~4 ms per move |

## Plan

Each step is measured before and after with the spec above (same scene, the
rows it touches), and ships when the numbers move; the order is by the size of
the effect.

1. **Layers panel and re-render fan-out** (`ui/Inspector.tsx`,
   `state/useSlideObjects.ts`, the toolbar).
   - `LayerRow` as a memoised component fed primitives and stable callbacks:
     a pointer move re-renders no row but, at most, the moved object's.
   - Find what re-renders the toolbar's 26 tooltips per commit and stop it.
   - One shared subscription to the active slide's objects (a provider that
     `useSlideObjects` reads) instead of eleven private ones, so one change is
     one state update.
   - Target: renders per commit from ~850 to under 100; script per move from
     ~50 ms to under 25 ms (dev build).
2. **Thumbnail of the active slide** (`state/useSlideThumbnails.ts`,
   `renderer/thumbnails.ts`). The slide being edited is already drawn, with
   its texts rasterised, by the editor's own canvas: render the thumbnail from
   that scene into a small render texture instead of re-mounting every object
   in a second Pixi app. Other slides keep the current path (they change only
   through collaborators), at idle priority. Target: no task over 50 ms after a
   gesture.
3. **Zoom** (`renderer/Canvas.tsx`, `SceneGraph.restageTextResolution`).
   Re-rasterise only the texts in the viewport, in batches across frames, the
   rest when they scroll in; commit the resolution when the gesture ends, not
   on a timer a stalled main thread can trip repeatedly. Target: zoom with 300
   texts at the fps of 40 texts.
4. **Text measurement** (`patchHTMLTextRace`/Pixi `measureHtmlText`
   surroundings). Keep the measurement from forcing a layout of the whole app
   DOM (an isolated, contained measuring root); virtualise the Layers list if
   its DOM is still the cost.
5. **Open questions, measure first.** Masks on the MacBook's GPU (the spec runs
   there; the draw-call count suggests a cost on tilers and integrated GPUs,
   nothing here shows one). Mipmaps for text textures (generated for every
   raster; switching them off saves a third of the texture memory). A
   production-build run of the spec to calibrate the React figures.

## Out of scope

- The renderer's scene-graph diff, the masks and the snap code: measured, not
  the cost.
- Anything that changes what a slide looks like.

## Log

- 2026-10-16: baseline measured (above); branch created.
- 2026-10-16, step 1 (Layers rows memoised, Toolbar memoised, `useRemotePeers`,
  snap-guide state skipped when unchanged): drag over 91 pointer moves, script
  5.8 → 3.3 s, React render time 3.6 → 1.9 s, row renders per commit ~150 → 0.
  `LayerRow` is a memo of primitives with callbacks read from a ref
  (`e2e/layers-panel.spec.ts` covers select, shift-select, drop-reorder,
  delete). The awareness fix: a local cursor move no longer re-renders the
  five readers of other people's state (`state/useAwareness.ts`, tested).
  Still open: ~3 commits per move (EditorLayout renders twice; a shared
  object subscription is the candidate), `LayersPanel` itself re-renders per
  commit (1 ms) — virtualisation only if it shows again.
- 2026-10-16, step 2 (`renderer/liveThumbnail.ts`): the active slide's
  thumbnail is read from the editor's canvas once it has settled; the edited
  text, faded under the overlay, is drawn for the read-back
  (`SceneGraph.withTextUnfaded`). Falls back to the renderer's path when the
  canvas is not showing exactly the slide. After a gesture: long tasks 305 /
  388 / 343 ms → 0 (nudge / drag / typing), texture upload 29 → 0 Mpx; drag
  32 → 42 fps, typing 26 → 41 fps (with step 1). `e2e/thumbnail-live.spec.ts`
  checks the pixels, including text being edited (it fails without the
  unfade — checked).
- 2026-10-16, step 3 designed, not started. Pixi re-rasterises every
  auto-resolution HTMLText at once when `renderer.resolution` changes (its
  `resolutionChange` runner calls `onViewUpdate` on each); a text with an
  explicit `.resolution` is skipped. So: (1) before the change, pin every
  HTMLText of the scene (top-level text, table cells, component leaves — the
  walker `forceTextResolutionRefresh` has) to the current resolution
  (`SceneGraph.pinTextResolution`); (2) change `renderer.resolution`; (3) hand
  the new value to the pinned texts in batches of ~8 per animation frame,
  the ones in the viewport first (`restageTextResolution(res, visibleRect)`,
  the rect from the canvas element's bounding box and the window, widened by
  25%), a generation counter cancelling a staging a newer zoom overtakes;
  (4) commit the resolution from `requestIdleCallback` after the 150 ms
  debounce, so queued wheel events (which cancel the commit) run first.
  `forceTextResolutionRefresh` and `e2e/zoom-text-probe.spec.ts`, which calls
  it, go with it. Check with `e2e/canvas-sharpness-final.spec.ts` and the
  `zoom-wheel+settle` rows of the probe (target: 300 texts at the fps of 40).
- 2026-10-18, step 3 (`renderer/textResolutionStaging.ts`,
  `SceneGraph.pinTextResolution` / `restageTextResolution`, the commit in
  `Canvas.tsx`): built as designed, plus one finding. Batching the
  _starts_ (8 texts a frame) did not remove the task behind the commit: Pixi
  rasterises an HTMLText's SVG into the texture (`texImage2D` of the image)
  in the image's `onload`, and those loads land together — one ~250 ms task
  of `texSubImage2D`, 150–450 ms after the commit, whatever the batch size.
  So a batch is now bounded by texts (8) _and_ texture pixels (2 Mpx,
  estimated from the current texture × the change²), and the next batch
  waits until the last one's rasters have landed (at most 6 frames, for
  hidden text). Pinned texts stay pinned; texts mounted later follow the
  committed resolution. `forceTextResolutionRefresh` and
  `e2e/zoom-text-probe.spec.ts` are gone (the probe is in git history, see
  `docs/testing-strategy.md`); `canvas-sharpness-final.spec.ts` gained a
  live-zoom test (every text, off screen too, ends drawn at the new
  resolution — fails with the staging switched off, checked). The probe
  rows now carry a timeline (input end, restage calls and their completion,
  long tasks). `zoom-wheel+settle`, MacBook M3 Pro (ANGLE Metal, 1× DPR, dev
  build), 3 runs each, before → after:

  | Texts (objects) | active fps    | long tasks while zooming    | tail (after input)                                        | task time     | uploads     |
  | --------------- | ------------- | --------------------------- | --------------------------------------------------------- | ------------- | ----------- |
  | 40 (144)        | 45–47 → 45–49 | 2× ≤ 278 ms → 1× ≤ 181 ms   | 60 fps → 60 fps                                           | 1.29 → 1.11 s | 208 → 208   |
  | 120 (224)       | 44–46 → 44–47 | 3–4× ≤ 203 ms → 1× ≤ 167 ms | 60 fps → 60 fps                                           | 1.86 → 1.58 s | 596 → 595   |
  | 300 (404)       | 43–45 → 40–43 | 2× ≤ 151 ms → 2× ≤ 182 ms   | 51 fps, max 167 ms, 1 long task → 60 fps, max 17 ms, none | 3.43 → 2.17 s | 1465 → ~900 |

  What is left in "long tasks while zooming" is the commit itself, one per
  resolution change (the probe's zoom reaches its clamp and rests there,
  so it commits twice): `resizeCanvas`, the backbuffer reallocation, ~100 ms
  with no text on the slide at all (0 texts: 1× 99 ms). Not text, so not
  this step — a candidate for step 5 (antialias/MSAA, a resize that does not
  reallocate on every commit). A staging finishes 0.4–0.6 s (40 texts) to
  1.0–1.4 s (120) after its commit, viewport first; at 300 texts the one at
  the zoom's peak is overtaken by the zoom back out, so off-screen text is
  never rasterised at the peak (the ~560 fewer uploads). An earlier run of
  the 120-text row on the same machine that day (33 fps, max 750 ms, 6 long
  tasks) did not reproduce in these runs; the machine was quieter.
