# M1 — Scene graph + resource manager

**Status**: Done  
**Datum**: 2026-04-19  
**Agent**: renderer

---

## Co bylo hotovo

- **PixiJS v8** namountován v React `<Canvas />` komponentě s full lifecycle (mount/unmount, StrictMode safe, ResizeObserver, HiDPI)
- **ResourceManager** — centrální správce GPU zdrojů s ref counting; API stabilní pro M11 (image uploads) a M12 (video)
- **SceneGraph** — thin wrapper nad Pixi Container; naivní ID diff reconciler (render/add/update/remove); připraven pro Yjs-driven reconciler v M3
- **RectangleRenderer** — první object renderer; Pixi Graphics fill; pivot na středu
- **Renderer registry** — Map<type, renderer> v `objectRenderers/index.ts`
- **DPR transforms** — `coords.ts` s `worldToScreen` / `screenToWorld`; DPR compensation povinná pro HiDPI konzistenci
- **Demo slide data** — dva hardcoded obdélníky v `data/demoSlide.ts`
- **EditorLayout** — center canvas placeholder nahrazen `<Canvas slideData={demoSlide} />`
- **19 unit testů** — ResourceManager (10) + SceneGraph (9); všechny zelené
- **ADR-0002** — renderer architecture dokumentace

---

## Klíčová rozhodnutí

### StrictMode safety

React 18 double-mount v dev módu. Řešení: `instanceRef` ref guard v mount useEffect. Pokud instance existuje, druhý mount ji přeskočí. Cleanup v return funkci efektu zničí Pixi Application kompletně.

```tsx
if (instanceRef.current !== null) return // StrictMode guard
```

### Pixi v8 API

- `new Application()` + `await app.init({ ... })` — asynchronní init
- `app.canvas` (ne `app.view` jako v Pixi v7)
- `resizeTo: containerEl` — Pixi sám sleduje resize parent elementu (ale ResizeObserver je navíc pro jistotu)
- `build.target: 'esnext'` v Vite config — top-level await vyžaduje ESNext target (Spike A nález)

### DPR compensation (Spike C)

`container.toGlobal()` vrací fyzické pixely, CSS pracuje v logical pixelech. Povinná formula:

```ts
cssX = physicalX / devicePixelRatio
```

Implementováno v `coords.ts`. Všechny budoucí DOM overlay implementace (M2+) musí tuto utilitu používat.

### Rect renderer a Symbol property

`rectangleRenderer` ukládá referenci na Graphics objekt přes Symbol property na Container (nutné pro update/destroy). Toto vyžaduje `any` cast s komentářem. V M2 bude vylepšeno přes Map nebo custom Container subclass.

### Vitest na Windows

pnpm hoisting na Windows nevytváří `.bin/vitest` binary. Řešení: `test` script volá `node ../../node_modules/vitest/vitest.mjs run` přímo. `pnpm -r test` zelená.

---

## Jak ověřit stav

```bash
# 1. Install (pokud ne hotovo)
pnpm install

# 2. Typecheck — musí být čistý
pnpm -r typecheck

# 3. Lint — musí být čistý
pnpm -r lint

# 4. Testy — 19/19 zelené
pnpm -r test

# 5. Build — Pixi bundlován do dist/
pnpm -r build

# 6. Vizuální smoke test
pnpm --filter @narrative/web dev
# Otevři http://localhost:5173
# Vidíš: 3-pane layout
# V centru: Pixi canvas s průhledným pozadím
# Na canvasu: modrý obdélník (rect-1, 300×200) a červený obdélník (rect-2, 180×120, rotovaný, opacity 0.8)
```

---

## Struktura renderer vrstvy

```
apps/web/src/renderer/
├── Canvas.tsx                   # React mount/unmount, ResizeObserver, StrictMode safe
├── SceneGraph.ts                # Scene graph wrapper, ID diff reconciler
├── ResourceManager.ts           # Texture lifecycle, ref counting
├── types.ts                     # SlideObjectData discriminated union
├── coords.ts                    # DPR-aware world↔screen transforms
├── ResourceManager.test.ts      # 10 unit testů
├── SceneGraph.test.ts           # 9 unit testů
└── objectRenderers/
    ├── index.ts                 # Renderer registry (Map<type, renderer>)
    └── rectangleRenderer.ts    # Graphics fill renderer
apps/web/src/data/
└── demoSlide.ts                 # Hardcoded demo data pro M1
```

---

## Další krok

**M2 — Yjs od začátku + object type registry + DOM overlay**

- Y.Doc v paměti, slide = Y.Map, objects = Y.Array
- `registerObjectType` registry s rectangle, ellipse, text typy
- Přesun `SlideObjectData` discriminated union do `packages/shared/`
- DOM overlay primitive pro text edit (positioning + focus management)
- Inspector panel s editovatelnými properties
- Drag na canvas vytvoří objekt přes Y.Doc transaction

Dispatch: `state-sync` + `renderer` agenti (koordinace potřebná pro registry API)

---

## Známé TODO / Technical debt

1. **Symbol property v rectangleRenderer** — `any` cast pro Graphics referenci. Vylepšit v M2 přes Map<Container, Graphics> nebo WeakMap.
2. **objectRenderers/index.ts registry** — `any` pro generické varianty ObjectRenderer. Finální typování přijde s plnou `registerObjectType()` API v M2.
3. **ResizeObserver redundantní** — Pixi `resizeTo` option sám sleduje resize. ResizeObserver navíc explicitně volá `app.renderer.resize()` — double coverage. Bezpečné, ale lze zjednodušit.
4. **Canvas.tsx: `app.renderer.resize()` vs `resizeTo`** — Pixi `resizeTo` option by měl stačit. V M2 ověřit zda ResizeObserver volání není zbytečné.
5. **`coords.ts screenToWorld`** — Zatím netestovaný a nepoužitý. Bude potřeba v M2 pro hit testing (klik na canvas → world koordináty).

---

## Závislosti přidané v M1

| Package   | Verze   | Kde                        | Justification                                               |
| --------- | ------- | -------------------------- | ----------------------------------------------------------- |
| `pixi.js` | ^8.9.2  | `apps/web` dependencies    | Hlavní GPU renderer. WebGL/WebGPU. Ověřen v Spike A.        |
| `vitest`  | ^3.1.2  | `apps/web` devDependencies | Test runner kompatibilní s Vite config.                     |
| `jsdom`   | ^26.1.0 | `apps/web` devDependencies | Browser environment emulace pro unit testy renderer vrstvy. |

---

## Commit

`feat(m1): scene graph + resource manager + pixi canvas`

---

## Odkazy

- **ADR-0002**: `docs/adr/0002-renderer-architecture.md`
- **Spike A**: `docs/handoff/spike-a-gsap-pixi.md` — Pixi v8 edge cases, esnext target
- **Spike C**: `docs/handoff/spike-c-dom-overlay.md` — DPR compensation formula
- **M0**: `docs/handoff/M0-foundation.md` — co bylo připraveno
