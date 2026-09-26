# ADR-0003 — Yjs Slide Model + Object Type Registry

**Status**: Accepted — extended by [ADR 0010](./0010-command-layer-is-the-only-writer.md) on 2026-09-26 (Yjs stays the single source of truth; it is written only through `packages/commands`)  
**Datum**: 2026-04-19  
**Autoři**: state-sync agent (M2 fáze 1)

---

## Context

M2 zavádí Yjs jako single source of truth pro slide state. Před tímto rozhodnutím bylo potřeba vyřešit:

1. Kde žijí TypeScript typy (sdílené across packages)?
2. Jak strukturovat Y.Doc pro jeden slide?
3. Jak obalit mutace aby byl UndoManager funkční a remote changes (M4+) se neundily?
4. Jak vyřešit pnpm workspace symlink problém na Windows?

---

## Rozhodnutí

### 1. Shared types v `@narrative/shared` (pure TypeScript)

Discriminated union `SlideObject = RectangleObject | EllipseObject | TextObject` žije v `packages/shared/src/slide.ts`. Tento package nesmí importovat nic runtime-specifického (žádný Yjs, Pixi, React).

**Alternativa zvažována**: typy přímo v `apps/web/src/renderer/types.ts` (M1 stav). Zamítnuto: renderer by pak vlastnil typy které patří do state vrstvy; packages/slide-model by nemohl importovat bez circular dependency.

### 2. Yjs adapter v `@narrative/slide-model`

`packages/slide-model` je single import point pro všechny Yjs operace. Renderer a editor-ui nesmí importovat Y.Doc přímo — všechno přes `@narrative/slide-model` API.

**Alternativa zvažována**: přímé Y.Doc manipulace v `apps/web`. Zamítnuto: zabíjí testovatelnost (testy musí spustit celou React app) a tvoří neprůhledný state management.

### 3. Y.Array na root doc, ne uvnitř Y.Map

```
doc.getArray('objects')     ← root-level (zvoleno)
doc.getMap('slide').get('objects')  ← nested (zamítnuto)
```

**Problém**: Yjs 13+ Y.Map funguje pro zápis před integrací do Y.Doc, ale čtení (`get()`, `entries()`) vrací undefined/prázdno bez doc kontextu. Y.Array uvnitř Y.Map má navíc observer timing problém s Y.UndoManager na Windows/Node.

**Řešení**: `objects` je root-level `doc.getArray('objects')`. Slide metadata (id) jsou v `doc.getMap('slideMeta')`. Multi-slide deck (M9) rozšíří přidáním Y.Array slidů na root levelu.

### 4. `doc.transact(fn, LOCAL_ORIGIN)` pro všechny mutace

`LOCAL_ORIGIN` je exportovatelný Symbol. UndoManager je konfigurován s `trackedOrigins: new Set([LOCAL_ORIGIN])`. Remote changes přes Hocuspocus (M4) přijdou s jiným originem → nebudou undo-ovány lokálním klientem.

**Alternativa zvažována**: Automerge místo Yjs. Zamítnuto: menší komunita, horší browser performance, žádná Hocuspocus integrace z boxu.

### 5. pnpm workspace symlinks — tsconfig paths fallback

pnpm na Windows vytváří symlinky s Unix cestami (`/d/Narrative/...`) které `open()` syscall na Windows nezvládne. Workspace packages jsou resolvovány přes:

- `tsconfig.json` paths aliasy pro TypeScript compiler
- `vite.config.ts` resolve aliases pro Vite bundler

Package.json `"@narrative/shared": "workspace:*"` zůstává pro dokumentaci záměrů, ale actual resolution jde přes aliasy.

---

## Consequences

### Pozitivní

- Testy pro bindings/mutations/observe jsou čisté unit testy bez React/Pixi
- UndoManager správně filtruje remote changes od M4 dál
- Object type registry (`registerObjectType`) je plugin boundary: renderer, editor-ui, plugin system (M27) přidávají typy bez změny state core

### Negativní / Trade-offs

- Každý nový workspace package musí přidat tsconfig paths alias do každého consumeru (manuální)
- Y.Map standalone (bez doc) nefunguje pro čtení — `plainObjectToYMap()` musí být vždy použita uvnitř `doc.transact()` před insert do Y.Array
- Full re-konverze všech Y.Map na každý Y.Doc update je O(n) — akceptovatelné pro M2, nahradí se inkrementálním diff v M3 reconcileru

### Budoucí milestony

| Milestone | Dopad                                                                                      |
| --------- | ------------------------------------------------------------------------------------------ |
| M3        | Reconciler nahradí `subscribeToObjects` full-reconversion inkrementálním diffem            |
| M4        | `LOCAL_ORIGIN` odliší lokální a remote changes; HocuspocusProvider připojí Y.Doc k serveru |
| M6        | Animation DSL pracuje nad stejným Y.Doc — objekty jsou targets pro GSAP tweeny             |
| M9        | Deck = Y.Array slidů na root doc; slide metadata Y.Map dostane slideIndex/order            |
| M27       | `registerObjectType` se stává veřejným SDK pro plugins                                     |
