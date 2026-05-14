# M28 — PowerPoint import & export

End-to-end `.pptx` round-trip: import → editable Narrative deck → export
back to a `.pptx` other tools open. Six commits beyond the M28 plan, all on
`plan/m25-powerpoint-import-export` (branch name predates the milestone
number sliding — see plan doc for the rationale).

## At a glance

- **Import**: drop a `.pptx` on the homepage (button "Import PPT" between
  "New folder" and "New deck", or drag anywhere on the page) → folder
  picker dialog → deck created → editor opens with all slides materialised
  from the Y.Doc seed.
- **Export**: in the editor toolbar, "Export" button (next to "Share")
  downloads `<deck-title>.pptx` via a fetch+blob flow with a spinner during
  the ~1-2 s pptxgenjs build.
- **Append**: "Append" button in the editor toolbar (next to Export) opens
  a hidden file input → uploads to `POST /decks/:id/append-pptx`. Server
  replays the deck's `deck_updates` rows, calls `buildDeckAppendUpdate`
  which writes the new slides at the end of the slides array, encodes a
  state-vector-based diff against the pre-append state, and inserts the
  diff as a new `deck_updates` row. Open Hocuspocus connections pick up
  the new slides within ~200 ms without a client reload.
- **Round-trip stability**: importing then exporting the same file
  preserves positions to ±2 EMU, colours exact, alpha + alignment +
  rotation + stroke + images + **multi-stop gradients** intact. Gradient
  fills are restored via a zip post-processing pass (`applyGradientFixups`
  in `pptx/export.ts`) — pptxgenjs can't write `<a:gradFill>` natively, so
  emit-time collapses to a placeholder solidFill then the post-process
  pass parses each affected slide XML, matches shapes by EMU coords, and
  swaps the placeholder for a real `<a:gradFill>` with original stops +
  angle.
- **Coverage** (mirrored on both sides):
  - text frames — frame-level color, fontSize, bold, align, vAlign,
    bullet / numbered list marker, plus **per-run inline formatting**
    (italic, underline, bold, color, fontSize) carried as Quill-style
    attributes on a Y.Text body so two-colour titles + bold-mid-paragraph
    survive the round-trip
  - **hyperlinks on text runs** (`<a:hlinkClick>`) collapsed onto
    `TextObject.hyperlink` (first run wins; Narrative models one
    hyperlink per object)
  - **speaker notes** — imported from `ppt/notesSlides/notesSlide{N}.xml`,
    written as `<paragraph>` blocks into the slide's notes Y.XmlFragment
    so Tiptap/y-prosemirror picks them up on first editor open. Exported
    back via pptxgenjs `addNotes` (per-slide map built by the route
    handler from each slide's notes fragment).
  - **tables** (`<p:graphicFrame>/<a:graphic>/<a:graphicData uri=".../table">/<a:tbl>`) —
    exploded into per-cell rectangle + text shapes (Narrative has no
    native table object). All shapes for a single table share one
    `groupId` so the editor's P6 implicit-grouping treats it as a
    movable unit. Honours `gridSpan` / `rowSpan` for merged cells.
    Per-cell `<a:tcPr>/<a:solidFill|gradFill>` lands as the cell rect's
    fill; per-edge `<a:lnL|R|T|B>` borders collapse to a single uniform
    stroke (priority L→R→T→B; first non-noFill edge wins — Narrative
    has one stroke per shape, not four), and cells where every declared
    edge is `<a:noFill/>` emit borderless. Cells without `<a:tcPr>` fall
    back to a 1px `#CCCCCC` grid. **`<a:tblPr>` preset toggles**
    (`firstRow / lastRow / firstCol / lastCol / bandRow / bandCol`) drive
    a theme-accent1 heuristic for cells with no explicit fill: header /
    edge slots get solid accent1, banded data rows/cols get an 85% tint
    of accent1. Full `ppt/tableStyles.xml` resolution stays as
    documented v2 work; the heuristic matches Office's defaults closely.
    **Tables round-trip on export**: `emitGroupedTables` detects groups
    whose rectangle members form a uniform N×M grid and re-bundles them
    via pptxgenjs's `addTable`, producing a real `<a:tbl>` in the .pptx.
    Non-grid groups (mixed sizes, overlapping rects) fall through to
    per-shape emit so user-created shape groups don't accidentally
    collapse into tables.
  - rectangle / ellipse / line shapes with solid + linear/radial gradient fill,
    stroke colour + width, alpha
  - solid + gradient slide backgrounds
  - **embedded images** (PNG / JPEG / GIF / WebP) — image shapes and image
    slide backgrounds, both routed through MinIO
  - position / size / rotation
  - placeholder geometry / alignment / font size / vertical anchor
    inherited from slide layout → master (`<p:ph>` lookups)
  - **master + layout flattening** — Narrative has no master/template
    concept, so anything visible on the source slide must be baked into
    each Narrative slide as a stand-alone object. The importer:
    - bakes every non-placeholder master/layout shape (logos, footer
      lines, accent strips) onto each slide in paint order (master →
      layout → slide), with their own image rels resolved against the
      master/layout `_rels` files
    - cascades slide `<p:bg>` → layout `<p:bg>` → master `<p:bg>` so a
      slide that "inherits" its background still has one
    - resolves placeholder text colour / size / bold against the master's
      `<p:txStyles>/<p:titleStyle|bodyStyle|otherStyle>` lvl1 defRPr
      defaults (last-fallback chain after slide rPr → layout/master
      placeholder defaults → master txStyles)
    - honours `showMasterSp="0"` on both slide and layout to suppress
      master shapes for that scope
  - theme `<a:schemeClr>` resolved against `ppt/theme/theme1.xml`, with
    `<a:lumMod>` / `<a:lumOff>` / `<a:shade>` / `<a:tint>` / `<a:alpha>`
    modifiers applied
  - `<p:style>` theme references (`<a:fillRef>` / `<a:lnRef>` /
    `<a:fontRef>`) — picks up the embedded scheme colour as the resolved
    fill / stroke / text colour
- **Tests**: 77 unit (`apps/server/src/pptx/*.test.ts`) + 2 Playwright e2e
  (`apps/web/e2e/pptx-roundtrip.spec.ts`), all green.

## Where everything lives

```
apps/server/src/
├── pptx/
│   ├── parser.ts          .pptx → ParsedPptx (jszip + fast-xml-parser)
│   ├── writer.ts          ParsedPptx → Y.Doc state buffer
│   ├── export.ts          Slide[] → pptxgenjs Buffer
│   ├── parser.test.ts     31 specs (master flattening + bgRef + bullets +
│   │                       rich text runs + hyperlinks + notes + tables +
│   │                       cell styling + tblPr presets)
│   ├── writer.test.ts     12 specs (incl. buildDeckAppendUpdate)
│   └── export.test.ts     15 specs (gradient post-process + table reconstruction)
├── routes/
│   ├── pptxImport.ts      POST /folders/:folderId/import-pptx
│   └── pptxExport.ts      GET  /decks/:id/export.pptx
└── scripts/
    ├── pptxSpike.ts       dev tool — round-trips through both paths
    └── pptxDebug.ts       dev tool — dumps parser + writer JSON for one file

apps/web/
├── src/
│   ├── api/client.ts                 importPptx(file, folderId)
│   ├── pages/FoldersHome.tsx         Import button + drag/drop overlay
│   └── ui/
│       ├── ImportPptxDialog.tsx      folder picker + success summary
│       └── Toolbar.tsx               Export button + spinner + error banner
└── e2e/
    ├── pptx-roundtrip.spec.ts        full import + export happy path
    └── fixtures/import-test.pptx     58 KB fixture (spike-generated)

packages/shared/src/
└── canvas.ts                          SLIDE_WIDTH / SLIDE_HEIGHT — single source
                                       of truth, imported by both web + server
docs/plans/m28-pptx-import-export.md   the milestone plan
```

## HTTP API

### `POST /folders/:folderId/import-pptx`

|                        |                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Auth                   | session cookie, caller must own the destination folder                                   |
| `Content-Type`         | `application/vnd.openxmlformats-officedocument.presentationml.presentation`              |
| Body                   | raw `.pptx` bytes (max 50 MB — enforced at the content-type parser + body-size re-check) |
| `X-Narrative-Filename` | optional header — strip `.pptx` and use as the deck title; falls back to "Imported deck" |

Response on 201:

```jsonc
{
  "deckId": "abc123…",
  "slideCount": 3,
  "objectsCreated": 8,
  "skipped": { "images": 0, "unknownShapes": 0 },
  "ignoredElements": ["a:effectLst", "a:srcRect", …],
  "slideWidth": 1280,
  "slideHeight": 720
}
```

`skipped.images` counts both unsupported MIMEs (EMF/WMF/SVG) and MinIO
upload failures. `ignoredElements` is the list of XML tags observed but
not in the MVP mapping table — useful for triaging real-world files.

### `GET /decks/:id/export.pptx`

|          |                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Auth     | session cookie, caller needs editor+ role on the deck                                                                                    |
| Response | `application/vnd.openxmlformats-officedocument.presentationml.presentation` + `Content-Disposition: attachment; filename="<title>.pptx"` |

The route replays every `deck_updates` row into a fresh Y.Doc, lists
slides via `@narrative/slide-model`'s `listSlides`, then hands them to
`exportDeckToPptx(slides, { title, assetLoader })`. The assetLoader is a
per-request memoised callback that turns an `assetId` into bytes via a
`GetObjectCommand` against MinIO — so the same logo on every slide hits
the bucket once.

## Image flow

PPTX images travel exactly the same path as user-uploaded media so the
existing renderer + imgproxy pipeline picks them up with zero new code.

**Import**: parser walks each slide's rels, resolves `<a:blip r:embed>`
references to zip paths, and pulls bytes out of `ppt/media/*` into
`ParsedPptx.embeddedImages`. The route handler then:

1. Filters to supported MIMEs (PNG / JPEG / GIF / WebP) via magic-header
   sniff — vector formats (EMF / WMF / SVG) are dropped with a count.
2. Per image: generate a `nanoid(12)` assetId, upload to MinIO at
   `decks/<deckId>/uploads/<assetId>/original.<ext>` (same convention as
   tus), probe width/height via `probe-image-size`, plan a
   `media_assets` row.
3. Walk parsed shapes + backgrounds, patch their `assetId` field.
4. Build the Y.Doc state.
5. Insert `decks` + `deck_permissions` + `media_assets[]` + `deck_updates`
   in one transaction.

If the transaction fails, the MinIO objects orphan — same trade-off the
rest of the upload pipeline accepts (documented in `media/assets.ts`).

**Export**: the route builds an `assetLoader` from a `GetObjectCommand` +
`streamToBuffer`, hands it to `exportDeckToPptx`. For each `ImageObject`
the exporter base64-encodes the bytes into a `data:<mime>;base64,…` URL
and passes it to `pptxgenjs`'s `slide.addImage({ data })`. Same trick for
slide-level `ImageBackground` via `slide.background = { data }`.

## Master + layout flattening pipeline

PowerPoint composes a final visible slide as `master ⊕ layout ⊕ slide`.
Narrative has no master concept, so the importer collapses that stack
into a single self-contained slide. The pipeline lives entirely in
`apps/server/src/pptx/parser.ts`:

1. **`buildSlideContexts(zip, slidePaths, theme, imagePathSink)`** walks
   each slide's `_rels` → layout → master chain. For each layout/master
   XML it produces a cached `LayoutMasterCacheEntry`:
   - `placeholders` from `collectPlaceholders` — geometry + per-level
     text defaults (colour / size / bold / align / vAlign).
   - `shapes` from `parseNonPlaceholderShapes` — every `<p:sp|p:pic|p:cxnSp>`
     on the spTree that does NOT have a `<p:ph>` child. Image rels
     resolve against the file's own `_rels/<name>.rels`.
   - `background` from `parseBackground` (reused — `<p:cSld>` is
     identical across slide/layout/master).
   - `txStyles` (master only) from `parseTxStyles` — title/body/other
     lvl1 defRPr font colour / size / bold.
   - `showMasterSp` (layout only) — `<p:sldLayout showMasterSp="0">`
     suppresses master shapes for every slide that uses this layout.
2. **`buildSlideContexts` merges** per-slide:
   - Placeholders: master first, layout on top (layout wins).
   - Background cascade: layout if non-`none`, else master, else
     `{ kind: 'none' }` so `parseSlide` doesn't second-guess.
   - Master shapes are zeroed out when the layout sets
     `showMasterSp="0"` on its root.
   - Image paths from master/layout shapes flow into the shared
     `imagePathSink` so the route handler's MinIO upload loop sees
     them.
3. **`parseSlide` consumes the context**:
   - Slide-level `showMasterSp="0"` (attribute on `<p:sld>`) suppresses
     master shapes for THIS slide regardless of layout config.
   - Final shape list: `[...masterShapes, ...layoutShapes,
...slideOwnShapes]` — master paints bottom, slide on top. The
     writer iterates in array order and `addObject` appends, so
     z-order is preserved end-to-end (covered by
     `writer.test.ts:"preserves master → layout → slide paint order"`).
   - Background: `parseBackground(slideXml)` first, falling through to
     `context.fallbackBackground` when slide returns `{ kind: 'none' }`.
4. **`parseShape` accepts a `txStyles` bucket map** as a final-fallback
   source for placeholder text properties. Bucket selection:
   `title|ctrTitle → title`, `body|subTitle → body`, anything else →
   `other`. The slide shape's `<p:ph type="…">` (or, if absent, the
   matched placeholder entry's recorded `phType`) drives the lookup.

The flattening logic adds **no new public types** to the parser
output; `ParsedSlide` still has just `background` + `shapes[]`. All
master/layout context is internal to the parser module.

### `<p:bgRef>` — themed-master backgrounds

Themed Office decks usually declare their master bg via
`<p:bgRef idx="…"><a:schemeClr val="…"/></p:bgRef>` rather than an
inline `<p:bgPr>` fill. The `idx` (1001–1003) references the theme's
`<a:bgFillStyleLst>` — typically subtle solid / moderate gradient /
intense gradient, with the inline colour descriptor providing the
"base" colour.

For v1 the parser extracts the inline colour descriptor (with full
`schemeClr` / `lumMod` / `lumOff` / etc. resolution) and emits a solid
background regardless of which template `idx` selected. This is
correct for `idx="1001"` (the common case) and a faithful approximation
for the gradient variants — the colour is the dominant visual signal,
and the gradient styling falls out as a known cosmetic loss documented
here. Fully expanding the theme template list is ~30 min once we
encounter a deck where the lost gradient matters.

## Architecture invariants

- **Canvas size lives in `@narrative/shared`** (`canvas.ts`). The pptx
  scaler reads `SLIDE_WIDTH`/`SLIDE_HEIGHT` from there. If you ever change
  the artboard dimensions (planned in M20 for aspect ratio overrides),
  the import scale falls into place automatically.
- **Parser → Writer is a pure pipeline.** Parser produces a
  `ParsedPptx` JSON; writer turns that into a Y.Doc state buffer. The
  route handler is the only piece with I/O (DB, MinIO). This lets the
  unit tests exercise the full transform without spinning up Postgres.
- **Writer uses the slide-model public API.** `createSlideDoc` +
  `addSlide` + `getSlideObjectsCtx` + `addObject` + `updateSlideBackground`
  — no direct Y.Map gymnastics. When the schema evolves, the writer
  follows for free.
- **Spike script (`pptxSpike.ts`) and Debug script (`pptxDebug.ts`) are
  permanent dev tools.** Don't delete them with the next refactor — they
  pay for themselves the next time someone hits a real-world fidelity
  bug.

## Test surface

- `pnpm --filter @narrative/server test src/pptx/` — 21 specs, ~1 s.
- `pnpm --filter @narrative/web test:e2e e2e/pptx-roundtrip.spec.ts` — 2
  Playwright specs, ~12 s; requires the dev stack up
  (`pnpm dev:no-worker` + Docker services).
- `pnpm --filter @narrative/server test` — full server suite, 291 passed
  / 1 skipped.

The fixture `apps/web/e2e/fixtures/import-test.pptx` (58 KB) is the
spike script's output — exercises text + rect + ellipse + line + image
shape + solid bg + image bg. Re-generate via:

```bash
pnpm --filter @narrative/server pptx:spike
cp /var/folders/.../narrative-pptx-spike/spike-export.pptx \
   apps/web/e2e/fixtures/import-test.pptx
```

For diagnosing a real-world file:

```bash
pnpm --filter @narrative/server exec node ../../node_modules/tsx/dist/cli.mjs \
  src/scripts/pptxDebug.ts /path/to/real.pptx
```

Prints both the parser JSON and the resulting Y.Doc shape tree. Add
fixtures to `tests/fixtures/pptx/` — gitignored so binaries don't bloat
the repo.

## Full coverage matrix (M28 round 2)

After the coverage-completion round, every Narrative slide-model
feature with a reasonable PPTX equivalent round-trips. The list:

| Category    | Feature                                            | Import |                   Export                   |
| ----------- | -------------------------------------------------- | :----: | :----------------------------------------: |
| **Objects** | Rectangle, ellipse, line                           |   ✓    |                     ✓                      |
|             | Triangle (`prst="triangle"`)                       |   ✓    |                     ✓                      |
|             | Polygon (pentagon … dodecagon)                     |   ✓    |                     ✓                      |
|             | Arrow (line + `<a:headEnd>` / `<a:tailEnd>`)       |   ✓    |                     ✓                      |
|             | Path object (`<a:custGeom>` cubic + line segments) |   ✓    |                     ✓                      |
|             | Image (PNG / JPEG / GIF / WebP via MinIO)          |   ✓    |                     ✓                      |
|             | Video (MP4 / WebM, `<a:videoFile>` embedded)       |   ✓    |                     ✓                      |
|             | ComponentInstance → flattened to baked shapes      | (n/a)  |                     ✓                      |
|             | Table (`<a:tbl>`) — exploded + reconstructed       |   ✓    |                     ✓                      |
|             | Chart — fallback image via `<mc:Fallback>`         |   ✓    |             (image, not chart)             |
| **Text**    | Color, fontSize, bold, italic, underline, align    |   ✓    |                     ✓                      |
|             | Per-run rich text via Y.Text (Quill attrs)         |   ✓    |                     ✓                      |
|             | Bullet / numbered list marker                      |   ✓    |                     ✓                      |
|             | Hyperlinks on text runs                            |   ✓    |                     ✓                      |
|             | fontFamily, letterSpacing, lineHeight              |   ✓    |                     ✓                      |
|             | paragraphSpaceBefore / After                       |   ✓    |                     ✓                      |
|             | textTransform (cap=all / small)                    |   ✓    |                     ✓                      |
|             | Text stroke (`<a:rPr><a:ln>`)                      |   ✓    |                     ✓                      |
| **Effects** | Drop shadow (`<a:outerShdw>`)                      |   ✓    |                     ✓                      |
|             | Gaussian blur (`<a:blur>`)                         |   ✓    | (one-way; pptxgenjs has no shape-blur opt) |
|             | Image crop (`<a:srcRect>` ↔ `imageRect`)           |   ✓    |                     ✓                      |
|             | Multi-stop gradient on shapes (zip post-process)   |   ✓    |                     ✓                      |
|             | Theme `<a:schemeClr>` + modifiers (lumMod, etc.)   |   ✓    |                     ✓                      |
| **Slide**   | Background (solid / gradient / image)              |   ✓    |                     ✓                      |
|             | Master/layout flattened into each slide            |   ✓    |                   (n/a)                    |
|             | `<p:bgRef>` themed-master background               |   ✓    |                   (n/a)                    |
|             | Speaker notes                                      |   ✓    |                     ✓                      |
|             | Slide `name`                                       |   ✓    |                     ✓                      |
|             | Slide `skipped` (PPTX `<p:sld show="0">`)          |   ✓    |                     ✓                      |
|             | Transitions (fade / push / cube / magic)           |   ✓    |                     ✓                      |
|             | Animations (14 presets, lossy timing tree mapping) |   ✓    |                     ✓                      |
| **Deck**    | Deck title                                         |   ✓    |                     ✓                      |
|             | Folder color tokens resolved to concrete hex       | (n/a)  |                     ✓                      |
|             | Append .pptx into existing deck                    |   ✓    |                   (n/a)                    |

## Remaining known gaps

| Gap                                               | Effort                                                                                                                                                                                                                                                                                                   | Visible?                                            |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **Custom font embedding** (`<p:embeddedFontLst>`) | ~3 hours — would splice TTF/OTF bytes from MinIO into `ppt/embeddings/*.ttf` + manifest + content-types. Currently text frames using custom fonts fall back to the system font in viewers without the font installed (same behaviour Office shows by default).                                           | Branded decks                                       |
| **Full `ppt/tableStyles.xml` resolution**         | ~2 hours — resolve `<a:tableStyleId>` GUIDs against per-slot `<a:fill>` blocks instead of the current accent1 heuristic. Matters only when the deck uses a non-default theme table style.                                                                                                                | Niche                                               |
| **Charts without an `<mc:Fallback>` poster**      | Server-side chart rendering — would need to parse `<c:plotArea>/<c:barChart\|lineChart\|pieChart>/<c:ser>` and render via a node chart library → PNG. Charts WITH a fallback already import as that fallback image. Decks exported from Office 365 / Google Slides / Canva ship the fallback by default. | Charts from exporters that omit the fallback poster |
| **SmartArt**                                      | Out of scope per M28 plan (generated from a small graph + rules; no clean fallback path).                                                                                                                                                                                                                | Marketing-grade decks only                          |
| **`<a:innerShdw>`, reflection, glow effects**     | Out of scope — Narrative has only `outer` shadow + uniform blur.                                                                                                                                                                                                                                         | Rare                                                |
| **Image rotation independent of frame** + masks   | Out of scope — Narrative's `imageRotation` / `mask` fields have no clean PPTX schema mapping.                                                                                                                                                                                                            | Rare                                                |
| **BullMQ worker**                                 | Not needed at current scale — typical import is ~200 ms.                                                                                                                                                                                                                                                 | Op visibility, eventually                           |

## Quick smoke after pulling on a fresh machine

```bash
pnpm install
pnpm dev:no-worker                    # Docker services + dev server
# In another shell:
curl -s -X POST http://localhost:3001/folders/<draftsId>/import-pptx \
  -H 'Content-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation' \
  -H 'X-Narrative-Filename: smoke.pptx' \
  --data-binary @apps/web/e2e/fixtures/import-test.pptx | jq
```

Expect `{"deckId":"…","slideCount":3,"objectsCreated":8, …}`. Open the
returned `deckId` in the editor and confirm the title, shapes, and red
image are visible on the first slide.

## Commit history

```
12d991f feat(m28): import + export embedded images (PNG/JPEG/GIF/WebP)
ebf0471 test(m28): e2e spec for the .pptx import + export round-trip
62ee2bd polish(m28): pptx UX + fidelity round (spinner, success banner, vAlign, tests)
2fdfb4a feat(m28): pptx export + import fidelity round (theme refs, alpha, alignment)
c68578f feat(m28): import .pptx via homepage drag-drop + button — v1 mapping
77ef7de spike(m28): pptxgenjs + jszip + fast-xml-parser proof of life — partial GO
070e4a9 plan(m28): scope PowerPoint import + export, un-park export
```

Branch is ready to merge to `main`. Recommend squash-merge given the
iterative shape of these commits — the plan + final state are what
matters; the iteration history lives here in the handover.
