# Polish P12c — Handover

**Date:** 2026-04-27
**Branch:** `polish/p12c-procedural-textures` (1 commit ahead of `polish/p12b-idle-render-loop`)
**Depends on:** PR #26 (P12a) and the P12b PR — both must merge first.
**Status:** Implemented, typechecks clean for new code, 6 new
ResourceManager tests pass. Pending in-browser verification.

---

## Scope

Procedural texture leak fix. Pre-P12c, every gradient slider tick on a
shape (or background gradient identity change) painted a fresh
`Texture.from(canvas)` and dropped the old one on the floor. Hours of
editing turned into hundreds of MB of unreleased GPU memory.

## What changed

### `ResourceManager.ts`

- Added a second cache (`procedural`) alongside the existing URL
  cache. New API:
  - `acquireProcedural(key, factory) → Texture` — runs `factory` only
    on cache miss, ref-counts on hit.
  - `releaseProcedural(key)` — decrements ref count; entry stays in
    cache for fast re-acquire (LRU is the actual reclaim path).
  - `proceduralTextureCount` — surfaced through the perf HUD.
  - `totalManagedTextureCount` — sum of both caches.
- LRU eviction: `PROCEDURAL_LRU_CAP = 128`. When the cache exceeds the
  cap, evicts the oldest entries with `refCount === 0`. **Never**
  evicts in-use entries — a held key always survives.
- `destroyAll()` clears the procedural cache too.

### `fillStyleToPixi.ts`

- `fillStyleToPixi(...)` now takes an optional `container` parameter.
  When supplied, gradient textures are routed through
  `acquireProcedural(key, factory)`; the container holds the most
  recent procedural key as a Symbol tag so a subsequent call
  automatically releases the previous key when the fill changes.
- `gradientKey()` builds a stable structural hash that captures kind,
  dimensions, stops, angle / center.
- `releaseProceduralFill(container)` — exported for renderer destroy
  hooks to drop the held ref.
- Backward-compatible: when `container` is omitted (or
  ResourceManager isn't installed — tests, headless thumbs), falls
  back to one-shot `Texture.from(canvas)` matching pre-P12c
  behaviour.

### Renderers wired up

- `rectangleRenderer.ts`, `ellipseRenderer.ts`, `polygonRenderer.ts`
  (covers triangle + polygon):
  - Pass `container` to `fillStyleToPixi()` from the draw routine.
  - Call `releaseProceduralFill(node)` in `destroy()` to drop the ref.

### `ArtboardBackground.ts`

- Linear / radial gradient backgrounds acquire from the procedural
  cache via key `bg:${signature}`. Falls back to `Texture.from(canvas)`
  if ResourceManager isn't installed (headless thumbnail Pixi).
- `clearContainer()` now releases the previously held procedural key
  before destroying the Sprite.
- Sprites are destroyed without `texture: true`, so the texture stays
  owned by ResourceManager.

### `PerfHud.tsx`

- New "procedural" row showing the count of cached procedural
  textures. Watch this go up while scrubbing, settle at `≤128`.

### Tests

- 6 new `ResourceManager.test.ts` cases covering: factory-once-per-key,
  cache-hit on identical keys, refCount=0 stays cached for re-acquire,
  LRU evicts under pressure, refCount>0 entries survive eviction,
  `destroyAll` clears procedural too.

---

## Files touched on this branch

```
apps/web/src/renderer/ResourceManager.ts                acquireProcedural / LRU
apps/web/src/renderer/ResourceManager.test.ts           6 new cases
apps/web/src/renderer/fillStyleToPixi.ts                container-aware acquire/release
apps/web/src/renderer/ArtboardBackground.ts             bg gradient via procedural cache
apps/web/src/renderer/objectRenderers/rectangleRenderer.ts  pass container, release on destroy
apps/web/src/renderer/objectRenderers/ellipseRenderer.ts    pass container, release on destroy
apps/web/src/renderer/objectRenderers/polygonRenderer.ts    pass container, release on destroy
apps/web/src/ui/PerfHud.tsx                             procedural count row
docs/handoff/polish-p12c-handover.md                    NEW
```

---

## Verification

- `pnpm --filter @narrative/web test src/renderer/ResourceManager.test.ts`
  — all 6 new cases green plus the 8 pre-existing.
- Total `apps/web` test count: 251 passing (up from 245), 37 pre-existing
  failures unchanged (rooted in `react-colorful` / `pixi-filters` test
  env issues — track in P12f).
- `pnpm --filter @narrative/web typecheck` — no NEW errors. Same
  pre-existing set documented in the P12 / P12b handovers.

## Smoke checklist for the user

Open the perf HUD and watch the new **procedural** row:

1. **Plain solid fill** — procedural count = 0. Gradients on shapes
   absent from the slide → 0.
2. **Add a rectangle with linear gradient** — procedural count
   becomes 1.
3. **Drag the angle slider** — count climbs up to a few dozen during
   the scrub (each interim angle = unique key → new texture). After
   release, count stabilises; the active angle's texture still has
   refCount=1, the rest sit at refCount=0 in the LRU.
4. **Continue scrubbing** — count rises but caps at 128. Older
   refCount=0 entries evict.
5. **Delete the rectangle** — its current procedural ref drops to 0.
   Count doesn't immediately fall (LRU keeps the entry); a few more
   distinct keys would push it out.
6. **Backgrounds** — same flow with a slide gradient background.
7. **Heap (Chromium)** — should stop the unbounded climb that
   pre-P12c sliders triggered.
8. **Image fill on a shape** — still works, still routed through
   `imageFillLoader` (URL-based RM cache, untouched here).

---

## Known follow-ups (move to later sub-phases)

- **`filterEffects.ts` instance churn** — `BlurFilter` /
  `DropShadowFilter` are still re-allocated on every change inside the
  bind-group-bug workaround. Now that the texture lifecycle is sane,
  P12c could be extended to memo filter instances per slot. Deferred
  to its own commit since the workaround is reactive to a Pixi bug,
  not a leak we own.
- **`imageRenderer.ts` thumbnailMount** — uses a separate Pixi
  instance with its own RM-less `Texture.from(img)`. Listed as a
  follow-up in the original P12 plan; not migrated here because the
  thumbnail Pixi has a different lifetime than the editor instance.
- Pre-existing typecheck + test debt unchanged. P12f.

---

## Resume instructions

1. Wait for PR #26 (P12a) and the P12b PR to merge.
2. Rebase this branch onto `main`:
   ```bash
   git checkout polish/p12c-procedural-textures
   git fetch origin
   git rebase origin/main
   ```
3. Run the smoke checklist above with the perf HUD.
4. Open PR — title `polish(p12c): procedural texture cache + LRU`.
5. After merge, start P12d on `polish/p12d-cold-start-latency`.

## P12d preview

**Cold-start latency.** From the P12 handover:

- Move `app.init()` outside the Hocuspocus `onSynced` gate; buffer
  changes via the existing `pendingChangesRef` until ready.
- `Promise.all` the media URL resolves in `useMediaPreload`.
- Defer the offscreen thumbnail Pixi `Application` until after the
  main canvas first frame.
- Stretch: optimistic local-first paint from IndexedDB if the doc is
  cached.
