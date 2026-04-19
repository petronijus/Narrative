# Handoff M3 — State Sync: Batched Incremental Observer

**Status:** done (fáze 1 — state-sync vrstva)
**Date:** 2026-04-19
**Agent:** state-sync
**Koordinuje s:** renderer agent (fáze 2 — surgical scene apply)

---

## Co bylo dokončeno

### 1. `packages/slide-model/src/observe.ts` — incremental diff API

Přidány nové exporty (stávající `subscribeToObjects` beze změny):

**`ObjectChangeSet` interface:**

- `added: SlideObject[]` — objekty přidané od poslední emise (already converted)
- `removed: string[]` — IDs odstraněných objektů
- `updated: Array<{ id: string; patch: Partial<SlideObject> }>` — merged patches
- `snapshot: SlideObject[]` — full snapshot pro initial state / nové subscribery

**`subscribeToObjectChanges(ctx, callback)` → `() => void`:**

- Per-frame batching přes `requestAnimationFrame` (Node fallback: microtask)
- Coalescing: více updates na stejný objekt v jednom frame = jeden merged patch
- Net-zero: add + delete stejného ID ve stejném frame = žádná emise
- Initial emission synchronní (v `subscribe()` samotném, před návratem)
- Unsubscribe cancels pending rAF

**`subscribeToObjectChangesWithFlush(ctx, callback)` → `{ unsubscribe, flush }`:**

- Stejné jako výše + explicitní `flush()` pro testing / SSR

### 2. `packages/slide-model/src/index.ts`

Exportuje `subscribeToObjectChanges`, `subscribeToObjectChangesWithFlush`, `ObjectChangeSet`.

### 3. `apps/web/src/state/useSlideObjectChanges.ts` — nový React hook

```ts
export function useSlideObjectChanges(callback: (changes: ObjectChangeSet) => void): void
```

- Callback v ref — nezpůsobuje re-subscribe při každém re-renderu
- Re-subscribes jen při změně `mutationCtx` (nový Y.Doc)

### 4. Tests

**`packages/slide-model/src/observeChanges.test.ts`** — 16 nových testů:

- Initial emission (prázdný doc + se stávajícími objekty)
- Single add / remove / update
- Coalescing (2 updates na stejný objekt → 1 merged entry)
- Coalescing pro více objektů (2 updated entries)
- Net-zero (add + remove stejného ID → žádná emise)
- Multiple rAF ticks (2 flush cycles → 2 emise)
- Unsubscribe před flush / po unsubscribe
- Flush je synchronní
- Snapshot konzistence přes více ticků
- Prázdný flush → žádná emise

### 5. Benchmark `packages/slide-model/src/observeChanges.bench.ts`

Výsledky na vývojářském stroji (Node.js, ne browser):

| Scénář                                                | hz     | mean (ms) |
| ----------------------------------------------------- | ------ | --------- |
| 1000 mutations na 1 obj, single flush (drag simulace) | 348/s  | 2.87ms    |
| 100 obj × 10 updates, single flush, 100 entries       | 51/s   | 19.4ms    |
| 60 rAF ticks × 1 update, 60 emissions                 | 3525/s | 0.28ms    |

**Klíčový výsledek drag scénáře:** 1000 mutací na jeden objekt v jednom rAF frame = **1 emise** s 1 updated entry. Mean 2.87ms na celý batch pro 1000 Yjs transakcí + 1 flush — O(K) ne O(N) kde K = počet unikátních changed IDs.

---

## Klíčová architektonická rozhodnutí

### Okamžitá konverze added Y.Map → plain object v observeru (ne v flush)

**Problém:** Y.Map přidaný do Y.Array může být ve stejném batch i smazán (net-zero scénář). Po smazání ze Y.Array, `Y.Map.get()` přestane vracet hodnoty protože Yjs vyčistí vnitřní stav. `yMapToPlainObject()` selže s `"missing type field"`.

**Řešení:** `PendingBatch.addedObjects: Map<string, SlideObject>` — konvertujeme okamžitě v Yjs observer callbacku (Y.Map je živý), ne lazy v flush. Tím net-zero nerozbíjí konverzi.

### Deleted ID extraction z Yjs internals

Pro deleted items v `changes.deleted` (Set<Item>): `item.content` je `ContentType`, `content.type` je Y.Map. Po smazání ze Y.Array je Y.Map označena deleted, ale data v `_map` internals jsou stále přítomna (CRDT append-only). Přistupujeme přes `readIdFromDeletedYMap()` — nejprve standardní `.get('id')`, fallback přes `_map` internals.

### PendingBatch je immutable per flush

Na začátku flush: `const batchToProcess = pending; pending = createPendingBatch()` — atomická swap před dispatch. Pokud callback vyvolá mutaci (re-entrancy), nový pending začne nový batch a bude zpracován v dalším rAF.

---

## Kontrakt pro renderer agenta

Renderer konzumuje `ObjectChangeSet` z `useSlideObjectChanges` a volá `sceneGraph.applyChanges(changes)`.

**Co renderer musí implementovat:**

- `SceneGraph.applyChanges(changes: ObjectChangeSet): void`
  - `added` → `sceneGraph.addObject(obj)` — mount renderer, přidat do scene
  - `removed` → `sceneGraph.removeObject(id)` — unmount renderer, odstranit ze scene
  - `updated` → renderer-specifický `applyPatch(node, patch)` — surgical update bez full re-render

**Initial state:** první emise z `subscribeToObjectChanges` má `added: <všechny existující objekty>` — renderer nemusí dělat separátní initial load.

**Snapshot:** k dispozici pro debug nebo reset, ale primárním datovým tokem jsou `added/removed/updated`.

---

## Jak ověřit stav

```bash
pnpm -r typecheck   # zelená
pnpm -r lint        # zelená
pnpm -r test        # 212 testů zelených (47 slide-model + 165 web)
pnpm -r build       # zelená

# Benchmark:
cd packages/slide-model
node ../../node_modules/vitest/vitest.mjs bench
```

---

## Soubory změněné

| Soubor                                                                       | Změna                                                                                                 |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/slide-model/src/observe.ts`                                        | Přidán incremental API (subscribeToObjectChanges, subscribeToObjectChangesWithFlush, ObjectChangeSet) |
| `packages/slide-model/src/index.ts`                                          | Export nových API                                                                                     |
| `apps/web/src/state/useSlideObjectChanges.ts`                                | Nový React hook (nový soubor)                                                                         |
| `packages/slide-model/src/observeChanges.test.ts`                            | 16 nových testů (nový soubor)                                                                         |
| `packages/slide-model/src/observeChanges.bench.ts`                           | Benchmark (nový soubor)                                                                               |
| `apps/web/src/renderer/SceneGraph.applyChanges.test.ts`                      | Opraven TS cast chyba v renderer testu (renderer agent soubor)                                        |
| `apps/web/src/renderer/objectRenderers/ellipseRenderer.applyPatch.test.ts`   | Opraveny lint chyby (renderer agent soubor)                                                           |
| `apps/web/src/renderer/objectRenderers/rectangleRenderer.applyPatch.test.ts` | Opraveny lint chyby (renderer agent soubor)                                                           |
| `apps/web/src/renderer/objectRenderers/textRenderer.applyPatch.test.ts`      | Opraveny lint chyby (renderer agent soubor)                                                           |
| `apps/web/src/renderer/objectRenderers/textRenderer.ts`                      | Opraven unused var (renderer agent soubor)                                                            |
| `apps/web/src/renderer/applyChanges.bench.ts`                                | Opraven unused import (renderer agent soubor)                                                         |

Renderer-owned soubory opraveny jen lint/typecheck-blocker errory, žádné logické změny.

---

## Blokery / Závislosti

Žádné blokery. Tech-lead merguje state-sync (fáze 1) + renderer (fáze 2) do jednoho M3 commitu.

**Renderer agent očekává:**

- `ObjectChangeSet` z `@narrative/slide-model` (exportováno)
- `useSlideObjectChanges` z `apps/web/src/state/useSlideObjectChanges.ts`
- `Canvas.tsx` (renderer zodpovědnost) napojí `useSlideObjectChanges` místo `useSlideObjects`

---

## Dokumentace klíčových souborů

- `packages/slide-model/src/observe.ts` — incremental observer implementace
- `packages/slide-model/src/index.ts` — public API
- `apps/web/src/state/useSlideObjectChanges.ts` — React hook pro renderer
- `apps/web/src/state/useSlideObjects.ts` — původní full-snapshot hook (stále funguje, zachován)
