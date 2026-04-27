# Polish P12 — Handover

**Date:** 2026-04-27
**Branch:** `polish/p12-layer-reorder-fix` (1 commit ahead of `main`)
**Last commit:** `3a7b5e9 fix(p12): layer reorder + hit-test z-order + drop indicator + perf HUD`
**Status:** P12a + reorder follow-up bugs DONE, user-tested, committed but not yet merged.

---

## Where we are in the polish phase

Polish phases P1–P11 are merged. P12 (Performance pass) is the LAST
polish phase before resuming the numbered milestones (M20 templates/
themes, M21 comments, M22 version history, then M16–M18 AI work).

P12 was opened in this session. The first sub-branch
`polish/p12-layer-reorder-fix` carries:

1. **Layer reorder visual fix** — `slideObserve.ts` flush() preserved
   the netZero ids in `currentSnapshot` so the rebuilt snapshot now
   contains the moved object. SceneGraph's `setChildIndex` loop
   actually fires. Send-to-back works without a refresh.
2. **Hit-test z-order fix** — `SceneGraph.hitTest` now walks
   `root.children` in reverse (Pixi visual order, the source of truth)
   instead of `nodes` Map insertion order. Added `containerToId`
   reverse Map kept in sync at add / remove / `adoptSlideRoot` /
   same-instance reset.
3. **LayersPanel drop indicator** — split each row into top / bottom
   halves; cursor in top half = `before` (indicator on top edge,
   drop above target), cursor in bottom half = `after` (indicator on
   bottom edge, drop below target). Dropping below the last row now
   correctly sends to the back.
4. **Perf HUD scaffold (P12a)** — `PerfHudProvider`, `PerfHudToggle`
   button next to `ThemeToggle` in bottom-left, `PerfHud` overlay top
   right. Reads from `window.__narrative_perf = { app, resourceManager }`
   exposed by `Canvas.tsx`. Shows FPS / frame ms / container count /
   ResourceManager texture count / JS heap. Toggle persists in
   localStorage.

User confirmed all four fixes work in the browser.

---

## Files touched on this branch

```
apps/web/src/App.tsx                            (PerfHudProvider + chrome)
apps/web/src/renderer/Canvas.tsx                (window.__narrative_perf)
apps/web/src/renderer/SceneGraph.ts             (containerToId, hitTest)
apps/web/src/state/PerfHudContext.tsx           NEW
apps/web/src/ui/Inspector.tsx                   (LayersPanel drop position)
apps/web/src/ui/PerfHud.tsx                     NEW
apps/web/src/ui/PerfHudToggle.tsx               NEW
packages/slide-model/src/slideObserve.ts        (netZero snapshot fix)
packages/slide-model/src/slides.observe.test.ts (regression test)
```

All 184 slide-model unit tests pass. All 22 SceneGraph hitTest tests
pass. Pre-existing typecheck errors and one pre-existing
`SceneGraph.applyChanges.test.ts` failure (stub root lacks
`getChildIndex`) are NOT caused by this branch — confirmed via
`git stash`. They belong in audit task #6.

---

## Next action on resume

**Open the PR for `polish/p12-layer-reorder-fix` first**, then start
P12b on a fresh branch `polish/p12b-idle-render-loop`.

```bash
gh pr create --title "polish(p12): layer reorder fixes + perf HUD" --body "..."
git checkout main && git pull
git checkout -b polish/p12b-idle-render-loop
```

---

## P12 remaining sub-phases (in execution order)

### P12b — Idle GPU: autoStart:false + dirty-flag (NEXT)

**Why:** User reports the GPU is pegged at high usage even when
nothing is moving on the slide. Diagnosis (renderer agent, this
session): `Canvas.tsx:138` calls `app.init()` without
`autoStart: false`, so Pixi's rAF loop runs at 60 Hz forever and
re-renders the full scene each frame. OverlayCompositor and the GSAP
global ticker compound it.

**Plan:**

1. `Canvas.tsx` — pass `autoStart: false` to `app.init(...)`. After
   init, do one explicit `app.renderer.render(app.stage)` for the
   first frame.
2. Introduce a tiny `RenderScheduler`:
   - `markDirty()` schedules a single rAF that calls
     `app.renderer.render(app.stage)` and clears the dirty flag.
   - Call `markDirty()` from: `SceneGraph.applyChanges`,
     `SceneGraph.addObject`/`removeObject`/`updateObject`,
     `SceneGraph.adoptSlideRoot`, every `setChildIndex` site,
     `OverlayCompositor.register/unregister/forceSync`,
     `ArtboardBackground.applyBackground`, `applyOutsideFade`,
     `setSlideBounds/setSlideOrigin`.
3. Animation runtime (`createAnimationRuntime`) — when a timeline is
   playing, call `markDirty()` from a GSAP `onUpdate` hook (or simpler:
   `app.ticker.start()` while playing, `stop()` on completion / pause).
4. OverlayCompositor — currently runs `_syncAllOverlays` every Pixi
   ticker tick. Convert to "sync-on-render": hook
   `app.renderer.on('postrender', ...)` so overlay positions update
   only when Pixi actually drew a new frame.
5. Thumbnail Pixi instance (`createThumbnailRenderer`) already opts
   out with `autoStart:false` — no change.
6. Verify with the perf HUD: open editor, no animation → FPS readout
   should drop to ~0 (idle), then jump to 60 during interaction.

**Watch out for:**

- Selection handles, transform overlay, snap guides — all DOM
  overlays — need `markDirty()` if their positions are computed from
  Pixi container bounds.
- Present-mode (`PresentLayout.tsx`) — animation runtime must keep
  the renderer awake while playing. Easiest: `app.ticker.start()` on
  timeline play, `stop()` on pause/end.
- VideoOverlay polls every rAF for the SceneGraph node (60 frames).
  After P12b that polling won't burn GPU, but the design smell stays.
  Listed in audit P3-6 — fix in a later sub-branch.

### P12c — Procedural texture lifecycle

**Scope:** Extend `ResourceManager` with
`acquireProcedural(key, paintFn): Texture` + ref-counted `release`.
Migrate the leaky paths flagged by the audit:

- `apps/web/src/renderer/fillStyleToPixi.ts:91,114` — gradient fills
  (linear + radial). `key = hash(fillStyle, w, h)`.
- `apps/web/src/renderer/ArtboardBackground.ts:199,244` — background
  gradient + image fill canvases.
- `apps/web/src/renderer/imageRenderer.ts:760` and
  `videoRenderer.ts:768` — `thumbnailMount` makes a `Texture.from(img)`
  with no destroy hook.
- `apps/web/src/renderer/filterEffects.ts:97-135` — `BlurFilter` /
  `DropShadowFilter` instances stranded inside rAF closures when the
  container is destroyed before the frame fires.

The MEMORY.md note `procedural-texture-leak.md` covers the gradient
case but the leak surface is wider — see the audit report below.

### P12d — Cold-start latency

**User report:** ~6 s first slide load.

**Diagnosis:** `apps/web/src/state/SlideDocProvider.tsx:126-134` gates
EVERYTHING (Pixi init, reconcile, render) behind the Hocuspocus
`onSynced` event. WS handshake → server hydrate → WebGL context init
→ first reconcile run sequentially, zero parallelism. Plus
`apps/web/src/state/useMediaPreload.ts:91` resolves media URLs
serially.

**Plan:**

1. Move `app.init()` to start eagerly at `Canvas` mount, NOT inside
   `onSynced`. Buffer incoming `ObjectChangeSet` until ready
   (the `pendingChangesRef` pattern is already there).
2. `Promise.all` the media URL resolution loop in `useMediaPreload`.
3. Defer the second offscreen Pixi `Application` (thumbnail renderer)
   until after the main canvas first frame. Currently both init in
   parallel and contend for the GPU driver.
4. Optimistic local-first paint — if IndexedDB has the doc cached,
   render from it before WS sync completes (stretch; may bump to a
   later milestone).

### P12e — DEFERRED

Reorder bug → fixed. No P12e.

### P12f — P0/P1 bug fixes from audit

The code-reviewer agent produced ~70 findings this session. Top P0/P1
items still unaddressed:

- **`imageFillLoader.ts:114-115`** — race in async cache-hit fast
  path: `peekTexture` doesn't acquire a ref, then `acquireTexture`
  awaits and increments — but if the slot changes between check and
  await, the cleanup branch skips `releaseTexture`, leaking one ref
  permanently.
- **`SlideDocProvider.tsx:171`** — `UndoManager` is leaked on every
  Hocuspocus reconnect (`onSynced` re-creates `deckCtx` without
  `undoManager.destroy()`). Each reconnect adds a permanent
  `afterTransaction` observer.
- **`videoRenderer.ts:234-252`** — `setInterval` poll timer leaks
  when `playTransition` is aborted. Aborted incoming roots are
  destroyed via Pixi's generic `Container.destroy`, bypassing the
  registered `videoRenderer.destroy` cleanup.
- **`VideoOverlay.tsx:165-175`** — `window.__narrative_video_currents`
  accumulates entries forever (cleanup forgot to `delete`).
- **`thumbnails.ts:230-238`** — child destroy loop bypasses renderer
  cleanup; image / video child textures never released.
- **`fillStyleToPixi.ts:91,114`** — gradient texture leak (also
  covered by P12c).
- **`SceneGraph.ts:391`** — `adoptSlideRoot` destroys old nodes via
  `removeObject`, then `root.destroy({ children: false })` leaves
  destroyed children in `root.children` momentarily. Brittle but not
  currently exploitable.
- **Pre-existing typecheck errors** in `EditorLayout.tsx`,
  `PresentLayout.tsx`, `dropdown-menu.tsx`, `playTransition.ts`,
  `slideHelpers.test.ts` — all `exactOptionalPropertyTypes` violations
  - a `MagicMoveObjectPair` import that no longer exists in the
    animation package. Need to be cleaned up before any "green CI"
    story.
- **Pre-existing test failure**:
  `SceneGraph.applyChanges.test.ts > "remove proběhne před add"` —
  stub `root` lacks `getChildIndex`. Update the stub.

Full audit report (~70 items, P0/P1/P2/P3) was generated by the
code-reviewer agent in this session — re-run the same agent on resume
if the report context was lost; the file paths are stable.

---

## Useful entry points on resume

**Audit hot files:**

```
apps/web/src/renderer/Canvas.tsx                    # idle loop, cold start
apps/web/src/renderer/SceneGraph.ts                 # reconciler, hit test
apps/web/src/renderer/ResourceManager.ts            # texture lifecycle
apps/web/src/renderer/fillStyleToPixi.ts            # gradient leak
apps/web/src/renderer/ArtboardBackground.ts         # bg texture leak
apps/web/src/renderer/filterEffects.ts              # filter rAF leak
apps/web/src/renderer/overlay/OverlayCompositor.ts  # per-tick DOM sync
apps/web/src/state/SlideDocProvider.tsx             # onSynced gate
apps/web/src/state/useMediaPreload.ts               # serial URL resolves
packages/slide-model/src/slideObserve.ts            # observer flush
packages/animation/src/runtime.ts                   # GSAP ticker
```

**Perf HUD:** Click the green `Activity` icon at bottom-left next to
the theme toggle. Persists in localStorage as `narrative:perf-hud`.
Numbers are read from `window.__narrative_perf = { app, resourceManager }`
populated by `Canvas.tsx` after `app.init()`.

**E2E test for reorder:**
`apps/web/e2e/layer-reorder.spec.ts` — run with
`pnpm --filter @narrative/web test:e2e -- layer-reorder`.

**Polish phase plan:**
`docs/handoff/polish-phase-plan.md` — original 11-phase scope. P12 is
the last of those.

---

## Open questions / decisions

- **PR strategy** — one big P12 PR, or one PR per sub-phase
  (b/c/d/f)? The plan called for one branch per phase. Recommend
  same here: easier to revert if a perf change regresses.
- **GSAP global ticker** — option A: couple it to `app.ticker` (one
  rAF source); option B: leave it running globally and only ensure
  no timelines do work when paused. Option A is cleaner but has more
  blast radius — touches every animation surface. Defer to P12b
  scope decision.
- **MEMORY.md** — the `procedural-texture-leak.md` note can be
  retired once P12c lands. Don't forget to delete the file and
  update the index.

---

## Resume command

```bash
cd ~/Documents/Dev/Narrative
git fetch origin
git checkout polish/p12-layer-reorder-fix
git log -1               # confirm 3a7b5e9 is the tip
gh pr create --base main --title "polish(p12): layer reorder fixes + perf HUD"
# or, if PR already opened from the other PC, just:
gh pr view --web

# After merge:
git checkout main && git pull
git checkout -b polish/p12b-idle-render-loop
# read this file, then start on Canvas.tsx autoStart:false
```
