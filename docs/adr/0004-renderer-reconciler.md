# ADR-0004: Renderer reconciler — batched incremental observer + surgical apply

**Status:** Accepted
**Date:** 2026-04-19
**Supersedes:** částečně ADR-0002 (renderer architecture) — reconciler pattern teď explicitně oddělen

## Context

Po M2 `SceneGraph.render(objects: SlideObject[])` provádělo ID-based diff proti vlastní `nodes` Map. Vstup: **plný snapshot** plain SlideObject[] z Yjs observeru na každou deep-observe událost. Problémy:

1. **Full snapshot per mutation.** Jeden drag (~60 mutations/s) = 60 full conversion Y.Map → SlideObject[] × N objektů. GC churn, CPU spike.
2. **Renderer nevidí co se přesně změnilo.** `update(node, fullData)` musel porovnávat kompletní objekty nebo rebuildnout celý node — nebyl efektivní pro "changed x, y" scénář.
3. **Žádný batching.** React re-render triggoval 60× per rAF, i když scéna měla dostávat update 1× per rAF.

Cíl M3: **čistý diff engine** s oddělenou observer vrstvou (state-sync) a render vrstvou (renderer), spojenou stabilním API.

## Decision

### 1. Observer vrstva emituje `ObjectChangeSet` s per-frame batching

```ts
interface ObjectChangeSet {
  added: SlideObject[]
  removed: string[]
  updated: Array<{ id: string; patch: Partial<SlideObject> }>
  snapshot: SlideObject[] // full snapshot pro UI konzumenty
}
```

`subscribeToObjectChanges(ctx, callback)` v `@narrative/slide-model`:

- Yjs deep-observe events → delta extraction → pending changes Map
- `requestAnimationFrame` flush → callback(changeSet) jednou per tick
- **Initial emission synchronně** po subscribe (callback se volá v subscribe samotném)
- Coalescing: multi-patch na stejný objekt v jednom tick sloučen do jednoho `updated` entry
- Add+remove stejného ID v jednom tick = no emission (net zero)

`subscribeToObjectChangesWithFlush` varianta s explicit `flush()` pro testy (synchronní emise).

### 2. Renderer přidává `applyChanges` + `applyPatch`

```ts
class SceneGraph {
  applyChanges(changes: ObjectChangeSet): void // remove → add → update pořadí
  render(objects: SlideObject[]): void // backward compat, stále funkční
}

interface ObjectRenderer<T> {
  mount(data: T): Container
  update(node: Container, data: T): void
  applyPatch?(node: Container, patch: Partial<T>): void // nový, optional
  destroy(node: Container): void
}
```

Všechny 3 builtin renderers implementují `applyPatch`:

- **rectangle/ellipse**: fill change → redraw Graphics; position/rotation/opacity → set property only
- **text**: text/fontSize/color/weight/align/width → in-place TextStyle mutation (ne new TextStyle object); position → set property

`nodeTypes: Map<string, SlideObjectType>` track type per node pro efektivní renderer lookup při apply.

### 3. Canvas.tsx přechází z `useSlideObjects() → render()` na `useSlideObjectChanges() → applyChanges()`

`useSlideObjects` (full snapshot hook) **zůstává** pro UI komponenty (Inspector, Toolbar, atd.) — granularity incremental changes je zbytečná pro komponenty co se renderují na celý snapshot. Dva hooky, dva use cases.

### 4. Buffer pro init race

Canvas přijde subscribe synchronně → `useSlideObjectChanges` callback může vypálit před dokončením `await app.init()`. Buffer `pendingChangesRef` nashromáždí pre-init emise, flush se volá ihned po init. Žádný lost update.

## Alternatives considered

1. **Observable snapshot s useSyncExternalStore + shallow equality.** Každá mutace vytvoří novou immutable snapshot; React dedupe přes shallowEqual. Problém: stále full reconversion per mutation. Nevyřešilo root cause.

2. **Structural sharing (immer.js style).** Dělá granular diff při apply patche, ale mezi Yjs a plain form by to byl triple conversion. Overkill.

3. **React concurrent features (useDeferredValue).** Odloží render, ale stále řeší kosmetický problém UI. Nerešilo GC v observer vrstvě.

4. **MobX-style proxies nad Y.Doc.** Auto-track property access, reactive updates. Zrušeno: přidává 3. paradigma (Yjs CRDT + MobX + React) co už máme dvě (CRDT + React) — složitější než zisk.

5. **Plný virtual DOM diff (react-reconciler pro Pixi).** Existuje `react-pixi`. Zrušeno v ADR-0002: oddělený render loop + resource manager + Yjs observer layer se lépe škáluje pro heavy media v budoucích milestonech.

## Consequences

**Pozitivní:**

- Drag operation: 1 rAF tick = 1 `applyChanges` volání = 1 surgical patch. Benchmark: **16.3× rychlejší** než původní full-update cesta (964k vs. 59k ops/s pro drag simulaci).
- Renderer updates vědí konkrétně co se změnilo → možná optimalizace per renderer (text: ne rebuild TextStyle na x change).
- Jasná package hranice: `@narrative/slide-model` emituje změny, `renderer` je aplikuje. Kontrakt přes `ObjectChangeSet` typ.
- Budoucí AI server-side client (M16) konzumuje stejný observer layer bez rendereru.

**Negativní:**

- Dvě subscribe API (`subscribeToObjects` + `subscribeToObjectChanges`) — ukládací composition, ale udržovaný kód. Plus: hooks se nikdy nepovolí vzájemně míchat (každý konzument si vybere variant, nekombinuje).
- Canvas má pre-init buffer logiku (`pendingChangesRef`). Kosmetické, ale je to zapotřebí protože subscribe je synchronní a `app.init()` je async.
- Batching v rAF znamená **1 frame latence** mezi mutation a render. Pro editor UX neregistrovatelná (<16ms). Pro performance testy nutno flush() synchronně.

**Performance budget od M3:**

- Drag 60 Hz: 1 flush/frame, <0.5ms scene update time.
- Bulk create (např. paste 50 objektů): 1 flush s 50 added, jeden `mount` loop, žádný per-object React render.

## Status

Accepted — implementováno v M3 commit (bude tech-lead commit hash). Reconciler pattern je závazný pro všechny budoucí object types a pro M4+ remote sync (remote updates projdou stejným observer + applyChanges pipeline).
