# M13 — Magic Move (Keynote-style slide transitions)

**Status:** Core complete + wired into present mode + outgoing-flash bug
fixed. Not yet polished.

**Date closed:** 2026-04-22 (session one)

**Commits** (on `main`):

| SHA     | What                                                                     |
| ------- | ------------------------------------------------------------------------ |
| aeb580d | `magic` transition kind + factory + 7 unit tests                         |
| ded4ed1 | Wire `playTransition` into PresentLayout + SceneGraph.adoptSlideRoot     |
| ea16166 | Add "Magic Move" to Inspector dropdown + duplicateSlide preserves ids    |
| bb44b4e | Outgoing-copy no longer flashes to (0,0) on tween start (proxy seed fix) |

## What's done

- **`SlideTransitionKind` union** extended with `'magic'`
  (`packages/shared/src/deck.ts`). `DEFAULT_TRANSITION` stays `'none'`.
- **`magicTransition` factory**
  (`packages/animation/src/transitions/magic.ts`) — manual flip pattern
  (Spike A: GSAP Flip plugin is DOM-only, so we seed per-object
  Containers at the outgoing snapshot and tween proxies back to the
  incoming's mounted target values). Rotation lerped via
  `timeline.progress()`. Root-level crossfade handles unmatched objects.
- **`SlideTransitionTargets.magicPairs?: MagicMoveObjectPair[]`**
  (`types.ts`) — optional per-object pairing channel the runtime fills
  when the transition kind is `'magic'`.
- **Present-mode wiring** — `apps/web/src/renderer/playTransition.ts` +
  `PresentLayout.navigateToSlide`. All kinds (fade/push/cube/magic) now
  actually play in present mode, resolving M9's
  `TODO(M9-transitions)`.
- **`SceneGraph.adoptSlideRoot(nextRoot, nextNodes)`** — swap the active
  root without re-mounting, so the transition end doesn't flash.
  `getApp()`, `getRoot()`, `getContainer(id)` accessors added.
- **Inspector dropdown** — Magic Move is selectable from the editor UI
  (`apps/web/src/ui/Inspector.tsx`).
- **`duplicateSlide` preserves object ids** — natural Magic Move
  authoring: duplicate slide → tweak positions → set transition to
  Magic Move → present. Also fixes animation `objectId` orphaning that
  the old TODO acknowledged.
- **Tests**: 8/8 magic factory, 6/6 playTransition wiring, 5/5
  slideHelpers, 238/238 renderer unit suite, 60/60 animation transition
  suite. Existing image-upload Playwright spec unchanged / green.

## What's still rough / follow-ups for the Polish Track

1. **No end-to-end Playwright test for transitions.** Earlier attempt
   (`e2e/slide-transition.spec.ts`) got stuck on fragile editor-UI
   locators. The clean fix is a dev-only `window.__narrative_test_api`
   hook that seeds a 2-slide fixture with a matched-id pair directly
   against the live Y.Doc, then drives present-mode navigation. See
   the Explore-agent notes in the M13 session transcript for the shape.

2. **`runSlideTransition` timing of `timeline.play()`**. Between
   `compileSlideTransition()` returning and `play()` actually ticking,
   there's one browser frame in which the seeded state is painted. If
   that's ever a visible pop (user hasn't reported it now, but watch
   on slow devices), wrap compile+play in a single animation-frame
   boundary — e.g. `requestAnimationFrame(() => timeline.play())`.

3. **`makeContainerProxy` is "apply-all"**. The outgoing-copy bug in
   `bb44b4e` was caused by `applyProxy()` writing all five proxy fields
   every frame. We patched the consumer. Better long-term: evolve
   `makeContainerProxy` to track which fields the caller opted into and
   only write those. Affects fade/push/cube/magic. Non-urgent — we
   verified none of the other transitions rely on partial application.

4. **Magic Move with nested rotation semantics** — for now rotation is
   lerped in the `onUpdate` callback via `timeline.progress()`. If the
   GSAP version is swapped to one that pauses-then-resumes, progress()
   may not be monotone and we'd get a jitter. Fine for current GSAP
   version.

5. **Inspector UX polish for Magic Move** — no hint that "this slide
   should have shared-id objects with the previous slide for the
   transition to morph". A helper text or visual indicator in the
   Transition section would reduce first-use confusion.

6. **Abort semantics** — `playTransition` exposes `abort()` but
   `PresentLayout.navigateToSlide` never calls it. If the user
   spam-presses ArrowRight the ref-gate blocks new transitions, which
   is correct but unfriendly (inputs are silently dropped). A
   "cancel-and-snap-to-target" path would feel better; deferred.

## Developer quick-test

Manual smoke test:

1. `http://localhost:5173` → new deck.
2. Add a rectangle on slide 1.
3. Right-click slide 1 thumbnail in the sidebar → **Duplicate** (or
   whatever the menu item is). Slide 2 now has the same rectangle at
   the same position, **with the same object id**.
4. On slide 2, move/resize the rectangle.
5. Inspector → Transition → Kind = **Magic Move**, Duration = 600.
6. Press **Present** (or route to `/deck/:id/present`). ArrowRight.
7. The rectangle should morph smoothly from slide 1's transform to
   slide 2's transform. No top-left flash. No snap at end.

If it still flashes: check the browser console for `PixiJS Warning`
traces and re-open this handoff under "What's still rough".
