# P15 Rich-Text Handover

**Branch:** `feat/p15-richtext-ytext` (pushed, NOT merged into `main`)
**Last commit on branch:** `400e2b8`
**Status:** working baseline. Bugs may remain in edge cases — this doc lists what's done, what's flaky, and what's next.

## Pull on the new machine

```bash
git fetch origin
git checkout feat/p15-richtext-ytext
git pull
pnpm install   # @fontsource-variable/inter was added
```

Then standard dev:

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d postgres minio minio-init
pnpm dev
```

## What landed in this session

Commits since `d3e8139`:

```
b6e83ec Reapply Phase B (Pixi.HTMLText swap)
84ff8d8 poke RenderScheduler for async HTMLText rasterize
1699d14 register custom fonts with Pixi Cache for HTMLText SVG embed
c6e4e6a per-selection inline rich-text formatting + Bold toggle
e01675c untoggle fix + drop CPU-eating render cascade
7fe71ad toggle buttons reflect inline run state at active selection
4dedbb0 bundle Inter so DOM textarea + Pixi HTMLText share metrics
79ef3b6 preserve Y.Text on reorder + per-selection weight/family
d4b85e5 per-selection font size
ab25b29 Cmd+A formatting promotes to box-wide change
b77d8cf out-of-edit changes clear inline run overrides
689ba38 per-keystroke NumberField no longer steals focus
ddf5837 NumberField selects on focus so typing replaces
5aab0db dedicated FontSizeField with deferred commit + steppers
9bf496f restore native number spinners on Size field
d903252 contenteditable overlay so selection highlight matches mixed sizes
771faf0 poke RenderScheduler when toggling Pixi text visibility
400e2b8 contenteditable overlay bugs (stale Pixi, lost selection, broken Enter)
```

## Architecture as it stands

### Render path

- **Pixi `HTMLText`** is the canonical text rendering. `apps/web/src/renderer/objectRenderers/textRenderer.ts` builds an HTML string from `Y.Text` via `toDelta` + `toHtml` (in `packages/slide-model/src/richText.ts`) and assigns it to a single `HTMLText` node.
- Per-run formatting is encoded as Quill-style attributes on Y.Text and rendered as nested `<i>` / `<u>` / `<span style="font-weight:…;color:…;font-family:…;font-size:…px">` wrappers.
- Async SVG → texture upload is poked via a deduped `markRenderDirty` cascade gated on actual styleKey/text change, so steady-state animations and typing don't burn CPU.

### Inline edit overlay

- `apps/web/src/ui/TextEditOverlay.tsx` is a **`contenteditable` div**, not a textarea. Mounting hides the Pixi text node via `alpha=0` so the contenteditable IS the visible rendering — same per-run styling means the native selection highlight matches mixed-size text.
- User typing → `onInput` → common-prefix/suffix diff against the previous plain-text snapshot → single `Y.Text.delete + insert` inside a `doc.transact`. Inserted characters inherit the format attrs of the run at the insertion point.
- Peer / Inspector mutations land via a `Y.Text.observe` callback that rebuilds `innerHTML` and restores the caret/selection by character index. A `localEditRef` flag suppresses the rebuild for our own diff-applied mutations.
- `Enter` is intercepted (`document.execCommand('insertLineBreak')`) so a `<br>` lands instead of Chrome's default `<div>`.
- Paste is normalised to plain text.

### Active-selection slot

`apps/web/src/ui/textEditSelection.ts` is a window-scoped singleton tracking `{ objectId, yText, start, end, refocus }`. The overlay publishes via `selectionchange` (only when the document selection is INSIDE the editor — outside-the-editor selections preserve the last valid range so Inspector controls keep targeting the right characters). Inspector controls subscribe via `useSyncExternalStore` and:

- Read the run's effective attrs at selection start via `readActiveSelectionAttrs` so toggle buttons reflect inline state.
- Apply inline format via `applyInlineFormatIfSelected` (Y.Text.format on the range) when a selection is active.
- Promote to box-wide patch + `clearActiveSelectionAttrs` when the selection covers the entire content (Cmd+A).
- Patch box-wide + `clearAllInlineRunAttrs` when the text object is selected without an open overlay.
- Refocus the editor via `refocusActiveTextEdit` after `<select>` interactions.

`data-text-edit-keep-focus` on Inspector wrappers tells the overlay's `onBlur` to ignore blurs into Inspector controls.

### Custom fonts

Pixi v8 HTMLText embeds `@font-face` data in its SVG via its own asset Cache (`${family}-and-url`), NOT `document.fonts`. So:

- `apps/web/src/state/FontLoader.tsx` registers each deck-uploaded font in BOTH `document.fonts` (for the contenteditable overlay) and Pixi's Cache (for HTMLText SVG embed).
- `apps/web/src/state/bundledFonts.ts` ships Inter via `@fontsource-variable/inter` and registers it the same way — needed because Inter is in the picker but not on every machine.
- `SceneGraph.refreshTextNodesUsingFamily` invalidates each HTMLText's `_gpuData[uid].currentKey` so the pipe forces a fresh `_updateGpuText` (which re-runs `getFontCss` and embeds the now-loaded face).

### Reorder + Y.Text

`packages/slide-model/src/mutations.ts:applyReorderMinimal` clones any `Y.Text` via `toDelta`/`applyDelta` into a fresh `Y.Text` BEFORE the parent `arr.delete`. Re-attaching the same Y.Text instance after detach is a silent no-op and used to wipe the text content.

### FontSizeField (Inspector)

`apps/web/src/ui/Inspector.tsx` has a dedicated `FontSizeField` for text:

- Local draft string drives the input; external value syncs via a ref-gated effect.
- Commit on Enter / blur / native spinner click / ArrowUp/Down — never per-keystroke.
- `inputType` distinguishes typing from native step events; spinner clicks commit immediately.
- `setTimeout(0)` select-on-focus so the selection survives the click's caret-placement.
- Wrapper `data-text-edit-keep-focus` + `onBlur` refocuses the editor on full blur.

## What works

- Inline edit with caret/selection highlight that hugs per-run glyph metrics.
- Bold / Italic / Underline toggles on selection or whole-text. Toggle state reflects the run at caret.
- Per-selection font weight / family / size via Inspector.
- Cmd+A → format change promotes to box-wide and strips inline overrides.
- Out-of-edit Inspector changes clear inline overrides on the whole Y.Text.
- Custom font upload + bundled Inter both render correctly inside Pixi HTMLText.
- Layer reorder preserves Y.Text content.
- Thumbnails wait for HTMLText texture promise so text appears in the sidebar.

## Known issues / things to watch

1. **Inter caret drift on long sentences** — even with bundled Inter (commit `4dedbb0`) some users may still see slight caret/glyph mismatch on long lines. Root cause: Pixi's `measureHtmlText` uses canvas `measureText` (OS-level font matching) while the SVG renders with embedded face. The `<contenteditable>` rewrite (`d903252`) sidestepped this by NOT using a textarea — both DOM and Pixi now show the embedded face — but the underlying width measurement Pixi uses for SVG sizing is still OS-based. Verify on a clean profile.
2. **`Y.Text` observer rebuilds `innerHTML` on every peer/Inspector mutation.** Caret is restored by character index, but very rapid Inspector mutations during typing could glitch. No reproducer yet.
3. **The diff-on-input is common-prefix/suffix only.** Pasting + Enter combinations or non-trivial multi-line edits could compute a larger replace than necessary. Acceptable for now.
4. **`selectionchange` listener is on `document`** — fires globally. Cheap, but watch for scenarios where multiple overlays are mounted.
5. **`alpha=0` Pixi hide depends on the HTMLText pipe still running addRenderable.** If a future renderer change skips invisible-but-alpha-0 nodes, the post-edit stale-text bug will return.

## Suggested next steps

- **Phase D** of `docs/superpowers/plans/2026-04-29-rich-text-yjs.md`: per-run color picker, per-run text-decoration controls beyond underline.
- **Phase E**: migration spec for legacy plain-string TextObjects → Y.Text on first edit.
- **E2E coverage** for the contenteditable flow. The two existing specs (`apps/web/e2e/htmltext-live-update.spec.ts`, `apps/web/e2e/text-reload-invisible.spec.ts`) were written for the textarea era. Either delete or rewrite for contenteditable.
- Consider hoisting `buildOverlayHtml` (currently duplicated in `TextEditOverlay.tsx` and `textRenderer.ts`) into `slide-model` so DOM and Pixi can never disagree on per-run styling.
- Decide on merge: branch is 19 commits ahead of `main`. Want a single squash, multiple themed merges, or rebase?

## Files of interest

| Area                           | File                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------ |
| Rich-text helpers              | `packages/slide-model/src/richText.ts`                                         |
| Y.Text reorder safety          | `packages/slide-model/src/mutations.ts`                                        |
| YTextEvent → patch             | `packages/slide-model/src/slideObserve.ts`                                     |
| Pixi text renderer             | `apps/web/src/renderer/objectRenderers/textRenderer.ts`                        |
| Thumbnail render               | `apps/web/src/renderer/thumbnails.ts`                                          |
| Custom font cache invalidation | `apps/web/src/renderer/SceneGraph.ts` (refreshTextNodesUsingFamily)            |
| Edit overlay (contenteditable) | `apps/web/src/ui/TextEditOverlay.tsx`                                          |
| Active selection slot          | `apps/web/src/ui/textEditSelection.ts`                                         |
| Inspector text controls        | `apps/web/src/ui/Inspector.tsx` (TextSection, FontSizeField)                   |
| Font selectors                 | `apps/web/src/ui/FontFamilySelect.tsx`, `apps/web/src/ui/FontWeightSelect.tsx` |
| Bundled fonts                  | `apps/web/src/state/bundledFonts.ts`                                           |
| Deck-uploaded fonts            | `apps/web/src/state/FontLoader.tsx`                                            |
