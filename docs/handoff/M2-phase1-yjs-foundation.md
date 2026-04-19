# M2 fáze 1 — Yjs Foundation + Object Type Registry

**Status**: Done  
**Datum**: 2026-04-19  
**Agent**: state-sync  
**Commit**: viz git log (feat(m2): yjs foundation + object type registry + shared types)

---

## Co je hotové v této fázi

### `packages/shared/src/slide.ts`

Discriminated union typů:

- `RectangleObject`, `EllipseObject`, `TextObject` extends `BaseSlideObject`
- `SlideObject = RectangleObject | EllipseObject | TextObject`
- `SlideObjectType`, `SlideObjectPatch<T>`, `Slide`
- Čistý pure TS, nulové runtime závislosti

### `packages/slide-model/src/`

- **registry.ts** — `registerObjectType`, `getObjectTypeDef`, `listRegisteredTypes`; duplicátní registrace → chyba
- **yDoc.ts** — `createSlideDoc()` vrací `{ doc, slideMeta, objects }`; `objects` je root-level Y.Array (viz ADR-0003 proč ne uvnitř Y.Map)
- **bindings.ts** — `yMapToPlainObject`, `plainObjectToYMap`, `plainObjectToYMapInDoc` (pro testy)
- **mutations.ts** — `addObject`, `removeObject`, `updateObject`, `createObjectOfType`; vše obaleno v `doc.transact(fn, LOCAL_ORIGIN)`
- **undo.ts** — `createUndoManager(ctx)` s filtrováním na `LOCAL_ORIGIN`
- **observe.ts** — `subscribeToObjects(ctx, callback)` s deep observe; vrací unsubscribe
- **index.ts** — re-exportuje vše + registruje 3 builtin typy (rectangle, ellipse, text)

### 31 testů v `packages/slide-model/src/`

- `registry.test.ts` (6)
- `bindings.test.ts` (6)
- `mutations.test.ts` (13 — včetně undo/redo, remote origin non-undoable)
- `observe.test.ts` (6)

### `apps/web/src/state/`

- **slideDocContext.ts** — React context (separátní soubor kvůli react-refresh)
- **SlideDocProvider.tsx** — mount/unmount lifecycle, demo seed na startu
- **useSlideDoc.ts** — hook pro přístup ke kontextu
- **useSlideObjects.ts** — hook vracející `{ objects: SlideObject[], mutationCtx }`

### Refactor renderer

- `renderer/types.ts` — re-exportuje z `@narrative/shared` (zpětná kompatibilita)
- `SceneGraph.ts` — přechod na `SlideObject` z `@narrative/shared`; ellipse/text bez renderer → `console.warn` + skip (sane fallback)
- `Canvas.tsx` — odstraněna `slideData` prop, čte z `useSlideObjects()`
- `EditorLayout.tsx` — Canvas bez prop, SlideDocProvider obaluje App
- `data/demoSlide.ts` — přejmenováno na `demoObjects`, slouží jen jako seed input

### Konfigurace

- vite.config.ts — alias `@narrative/slide-model` přidán
- apps/web/tsconfig.json — paths pro `@narrative/slide-model`
- packages/slide-model/tsconfig.json — paths pro `@narrative/shared`, odstraněn rootDir (cross-package imports)
- packages/slide-model/vitest.config.ts — resolve alias pro testy
- ADR-0003 — `docs/adr/0003-yjs-slide-model.md`

---

## Co není hotové a co zbývá pro fázi 2

### Renderer agent

- **EllipseObject renderer** — `ellipseRenderer.ts` v `objectRenderers/`
- **TextObject renderer** — `textRenderer.ts` s DOM overlay primitiv (Spike C API)
- DOM overlay positioning pro text edit (coords.ts DPR compensation)
- Registrace ellipse/text rendererů v `objectRenderers/index.ts`

### Editor-UI agent

- **Toolbar** — tlačítka pro vytvoření objektu (volá `createObjectOfType` z mutations API)
- **Pointer events pro drag** — hit testing, drag handling, `updateObject` s novou pozicí
- **Inspector panel** — editovatelné properties (volá `updateObject` s patchem)
- Keyboard shortcut Cmd+Z / Cmd+Y pro undo/redo (přes `undoManager` z `useSlideDoc()`)

### M3 (future)

- Inkrementální reconciler v `subscribeToObjects` — nahradí full O(n) re-konverzi

---

## Jak ověřit stav

```bash
# Testy
pnpm -r test
# Očekáváno: 31 slide-model + 19 apps/web = 50 zelených

# Typecheck
pnpm -r typecheck
# Očekáváno: všechny zelené (6 packages)

# Lint
pnpm -r lint
# Očekáváno: no errors

# Build
pnpm -r build
# Očekáváno: vite build zelený

# Dev server — vizuální smoke test
pnpm --filter @narrative/web dev
# http://localhost:5173
# Vidíš stejný view jako M1: modrý obdélník + červený rotovaný obdélník
# DevTools Console: "[Canvas] Pixi initialized, Y.Doc observer active"
# Data teď procházejí Y.Doc → subscribeToObjects → useSlideObjects → SceneGraph.render()
```

---

## Klíčové architektonické poznatky

### Y.Map standalone nefunguje pro čtení

Yjs 13+: `new Y.Map()` bez integrace do Y.Doc vrací `undefined` pro `get()` a prázdno pro `entries()`. `plainObjectToYMap()` je určena pouze pro insert do `Y.Array.push()` uvnitř `doc.transact()`. Test helper `plainObjectToYMapInDoc()` zajišťuje doc kontext před čtením.

### Y.Array na root doc (ne uvnitř Y.Map)

`doc.getArray('objects')` je robustnější než `doc.getMap('slide').get('objects')`. Viz ADR-0003 pro detaily.

### pnpm workspace symlinks na Windows

pnpm vytváří symlinky s Unix cestami které Windows open() syscall nezvládne. Workspace packages jsou resolvovány přes tsconfig paths + vite aliases, ne přes symlinky.

---

## Závislosti přidané v M2 fázi 1

| Package  | Verze    | Kde                    | Justification                             |
| -------- | -------- | ---------------------- | ----------------------------------------- |
| `yjs`    | ^13.6.27 | `packages/slide-model` | CRDT engine, single source of truth od M2 |
| `nanoid` | ^5.0.9   | `packages/slide-model` | URL-safe ID generátor pro objekty a slidy |

---

## Odkaz na ADR

- **ADR-0003**: `docs/adr/0003-yjs-slide-model.md`
