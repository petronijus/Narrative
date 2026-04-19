# M6 Phase 2 — Editor UI Animation Integration

**Datum:** 2026-04-19
**Agent:** editor-ui
**Status:** DONE — 0 TS chyb, 206/206 testů

---

## Co bylo implementováno

### 1. `apps/web/src/renderer/CanvasInstanceContext.tsx` — NOVÝ

Context pro exposování Canvas internals (SceneGraph + OverlayCompositor) mimo Canvas.tsx:

```ts
export interface CanvasInstance {
  sceneGraph: SceneGraph
  compositor: OverlayCompositor
}
export const CanvasInstanceContext = createContext<CanvasInstance | null>(null)
export function useCanvasInstance(): CanvasInstance | null
```

### 2. Canvas ref exposure — Varianta B (state lifting)

**`apps/web/src/renderer/Canvas.tsx`** — přidán `onReady?: (instance: CanvasInstance) => void` prop. Voláno po `app.init()` success.

**`apps/web/src/components/DeckShell.tsx`** — drží `canvasInstance` state, poskytuje `CanvasInstanceContext.Provider` a `DeckShellContextValue` přes Outlet context:

```ts
export interface DeckShellContextValue {
  onCanvasReady: (instance: CanvasInstance) => void
}
```

**`apps/web/src/pages/DeckEditor.tsx`** — `useOutletContext<DeckShellContextValue | null>()`, pasuje `ctx?.onCanvasReady` do EditorLayout.

**`apps/web/src/pages/DeckPresent.tsx`** — totéž, pasuje do PresentLayout.

**`apps/web/src/components/EditorLayout.tsx`** — přijímá `onCanvasReady` prop, pasuje do `<Canvas onReady={...} />`.

### 3. `apps/web/src/animation/targetResolver.ts` — NOVÝ

TargetResolver implementace pro Pixi:

```ts
export function createPixiTargetResolver(sceneGraph: SceneGraph): TargetResolver
```

- `resolve(objectId)` → `PixiTargetHandle | null`
- Proxy inicializován ze současného Pixi Container stavu
- `apply()` volá `container.position.set()`, `container.scale.set()`, nastaví rotation + alpha
- DOM targets jsou M15

### 4. `apps/web/src/components/PresentLayout.tsx` — rozšíření

- Přijímá `onCanvasReady` prop (pasuje do Canvas)
- `useCanvasInstance()` pro SceneGraph přístup
- `useAnimations()` pro AnimationStep[] snapshot
- `useEffect` → vytvoří runtime + play při canvas ready + animations > 0; destroy při cleanup
- `createClickInputBridge(document.body)` pro onClick triggers
- Re-create runtime při změně animations (Yjs change → nový snapshot → nový runtime)

### 5. `apps/web/src/ui/Inspector.tsx` — rozšíření

Přidána sekce **Animations** pro vybraný objekt:

- 5 tlačítek: `+ fadeIn`, `+ slideIn up/down/left/right`
- List existujících animací filtrovaný na `step.objectId === selectedId`
- Každý row: preset label + trigger label + delete ikonka (X)
- Mutace přes `addAnimation()` / `removeAnimation()` z `@narrative/slide-model`
- Default trigger: `onEnter` pro první animaci, `afterPrevious` pro další

### 6. `apps/web/src/ui/Toolbar.tsx` — rozšíření

Přidáno **Preview tlačítko** (▷) vlevo od Present:

- Naviguje na `/deck/:id/present?preview=1`
- M14 implementuje full inline preview. Nyní = present mode v plnohodnotném view (auto-return není implementován v M6 — preview = identické s present, ale URL se liší).

### 7. Nové testy

| Soubor                                  | Nové testy                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/animation/targetResolver.test.ts`  | 6 testů — null resolve, pixi handle, proxy init, apply(), scale.set(), proxy izolace                         |
| `src/ui/Inspector.test.tsx`             | 8 nových testů — Animations sekce, 5 add buttons, addAnimation mock, removeAnimation mock, filter per object |
| `src/components/PresentLayout.test.tsx` | 4 nové testy — no runtime bez canvas, no runtime bez animations, play() na mount, destroy() na unmount       |

---

## Canvas ref exposure strategie

**Varianta B** — state lifting přes DeckShell:

- DeckShell drží `canvasInstance` state
- Canvas dostane `onReady` callback prop
- Context provider v DeckShell wrappuje Outlet
- Konzumenti čtou přes `useCanvasInstance()`
- Výhoda: žádný refactoring Canvas internals, clean separation
- Test-friendly: DeckPresent.test.tsx renderuje bez DeckShell → `useOutletContext` vrátí null → graceful degradace přes `ctx?.onCanvasReady`

---

## Files added/changed

**Nové:**

- `apps/web/src/renderer/CanvasInstanceContext.tsx`
- `apps/web/src/animation/targetResolver.ts`
- `apps/web/src/animation/targetResolver.test.ts`

**Upravené:**

- `apps/web/src/renderer/Canvas.tsx` — `onReady` prop
- `apps/web/src/components/DeckShell.tsx` — state lifting, DeckShellContextValue, CanvasInstanceContext.Provider
- `apps/web/src/components/EditorLayout.tsx` — `onCanvasReady` prop, pass do Canvas
- `apps/web/src/components/PresentLayout.tsx` — animation runtime lifecycle
- `apps/web/src/components/PresentLayout.test.tsx` — runtime mocks + 4 nové testy
- `apps/web/src/pages/DeckEditor.tsx` — useOutletContext, onCanvasReady do EditorLayout
- `apps/web/src/pages/DeckPresent.tsx` — useOutletContext, onCanvasReady do PresentLayout
- `apps/web/src/pages/DeckPresent.test.tsx` — animation/useAnimations mocks
- `apps/web/src/ui/Inspector.tsx` — AnimationsSection
- `apps/web/src/ui/Inspector.test.tsx` — useAnimations mock + 8 nových testů
- `apps/web/src/ui/Toolbar.tsx` — Preview tlačítko
- `apps/web/package.json` — `@narrative/animation: workspace:*`
- `apps/web/tsconfig.json` — path alias pro `@narrative/animation`
- `apps/web/vite.config.ts` — vite resolve alias pro `@narrative/animation`

---

## Known gaps (pro budoucí milestony)

- **M14**: Plný animation timeline scrubber, trigger dropdown v Inspectoru, drag-to-reorder animací
- **M14**: Full inline preview (bez navigace) — `PreviewController` s mount/unmount runtime přímo v editoru
- **M15**: DOM overlay targets (text letter-by-letter) — `createPixiTargetResolver` doplnit o DomTargetHandle větev
- **M9**: Re-wiring runtime při multi-slide navigaci — teď runtime destroy/re-create na každou slide change
- **M6 gap**: Preview button naviguje do present mode identicky jako Present. `?preview=1` query param není dosud konzumován (PresentLayout ho ignoruje). Auto-return po dokončení animací je M14.
- **Runtime re-create**: Každá Yjs animations change triggeruje destroy + re-create runtime (useEffect deps). Sofistikovanější hot-patch přijde v M14.
