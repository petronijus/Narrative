# M7 Phase 2 — Editor UI Transform Handles Handoff

## Agent: editor-ui | Date: 2026-04-20

## Deliverables implemented

### Must-have (all delivered)

- [x] Multi-select state (ReadonlySet<string>), shift-click, deselect on empty click
- [x] Drag marquee (rectangle selection on empty area, overlap test)
- [x] Transform handles single-select (8 resize + 1 rotation) — DOM overlay
- [x] Transform handles multi-select (8 resize, no rotation handle, translation only)
- [x] Keyboard: Ctrl/Cmd+D duplicate all selected (offset 20,20), selection updated to new IDs
- [x] Arrow nudge (1px / 10px with Shift), bulkUpdateObjects
- [x] Delete/Backspace: bulk remove all selected
- [x] Replace naïve hit test with SceneGraph.hitTest (rotation-aware)
- [x] Replace naïve selection overlay with rotation-aware SVG polygon outline

### Should-have (all delivered)

- [x] Snap to object edges/centers (6 edge strings each axis, threshold 6px)
- [x] Grid snap fallback (10px default) when no object snap
- [x] SnapGuides visual overlay (1px blue lines)

### Nice-to-have (deferred to M14)

- [ ] Multi-select group resize (only translation in M7)
- [ ] Multi-select rotation handle
- [ ] Keyboard focus ring for transform handles
- [ ] Rotated multi-select bounds

## Files added/changed

### New files

- `apps/web/src/editor/snap.ts` — pure snapping engine (no deps)
- `apps/web/src/editor/snap.test.ts` — 18 math tests
- `apps/web/src/ui/TransformHandles.tsx` — resize/rotate handles + outline
- `apps/web/src/ui/TransformHandles.test.tsx` — 8 tests
- `apps/web/src/ui/SnapGuides.tsx` — snap guide line overlay

### Modified files

- `apps/web/src/state/SelectionContext.tsx` — refactored to multi-select API
- `apps/web/src/state/SelectionContext.test.tsx` — extended (13 tests covering multi-select, toggle, compat)
- `apps/web/src/components/EditorLayout.tsx` — complete rewrite for M7
- `apps/web/src/ui/Inspector.tsx` — multi-select placeholder (size>1 shows message)
- `apps/web/src/ui/Inspector.test.tsx` — added multi-select placeholder test

## API changes

### SelectionContext (backward compat preserved)

```ts
interface SelectionContextValue {
  selectedIds: ReadonlySet<string>
  selectedId: string | null // null if 0 or >1 selected
  isSelected(id: string): boolean
  selectOne(id: string): void
  selectMany(ids: string[]): void
  toggle(id: string): void
  clear(): void
  // Deprecated aliases (M2 compat)
  setSelectedId(id: string): void // → selectOne
  clearSelection(): void // → clear
}
```

### computeSnap (snap.ts)

```ts
computeSnap(
  proposedBounds: BoundsRect,
  otherObjectBounds: OtherObjectBounds[],
  gridSize = 10,
  threshold = 6,
): SnapResult  // { dx, dy, guides: SnapGuide[] }
```

## Architecture notes

- TransformHandles renders as DOM absolute-positioned divs directly in the canvas container
  (not via OverlayCompositor.registerOverlay — compositor is for Pixi-tracked elements,
  handles are purely DOM-based at world coordinates from SceneGraph.getBounds)
- Outline is SVG polygon (rotation-aware), not a div with CSS transform
- Snap guides are cleared on pointerup (both from drag in EditorLayout and from TransformHandles)
- Multi-select group resize deferred: handles appear but only translate (same dx/dy for all objects)
- Coord system: CSS px = world px at zoom=1 (M8 will add zoom, clientToCanvasCoords must be updated)

## Test results

281/281 tests passing. TypeScript strict: 0 errors.

## Known limitations / deferred

- Multi-select resize: moves all objects by same delta, does not scale proportionally around group center (M14)
- Multi-select rotation handle: not shown (M14)
- Zoom/pan: coord transform is 1:1, will need update in M8
- Rotation handle cursor changes to 'grabbing' during drag — not implemented (cosmetic, M14)
- No keyboard focus ring on handles (M14 accessibility polish)
