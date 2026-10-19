# ADR 0016 — Present mode shows slides prepared off stage; an advance only swaps scenes

**Status**: Accepted (2026-10-19, Petr), built on branch
`perf/crowded-slide` for the performance programme's present-mode
workstream ([`plans/performance.md`](../plans/performance.md) → D, P0–P3).
**Scope**: present mode only — `apps/web/src/renderer/presentSlides.ts`,
`renderer/presentVideos.ts`, `renderer/playTransition.ts`, the scene swap
and held-slide bookkeeping in `renderer/SceneGraph.ts`, the resident budget
in `renderer/ResourceManager.ts`, `present/presentation.ts`,
`present/preloadMedia.ts`, `components/PresentLayout.tsx`. The editor's
canvas is unchanged except for the bookkeeping (Canvas.tsx tells the scene
graph which slide a change set belongs to).
**Related**: ADR 0002 (renderer architecture), ADR 0004 (the reconciler),
ADR 0007 (the CSP).

## Context

Petr's requirement (2026-10-18): once the presenter is ready, every
advance, transition, build animation and video runs without a hitch, a
blink, a freeze or a visibly loading slide; a long load before the first
slide is fine, and smoothness is never traded for a faster start.

Present mode used the editor's path for every advance: the slide's objects
were mounted when it became active (or, for a transition, at the moment of
the click), each text rasterised asynchronously and each picture uploaded in
the frame that first drew it. Measured with the new `present.*` benches
(MacBook M3 Pro, prod build): a pass through a 12-slide text deck rasterised
176 texts and uploaded 113 Mpx after "ready"; every cut drew its slide a
frame or more before its texts arrived (sampled frames,
`e2e/present-smooth.spec.ts`); the presenter view rendered the next slide's
thumbnail in a second Pixi application on every advance; a video slide
created its `<video>`, fetched its info and swapped poster for live frames
after the advance; builds were applied after a transition had already shown
the objects (a blink). Pixi's garbage collector would also unload anything
not drawn for a minute.

## Decision

1. **Slides are prepared off stage before they are needed.** A slide scene
   is the slide's background and every object mounted through the renderer
   registry, as the scene graph mounts them, under its own root (a render
   group), painted for that slide's page number and surface. It is drawn
   once into a 1 × 1 render texture — Pixi uploads every picture and starts
   every text raster — and again once the rasters have landed. Nothing about
   it is left for the frame that shows it.
2. **An advance swaps scenes.** `SceneGraph.swapSlideScene` installs a
   prepared scene and hands the outgoing one back intact; the cache restores
   its transforms (builds and transitions move containers) and keeps it. A
   transition animates the prepared incoming root next to the outgoing one
   and swaps at its end. The canvas's Yjs subscription still applies every
   change to the slide on stage; the scene graph records which slide and
   which deck-store version it holds, so the removal emitted for a slide
   already swapped out, and the first emission of a slide swapped in at its
   current version, do nothing.
3. **Ready means ready.** The presentation shows its first slide after the
   deck's inputs are loaded, every picture is fetched, every video is
   buffered on its first frame, the slides are prepared and the presenter
   view's pictures are rendered. No timer cuts this short; the presenter can
   skip it.
4. **The ResourceManager budgets what stays resident.** Prepared scenes are
   admitted against a GPU budget (1 GiB by default, counted over the union of
   their texture sources); the slide shown, its neighbours and the slides it
   links to are resident whatever the budget says; lower priorities make room
   for higher ones; a big deck keeps a window around the presenter's position
   and prepares what enters it in idle time, never during a transition or a
   build. Pixi's garbage collector is off on the present canvas (`gcActive:
false`): residency is decided here, not by a timer.
5. **Builds are compiled before the slide is shown**, on its prepared
   containers, so their first state is on the slide from its first frame,
   transition included; they play on arrival as before.
6. **Videos are pooled.** One element per video object, buffered with
   `preload="auto"` until it can play through, seeked to its first frame and
   attached to the renderer before the presentation starts; the slide's
   preview plays and rewinds that element. No blob URL: `media-src 'self'`
   (ADR 0007) would refuse it, and the policy is not loosened.

## Consequences

- An advance does no mounting, rasterising, uploading, decoding or fetching
  (budgeted at 0 in `perf/budgets/present.*.json`); its cost is compositing.
- Present mode needs GPU memory for the prepared slides (a 12-slide photo
  deck: ~300 MB of distinct 2560-px photos) and a longer start (the photo
  deck: ~10 s on a MacBook in dev, most of it decoding and uploading).
- A deck bigger than the budget prepares as it goes; a jump outside the
  window waits for its target (the current slide stays until the target is
  whole) instead of showing it half drawn.
- The IndexedDB media copy is gone (it was never read, and the texture
  loader could not use a blob URL under the CSP). The `idb` dependency is
  now unused; dropping it needs a lockfile change.
- A live edit of a prepared slide during a presentation rebuilds that scene
  in idle time; an edit of the slide on stage is applied in place, as before.
- The editor's slide switch still mounts (E3); the same cache could serve
  it, as a separate decision.
