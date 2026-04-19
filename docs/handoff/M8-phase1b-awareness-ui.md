# M8 Phase 1b — Awareness UI Handoff

**Date:** 2026-04-19
**Agent:** editor-ui
**Milestone:** M8 — Real-time collaboration awareness
**Phase:** 1b (UI layer — konsumuje state-sync fáze 1a)

---

## Co bylo implementováno

### Nové UI komponenty

**`apps/web/src/ui/PeerCursors.tsx`**

- Remote peer cursors jako DOM overlays přes OverlayCompositor
- SVG šipka (14×18px) s name labelem v peer barvě
- Lifecycle management přes `Map<clientId, PeerOverlayEntry>`
- Renderuje `null` — side-effecty přes OverlayCompositor
- Cleanup na unmount i na peer/cursor změnu
- `pointer-events: none` — neblokuje canvas input

**`apps/web/src/ui/PeerSelectionOverlays.tsx`**

- Dashed SVG outlines pro objekty, které mají remote peeri vybrané
- Barva outline = `peer.state.user.color`
- Stacking pro multi-peer overlap: každý peer posune svůj outline o 4px ven
- Tooltip (`<title>`) na každém polygonu s jmény peerů, kteří mají daný objekt
- Pozicování přes `sceneGraph.getBounds(id).corners` (rotation-aware)

**`apps/web/src/ui/AvatarChips.tsx`**

- Avatar chips v toolbaru (pravá strana) pro všechny connected peery
- Kruh 26px, iniciály (první 2 znaky), background = peer.color
- Lokální peer má white ring outline + "(you)" v tooltip
- Max 5 viditelných, zbytek jako "+N" overflow chip s popoverem
- Popover: backdrop div + listbox s jmény přeflowlých peerů
- `role="list"` + `role="listitem"` + `aria-label` pro accessibility

### Modifikované soubory

**`apps/web/src/components/EditorLayout.tsx`**

- Import `PeerCursors`, `PeerSelectionOverlays`, `useAwarenessUpdater`
- M8 selection broadcast: `useEffect(() => setSelection([...selectedIds]), [selectedIds])`
- M8 cursor broadcast: `setCursor({ x, y })` na každý `pointermove` (throttle na state-sync straně)
- `handlePointerLeave` → `setCursor(null)` při opuštění canvas containeru
- `<PeerSelectionOverlays />` vložen do canvas container (před TransformHandles)
- `<PeerCursors />` vložen jako poslední child canvas containeru

**`apps/web/src/ui/Toolbar.tsx`**

- Import + render `<AvatarChips />` napravo od spaceru (levý od Preview/Present tlačítek)

### Stub soubory (nahradit po state-sync dodání)

Původní stub `useAwareness.ts` a `useAwarenessUpdater.ts` byly přepsány state-sync agentem
se skutečnou implementací během stejné session. Jsou tedy finální — **nesmazávat**.

- `apps/web/src/state/useAwareness.ts` — `useSyncExternalStore` nad `Y.Awareness`
- `apps/web/src/state/useAwarenessUpdater.ts` — trailing RAF throttle cursor, merge pattern

---

## Architektonické poznámky

### PeerCursors + OverlayCompositor coupling

`PeerCursors` přistupuje k `sceneGraph.root` přes unsafe cast:

```ts
const rootContainer = (sceneGraph as unknown as { root: Container }).root
```

Důvod: SceneGraph nemá public `root` accessor. Alternativy:

1. Přidat `get rootContainer()` do SceneGraph (čistší — doporučeno pro M9)
2. Přidat `registerRawOverlay(element, worldCoords)` do OverlayCompositor
   (bypass Pixi Container úplně — nejčistší pro cursor use-case)

Pro M8 funkční, pro M9+ refaktorizovat.

### Cursor positioning model

`cursor.x, cursor.y` jsou world coords (slide space). OverlayCompositor
pozicuje přes `worldOffset` na root Pixi Container (který je na world 0,0).
Tím worldOffset přímo = cursor pozice. Funguje pro M8 bez zoom/pan.

**M9 (zoom/pan):** Při přidání viewport transform bude potřeba transformovat
cursor world coords přes viewport matrix. OverlayCompositor by měl zvládnout
automaticky přes `toGlobal()` chain — potvrdit v M9 spike.

### PeerSelectionOverlays — SVG vs. Canvas

M8 používá SVG polygon přes absolutní overlay (stejný přístup jako TransformHandles).
Pro 15 peerů × max 20 objektů = 300 polygonů — SVG je dostatečné.
Pokud by vznikl výkonnostní problém, přesunout do OverlayCompositor Canvas layer.

---

## Tests

**Přidané test soubory:**

- `apps/web/src/ui/AvatarChips.test.tsx` — 8 testů
- `apps/web/src/ui/PeerCursors.test.tsx` — 7 testů
- `apps/web/src/ui/PeerSelectionOverlays.test.tsx` — 9 testů

**Výsledek:** 319/319 testů prochází (celá test suite), 0 regresí.

---

## Known limitations

1. `sceneGraph.root` přístup přes unsafe cast — refaktorizovat v M9
2. Cursor koordináty jsou world space bez zoom/pan kompenzace — M9
3. Overflow popover nemá focus trap — M29 polish (accessibility)
4. Peer cursor SVG šipka je inline HTML string (ne React SVG) — rendering v DOM overlay
   vyžaduje innerHTML (OverlayCompositor přijímá HTMLElement, ne ReactNode)
5. TS chyby v `SlideDocProvider.tsx` a testech jsou pre-existující ze state-sync fáze 1a
   — netýkají se editor-ui kódu, řeší state-sync agent

---

## Napojení na state-sync (co se konzumuje)

- `useAwareness()` → `{ peers, remotePeers, localClientId }` — hook z `state/useAwareness.ts`
- `useAwarenessUpdater()` → `{ setCursor, setSelection }` — hook z `state/useAwarenessUpdater.ts`
- `PeerInfo`, `PeerUser`, `PeerCursor`, `PeerAwarenessState` — typy z `@narrative/shared`

**Žádný přímý import HocuspocusProvider, Y.Awareness, nebo y-protocols.**

---

## Další kroky (M9+)

- Přidat `get rootContainer(): Container` do `SceneGraph.ts`
- Zoom/pan viewport transform → cursor positioning update
- M10: `localUser.name` a `localUser.color` z auth tokenu (nahradí placeholder)
- M29: Focus trap v overflow popoveru, konflikty editace UI
