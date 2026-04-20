# M9 Phase 2 (Part 3) — Editor UI: Slide Sidebar + Navigation

**Agent**: editor-ui  
**Date**: 2026-04-20  
**Status**: Complete — all 360 tests passing, TypeScript strict clean

---

## What was built

### 1. `SlidesPanel` — `apps/web/src/ui/SlidesPanel.tsx`

Full left sidebar slide panel replacing the "No slides yet" placeholder in `EditorLayout`.

Features:

- Ordered list of slide thumbnails (16:9, 200px wide)
- Thumbnail images from `useSlideThumbnails()` (renderer agent's hook — now wired)
- Placeholder color block when thumbnail not yet rendered
- 1-based slide numbering label (bottom-left of each thumbnail)
- Active-slide highlight: 2px blue ring (`ring-2 ring-blue-500`)
- Click thumbnail → `setActiveSlideId(id)` + `clearSelection()`
- "+" button → `addSlide(deckCtx)` → auto-selects new slide
- Three-dot menu per slide item (see `SlideItemMenu`)
- Drag-to-reorder via pointer events (no library) → `moveSlide(deckCtx, id, targetIndex)`
- Keyboard nav: Up/Down in `listbox`, Enter activates
- `role="listbox"` / `role="option"` ARIA structure; menu button `aria-haspopup="menu"` + `aria-expanded`

### 2. `SlideItemMenu` — `apps/web/src/ui/SlideItemMenu.tsx`

Three-dot context popover per slide. Items:

- **Duplicate** → `duplicateSlide(deckCtx, slideId, insertAtIndex)` from `slideHelpers.ts`
- **Transition settings** → activates that slide so Inspector shows its transition
- **Delete** → `removeSlide(deckCtx, slideId)` (no confirm dialog in M9; undo covers it)

Keyboard: arrow keys within menu, Escape closes and returns focus to trigger button.

### 3. `slideHelpers.ts` — `apps/web/src/ui/slideHelpers.ts`

Client-side `duplicateSlide()` helper:

- Reads source slide via `listSlides()`
- Creates new slide via `addSlide()` at insertion index
- Copies objects with fresh `nanoid()` IDs via `addObject()`
- Copies animations via `addAnimation()` (objectId linkage NOT remapped — TODO M22)

**TODO (M22 cleanup)**: move `duplicateSlide` into `@narrative/slide-model` as a first-class mutation with full ID remapping.

### 4. Inspector slide mode — `apps/web/src/ui/Inspector.tsx`

When no object is selected (`selectedId === null`), Inspector now shows `SlideInspector` instead of "No selection" placeholder.

`SlideInspector` sections:

- Slide ID (truncated, for reference)
- **Transition** section:
  - Kind dropdown (none / fade / push / cube)
  - Duration input (ms) — disabled when kind === 'none'
  - Direction dropdown — shown only when kind === 'push'

All edits go through `updateSlideTransition(deckCtx, activeSlideId, patch)`.

### 5. Present mode navigation — `apps/web/src/components/PresentLayout.tsx`

- ArrowRight / Space / PageDown → next slide (boundary: no-op at last)
- ArrowLeft / PageUp → previous slide (boundary: no-op at first)
- Escape → back to editor (unchanged)
- F / F11 → fullscreen toggle (unchanged)
- Slide counter: real `X / N` from `useSlides()` + `activeSlideId`

**Transition playback** (instant swap): calls `setActiveSlideId(nextId)` immediately. `runSlideTransition` from `@narrative/animation` is not yet available as a public API — marked as TODO in `PresentLayout.tsx`.

### 6. `EditorLayout` wiring — `apps/web/src/components/EditorLayout.tsx`

Left `<aside>` width bumped from `w-48` (192px) to `w-60` (240px). Now mounts `<SlidesPanel />`.

---

## Files added

- `apps/web/src/ui/SlidesPanel.tsx`
- `apps/web/src/ui/SlideItemMenu.tsx`
- `apps/web/src/ui/slideHelpers.ts`
- `apps/web/src/ui/SlidesPanel.test.tsx`
- `docs/handoff/M9-phase2-editor-ui-slides.md` (this file)

## Files changed

- `apps/web/src/ui/Inspector.tsx` — added `SlideInspector`, imported `useActiveSlide`, `useSlides`, `useSlideDoc`, `updateSlideTransition`
- `apps/web/src/components/PresentLayout.tsx` — slide navigation, real counter, `useSlides` + `useActiveSlide`
- `apps/web/src/components/EditorLayout.tsx` — replaced sidebar placeholder with `<SlidesPanel />`
- `apps/web/src/components/PresentLayout.test.tsx` — replaced placeholder-behavior tests with real navigation tests
- `apps/web/src/ui/Inspector.test.tsx` — added `SlideInspector` tests (transition kind/duration/direction)
- `apps/web/src/pages/DeckPresent.test.tsx` — added `ActiveSlideContext.Provider` + `useSlides` mock

---

## Deferred (TODOs in code)

| Item                                      | Location                    | Target                     |
| ----------------------------------------- | --------------------------- | -------------------------- |
| `runSlideTransition` playback             | `PresentLayout.tsx`         | M14 or dedicated follow-up |
| `duplicateSlide` → slide-model            | `slideHelpers.ts` + comment | M22 cleanup                |
| Animation objectId remapping in duplicate | `slideHelpers.ts`           | M22 cleanup                |
| Awareness `activeSlideId` broadcast       | —                           | M29                        |

---

## Tests added / changed

- `SlidesPanel.test.tsx`: 15 tests — rendering N items, active highlight, click activation, add/delete/duplicate, keyboard nav, drag-to-reorder mock
- `Inspector.test.tsx`: +5 tests — SlideInspector visibility, transition kind/duration/direction
- `PresentLayout.test.tsx`: replaced 5 console.debug-placeholder tests with 7 real navigation tests + 3 counter tests (25 tests total, same file)
- `DeckPresent.test.tsx`: fixed `ActiveSlideContext` provider wiring (4 tests, all passing)
- Total: 360 tests, all passing
