# M6 Phase 1b — Animation Schema Extension (state-sync)

**Datum:** 2026-04-19
**Agent:** state-sync
**Branch:** main
**Status:** Hotovo — 0 TS chyb, 78/78 testů v slide-model, 188/188 v web

---

## Co bylo implementováno

### 1. `packages/shared/src/animation.ts` — type guards přidány

Soubor existoval (schema kontrakt byl předpřipravený). Přidány:

- `isAnimationPreset(s): s is AnimationPreset`
- `isAnimationTrigger(s): s is AnimationTrigger`

Re-exporty z `packages/shared/src/index.ts` přidány.

### 2. `packages/slide-model/src/yDoc.ts` — rozšíření o animations

`SlideDocHandles` rozšířen o `animations: Y.Array<Y.Map<unknown>>`.
`createSlideDoc()` volá `doc.getArray('animations')` — backward compat: existující decky dostanou prázdný array.

### 3. `packages/slide-model/src/slideMutationContext.ts` — nový soubor

```ts
export interface SlideMutationContext extends MutationContext, AnimationMutationContext {}
```

Unified kontext pro konzumenty, kteří potřebují obě API.

### 4. `packages/slide-model/src/animationBindings.ts` — nový soubor

- `yMapToAnimationStep(yMap)` — konverze s validací všech required fields
- `animationStepToYMap(step)` — standalone (pro insert do Y.Array.push())
- `animationStepToYMapInDoc(doc, step)` — integrovaný v doc (pro testy)

### 5. `packages/slide-model/src/animationMutations.ts` — nový soubor

```ts
interface AnimationMutationContext { doc: Y.Doc; animations: Y.Array<Y.Map<unknown>> }

addAnimation(ctx, step) → AnimationStep   // generuje id, vrátí full step
removeAnimation(ctx, id) → void           // no-op + warn pokud nenalezeno
updateAnimation(ctx, id, patch) → void    // no-op + warn pokud nenalezeno
reorderAnimations(ctx, newOrder) → void   // validuje bijekci, throw pokud invalid
```

Všechny mutace přes `doc.transact(fn, LOCAL_ORIGIN)`.

Validace v `reorderAnimations`: nejprve ověří délku, pak unknown IDs v newOrder, pak chybějící existing IDs.

### 6. `packages/slide-model/src/animationObserve.ts` — nový soubor

```ts
subscribeToAnimations(ctx, callback) → () => void
```

Full snapshot pattern. `observeDeep` zachytí i nested Y.Map updates (updateAnimation patches). Synchronní initial emission.

### 7. `packages/slide-model/src/undo.ts` — rozšíření

`createUndoManager` teď přijímá `SlideMutationContext` a trackuje obě Y.Array:

```ts
new Y.UndoManager([ctx.objects, ctx.animations], { trackedOrigins: new Set([LOCAL_ORIGIN]) })
```

### 8. `packages/slide-model/src/index.ts` — nové exporty

Přidány: `addAnimation`, `removeAnimation`, `updateAnimation`, `reorderAnimations`, `subscribeToAnimations`, `AnimationMutationContext`, `SlideMutationContext`, `yMapToAnimationStep`, `animationStepToYMap`, `animationStepToYMapInDoc`.

### 9. `apps/web/src/state/slideDocContext.ts` — M6 update

`SlideDocContextValue.mutationCtx` je teď `SlideMutationContext` (obsahuje `doc + objects + animations`).

### 10. `apps/web/src/state/SlideDocProvider.tsx` — M6 update

Provider teď volá `doc.getArray('animations')` a předává `SlideMutationContext` do kontextu.

### 11. `apps/web/src/state/useAnimations.ts` — nový hook

```ts
export function useAnimations(): { animations: AnimationStep[]; mutationCtx: SlideMutationContext }
```

Analogie k `useSlideObjects`. Plný snapshot při každé změně.

---

## Nové soubory

- `packages/slide-model/src/slideMutationContext.ts`
- `packages/slide-model/src/animationBindings.ts`
- `packages/slide-model/src/animationMutations.ts`
- `packages/slide-model/src/animationObserve.ts`
- `packages/slide-model/src/animationBindings.test.ts`
- `packages/slide-model/src/animationMutations.test.ts`
- `packages/slide-model/src/animationObserve.test.ts`
- `apps/web/src/state/useAnimations.ts`

## Upravené soubory

- `packages/shared/src/animation.ts` — přidány type guards
- `packages/shared/src/index.ts` — re-export type guards
- `packages/slide-model/src/yDoc.ts` — animations Y.Array
- `packages/slide-model/src/undo.ts` — SlideMutationContext + track animations
- `packages/slide-model/src/index.ts` — nové exporty
- `packages/slide-model/src/mutations.test.ts` — makeFullCtx() pro UndoManager testy
- `apps/web/src/state/slideDocContext.ts` — SlideMutationContext
- `apps/web/src/state/SlideDocProvider.tsx` — animations getArray
- `apps/web/src/ui/Inspector.test.tsx` — SlideMutationContext v helperu
- `apps/web/src/components/PresentLayout.test.tsx` — SlideMutationContext v helperu
- `apps/web/src/pages/DeckPresent.test.tsx` — SlideMutationContext v helperu

---

## Schema kontrakt — ověření

`AnimationStep` v `packages/shared/src/animation.ts` odpovídá kontraktu s animation agentem:

- `id: string`, `objectId: string`, `preset: AnimationPreset`, `trigger: AnimationTrigger`
- `duration: number`, `delay: number`, `easing: string`, `params?: Record<string, unknown>`

Tento soubor se nesmí měnit bez koordinace s animation agentem.

---

## Co konzumuje animation agent (fáze 1a)

Animation engine (GSAP compiler) konzumuje:

- `subscribeToAnimations(ctx, cb)` — dostane `AnimationStep[]` při každé změně
- `AnimationStep.preset`, `AnimationStep.params` — pro GSAP factory lookup
- `AnimationStep.trigger`, `AnimationStep.duration`, `AnimationStep.delay`, `AnimationStep.easing`

---

## Co bude volat editor-ui (fáze 2)

```ts
const { animations, mutationCtx } = useAnimations()

// Přidání animace:
addAnimation(mutationCtx, { objectId, preset, trigger, duration, delay, easing })

// Odebrání:
removeAnimation(mutationCtx, stepId)

// Aktualizace:
updateAnimation(mutationCtx, stepId, { duration: 1.5 })

// Reorder (drag-and-drop v timeline panelu):
reorderAnimations(mutationCtx, newOrderIds)
```

---

## Backward compat

Existující decky bez `animations` Y.Array: `doc.getArray('animations')` vrátí prázdný array. Žádná migrace není potřeba.

---

## M9 poznámka

M9 přestěhuje strukturu na per-slide (každý slide bude mít vlastní `objects` a `animations`). Aktuální root-level implementace je intentional temporary — refactor v M9.
