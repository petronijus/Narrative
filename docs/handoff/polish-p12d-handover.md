# Polish P12d — Handover

**Date:** 2026-04-27
**Branch:** `polish/p12d-cold-start` (1 commit ahead of `main`)
**Status:** Implemented, typechecks clean for new code, useMediaPreload
6/6 passing.

---

## Scope

User-reported cold-start latency (~6 s first slide load). Three serial
bottlenecks identified by the P12 audit:

1. `SlideDocProvider` gated EVERYTHING behind Hocuspocus `onSynced` —
   WS handshake → server hydrate → Canvas mount → Pixi init →
   reconcile ran sequentially.
2. `useMediaPreload` resolved each media URL with serial `await`.
3. The offscreen thumbnail Pixi `Application` initialised in parallel
   with the main canvas, contending for the GPU driver during the
   moment that matters most.

## What changed

### `state/SlideDocProvider.tsx`

- The `value` (deckCtx + undoManager + awareness) is now set
  **immediately after creating the HocuspocusProvider**, not inside
  `onSynced`. Children mount and Pixi `app.init()` runs in parallel
  with the WS sync.
- `hydrateSlideDoc(doc)` still runs in `onSynced` only — the comment
  about "extra empty slide on every reload" still applies, so the
  pre-sync handshake intentionally skips hydration. The deckCtx
  wraps the stable Y.Doc reference, so when the server's slides
  arrive, Y.Array `observeDeep` callbacks fire and the reconciler
  updates without re-setting the context.
- The `Connecting…` placeholder no longer blocks Canvas mount. The
  WS-status indicator the user already has surfaces "still syncing"
  through `wsStatus` for any chrome that wants it.

### `state/useMediaPreload.ts`

- The serial `await api.getMediaUrl(...)` / `api.getVideoInfo(...)`
  loop became a parallel `Promise.all` over per-asset resolvers.
- Each resolver returns `PreloadItem[]` (image fills add 1 entry;
  video info may add 0–2 entries). `flat()` produces the final
  list. Errors swallowed per resolver, matching the prior behaviour.

### `state/useSlideThumbnails.ts`

- The thumbnail Pixi `Application` mount is now deferred via
  `requestIdleCallback(start, { timeout: 1500 })` — falls back to a
  250 ms `setTimeout` on browsers without it. Cancellation is wired
  through the existing `cancelled` flag.
- Net effect: the editor's main Pixi `app.init()` runs first,
  paints, and only then does the thumbnail renderer's parallel
  application boot.

---

## Files touched on this branch

```
apps/web/src/state/SlideDocProvider.tsx       early deckCtx, hydrate-in-onSynced
apps/web/src/state/useMediaPreload.ts          Promise.all media URL resolves
apps/web/src/state/useSlideThumbnails.ts       defer thumbnail Pixi via rIC
docs/handoff/polish-p12d-handover.md           NEW
```

---

## Verification

- `pnpm --filter @narrative/web typecheck` — no new errors.
  Pre-existing set unchanged.
- `pnpm --filter @narrative/web test src/state/useMediaPreload` — 6/6
  passing. Promise.all preserves the existing semantics covered by
  those tests.
- Browser smoke pending — open editor, watch console / network /
  perf HUD; first paint should be perceptibly faster than pre-P12d.

## Smoke checklist for the user

1. **Cold load** — open the editor on a moderate deck (5+ slides).
   First Pixi paint should land before the WS handshake completes
   (visible if you throttle Network in DevTools); pre-P12d the
   editor stayed blank until sync was done.
2. **Empty doc** — create a brand-new deck; verify exactly one
   default slide is created (no doubles from the pre-sync hydrate
   bug).
3. **Reload existing deck** — verify slide count matches what the
   server has; no extra empty slides.
4. **Many media assets** — open a deck with 10+ images / videos.
   Network panel should show URL resolves firing concurrently
   instead of in a serial chain.
5. **Thumbnails** — they should still appear, just a beat after the
   main canvas. Verify side panel previews populate within ~1s of
   the editor becoming interactive.
6. **Undo/redo** — first edit after cold start should be undoable
   (exercise the early-mounted UndoManager).

---

## Known follow-ups

- Optimistic local-first paint from IndexedDB — listed in the P12
  plan as a stretch goal. Skipped here since the parallel-init win
  alone should cut the 6 s number significantly. Revisit if user
  measurement shows we're still bottlenecked on the WS round-trip.
- Pre-existing typecheck + test debt unchanged. P12f.

---

## Resume instructions

1. Open PR — `polish(p12d): cold-start latency`.
2. After merge, start P12f on `polish/p12f-typecheck-debt`:
   - `EditorLayout.tsx` / `PresentLayout.tsx` `CanvasInstance | null`
     prop signature.
     - `dropdown-menu.tsx` Radix `CheckedState | undefined`.
   - `playTransition.ts` `MagicMoveObjectPair` re-export from
     `@narrative/animation`.
   - `slideHelpers.test.ts` `VideoObject` cast.
   - `react-colorful` test env install.
   - `pixi-filters` ambient types.
   - `y-protocols/awareness` type re-export from `slide-model`.
3. After P12f, declare P12 closed and move on to **M20** (templates +
   themes / slide masters).
