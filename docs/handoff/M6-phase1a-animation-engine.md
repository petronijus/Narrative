# M6 Fáze 1a — Animation Engine Core

**Datum**: 2026-04-19
**Agent**: animation
**Status**: DONE — tsc clean, 25/25 testů

---

## Co bylo implementováno

### packages/shared/src/animation.ts (NOVÝ)

Sdílený DSL schema — kontrakt mezi animation engine, state-sync a AI agentem (M16):

- `AnimationPreset` union: `'fadeIn' | 'slideIn'`
- `AnimationTrigger` union: `'onEnter' | 'onClick' | 'withPrevious' | 'afterPrevious'`
- `AnimationStep` interface (id, objectId, preset, trigger, duration, delay, easing, params)
- Type guards: `isAnimationPreset()`, `isAnimationTrigger()` (přidány linterem)

### packages/animation/src/ (engine core)

| Soubor               | Obsah                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`           | Re-export z shared + engine-only types (CompiledTimeline, PixiTargetHandle, DomTargetHandle, TargetResolver, InputBridge, AnimationContext) |
| `compiler.ts`        | `compileSteps(steps, ctx) → CompiledTimeline` — DSL → GSAP timeline                                                                         |
| `runtime.ts`         | `createAnimationRuntime(steps, ctx) → AnimationRuntime` (play/pause/reset/seek/advance/destroy)                                             |
| `inputBridge.ts`     | `createClickInputBridge(element)` + `createManualInputBridge()`                                                                             |
| `presets/fadeIn.ts`  | fadeIn factory — Pixi proxy alpha + DOM opacity                                                                                             |
| `presets/slideIn.ts` | slideIn factory — direction up/down/left/right, slide+fade combo                                                                            |
| `presets/index.ts`   | Preset registry s `getPresetFactory()`                                                                                                      |
| `index.ts`           | Veřejné API exports                                                                                                                         |

### Testy

- `src/__tests__/compiler.test.ts` — 5 testů (fadeIn, afterPrevious, withPrevious, onClick/advance, null target skip)
- `src/__tests__/presets/fadeIn.test.ts` — 4 testy (proxy alpha, onUpdate, DOM opacity, duration/easing)
- `src/__tests__/presets/slideIn.test.ts` — 10 testů (4 directions Pixi, custom distance, alpha combo, 4 directions DOM)
- `src/__tests__/runtime.test.ts` — 6 testů (play/pause/reset/seek/advance/destroy)

---

## Veřejné API (exports z @narrative/animation)

```ts
// Runtime
createAnimationRuntime, type AnimationRuntime

// Compiler
compileSteps, type CompiledTimeline

// DSL types (re-export z @narrative/shared)
type AnimationStep, type AnimationPreset, type AnimationTrigger

// Engine context
type AnimationContext, type TargetResolver
type PixiTargetHandle, type DomTargetHandle, type InputBridge

// InputBridge
createClickInputBridge, createManualInputBridge

// Presets
fadeIn, slideIn, getPresetFactory, type PresetFactory
```

---

## Závislosti přidány

| Package        | Verze     | Důvod                                                               |
| -------------- | --------- | ------------------------------------------------------------------- |
| `gsap`         | `^3.12.5` | Animation engine runtime (free licence od 2024 po Webflow akvizici) |
| `vitest` (dev) | `^2.0.0`  | Unit testy, jsdom environment pro DOM target testy                  |

GSAP je hoistovaný v root `node_modules/` — dostupný bez lokálního install v animation package.

---

## Architektonická rozhodnutí

### Proxy pattern jako povinný pro Pixi (ze Spike A)

GSAP animuje plain JS `proxy` objekt. `onUpdate` kopíruje na Pixi. Důvod: Pixi v8 `scale` je `ObservablePoint`. Přímý `gsap.to(pixiObject, { scale: 1.5 })` není spolehlivý. Proxy pattern je konzistentní pro všechny Pixi properties.

### gsap.core.Timeline typ

`gsap.core` je ambient namespace (ne named export). Nelze importovat `import type { core } from 'gsap'`. Engine používá `ReturnType<typeof gsap.timeline>` jako Timeline typ. Funguje čistě bez type hacks.

### tsconfig paths pro @narrative/shared

Shared package exportuje `.ts` soubory přímo (bez build step). tsc path mapping `"@narrative/shared": ["../shared/src/index.ts"]` + `include: ["../shared/src"]` řeší resolution. Vitest resolvuje přes Vite bundler automaticky.

---

## Co fáze 2 (PresentLayout) potřebuje od renderer strany

Aby PresentLayout mohl sestavit `TargetResolver`, potřebuje:

1. **Od SceneGraph / renderer**: `sceneGraph.getObject(objectId) → PixiDisplayObject | null`
   - V M3 renderer reconciler drží registry objektů — potřebuje getter pro external consumption.

2. **Od OverlayCompositor**: `compositor.getElement(overlayId) → HTMLElement | null`
   - M3 spike C implementoval `registerOverlay(opts) → handle`. Handle musí mít `.element` nebo compositor potřebuje `getElement(id)` metodu.

3. **InputBridge**: PresentLayout volá `createClickInputBridge(document.body)` — žádné nové závislosti.

Kontrakt viz README sekce "Pro konzumenty — wiring TargetResolver".

---

## Co state-sync agent (fáze 1b) dodá

Podle `docs/handoff/M6-phase1b-animation-schema.md` (pokud existuje):

- Y.Doc `animations` array na slide dokumentu
- Binding `AnimationStep[]` ↔ Y.Array
- Change observable pro PresentLayout (react na DSL update)

Engine konzumuje `AnimationStep[]` — je mu jedno odkud pochází (Y.Doc binding nebo jiný zdroj).

---

## Jak spustit testy

```bash
# Z root Narrative/
node_modules/.bin/vitest run --root packages/animation --config packages/animation/vitest.config.ts

# Typecheck
node_modules/.bin/tsc --noEmit -p packages/animation/tsconfig.json
```

---

## Soubory

```
packages/animation/
├── package.json          (gsap + vitest deps)
├── tsconfig.json         (DOM lib, paths pro @narrative/shared)
├── vitest.config.ts      (jsdom environment)
├── README.md             (architecture overview)
└── src/
    ├── index.ts          (public API)
    ├── types.ts          (engine types)
    ├── compiler.ts       (DSL → GSAP)
    ├── runtime.ts        (lifecycle runtime)
    ├── inputBridge.ts    (click + manual bridges)
    └── presets/
        ├── index.ts      (registry)
        ├── fadeIn.ts
        └── slideIn.ts
packages/shared/src/
    └── animation.ts      (DSL schema — NOVÝ)
```
