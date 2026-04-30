# M5 — Present Mode MVP

**Date:** 2026-04-19
**Owner:** editor-ui agent

## Co bylo implementováno

Present mode jako druhý mód stejného renderer pipeline. Architektonický edit/present split hotový.

## Nové soubory

| Soubor                                           | Popis                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| `apps/web/src/renderer/constants.ts`             | `SLIDE_WIDTH = 1920`, `SLIDE_HEIGHT = 1080` — kanonický world size      |
| `apps/web/src/components/DeckShell.tsx`          | Parent route wrapper, drží `SlideDocProvider` + `<Outlet />`            |
| `apps/web/src/components/PresentLayout.tsx`      | Fullscreen present shell — scale-to-fit, keyboard nav, no editor chrome |
| `apps/web/src/pages/DeckPresent.tsx`             | Page component pro `/deck/:id/present` route                            |
| `apps/web/src/components/PresentLayout.test.tsx` | 16 testů (layout, keyboard, scale)                                      |
| `apps/web/src/pages/DeckPresent.test.tsx`        | 4 smoke testy                                                           |

## Změněné soubory

| Soubor                              | Co se změnilo                                                     |
| ----------------------------------- | ----------------------------------------------------------------- |
| `apps/web/src/App.tsx`              | Nested routes: `/deck/:id` → DeckShell > DeckEditor / DeckPresent |
| `apps/web/src/pages/DeckEditor.tsx` | Odstraněn SlideDocProvider (přesunut do DeckShell)                |
| `apps/web/src/ui/Toolbar.tsx`       | Přidán Present button (▶) + Ctrl+Enter shortcut                   |
| `apps/web/src/ui/Toolbar.test.tsx`  | Přidán MemoryRouter wrapper + testy pro Present button            |

## Nové routes

- `/deck/:id` → `DeckShell > DeckEditor` (beze změny UX)
- `/deck/:id/present` → `DeckShell > DeckPresent > PresentLayout`

## Sdílený Y.Doc

`SlideDocProvider` je nyní v `DeckShell` — parent route nad oběma child routes. Y.Doc + Hocuspocus WebSocket přežijí navigaci editor ↔ present bez reconnect. `DeckShell` se remountuje pouze pokud se změní `:id` (jiný deck).

## Scale-to-fit strategie

- Slide má kanonický size `SLIDE_WIDTH × SLIDE_HEIGHT` (1920×1080).
- `PresentLayout` měří kontejner přes `ResizeObserver`.
- `scale = min(viewportW / 1920, viewportH / 1080)`.
- CSS `transform: scale(X)` na slide wrapper div — Pixi canvas zůstává 1:1 s CSS logical pixels.
- Editor mode zůstává beze změny (fit-to-container existující behavior).

## Keyboard shortcuts (present mode)

| Klávesa                                   | Akce                                        |
| ----------------------------------------- | ------------------------------------------- |
| `Escape`                                  | Zpět do editoru (`/deck/:id`)               |
| `ArrowLeft/Right`, `Space`, `PageUp/Down` | Placeholder log (M9 napojí multi-slide nav) |
| `f` nebo `F11`                            | Toggle browser fullscreen API               |

## Keyboard shortcuts (editor — přidáno)

| Klávesa          | Akce                   |
| ---------------- | ---------------------- |
| `Ctrl/Cmd+Enter` | Přejít do present mode |

## Testy

- **36 nových testů** (16 PresentLayout + 4 DeckPresent + 2 Toolbar nové)
- **188 testů celkem**, vše prochází, žádný regres.
- Canvas mockován jako `<div data-testid="canvas-mock">` — bez Pixi závislosti v testech.
- `ResizeObserver` polyfill v test souborech (jsdom nemá nativně).

## Co přijde v dalších milestonech

- **M6** — GSAP animace (present mode je read-only konzument)
- **M9** — Multi-slide navigace (Arrow/Space/Page keys dostanou reálnou implementaci)
- **M13** — Presenter view v separátním okně
- **M16** — Deck-level aspect ratio (nahradí hardcoded 16:9 v constants.ts) — renumbered from M20 on 2026-05-01

## Verifikace ručně

1. Otevřít `/deck/:id` → editor funguje normálně.
2. Kliknout ▶ Present (nebo Ctrl+Enter) → přechod na `/deck/:id/present`.
3. Fullscreen bez toolbar/inspector/sidebar, slide centrovaný.
4. `Escape` → zpět do editoru, editace stále funkční (Y.Doc nezresetovaný).
5. `f` → toggle fullscreen.
6. Resize okna → slide se přeškáluje.
