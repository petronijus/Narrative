# @narrative/animation

Animation engine pro Narrative prezentační platformu.

JSON DSL schema, GSAP compiler, runtime interpreter s triggery, mixed-target dispatch (Pixi + DOM overlay).

---

## Architecture overview

```
AnimationStep[]  (JSON DSL — single source of truth)
       │
       ▼
compileSteps(steps, ctx)    ← packages/animation/src/compiler.ts
       │
       ├── TargetResolver.resolve(objectId)
       │       ├── PixiTargetHandle  (proxy + apply)
       │       └── DomTargetHandle   (HTMLElement)
       │
       ├── getPresetFactory(preset)
       │       ├── fadeIn
       │       └── slideIn
       │
       └── gsap.timeline()   (pausovaný root timeline)
               │
               ▼
       CompiledTimeline { gsapTimeline, dispose }
               │
               ▼
       createAnimationRuntime(steps, ctx)
               │
               └── AnimationRuntime { play, pause, reset, seek, advance, destroy }
```

Celý GSAP kód je zapouzdřen v `packages/animation/` — žádné přímé `gsap.*` volání mimo tento package.

---

## Proxy pattern pro Pixi targets

Pixi v8 `scale` je `ObservablePoint`, ne plain number. GSAP nemůže animovat Pixi objekty přímo (ověřeno Spike A). Engine používá proxy pattern pro všechny Pixi targets:

```ts
// Compiler vytvoří proxy objekt:
const proxy = { x: 0, y: 0, rotation: 0, alpha: 1, scaleX: 1, scaleY: 1 }

// GSAP animuje proxy — plain JS objekt, žádné Pixi:
gsap.to(proxy, {
  alpha: 1,
  onUpdate: () => {
    // Renderer setter kopíruje proxy state na Pixi DisplayObject
    pixiObject.alpha = proxy.alpha
    pixiObject.scale.set(proxy.scaleX, proxy.scaleY)
  },
})
```

`PixiTargetHandle` (dodáván konzumentem přes `TargetResolver`) obsahuje:

- `proxy` — plain JS objekt animovaný GSAP
- `apply()` — callback aplikující proxy na Pixi (volán z `onUpdate`)

DOM targets (`DomTargetHandle`) obdrží `HTMLElement` přímo — GSAP animuje CSS properties a GSAP Flip plugin funguje.

---

## Trigger semantics

| Trigger         | Chování                                                         |
| --------------- | --------------------------------------------------------------- |
| `onEnter`       | Spustí se při vstupu na slide. Výchozí pro první krok.          |
| `onClick`       | Pausuje timeline. Čeká na user klik/tap (přes `InputBridge`).   |
| `withPrevious`  | Spustí se současně s předchozím krokem (GSAP position `"<"`).   |
| `afterPrevious` | Spustí se po dokončení předchozího kroku (GSAP position `">"`). |

**onClick bez InputBridge**: pokud `ctx.inputBridge` není poskytnut, timeline se pausuje ale nikdo ji neresumuje automaticky. `runtime.advance()` lze volat manuálně.

---

## Mixed targets: Pixi vs DOM

Jeden AnimationStep cílí na buď Pixi objekt nebo DOM overlay — ve stejném timeline mohou být oba.

```ts
const steps: AnimationStep[] = [
  // Pixi objekt — proxy pattern
  { id: '1', objectId: 'rect-1', preset: 'fadeIn', trigger: 'onEnter', ... },
  // DOM overlay — přímý CSS
  { id: '2', objectId: 'overlay-title', preset: 'slideIn', trigger: 'withPrevious',
    params: { direction: 'up' }, ... },
]
```

`TargetResolver.resolve(objectId)` vrací buď `PixiTargetHandle` nebo `DomTargetHandle` — engine automaticky dispatchne správný rendering path.

Implementaci `TargetResolver` dodává konzument (PresentLayout nebo editor wrapper). Engine nezná Pixi ani OverlayCompositor přímo.

---

## Jak přidat nový preset (M15+)

1. Vytvořit `packages/animation/src/presets/<name>.ts`:

```ts
import type { AnimationStep, PixiTargetHandle, DomTargetHandle } from '../types.js'
import { gsap } from 'gsap'

type Timeline = ReturnType<typeof gsap.timeline>

export function myPreset(
  step: AnimationStep,
  target: PixiTargetHandle | DomTargetHandle,
  tl: Timeline,
  position: string | number,
): void {
  if (target.kind === 'pixi') {
    // Animuj přes proxy + onUpdate
    tl.fromTo(target.proxy, { /* from */ }, { /* to */, onUpdate: target.apply.bind(target) }, position)
  } else {
    // Animuj CSS properties přímo
    tl.fromTo(target.element, { /* from */ }, { /* to */ }, position)
  }
}
```

2. Přidat do `src/presets/index.ts` registry:

```ts
import { myPreset } from './myPreset.js'
// ...
const PRESET_REGISTRY = new Map<AnimationPreset, PresetFactory>([
  ['fadeIn', fadeIn],
  ['slideIn', slideIn],
  ['myPreset', myPreset], // <-- přidat
])
```

3. Přidat do `AnimationPreset` union v `packages/shared/src/animation.ts`:

```ts
export type AnimationPreset = 'fadeIn' | 'slideIn' | 'myPreset'
```

4. Napsat unit test v `src/__tests__/presets/myPreset.test.ts`.

---

## GSAP Flip plugin

Flip plugin (`gsap/Flip`) funguje **pouze na DOM elements** — validní pro `DomTargetHandle` targets.

Pro Pixi objects (Magic Move v M13) bude implementován manual flip pattern:

1. `engine.flipSnap(objectIds)` — snapshot Pixi state
2. Renderer aplikuje nový layout
3. `engine.flipFrom(snapshot, duration, ease)` — tween proxy from snapshot k aktuálnímu stavu

Viz `docs/handoff/spike-a-gsap-pixi.md` sekce "Test 3" pro detaily.

---

## Veřejné API

```ts
import {
  // Runtime
  createAnimationRuntime,
  type AnimationRuntime,

  // Compiler (nízkoúrovňové)
  compileSteps,
  type CompiledTimeline,

  // DSL types (re-exportováno z @narrative/shared)
  type AnimationStep,
  type AnimationPreset,
  type AnimationTrigger,

  // Engine context types
  type AnimationContext,
  type TargetResolver,
  type PixiTargetHandle,
  type DomTargetHandle,
  type InputBridge,

  // InputBridge implementace
  createClickInputBridge, // browser click events
  createManualInputBridge, // testy / custom integrace

  // Preset factories (pro DSL generátory / AI agent M16)
  fadeIn,
  slideIn,
  getPresetFactory,
  type PresetFactory,
} from '@narrative/animation'
```

---

## Pro konzumenty — wiring TargetResolver

PresentLayout (fáze 2, M6) musí dodat:

```ts
const resolver: TargetResolver = {
  resolve(objectId: string): PixiTargetHandle | DomTargetHandle | null {
    // Zkus Pixi registry (renderer SceneGraph)
    const pixiObj = sceneGraph.getObject(objectId)
    if (pixiObj) {
      return {
        kind: 'pixi',
        proxy: {
          x: pixiObj.x,
          y: pixiObj.y,
          rotation: pixiObj.rotation,
          alpha: pixiObj.alpha,
          scaleX: pixiObj.scale.x,
          scaleY: pixiObj.scale.y,
        },
        apply() {
          pixiObj.x = this.proxy.x
          pixiObj.y = this.proxy.y
          pixiObj.alpha = this.proxy.alpha
          pixiObj.scale.set(this.proxy.scaleX, this.proxy.scaleY)
        },
      }
    }
    // Zkus DOM overlay
    const overlayEl = overlayCompositor.getElement(objectId)
    if (overlayEl) return { kind: 'dom', element: overlayEl }
    return null
  },
}
```
