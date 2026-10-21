# ADR 0019 — The render page switches decks in place only behind a page-wide session reset

**Status**: Proposed (2026-10-20, renderer agent). Not built. Needs the
tech-lead, `state-sync` (who owns half the state involved) and
`security-reviewer` before any code.
**Scope**: `apps/web/src/pages/DeckRender.tsx` and `components/DeckShell.tsx`
(the render page), module-level state in `apps/web/src/renderer/`,
`state/` and `lib/`; `apps/render-worker/src/render.ts` (`recyclePage`) and
`warmPages.ts`.
**Related**: [`plans/performance.md`](../plans/performance.md) → G, R1 (the
deck-agnostic pool, 2026-10-18; "Open: the slim render entry / an in-place
deck switch"); [`plans/a3-render-worker.md`](../plans/a3-render-worker.md) →
Isolation; ADR 0007 (CSP), ADR 0017 (local document copies).

## Context

Since R1 the render worker keeps idle render pages and recycles one for a
job of another session (`recyclePage`): the old tab goes to `about:blank`,
the origin's storage, the cookies and the HTTP cache are cleared, and the
new deck loads in a new tab of the same browser context, which keeps the
renderer process and its compiled shaders. Measured on 2026-10-18 under VM
103's limits: 1.17 s (new page) → 0.93 s (recycled) to "app ready". What
the recycled page still pays is the whole app: the HTML and the bundle
fetched again (the HTTP cache was cleared, and with it V8's code cache),
parsed and evaluated, React mounted, Pixi started (a WebGL context under
SwiftShader), then the deck's own inputs (Hocuspocus sync, the deck role,
fonts, tokens).

An in-place switch would keep the evaluated app and the Pixi application
and only change the deck: a client-side navigation to the new deck's render
URL (`history.replaceState`, so no session-history entry keeps the old
token), DeckShell unmounting the old deck's providers (its WebSocket
closes) and mounting the new one's.

The pool hands a spare page to **another session** — usually another
person. A recycled page is safe today because each deck gets a fresh
document: nothing in the JS heap survives. An in-place switch keeps the
heap, and the heap holds the previous deck in module-level state owned by
several areas (surveyed 2026-10-20, not exhaustive):

- media: the signed-URL cache of `renderer/imageUrl.ts` (keyed by asset
  id — a deck B that names deck A's asset id would get A's signed URL
  without the server's access check: a cross-tenant read), video info
  (`renderer/videoInfo.ts`), `ResourceManager` textures and Pixi's
  `Assets` cache, `thumbnailImages.ts` blobs;
- fonts: A's folder fonts installed in `document.fonts` (B's text in a
  family of the same name would draw in A's face), `renderer/fontChanges.ts`
  faces, `lib/fontLineMetrics.ts`, the `textRenderer` metrics cache,
  `htmlTextBoundsMemo`, `renderWork`'s failed-face list;
- documents: `state/componentDocCache.ts` (Y.Docs with open connections),
  `useFolderFonts` / `useDeckFonts` / `useFolderComponents` caches,
  `deckThumbnailCache`, the colour resolver, `slideNumberContext`,
  `pixelDensityContext`, the clipboards;
- the page: `performance` resource entries (URLs with A's token),
  `sessionStorage`, `window.name`, timers and listeners A's providers left.

Missing one of these is either a leak between tenants or a slide drawn
wrong, and nothing would report it: the failure mode is silent, like the
CSP failures of ADR 0007.

## Decision (proposed)

1. **A page-wide session scope.** One module (`state/renderSession.ts`)
   with `onSessionReset(fn)`; every module above registers its reset
   next to its state, and the render page's `__narrativeRenderSwitch(url)`
   unmounts the deck, awaits every reset, then navigates. Owners keep
   their own state; the registry only makes "forget the deck" one call.
2. **A guard that fails the build** when module state appears without a
   reset: a unit test that walks `apps/web/src/{renderer,state,lib}` for
   top-level `new Map/Set`, `let` and singletons and requires each to be
   registered or listed with a reason (as `actions/catalog.test.ts` does
   for actions).
3. **The isolation test extended** (`render.browser.test.ts`, "a recycled
   page"): after an in-place switch, deck B's page finds nothing of deck
   A — the existing storage/history/WebSocket checks, plus a B naming A's
   asset id gets no picture, a B using A's font family name draws its own
   face, `performance.getEntries()` holds none of A's URLs.
4. **Same session first.** The switch is used across sessions only once 1–3
   are in; a session's own next deck (same person, another deck) can use it
   earlier, since nothing crosses a tenant there.
5. Measure before building: the production bundle under VM 103's limits,
   "app ready" of a recycled page split into fetch / evaluate / React /
   Pixi init / deck inputs. If the part an in-place switch saves is small
   next to the deck inputs (which it does not save), the "slim render
   entry" — a separate entry for the render page that imports neither
   the router, the auth layer nor the editor's chunks, so that a fresh page
   evaluates less — gets the same gain with the isolation of a fresh
   document, and this ADR is withdrawn.

## Consequences

- Without 1–3, the in-place switch is not built: the risk is a silent
  cross-tenant leak, against a measured saving of at most ~0.9 s of a cold
  job (3–6 s).
- With them, every new module-level cache in the web app needs a reset or
  a reason — a cost for every area, enforced by the guard.
- The render page's slide switch itself (the same deck) is unaffected: it
  was cut on 2026-10-20 without touching isolation (performance.md, R1).
