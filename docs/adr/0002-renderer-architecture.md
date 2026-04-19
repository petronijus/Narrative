# ADR-0002 — Renderer Architecture

**Status**: Accepted  
**Datum**: 2026-04-19  
**Autor**: renderer agent  
**Milestone**: M1

---

## Context

Narrative potřebuje GPU renderer, který:

1. Zvládne budoucí heavy media (video frames v M12, Lottie rastrování v M25, Three.js render targets v M26).
2. Funguje s mixed DOM overlay targety pro text edit (M2), video v present mode (M12), iframes (M24).
3. Poskytuje předvídatelný lifecycle GPU zdrojů — textury, framebuffery, external rendery.
4. Umožňuje reconciler diff pattern: vstup = immutable slide snapshot, výstup = aplikované mutace na scene graph (M3).
5. Splňuje performance budget: 60 fps / 50 objektů / 10 simultánních animací na mid-range hardware.

Spike A (GSAP + Pixi performance) a Spike C (DOM overlay) ověřily, že zvolený stack tyto požadavky splňuje.

---

## Decision

### 1. PixiJS v8 jako primární render vrstva

Pixi v8 (WebGPU s WebGL fallback) je canvas renderer. Veškerý GPU rendering jde přes Pixi API — žádný přímý WebGL/WebGPU kód v aplikační vrstvě.

Pixi v8 API odlišnosti oproti v7:

- `new Application()` + `await app.init({ ... })` (ne synchronní constructor)
- `app.canvas` (ne `app.view`)
- `resolution: devicePixelRatio, autoDensity: true` pro HiDPI

### 2. SceneGraph jako thin wrapper

`SceneGraph` vlastní root `Pixi.Container` a interní mapu `objectId → {container, data}`. Veřejné API:

```ts
addObject(data: SlideObjectData): void
removeObject(id: string): void
updateObject(id: string, next: SlideObjectData): void
render(objects: SlideObjectData[]): void  // naivní ID diff
destroy(): void
```

V M1 je `render()` voláno z React `useEffect`. V M3 bude driven Yjs reconciler diff engine s batching. SceneGraph API zůstane stejné — změní se pouze volající.

### 3. ResourceManager jako central authority nad GPU zdroji

`ResourceManager` spravuje lifecycle textur přes ref counting:

- `acquireTexture(url)` → load-once, refCount++
- `releaseTexture(url)` → refCount--; při 0 `texture.destroy(true)`
- `destroyAll()` → cleanup na unmount

Object renderers nealokují textury přímo — vždy žádají ResourceManager. Tato invarianta je kritická pro M11 (image uploads) a M12 (video frames).

### 4. Object renderers izolované v `objectRenderers/`

Každý object type má isolated renderer module s rozhraním:

```ts
{ type, mount(data): Container, update(node, prev, next): void, destroy(node): void }
```

M1: `rectangleRenderer` (Graphics fill, žádné textury).  
M2: Registry se rozšíří o `ellipse`, `text` a přesune do `packages/slide-model` jako plné `registerObjectType()` s inspector/schema/hitTest.

### 5. DPR-aware coordinate transforms od začátku

Ze Spike C: `container.toGlobal()` vrací fyzické pixely, CSS pracuje v logical pixelech. Povinná formula:

```ts
cssX = physicalX / devicePixelRatio
```

Implementováno v `coords.ts`. Všechny budoucí DOM overlay implementace (M2+) musí tuto utilitu používat.

### 6. Canvas komponenta: StrictMode safe lifecycle

React 18 StrictMode double-mount v dev módu. Ref guard (`instanceRef`) zabraňuje duplicitní inicializaci. Cleanup v return funkce `useEffect` zničí Pixi Application kompletně: `app.destroy(true, { children: true, texture: true })`.

---

## Alternatives Considered

| Alternativa              | Důvod zamítnutí                                                                                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Konva**                | Slabší podpora heavy media (video, WebGL render targets). Žádný WebGPU path.                                                                                                             |
| **Raw WebGL / WebGPU**   | Příliš low-level pro milestone tempo. Zbytečná reimplementace scene graph, batching, texture management.                                                                                 |
| **Three.js Fiber (r3f)** | Overkill pro 2D slide content. 3D je potřeba jen jako embedded object type (M26), ne jako primární renderer. Three.js bude použit jako offscreen renderer → Pixi texture bridge pro M26. |
| **Pixi v7**              | v8 má WebGPU, lepší TypeScript typy a je aktuálně maintainovaná větev.                                                                                                                   |

---

## Consequences

**Pozitivní:**

- Jasné hranice pro `animation` agent (volá public setters SceneGraph, nikdy nemutuje Pixi přímo) a `state-sync` agent (poskytuje data přes observations, nikdy nepřistupuje k Pixi).
- ResourceManager připravuje půdu pro video (M12) a Lottie (M25) — oba typy budou potřebovat centrální správu GPU zdrojů.
- DPR handling odladěn jednou, znovupoužit ve všech DOM overlay implementacích.
- SceneGraph.render() API je stabilní; přechod z React-driven na Yjs-driven (M3) nevyžaduje změnu API, jen náhradu volajícího.

**Rizika / Known limitations:**

- Performance budget musí být průběžně ověřován — Spike A ukázal rezervu (59.3 fps při 50 tweenech), ale produkční verze s více typy objektů a animacemi bude potřebovat profiling v M6.
- Pixi v8 WebGPU je stále beta API v některých prohlížečích — `preference: 'webgpu'` s WebGL fallback je správná strategie, ale edge cases existují.
- `rectangleRenderer.ts` používá `Symbol` property na Container pro ukládání Graphics reference (netypovatá cesta). V M2 bude nahrazeno čistějším vzorem přes Map nebo custom Container subclass.

---

## Implementace

```
apps/web/src/renderer/
├── Canvas.tsx                   # React mount/unmount, ResizeObserver, StrictMode safe
├── SceneGraph.ts                # Scene graph wrapper, ID diff reconciler
├── ResourceManager.ts           # Texture lifecycle, ref counting
├── types.ts                     # SlideObjectData discriminated union
├── coords.ts                    # DPR-aware world↔screen transforms
└── objectRenderers/
    ├── index.ts                 # Renderer registry
    └── rectangleRenderer.ts    # První object renderer
```

---

## Odkazy

- Spike A: `docs/handoff/spike-a-gsap-pixi.md` — Pixi v8 ObservablePoint edge cases, proxy pattern
- Spike C: `docs/handoff/spike-c-dom-overlay.md` — DPR compensation formula, layered compositor pattern
- M0 Foundation: `docs/handoff/M0-foundation.md`
