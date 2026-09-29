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

| Trigger         | Behaviour                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------- |
| `onEnter`       | Starts at the slide start (position 0 + delay) at any index. Legacy — see the note below. |
| `onClick`       | Pauses the timeline and waits for a click/tap (via `InputBridge`).                        |
| `withPrevious`  | Starts together with the previous step (GSAP position `"<"`).                             |
| `afterPrevious` | Starts when the previous step ends (GSAP position `">"`).                                 |

The first step (index 0) starts at position 0 whatever its trigger
(`compiler.ts` `resolvePosition`). Since agentic-layer A0 (2026-09-26,
released in 0.10.0) the editor creates new steps with `afterPrevious` and offers
`onEnter` only for a step that already has it; existing `onEnter` steps are
kept and play as before, and opening the timeline no longer rewrites them.
(Was: `onEnter` as the default for the first step.)

**onClick without an InputBridge**: if `ctx.inputBridge` is not provided, the timeline still pauses at every click step but nothing resumes it; call `runtime.advance()` by hand. (The compiler's `console.warn` for this case says the opposite — that onClick behaves like afterPrevious and the timeline does not pause; the warning text is wrong as of 2026-09-29, the pause is added unconditionally in `compileSteps`.)

### Where a step sits on the timeline (`layoutAnimationSteps`)

The same positions, as seconds from the slide start, come from
`layoutAnimationSteps` in `@narrative/shared` (`animationTiming.ts`) — not
from this package, because it loads GSAP at import and the server-side
commands need the layout too. The editor's timeline draws its bars there,
`animation.retime` places steps by it, and `query.slide` / `query.object`
report each step's `start` from it (A2.9, 2026-09-29).

A change to `resolvePosition` must change `layoutAnimationSteps` in the
same change: `src/__tests__/timelineLayout.test.ts` compiles step sequences
with `compileSteps` and checks every tween starts where the layout says
(moved here from `apps/web/src/ui/AnimationTimeline.layout.test.ts`).

`onClick` is outside that contract on purpose: the compiler anchors the
click pause at `tl.duration()` (the end of everything before it), the
layout at the previous step's end. The two differ after an overlapping
`withPrevious`, so the timeline draws such a click step earlier than it
plays. Known and not fixed as of 2026-09-29.

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
