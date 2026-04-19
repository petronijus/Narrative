# Handoff M2 — Data model refactor + DOM overlay primitive

**Status:** done
**Date:** 2026-04-19
**Previous:** M1 (commit `d9ca563`)

---

## Co bylo dokončeno

### Fáze 1 — Yjs foundation (commit `b862bff`)

- `packages/shared` — `SlideObject = RectangleObject | EllipseObject | TextObject` discriminated union, `Slide`, `SlideObjectPatch<T>`. Pure TS, zero runtime deps.
- `packages/slide-model` — 7 modulů:
  - `registry.ts` — `registerObjectType` / `getObjectTypeDef` / `listRegisteredTypes` (duplicate throws)
  - `yDoc.ts` — `createSlideDoc()` s root-level Y.Array (ne uvnitř Y.Map — viz ADR-0003)
  - `bindings.ts` — `yMapToPlainObject` / `plainObjectToYMap` / `plainObjectToYMapInDoc`
  - `mutations.ts` — `addObject`, `removeObject`, `updateObject`, `createObjectOfType`, vše přes `doc.transact(fn, LOCAL_ORIGIN)`
  - `undo.ts` — `createUndoManager` filtrující na `LOCAL_ORIGIN`
  - `observe.ts` — `subscribeToObjects` s deep observe + unsubscribe
  - `index.ts` — re-exportuje + registruje 3 builtin typy
- `apps/web/src/state/` — `SlideDocProvider` + `useSlideObjects` hook (Y.Doc → React reaktivita)
- `Canvas.tsx` refactor — čte z `useSlideObjects()` místo `slideData` prop
- ADR-0003 (`docs/adr/0003-yjs-slide-model.md`)
- 31 testů v `packages/slide-model` (registry, bindings, mutations, observe)

### Fáze 2a — Renderer (ellipse + text + overlay compositor)

- `objectRenderers/ellipseRenderer.ts` — Pixi v8 Graphics ellipse
- `objectRenderers/textRenderer.ts` — Pixi v8 Text node s TextStyle
- `objectRenderers/index.ts` — registrace 3 typů, žádný fallback warn
- `SceneGraph.ts` — přidán `hitTest(worldX, worldY): string | null` (AABB, z-order aware)
- `coords.ts` — přidán `getCanvasDPR(app)`
- `overlay/OverlayCompositor.ts` + `overlay/types.ts` — produkční API podle Spike C
  - `registerOverlay(opts)`, `update`, `setInteractive`, `destroy`
  - Ticker-based sync, DPR-aware, GC-free per-frame (`_scratch` Point reuse)
- `Canvas.tsx` — overlay root `<div>`, compositor lifecycle (destroy před `app.destroy()`)
- 74 renderer testů (14 ellipse + 22 text + 14 hitTest + 24 compositor)

### Fáze 2b — Editor UI (toolbar + drag + inspector + undo)

- `state/SelectionContext.tsx` — ephemeral selection (selectedId, setSelectedId, clearSelection)
- `state/ToolContext.tsx` — activeTool state
- `state/useUndoManager.ts` — wrapper nad Y.UndoManager s canUndo/canRedo reactive
- `ui/Toolbar.tsx` — 4 buttons (Select/Rectangle/Ellipse/Text) + keyboard shortcuts V/R/O/T
- `ui/Inspector.tsx` — editovatelný panel podle typu (Position/Size/Transform/Appearance/Text sections)
- `components/EditorLayout.tsx` — pointer events (select/drag/create), selection overlay, Delete + Ctrl+Z/Ctrl+Shift+Z bindings
- 27 editor-ui testů (Toolbar 13, Inspector 10, SelectionContext 4)

**Celkem:** 151 testů zelených (31 slide-model + 120 web).

---

## Klíčová rozhodnutí

1. **Y.Array uvnitř Y.Doc root**, ne uvnitř Y.Map (standalone Y.Map bez Y.Doc vrací `undefined` pro `get()` — gotcha z Yjs v14). Viz ADR-0003. Pro multi-slide v M6 změníme na `Y.Array<Y.Map>` (deck → slides → objects).
2. **LOCAL_ORIGIN symbol** pro `doc.transact`. UndoManager trackne jen tento origin — v M5 (remote sync) nebudeme undovat cizí changes.
3. **Object type registry** jako plugin boundary od začátku (`registerObjectType`). V M2 má jen `defaultProps`, v budoucích milestones přibývá `inspector`, `schema`, `hitTest` specific — M27 (plugin SDK) odemkne pro third-party.
4. **Naivní hit test + selection overlay** pro M2 (CSS pixely = world pixely bez zoom/pan). TODO komentáře v `EditorLayout.tsx` odkazují na `SceneGraph.hitTest()` a `OverlayCompositor.registerOverlay()` — zapojí se v M5 (present mode může mít scale) nebo M7 (transform handles s reálným zoom).
5. **Renderer ignoruje rotation pro hit test** (AABB only). Přesný rotated hit test přijde v M7.
6. **Pixi Text auto-měří height** — `TextObject.height` pro teď ignorujeme, wordWrap používá `width`. Relevantní pro clipping/scrollable text v budoucích milestones.
7. **Renderer fáze 2a + editor-ui fáze 2b běželi paralelně** s jasným interface kontraktem. Merge proběhl bez konfliktů (sdílený bod: `Canvas.tsx` = renderer; `EditorLayout.tsx` = editor-ui).

---

## Jak ověřit stav

```bash
cd D:\Narrative
pnpm install
pnpm -r typecheck   # ✓ 6 packages
pnpm -r lint        # ✓ 0 errors
pnpm -r test        # ✓ 151 tests
pnpm -r build       # ✓
pnpm --filter @narrative/web dev   # http://localhost:5173
```

V prohlížeči:

1. Uvidíš 3-pane layout s toolbarem nahoře
2. Klik na **Rectangle** / **Ellipse** / **Text** (nebo V/R/O/T) → přepnou tool
3. Klik na canvas v non-select modu vytvoří objekt dané typu
4. V select modu klik na objekt → vybere se (modrý outline)
5. Drag vybraného objektu pohybuje jím (Y.Doc update přes `updateObject`)
6. Inspector vpravo ukazuje editovatelné fields
7. Editace Inspector fields → real-time update na canvasu
8. **Delete/Backspace** odstraní vybraný
9. **Ctrl/Cmd+Z** undo, **Ctrl/Cmd+Shift+Z** nebo **Ctrl+Y** redo

---

## Známé TODO

- **Naivní hit test a selection overlay** nahradit přes SceneGraph.hitTest + OverlayCompositor při zavedení zoom/pan (M5 present mode s fullscreen scale, M7 transform handles).
- **Rotated hit test** (teď AABB) — M7.
- **TextObject.height ignorován** — wordWrap používá `width`, height je auto. Clipping v budoucnu.
- **Chunk size warning** v Vite buildu (Pixi 528kB). Dynamic import() nebo manualChunks — M12 až to bude relevantní (performance polish).

---

## Další krok

**M3 — Renderer reconciler.** Dispatch `renderer` + `state-sync` koordinovaně:

- Čistý diff engine: Y.Doc state snapshot → PixiJS scene (add/update/remove) bez přímých mutací z editing kódu.
- Observer layer s batching (per-frame, ne per-op) — scene update 1× per rAF místo N× per transakce.
- ADR-0004 (reconciler pattern).

Prompt pro další session: _"Pokračuj na M3 podle BUILD_PLAN.md. Nejdřív načti docs/handoff/M2-data-model-refactor.md. Dispatchni state-sync + renderer paralelně na reconciler design."_

---

## Odkazy

- **ADR-0003**: `docs/adr/0003-yjs-slide-model.md` (Yjs slide model + registry)
- **Fáze 1 commit**: `b862bff feat(m2): yjs foundation + object type registry + shared types`
- **Celkový M2 commit**: (bude vytvořen při tomto handoffu)
- **Klíčové soubory**:
  - `packages/shared/src/slide.ts` — discriminated union
  - `packages/slide-model/src/index.ts` — public API
  - `apps/web/src/state/SlideDocProvider.tsx` + `useSlideObjects.ts` — Yjs ↔ React
  - `apps/web/src/renderer/overlay/OverlayCompositor.ts` — layered compositor primitive
  - `apps/web/src/ui/Toolbar.tsx`, `Inspector.tsx` — editor chrome
  - `apps/web/src/components/EditorLayout.tsx` — pointer events + selection
- **Spike C handoff**: `docs/handoff/spike-c-dom-overlay.md` — pattern kompozitor inheritance
