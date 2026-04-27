# Polish P12b — Handover

**Date:** 2026-04-27
**Branch:** `polish/p12b-idle-render-loop` (1 commit ahead of `polish/p12-layer-reorder-fix`)
**Depends on:** PR #26 (`polish/p12-layer-reorder-fix`) — must merge first.
**Status:** Implemented, typechecks clean for new code, unit tests for
slide-model + animation green. Pending in-browser verification by user.

---

## What changed

The user's complaint entering P12 was that the GPU sat at high usage with
nothing happening on the slide. Diagnosis (from the P12 handover) pointed
at Pixi's auto-render loop running at 60 Hz forever. P12b flips that to
on-demand rendering.

### New module — `apps/web/src/renderer/RenderScheduler.ts`

- `markDirty()` — schedules a single rAF that calls
  `app.renderer.render(app.stage)` and clears the dirty flag. Multiple
  calls in the same frame coalesce into one render.
- `renderNow()` — synchronous render, used for the first paint after
  init.
- `onAfterRender(fn)` — subscription mechanism that runs `fn` after every
  scheduler-driven render. Replaces the per-tick `app.ticker.add(syncFn)`
  hook OverlayCompositor used to install (the ticker is OFF in idle mode
  so it would never fire).
- Default singleton via `setDefaultRenderScheduler` /
  `getDefaultRenderScheduler` / `markRenderDirty()` for deep async paths
  (image / video poster loaders) that can't easily receive a parameter.

### `Canvas.tsx`

- `app.init({ ..., autoStart: false })` — disables Pixi's built-in 60 Hz
  render loop.
- Builds the scheduler after `init`, sets it as the default singleton,
  injects into SceneGraph and OverlayCompositor.
- After flushing pending changes, calls `scheduler.renderNow()` so the
  first frame paints synchronously.
- On unmount, `scheduler.destroy()` cancels any pending rAF and clears
  the singleton so a queued render can't fire against a torn-down GL
  context.

### `SceneGraph.ts`

- Optional `RenderScheduler` reference, set via `setRenderScheduler()`.
- `markDirty()` poke after every Pixi mutation:
  `addObject`, `removeObject`, `updateObject`, `applyChanges` (only when
  any of `removed/added/updated` is non-empty), `adoptSlideRoot`,
  `setSlideOrigin`, `setSlideBounds`, `ensureBackgroundContainer` (when
  the bg container is mounted/remounted).

### `OverlayCompositor.ts`

- Dropped `app.ticker.add(syncFn)`.
- Subscribes to `scheduler.onAfterRender(syncFn)` instead — overlay
  positions resync once per painted frame, not once per rAF.
- `registerOverlay` and `update` now call `markDirty()` so a frame is
  queued when a new overlay lands or its target moves (peer cursors, the
  primary `update` consumer).
- Window resize handler also pokes `markDirty()` since a resize doesn't
  trigger a render on its own.

### `ArtboardBackground.ts`

- `mountImageBackground` async path calls `markRenderDirty()` after the
  Sprite lands — without it, the resolved image would be invisible until
  the next unrelated mutation.

### `imageRenderer.ts` / `videoRenderer.ts`

- `loadAsync` / `applyVideoInfoResult` / `loadPosterTexture` async paths
  call `markRenderDirty()` after the sprite lands. Same reason as above —
  Pixi auto-render is OFF, so the async branch must poke explicitly.

### Animation runtime — `packages/animation`

- `AnimationContext.onTick?` (new optional field). When set,
  `runtime.ts` wires it via `tl.eventCallback('onUpdate', onTick)` —
  fires once per GSAP tick during playback.
- Consumers (`AnimationTimeline.tsx`, `PresentLayout.tsx`,
  `playTransition.ts`) pass `() => scheduler.markDirty()` so GSAP-driven
  property writes actually reach the screen under autoStart:false.

---

## Files touched on this branch

```
apps/web/src/renderer/RenderScheduler.ts                NEW
apps/web/src/renderer/Canvas.tsx                        autoStart:false + scheduler wiring
apps/web/src/renderer/SceneGraph.ts                     markDirty in mutations
apps/web/src/renderer/overlay/OverlayCompositor.ts      ticker → onAfterRender
apps/web/src/renderer/overlay/OverlayCompositor.test.ts mock app updated for new API
apps/web/src/renderer/ArtboardBackground.ts             markRenderDirty after async paint
apps/web/src/renderer/objectRenderers/imageRenderer.ts  markRenderDirty after async load
apps/web/src/renderer/objectRenderers/videoRenderer.ts  markRenderDirty after poll/poster
apps/web/src/renderer/playTransition.ts                 onUpdate hook for transitions
apps/web/src/components/PresentLayout.tsx               onTick → scheduler
apps/web/src/ui/AnimationTimeline.tsx                   onTick → scheduler
packages/animation/src/types.ts                         AnimationContext.onTick
packages/animation/src/runtime.ts                       onUpdate eventCallback
```

---

## Verification

- `pnpm --filter @narrative/animation test` — 130/130 passing.
- `pnpm --filter @narrative/slide-model test` — 185/185 passing.
- `pnpm --filter @narrative/web typecheck` — no NEW errors. Same
  pre-existing errors documented in the P12 handover (pixi-filters,
  react-colorful, MagicMoveObjectPair, exactOptionalPropertyTypes
  violations) remain.
- OverlayCompositor unit tests — all pass except the pre-existing DPR
  test (asserts `200/2 = 100`, but the `/DPR` divide was removed in
  P11r; test never updated).
- Browser smoke — **not yet run by the assistant**. User to verify with
  perf HUD: editor open with no animation should drop FPS readout to
  ~0 (idle), interaction → 60.

## Smoke checklist for the user

Open the perf HUD (green Activity icon, bottom-left) and watch FPS:

1. **Editor idle** — load a deck, click an empty area, do nothing. FPS
   should drop to 0 (the readout updates infrequently when nothing
   renders; that's expected). If FPS stays at ~60, idle render loop is
   not properly off.
2. **Drag an object** — FPS climbs to 60 during the drag, drops back to
   0 after release.
3. **Slider scrub** in Inspector — fill colour, opacity, blur — FPS
   spikes during scrub, idle after.
4. **Background change** — color → linear gradient → image. The image
   variant should appear once the imgproxy URL resolves (proves the
   async markRenderDirty() works).
5. **Present mode** — slide transitions render smoothly; per-step
   animations play at 60 FPS; idle at end of timeline → FPS to 0.
6. **Peer cursors** — open a second tab as another user and move the
   mouse; the cursor should track without "stuck at last position"
   stutter.
7. **Image / video paste** — async texture loads should display once
   resolved (not invisible until another mutation).
8. **Layer reorder** — still works (this is the P12a fix; verify it
   didn't regress).

---

## Known follow-ups (move to P12c+)

- `OverlayCompositor.test.ts` DPR=2 test still fails — pre-existing,
  unrelated to this branch.
- Pre-existing typecheck errors in `EditorLayout.tsx`,
  `PresentLayout.tsx`, `dropdown-menu.tsx`, `playTransition.ts`,
  `slideHelpers.test.ts`, `ColorInput.tsx`, `filterEffects.ts`,
  `context-menu.tsx`. Track in P12f.
- Many vitest failures unrelated to my changes (37 vs 42 baseline) —
  most rooted in `react-colorful` / `pixi-filters` not being installed
  in test env. Track in P12f.
- `imageRenderer.ts` `thumbnailMount` async branch (line ~741) doesn't
  call `markRenderDirty` — but it runs on the offscreen thumbnail
  Pixi instance, which has its own (already opt-in) render loop. Verify
  this assumption holds when wiring P12c.

---

## Resume instructions

1. Wait for PR #26 (`polish/p12-layer-reorder-fix`) to merge.
2. Rebase this branch onto `main`:
   ```bash
   git checkout polish/p12b-idle-render-loop
   git fetch origin
   git rebase origin/main
   ```
3. Run user-facing smoke checklist above with the perf HUD.
4. Open PR — title `polish(p12b): autoStart:false + RenderScheduler`.
5. After merge, start P12c on `polish/p12c-procedural-textures`.

## P12c — next sub-phase preview

**Procedural texture lifecycle.** From the P12 handover:

- Extend `ResourceManager` with `acquireProceduralTexture(key, factory)
→ Texture` + ref-counted `releaseProceduralTexture(key)`.
- Migrate the gradient + image-fill + filter paths flagged in the audit:
  - `apps/web/src/renderer/fillStyleToPixi.ts` (gradients)
  - `apps/web/src/renderer/ArtboardBackground.ts` (bg gradient + image)
  - `apps/web/src/renderer/imageRenderer.ts` thumbnailMount
  - `apps/web/src/renderer/filterEffects.ts` (filter instance churn)
- Add LRU cap (~128 textures) + perf-HUD-visible counter.
- Exit criteria: 10-min slider scrub does not grow texture count beyond
  ~2× visible filled shapes; FPS stays ≥ 55 during scrub.
