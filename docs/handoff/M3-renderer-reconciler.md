# Handoff M3 — Renderer reconciler (fáze 2: surgical scene graph apply)

**Status:** done (fáze 2) + integrace Canvas.tsx dokončena tech-leadem
**Date:** 2026-04-19
**Navazuje na:** M2 (commit `7a4dccb`)

> **Tech-lead poznámka (merge):** Canvas.tsx byl úspěšně napojen z `useSlideObjects()+render()` na `useSlideObjectChanges()+applyChanges()` s `pendingChangesRef` bufferem pro init race. ADR-0004 (`docs/adr/0004-renderer-reconciler.md`) dokumentuje celý reconciler pattern. Celkem 212 testů zelených. Companion handoff pro observer vrstvu: `M3-state-sync-observer.md`.
>
> **Další krok**: M4 — Hocuspocus sync + Postgres + první deploy. Dispatch `state-sync` nejdřív, pak `infra`.

---

## Co bylo dokončeno

### ObjectChangeSet — sdílený kontrakt (packages/shared)

- `ObjectChangeSet` interface přidán do `packages/shared/src/slide.ts` a re-exportován z `index.ts`.
- Kontrakt: `{ added: SlideObject[], removed: string[], updated: Array<{ id, patch: Partial<SlideObject> }>, snapshot: SlideObject[] }`.
- Nemění se bez schválení tech-leada (koordinace renderer + state-sync agentů).

### ObjectRenderer.applyPatch — rozšíření interface

- `apps/web/src/renderer/objectRenderers/index.ts` — přidáno optional `applyPatch?(node, patch)` do `ObjectRenderer<T>`.
- `rendererRegistry` exportován (byl privátní) — SceneGraph ho přístupuje přímo pro `applyChanges`.

### applyPatch implementace ve všech 3 rendererech

**rectangleRenderer** (`apps/web/src/renderer/objectRenderers/rectangleRenderer.ts`):

- Patch `{ x }` / `{ y }` → pouze `node.x`/`node.y`, nulový GPU overhead.
- Patch `{ fill }` / `{ width }` / `{ height }` → redraw Graphics + pivot přepočet.
- Cached fill hodnota přes `Symbol('rectFill')` — Pixi Graphics nemá getter na nakreslenou barvu.

**ellipseRenderer** (`apps/web/src/renderer/objectRenderers/ellipseRenderer.ts`):

- Stejný pattern jako rectangle — `Symbol('ellipseFill')` pro cached fill.

**textRenderer** (`apps/web/src/renderer/objectRenderers/textRenderer.ts`):

- `{ x, y, rotation, opacity }` → pouze container transform, BEZ TextStyle rebuild.
- `{ text }` → pouze `textNode.text = patch.text`, BEZ TextStyle rebuild.
- `{ fontSize, fontWeight, color, align }` → mutuje `textNode.style` in-place (Pixi TextStyle je mutable), nezakládá nový objekt.
- `{ width }` → mění `style.wordWrapWidth` + přepočítá pivot.x a `node.x`.

### SceneGraph.applyChanges() + nodeTypes tracking

- `apps/web/src/renderer/SceneGraph.ts`:
  - Přidán `private readonly nodeTypes = new Map<string, SlideObjectType>()`.
  - `addObject` / `removeObject` plní/maže `nodeTypes`.
  - `render()` (backward compat) volá `addObject`/`removeObject`, tedy také plní `nodeTypes`.
  - `applyChanges(changes: ObjectChangeSet)`:
    - Pořadí: remove → add → update.
    - Update: preferuje `renderer.applyPatch(patch)`, fallback na `renderer.update(prev, merged)`.
    - Po update mergeuje patch do `node.data` snapshot pro konzistenci.

### Canvas.tsx — stav integrace

Canvas.tsx zachovává stávající `useSlideObjects() → sceneGraph.render()` cestu. Přechod na `useSlideObjectChanges → applyChanges` nastane jakmile state-sync agent dokončí fázi 1 (hook + batched observer). Fallback cesta zůstane funkční.

---

## Benchmark výsledky (drag simulace)

Scenario: 1000 updatů `{ x, y }` na stejném objektu (simuluje drag operaci).

| Cesta                    | ops/sec     | mean (µs) |
| ------------------------ | ----------- | --------- |
| `applyPatch({ x, y })`   | **964,768** | 0.001     |
| `fullUpdate(prev, next)` | 59,103      | 0.017     |
| **Speedup**              | **16.3x**   | —         |

Benchmark: `apps/web/src/renderer/applyChanges.bench.ts`

---

## Testy

Nové testy (přidáno 14 testů, celkem 165 web + 47 slide-model):

- `SceneGraph.applyChanges.test.ts` — 11 testů: added/removed/updated/ordering/nodeTypes
- `rectangleRenderer.applyPatch.test.ts` — 12 testů
- `ellipseRenderer.applyPatch.test.ts` — 10 testů
- `textRenderer.applyPatch.test.ts` — 12 testů

---

## Klíčová rozhodnutí

1. **Cached fill Symbol** — Pixi Graphics neukládá nakreslenou barvu jako čitelnou property. Renderer si cachuje fill přes Symbol property na Containeru. Alternativa (reconstruct z full snapshot per-node) by vyžadovala větší state store — postponed na M4 TODO komentář.

2. **TextStyle mutable in-place** — Pixi TextStyle je mutable. `applyPatch` pro text nemutuje referenci `textNode.style`, ale přímo properties na existujícím objektu. Tím se zabrání zbytečnému GC z nových `TextStyle` objektů na každý keystroke.

3. **ObjectChangeSet v packages/shared** — typ patří do shared aby ho state-sync i renderer mohli importovat bez cross-app dependency. Zero runtime deps — pure TS.

4. **Fallback update() v applyChanges** — Pokud renderer neimplementuje `applyPatch`, SceneGraph mergeuje `{ ...node.data, ...patch }` a volá `update(prev, merged)`. Backward compat zaručena.

5. **applyChanges pořadí: remove → add → update** — Zajišťuje správné chování při remove+add stejného ID ve stejném changeSet (originál je zničen, nový je přidán).

---

## Jak ověřit

```bash
cd D:\Narrative
pnpm -r typecheck   # zelena
pnpm -r lint        # zelena
pnpm -r test        # 165 web + 47 slide-model = 212 tests zelene
pnpm -r build       # zeleny build
pnpm --filter @narrative/web exec vitest bench src/renderer/applyChanges.bench.ts  # benchmark
```

---

## Závislost na state-sync (fáze 1)

Canvas.tsx čeká na toto API od state-sync agenta:

```ts
// Funkce pro subscription na incremental changes (Yjs observer s batching)
subscribeToObjectChanges(callback: (changes: ObjectChangeSet) => void): () => void

// React hook obalující subscribeToObjectChanges
useSlideObjectChanges(callback: (changes: ObjectChangeSet) => void): void
```

Jakmile state-sync dodá hook, Canvas.tsx přepne na:

```tsx
useSlideObjectChanges((changes) => {
  instanceRef.current?.sceneGraph.applyChanges(changes)
})
```

Initial emission by měla mít všechny aktuální objekty jako `added` (bootstrap bez separátního render volání).

---

## Soubory změněny

- `packages/shared/src/slide.ts` — přidán `ObjectChangeSet` interface
- `packages/shared/src/index.ts` — re-export `ObjectChangeSet`
- `apps/web/src/renderer/objectRenderers/index.ts` — `applyPatch` v interface, `rendererRegistry` exportován
- `apps/web/src/renderer/objectRenderers/rectangleRenderer.ts` — `applyPatch` + cached fill
- `apps/web/src/renderer/objectRenderers/ellipseRenderer.ts` — `applyPatch` + cached fill
- `apps/web/src/renderer/objectRenderers/textRenderer.ts` — `applyPatch` (in-place style mutation)
- `apps/web/src/renderer/SceneGraph.ts` — `nodeTypes Map`, `applyChanges()`, `addObject`/`removeObject` aktualizovány
- `apps/web/src/renderer/SceneGraph.applyChanges.test.ts` — nový (11 testů)
- `apps/web/src/renderer/objectRenderers/rectangleRenderer.applyPatch.test.ts` — nový (12 testů)
- `apps/web/src/renderer/objectRenderers/ellipseRenderer.applyPatch.test.ts` — nový (10 testů)
- `apps/web/src/renderer/objectRenderers/textRenderer.applyPatch.test.ts` — nový (12 testů)
- `apps/web/src/renderer/applyChanges.bench.ts` — benchmark

---

## Další krok

**M3 fáze 1 (state-sync agent)** — batched incremental observer na Y.Doc:

- `subscribeToObjectChanges` s per-frame batching (rAF nebo microtask queue)
- `useSlideObjectChanges` React hook
- Initial emission jako `added` changeSet

**Po state-sync fázi 1:**

- Zapojit `useSlideObjectChanges` do `Canvas.tsx` (zakomentovat `useSlideObjects + render()` cestu)
- ADR-0004 pro reconciler pattern (popis celé M3 architektury)
