# Spike C — DOM Overlay over PixiJS v8

**Status: GO**

Datum: 2026-04-19
Autor: renderer agent
Lokace spike: `spikes/spike-c-dom-overlay/`

---

## Naměřené metriky

| Scénář                   | Metrika              | Hodnota  | Kritérium        | Výsledek |
| ------------------------ | -------------------- | -------- | ---------------- | -------- |
| C1 Pan/Zoom (5 overlays) | Avg jitter           | 0.000 px | < 1 px           | PASS     |
| C1 Pan/Zoom (5 overlays) | Max jitter           | 0.000 px | < 3 px           | PASS     |
| C1 Pan/Zoom (5 overlays) | DOM update avg       | 0.032 ms | —                | —        |
| C1 Pan/Zoom (5 overlays) | Sample count         | 238      | —                | —        |
| C2 Text edit handoff     | Edit mode enter      | true     | musí vstoupit    | PASS     |
| C2 Text edit handoff     | Commit on ESC        | true     | musí commitovat  | PASS     |
| C2 Text edit handoff     | Overlay pointer stop | true     | žádný event leak | PASS     |
| C3 50 overlays perf      | FPS                  | 60 fps   | >= 60 fps        | PASS     |
| C3 50 overlays perf      | DOM update avg       | 0.093 ms | < 4 ms           | PASS     |
| C3 50 overlays perf      | DOM update max       | 0.300 ms | < 8 ms           | PASS     |
| C3 50 overlays perf      | DOM update p95       | 0.200 ms | < 4 ms           | PASS     |

Headless Chromium 1600×900, DPR=1, Windows 11, CPU: testovací stroj.

---

## Klíčová zjištění

### 1. Coordinate transform: `toGlobal()` + DPR compensation

Pixi v8 s `resolution: window.devicePixelRatio, autoDensity: true` interně škáluje `app.stage` hodnotou DPR. `container.toGlobal(new Point(0,0))` vrací souřadnice v _physical_ pixelech (Pixi render space), nikoliv v CSS logical pixelech. CSS `translate()` pracuje v logical pixelech.

**Správná formula:**

```ts
const DPR = window.devicePixelRatio || 1
const global = container.toGlobal(new Point(0, 0))
const cssX = global.x / DPR
const cssY = global.y / DPR
```

Bez tohoto dělení vzniká 2× (nebo DPR×) offset na HiDPI displejích. Headless testy (DPR=1) to neodhalí — nutno ověřit na reálném hardware.

Alternativní přístup: matrix-based transform přímo z `viewport.worldTransform`, který je taktéž v render space. Oba přístupy vyžadují DPR division.

### 2. Jitter = 0 px, ale kritická podmínka: viewport driver a syncOverlays musí být ve stejném RAF ticku

Původní implementace používala:

- Animaci viewportu: vlastní `requestAnimationFrame` smyčka
- Jitter measurement: `setInterval(16ms)`
- DOM sync: třetí RAF smyčka (main loop)

Výsledek: naměřený jitter 12.8 px avg, 98 px max — kompletně způsobený timing driftem mezi timery, ne skutečným positioning bugem.

**Správná architektura:** viewport update, `syncOverlays()`, a jitter measurement musí probíhat v jednom RAF ticku, ve správném pořadí:

```
RAF tick:
  1. Update viewport (vpX, vpY, vpScale → applyViewport)
  2. syncOverlays() — čte toGlobal, píše CSS transform
  3. measureJitter() — getBoundingClientRect() force-reflow, porovná s toGlobal
```

Při tomto pořadí je jitter skutečně 0 px (subpixel rounding noise). `getBoundingClientRect()` force-reflow zaručí committed DOM pozici v témže ticku.

### 3. Event routing: `pointer-events: none` by default, `auto` jen pro aktivní overlay

Pattern funguje spolehlivě:

- `#overlay-layer`: `pointer-events: none` — propadá vše na canvas
- `.overlay-item` v idle: `pointer-events: none`
- `.overlay-item.edit-mode`: `pointer-events: auto` — zachytí typing, stopPropagation pro pointerdown

Klik mimo overlay (na canvas) vyvolá Pixi `pointerdown` → správný deselect/blur. Klik uvnitř overlay je zastaven `stopPropagation` → Pixi ho nevidí. Žádný event leak v obou směrech.

### 4. Focus management

`dblclick` na canvas → hit-test v JS → `enterEditMode()` → `textarea.focus()` volaný v `requestAnimationFrame` callback (ne synchronně) → funguje spolehlivě.

ESC v `textarea` keydown handler → `commitEdit()` → `.blur()` → další DOM click nezpůsobí double-commit (flag `editMode` to chrání).

Keyboard event routing: šipky v edit módu jdou do `textarea` (přirozené chování, overlay má `pointer-events: auto`). Po commitu (blur/ESC) Pixi canvas opět dostává keyboard eventy normálně — nebylo nutné žádné speciální přepínání.

### 5. Font size v zoom

Při zoom `vpScale !== 1` musí DOM `textarea` mít `font-size = baseFontSize * vpScale` aby opticky matchovala Pixi text. Ověřeno v kódu (`ta.style.fontSize = ${28 * vpScale}px`). Při programaticky animovaném zoom by bylo nutné `font-size` aktualizovat v RAF loop pro aktivní overlay (nenaimplementováno v spike, ale pattern je jasný).

### 6. Performance s 50 overlays

DOM update (50× `style.transform = translate(x, y)` + `width`/`height`) průměrně 0.093 ms per frame. Headroom je obrovský — pro 60fps frame budget (16.67ms) jsme na 0.56% budgetu. Toto není bottleneck ani při 200 overlays.

Reflow z `getBoundingClientRect()` v jitter measurement nebude v produkci nutný — jitter měříme jen jako diagnostiku, ve finální implementaci se neměří per-frame.

---

## Doporučení pro layered compositor primitive (M2)

### API návrh

```ts
// Registrace
interface OverlayOptions {
  worldWidth: number // Pixi world units
  worldHeight: number
  zIndex?: number
}

function registerOverlay(
  objectId: string, // Yjs object ID
  pixiContainer: Container, // tracked Pixi object
  domElement: HTMLElement, // caller vytváří element
  opts: OverlayOptions,
): OverlayHandle

// Zrušení
function unregisterOverlay(handle: OverlayHandle): void

// Přepnutí edit módu (pointer-events)
function setOverlayInteractive(handle: OverlayHandle, interactive: boolean): void

// Aktualizace rozměrů po změně textu/obsahu
function updateOverlaySize(handle: OverlayHandle, worldWidth: number, worldHeight: number): void
```

### Coordinate sync strategie

Sync probíhá v main RAF loop `app.ticker.add()` nebo vlastní RAF — vždy JEDEN centrální sync bod, ne per-overlay timery. Pořadí: Pixi render → `syncAllOverlays()` → (volitelně) jitter diagnostika.

### Lifecycle

- `registerOverlay` vkládá element do `#overlay-layer` a přidá do interní mapy.
- `unregisterOverlay` odstraní element, maže z mapy. Žádné dangling references.
- Compositor poslouchá `ResizeObserver` na `#canvas-container` → při resize zavolá `syncAllOverlays()` synchronně.
- Compositor nedrží referenci na Yjs stav — je čistě render vrstva.

### DPR handling v produkci

```ts
// V initPixi nebo jako getter:
const getDPR = () => window.devicePixelRatio || 1;

// V worldToScreen:
const global = container.toGlobal(new Point(0, 0));
return { x: global.x / getDPR(), y: global.y / getDPR(), ... };
```

Při `window` resize může DPR změnit (přesun okna mezi monitory) — compositor musí přepočítat.

---

## Doporučení pro mixed-target animation pipeline (M6)

DOM overlay vrstva potřebuje přijímat GSAP tweeny pro:

- Pozici (ale tu řídí coordinator sync z Pixi world coords, ne přímý GSAP na DOM)
- Opacity / filter efekty overlay elementu
- Font-size při animated zoom

Doporučení: **GSAP nesmí přímo animovat `left`/`top`/`transform` overlay elementů** — to by kolidovalo s coordinate sync z Pixi. GSAP může animovat:

- `opacity` overlay elementu (fade in/out pro edit mode transition)
- `font-size` textarea při zoom animaci
- CSS custom properties pro efekty

Koordinátový transform zůstává výhradně v `syncAllOverlays()` volaném z RAF.

Pro plynulé přechody (enter edit mode): GSAP Timeline `opacity: 0 → 1` na overlay `div`, zatímco Pixi text `alpha: 1 → 0` — obojí ve stejné GSAP Timeline, takže jsou perfektně synchronizované.

---

## Reprodukce

```bash
cd spikes/spike-c-dom-overlay
npm install
# V jednom terminálu:
npx vite --port 5177
# Ve druhém:
node run-tests.mjs
```

Manuální smoke test (Scénář 2 — text editing):

1. `npm run dev` → otevři prohlížeč na `http://localhost:5177`
2. Klikni "Test 2: Text Edit Handoff"
3. Double-click na text ve scéně → textarea se otevře, kurzor aktivní
4. Pište → text v textarea se mění
5. ESC → text commitovan zpět do Pixi, overlay přepnut do idle
6. Klik mimo text → žádný efekt na textarea (je skryta)
7. Zoom kolečkem → opakuj double-click → font size v textarea odpovídá zoom levelu

---

## Další krok

Všechny tři spiky jsou GO:

- Spike A (GSAP + Pixi performance): GO
- Spike B (Yjs scale): GO
- Spike C (DOM overlay): GO

**Fáze -1 validace kompletní. Pokračujeme do M0 foundation.**

M0 deliverables zahrnují layered compositor jako first-class primitiv — implementace může přímo vycházet z pattern ověřeného v tomto spike (`registerOverlay`, DPR-aware `worldToScreen`, single RAF sync loop).
