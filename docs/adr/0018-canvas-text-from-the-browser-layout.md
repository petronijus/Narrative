# ADR 0018 — Canvas text: the browser lays it out, a worker paints the glyph runs

**Status**: Accepted (Petr, 2026-10-23; proposed 2026-10-20 by renderer).
The run engine is the default in every engine, Blink and WebKit — Safari and
the Tauri shell included (Petr, 2026-10-26, option B; `runText/flag.ts`
`DEFAULT_TEXT_ENGINE = 'runs'`). Accepted with it: in WebKit non-black canvas
text is a shade lighter than the same text in HTML (WebKit smooths HTML text
with CoreGraphics and never canvas text — Fidelity below); where a text sits
is not allowed to differ — gated against the edit overlay (Position gates).
The spike: `apps/web/src/renderer/experimental/textEngine/`,
`/text-engine-spike.html`, `e2e/text-engine-spike.spec.ts`.
**Scope**: every text the canvas draws — text boxes, table cells, component
leaves — in `apps/web/src/renderer/` (`objectRenderers/textRenderer.ts`,
`tableRenderer.ts`, the HTMLText helpers around them), the font registry
(`renderer/fontChanges.ts`, `pixiFontSink.ts`), the thumbnail and render
paths that wait for rasters (`htmlTextRaster.ts`, `thumbnails.ts`,
`settleScene.ts`), and the zoom staging (`textResolutionStaging.ts`). The
markup and CSS of a text (`buildHtml`, `buildStyleOpts`, the slide model's
`buildListedHtml`) and the edit overlay are unchanged.
**Related**: ADR 0002 (renderer architecture), ADR 0004 (the reconciler),
ADR 0007 (the CSP), performance.md → E2, E7, W1, W2; canvas-performance.md
steps 3–4.

## Context

Every canvas text is a Pixi `HTMLText`: its markup is put into an SVG
`foreignObject` with the faces it uses embedded as base64 `data:` URLs, the
SVG is loaded as an image, the image is drawn into a canvas (our race patch)
and uploaded. Per raster that is a DOM measurement in `document.body` (a
style and layout pass over the whole app — canvas-performance.md step 4,
needs Pixi upstream), an XML serialisation, a font decode per embedded face
(E2 cut it to the matched faces), an SVG document load, and in WebKit a
fixed 100 ms wait whenever a face is embedded (W1, upstream). A zoom or a
resolution change repeats all of it for every text (staged, step 3). The
textures come from Pixi's power-of-two pool.

E7 asked whether a different text engine removes that cost without
changing what a slide looks like. Three candidates were built and measured
in Chromium and WebKit on the MacBook (numbers: performance.md → Log,
2026-10-20, E7):

- **(a2) DOM layout, Canvas2D glyph runs in a worker.** The browser lays the
  same markup out with the same CSS in a contained host of our own (the
  structure Pixi measures with: `svg > foreignObject > div`); the line
  fragments, fonts, colours and baselines are read off it (`Range` rects,
  computed styles, one baseline probe per font), and a worker paints the
  runs with `fillText` on an `OffscreenCanvas` at the text's resolution,
  transferred back as an `ImageBitmap`.
- **(a1) Layout without the DOM.** The same markup's computed styles (a
  style pass in a `display: none` host, no layout) become a serialisable
  block model; a worker breaks lines and places runs from Canvas2D
  measurements, then paints them.
- **(b) SDF glyph atlases.** Glyphs made at runtime with `@mapbox/tiny-sdf`
  in the worker, drawn by Pixi's BitmapText SDF shader at (a2)'s positions.

Fidelity (each text drawn by HTMLText and by the candidate, compared pixel
by pixel over white):

- (a2) is pixel-identical on the crowded slide's 121 texts in both engines
  at 1×, and on 18–20 of the 21 feature boxes (lists and levels, mixed
  sizes, runs, letter spacing, alignment, wrap none, transforms, tight and
  loose lines, stroke in Chromium, long words, Inter weights, fallback
  faces, paragraph spacing, 11 px and 160 px) at 1× and 2×. What is left:
  the underline's geometry (no API exposes a font's underline metrics; the
  spike estimates them), WebKit's text stroke (a sub-pixel offset), and
  sub-1/64 px residues where Chromium kerns across a space.
- (a1) is identical on the crowded slide in both engines, but in Chromium
  it cannot be exact: Chromium's text layout kerns across spaces (Arial's
  "A ", " A": 1.3 px at 24 px) while its Canvas2D shapes word by word and
  never does, and no canvas API reveals those pairs. It also re-implements
  the inline layout (line breaking is a UAX #14 subset, the half-leading
  rounding differs between the engines), which is a second definition of
  the text's look to keep equal to the browser's.
- (b) is visibly another rasteriser (no hinting, other gamma, dilated or
  rounded at large sizes, no shaping beyond pair kerning, no stroke): about
  a third of the ink pixels differ. It is zoom-free and tiny in memory, and
  that is all.

Cost (MacBook M3 Pro, AC, Low Power Mode off, dev server, Chromium 156 on
ANGLE Metal and Playwright WebKit 27.2; median of 3 fresh pages; "blocked" =
the frame time over 16.7 ms summed, i.e. what the page could not draw):

| 121 texts (crowded slide) | HTMLText ready / blocked / longest frame | (a2) ready / blocked / longest frame |
| ------------------------- | ---------------------------------------- | ------------------------------------ |
| Chromium, mount           | 196 / 126 / 68 ms                        | 66 / 17 / 30 ms                      |
| Chromium, zoom 1× → 2×    | 359 / 267 / 103 ms                       | 48 / 0 / 17 ms                       |
| Chromium, slide switch    | 242 / 159 / 100 ms                       | 47 / 3 / 19 ms                       |
| WebKit, mount             | 988 / 946 / 766 ms                       | 531 / 410 / 291 ms                   |
| WebKit, zoom 1× → 2×      | 859 / 816 / 824 ms                       | 611 / 530 / 239 ms                   |
| WebKit, slide switch      | 569 / 530 / 398 ms                       | 317 / 272 / 220 ms                   |
| texture pixels at 1× / 2× | 17.3 / 66.3 Mpx (power-of-two pool)      | 8.2 / 32.7 Mpx (exact size)          |

In WebKit what is left of (a2) is two things: its DOM layout of our markup
costs ~1.7 ms a text (Chromium ~0.12 ms), and uploading an `ImageBitmap`
costs ~13 µs per thousand pixels on the main thread (444 ms for the zoom's
32.7 Mpx; copying the bitmap into a canvas first: 360 ms). (a1)'s style-only
model halves the WebKit mount (296 / 178 / 144 ms).

## Decision

1. **Canvas text is drawn from glyph runs, not from an SVG.** A text's
   look stays defined by its markup and CSS (`buildHtml`,
   `buildStyleOpts`); the browser lays it out in a contained measuring host
   the renderer owns; the layout is read as glyph runs (candidate a2) in CSS
   px, and painted by Canvas2D in a worker pool at the resolution the text
   is drawn at.
2. **One layout, many paints.** The runs are kept per text (keyed by markup,
   CSS and the font generation — what `htmlTextBoundsMemo` keys on today);
   a zoom, a thumbnail or a present-mode scene paints them again at another
   resolution without touching the DOM. The measured size the vertical
   alignment, autofit and the clip mask use is that layout's.
3. **Fonts go to the workers once.** The font registry hands every face's
   bytes and descriptors to each worker (`FontFace` from bytes in the
   worker's `FontFaceSet`), so the worker matches faces with the engine's
   own CSS Fonts 4 §5.2 algorithm over the same faces the page has
   (`fontFaceMatch.ts` stays the reference for anything the renderer
   decides itself). Nothing is embedded per raster: the E2 subsets, the
   `data:` font URLs and the WebKit 100 ms wait go with the SVG.
4. **The texture an HTMLText raster would get.** Proposed as exact-size
   textures under the ResourceManager (half the texture memory); the port
   measured that this changes pixels: a texture of another backing size is
   sampled with other UV steps and other mip levels — Δ1 of 255 on every
   text at 1:1, up to 64 on text drawn scaled (a shrunk autofit box) and 22
   in thumbnails (`e2e/text-runs-artboard.spec.ts`, 2026-10-26). Nothing may
   change how a slide looks, so a raster takes Pixi's own pooled
   power-of-two texture of the HTMLText geometry (`textureSizeFor`), painted
   whole by the worker (no stale texels from the pool); texture memory stays
   what it is today. The memory saving is a separate decision: it changes
   pixels within those bounds.
   **Amended 2026-10-31** ([ADR 0020](0020-editor-canvas-draws-the-visible-region.md)
   → texture memory): where the canvas draws the page (the editor, present
   mode, the render page) a raster is painted for the device grid and held
   to the edit overlay's pixels (`text-edit-parity`), not to HTMLText's, and
   the pool's sizes held 2.0× the rasters and kept every returned texture
   on the GPU until Pixi's collector ran — 1.86 GB on the crowded slide at
   544 %. There a raster gets an exact-size texture of its own, freed when
   it is replaced, and mipmaps only where it is drawn resampled (the
   editor; present mode and the render page keep them: builds, transitions
   and captures draw texts smaller) — `runTextSystem.ts → RunTextureShape`,
   `mipmapsFor`. The thumbnails and HTMLText-compatible mode keep the pooled
   power-of-two texture of this decision.
5. **HTMLText stays as the fallback** behind a renderer flag until the
   fidelity spec covers every feature exactly in both engines; the switch
   is per renderer instance, so thumbnails, the editor and present mode can
   move together. _Amended 2026-10-26 (Petr):_ runs are the default
   everywhere; HTMLText stays as the per-text fallback (`layout.unsupported`,
   a failed paint, no worker) and as the comparison the fidelity probe draws.
6. **A text sits where the page puts it** (Petr, 2026-10-26: "exactly the
   same place on canvas as in edit mode; no move or jump entering or leaving
   edit mode"). The edit overlay is the page laying the same markup out; the
   canvas must put every line and word where it does, within 0.5 device px,
   at every zoom — not merely where HTMLText put them. See Placement.

## Consequences

- Per text, the main thread does one contained layout plus a few range
  reads; no serialisation, no SVG document, no font decode, no image load.
  Workers do the painting in parallel. Zoom re-rasters cost a paint and an
  upload, no layout. Texture memory stays as it is (decision 4).
- WebKit gains less than Chromium (table above): its layout of the markup
  and its `ImageBitmap` uploads stay on the main thread. The zoom staging's
  upload budget stays; a WebKit-specific upload path (and (a1)'s worker
  layout for WebKit) are follow-ups to measure, not part of the decision.
- The spike also saw WebKit's HTMLText draw some texts in an embedded face
  as nothing at all (1–5 of 24 Inter texts per run on the present scene, the
  first rasters of a face) — a reason more, to be confirmed in the app.
- The CSP gets simpler, not looser: a same-origin module worker
  (`worker-src 'self'`) and `FontFace` from bytes (no fetch, `font-src` not
  involved). Text would no longer need `font-src data:` or `img-src data:`;
  tightening those is a later ADR 0007 amendment, not part of this one.
- New things to own: the run extraction (line fragments, bidi runs, word
  positions where Chromium kerns across a space), the baseline snapping
  rules of each engine (Chromium rounds a baseline to a whole CSS pixel
  before scaling; decorations likewise), decoration geometry (underline and
  line-through need the font's `post` metrics: parsed from the bytes of
  registered faces, probed once per system font and size), text stroke in
  WebKit, `font-stretch` widths Canvas2D cannot spell (keywords only in
  Chromium, none in WebKit: a registered face per width range instead).
- What has to be equal is tested, not argued: `text-engine-spike.spec.ts`
  becomes the gate (every feature box, every engine, 1× and 2×, pixel
  equality with HTMLText while HTMLText exists, then with committed
  references), plus the real-deck corpus (`just pptx-roundtrip` decks) in
  both engines.
- Rejected: (a1) as the primary engine (Chromium kerning across spaces, a
  second layout definition); (b) SDF (not the browser's glyphs). (a1)'s
  worker layout remains an option for typing-heavy paths if the contained
  DOM layout ever shows in a profile; (b) for very large on-screen text
  (an animation scaling text up) is a separate question.

## Plan

1. Renderer flag and a `RunText` node (a Container with a Sprite) that
   takes an HTMLText's place in `textRenderer`, `tableRenderer` and the
   component leaves; its texture promise feeds `collectHtmlTextRasters`'s
   successor, so thumbnails, the render page and present mode wait for it.
2. The measuring host, the run cache and the realignment
   (`realignIfMeasureMoved`) on the new measurement; the edit overlay reads
   the same offsets.
3. The worker pool and font delivery from `fontChanges.ts`; the restage
   budget (`restageBudget.ts`) measures paints and uploads.
4. Decorations from font metrics; WebKit stroke; bidi and vertical text
   checks; `font-stretch` by face.
5. The fidelity gate over every feature and the deck corpus; then the flag
   on in the editor, thumbnails and present mode; HTMLText and its patches
   (`patchHTMLTextRace`, `pixiHtmlTextStyleScope`, `htmlTextBoundsMemo`,
   the E2 font keys) removed once nothing uses them.

Size: L (three to five weeks with the gate). Each step measured with the
crowded-slide and present benches before and after.

## Implementation (the port, from 2026-10-23)

Built in `apps/web/src/renderer/runText/` behind a page-wide flag
(`runText/flag.ts`: `textEngine` = `html` | `runs`, from
`globalThis.__narrative_textEngine`, `?textEngine=`, localStorage
`narrative:textEngine`, the build's `VITE_TEXT_ENGINE`; default `runs` since
2026-10-26).

**The node stays an `HTMLText`; what is behind it changes.** Plan step 1
proposed a `RunText` node in its place. The port keeps Pixi's `HTMLText` as
the scene node instead: its markup and its `HTMLTextStyle` (whose `cssStyle`
is the text's CSS) are exactly what the decision keeps as the definition of a
text's look, and every consumer of a canvas text reads the node's contract —
`textNode.height` and the anchor (alignment, autofit, the clip mask, the
realignment, the edit overlay's offsets), `_gpuData[uid].texturePromise` /
`.texture` (thumbnails, present mode's preparation, the render page's settle,
the zoom staging). Swapping what produces those, rather than the node, moves
every consumer at once and leaves none to drift:

- **Raster** — the renderer's `htmlText` system's public
  `getTexturePromise` / `returnTexturePromise` are wrapped per renderer
  (`runTextSystem.ts` → `installRunText`, after `patchHTMLTextRace` in
  `Canvas.tsx` and `thumbnails.ts`): the text's layout (`layoutCache.ts`),
  painted in a worker (`textRasterPool.ts`, `textRasterWorker.ts`,
  `paintRuns.ts`) into a canvas the size of the texture it gets — its own,
  exact-size, where the canvas draws the page; elsewhere the pooled
  power-of-two texture Pixi gives an HTMLText raster (decision 4, amended
  2026-10-31) — uploaded at once into that texture, and destroyed (or
  returned to the pool) when the pipe hands it back.
- **Measurement** — `HTMLText.updateBounds` (already wrapped by
  `htmlTextBoundsMemo.ts`) takes the same layout's size
  (`setHtmlTextMeasurer`): a text's bounds and its pixels come from one
  layout, laid out once (`readRuns.ts` in `layoutHost.ts`'s contained host).
- **Fonts** — the registry (`fontChanges.ts`) keeps every face's bytes and
  feeds them to the pool (`subscribeHtmlTextFaces`), which posts each face to
  every worker before any later paint; a worker paints only after the faces
  posted before the paint have loaded.
- **Fallback, per text** — what the run painter cannot draw as the engine
  does is named by the layout (`layout.unsupported`) or by a failed paint, and
  that text is rasterised by the system's original HTMLText path (the race
  patch and the table grouping around it). A worker that never starts (a CSP
  that blocks it fails silently: no `ready` within 4 s) or crashes is
  replaced by painting on the page with the document's fonts.

The gate (`e2e/text-runs-parity.spec.ts` over `e2e/fixtures/textCorpus.ts`;
`window.__narrative_runText.compare()`, `runText/fidelityProbe.ts`) draws
every text on the canvas both ways in the page and compares them channel by
channel, per slide, zoom and DPR.

### What the painter reproduces, and from where

The layout is the browser's; what the painter adds is drawn by each engine's
own rules, read from the engines' sources (Chromium 156.0.8078.4, the
Playwright build the gate runs; WebKit main of October 2026) and held to by
the gate:

- **Baselines** are rounded to a whole CSS px of the layout before the
  resolution scales them (the SVG raster scales the laid-out line).
- **Word positions**: Chromium's layout kerns across spaces and its canvas
  does not, so where a fragment has spaces each word is placed where the
  layout put it (range rects are exact in Chromium). WebKit's layout and
  canvas agree; its rects of partial ranges are snapped to whole px
  (`enclosingIntRect`), those of whole text boxes are not — WebKit draws
  each line fragment as its collapsed string from the box's start, word
  positions only for preserved tabs.
- **Collapsed whitespace**: a run of spaces is drawn as one space, and a
  leading space only where the layout gave it a box.
- **Underlines** (`decorations.ts`): Blink — thickness `auto` = size / 10
  (≥ 1), offset = rounded ascent + max(1, ⌈T / 2⌉), painted with the top
  rounded and the height floored in the text's own px, ink skipped where the
  glyph outlines cross the unsnapped line inset by ½ px (against the
  unrounded ascent's baseline), clipped out without antialiasing, widened by
  min(T, 13). WebKit — thickness = size / 16, offset = ascent + max(1,
  ⌈size / 16 / 2⌉), origin rounded then the top rounded up to a device px,
  the height unsnapped (≥ ½), faded by the scale below 1, ink skipped per
  glyph, widened by min(height, font height / 5). Glyph crossings are found
  on a mask of the glyphs 16× finer than a CSS px; CJK is drawn through, as
  both engines do.
- **Text stroke** (`-webkit-text-stroke`, `paint-order: stroke`): under the
  fill, miter joins; Blink's miter limit is Skia's default 4, WebKit's 10.
- **Bidi**: a fragment with right-to-left letters is split into the boxes the
  layout made of it, each drawn in its direction from its edge.
- **Shaping across spaces** (Blink): its canvas shapes word by word, its
  layout whole lines — kerning across a space and contextual alternates that
  look across one (Inter's raised dash between figures) were lost. Spaces are
  drawn as no-break spaces (the space glyph, no word boundary for the
  canvas), so the canvas shapes as the layout did; a word the layout still
  puts elsewhere is drawn from the whole string, moved, clipped to its
  stretch.

### Placement: where the page rounds (2026-10-27)

The page rounds a text's baselines to whole CSS px **in its own
coordinates** (the artboard's: slide px), then scales, then Skia rounds the
device y; horizontally glyphs keep sub-pixel positions (probe: spans in a
`scale(0.54)` element step once per CSS px of `top`, canvas `fillText` steps
on device px). A raster that rounds in its own coordinates and is drawn at a
fractional device position put lines of one box a whole device px apart from
the overlay at 100 % and up to 1 device px off at the fitted zoom — HTMLText
did the same; the canvas never matched the edit overlay exactly. Now:

- **The raster is painted for its place** (`runText/placement.ts`,
  `glyphRuns.ts` → `placeLayout`): an upright, unscaled text's layout is moved
  into world coordinates before painting, CSS-px roundings (baselines,
  underline positions) are taken from the page origin (the slide's 0, 0 in
  the canvas's world), device-px roundings on the canvas's grid, positions
  quantised to LayoutUnits (1/64 px — a sum a hair under a half otherwise
  rounds the other way, measured: one line 1 px off). The quad is drawn with
  `roundPixels` so its corner lands on the device pixel the raster was
  painted for, and content anchored right or centred is painted by the
  anchor's share of the rounded-up frame further right (Pixi anchors on the
  rounded frame: up to 1 device px left of the page, HTMLText too).
- **A text that moves is painted again** once it has stayed put for 150 ms
  (`PlacementWatch`, the renderer's `postrender`): while it moves it steps by
  whole device px.
  What counts as moved (2026-10-30, after the timing pass found every text
  of a no-op zoom gesture, a dragged table's 96 cells and a build's texts in
  present mode painted again for nothing):
  - a move by whole device px, whole rounding units of the page (CSS px in
    Blink, device px in WebKit) and whole LayoutUnits — the box and the
    frame moved with it — keeps the raster: each rounding commutes with it,
    and the quad moves with the text (`gridShiftKeepsRaster`, unit-tested
    against `placeLayout`);
  - a text off the grid now (turned or scaled by a parent, or drawn at
    another resolution than the canvas's — the zoom staging's to change) is
    not painted again: a new raster at its resolution would be resampled
    just the same. Only one the device-px painter now draws (a turned text
    box) is;
  - `holdPlacementRepaints` stops the watch: the editor's zoom gesture holds
    it until its commit (the region follows the live zoom and the grid's
    phase wanders while the compositor scales the canvas anyway; at the
    end every text is compared once), a pointer gesture until the button
    is released (a drag painted its texts again wherever the page stalled
    for 150 ms on the way — a GC mid-drag), and present mode's slide cache holds
    it for its life (every text is painted at rest while its slide is
    prepared; builds and transitions take texts away for a moment and put
    them back — ADR 0016, nothing painted after ready). A raster cut to the
    drawn region is still painted again once the region leaves it.
- **A raster for a resolution the canvas is about to draw at** is placed on
  that canvas's grid (2026-11-01): present mode prepares a standby set for a
  new display density while the canvas still draws at the old one, and the
  canvas publishes the page it will draw then (`setProspectivePage`); the
  plan takes the grid of the raster's own resolution (`pageGridFor`: the
  canvas's now, that prospective page, or none). Before, those rasters were
  painted unplaced and stayed so after the swap (ADR 0020 → Present mode).
- **The canvas is on the device pixel grid at every zoom** (`Canvas.tsx` →
  `resolutionFor`). The resolution was `dpr × max(1, zoom)`: below 100 % the
  canvas was drawn at 1× and shrunk by the compositor, and no raster could
  land where the page draws — it is `dpr × zoom` now, from the first paint
  (a deck opened at the fitted zoom is not rasterised twice). Since
  [ADR 0020](0020-editor-canvas-draws-the-visible-region.md) the canvas
  draws the region the window shows, with no pixel cap: its box sits at
  whole CSS px of the zoomed artboard and a `translate() scale()` about its
  corner puts its backing store texel for device px on a whole device px
  (Chrome snaps a replaced element's box in its own coordinates: a canvas at
  `top: 1092.5px` at 400 % was drawn 2 device px off). Text rasters snap to
  that texel grid, whose phase `setPageOrigin` carries
  (`placement.ts` → `gridPhaseOf`); nothing else moves.
- **Kerning**: the painter sets `textRendering = 'optimizeLegibility'`. A
  canvas's `auto` stops kerning a longer string where the page's
  `text-rendering: auto` kerns at every length (Chromium, 22 px, "— AV Ta
  WA To 0123": Arial 210.31 px on the canvas vs 207.09 laid out, Times New
  Roman 201.22 vs 197.22); with `optimizeLegibility` every probe matched the
  layout within 0.02 px. And where the whole string is as wide as the layout
  made the run (within two LayoutUnits) no word is moved: the per-word pens
  are estimates from measured substrings, and Times New Roman's legacy
  `kern` table misleads them (the suffix measured alone put "AV" 0.6–1.4 px
  left of where the whole string draws it — the 0.62 px of Times New Roman
  bold at 1×).

- **WebKit rounds to a device px of the page, not a CSS px** (2026-10-28):
  `roundToDevicePixel` takes the device pixel ratio, so at DPR 2 its
  baselines (and underline origins) land on half CSS px. The painter rounded
  to whole px: at DPR 2 WebKit put almost every text one device px off the
  overlay (81 of 147 gate rows, 4 px at 400 %). `RasterPlace.unit` carries
  the ratio (Blink keeps whole px): 13 of 147 rows over after, none of them
  by that rounding.
- **The world is the stage's own space** (2026-10-28). Pixi puts the canvas
  region's render transform into the stage's local transform while it
  renders (`RenderGroupSystem.render`), so `getGlobalTransform` called for a
  raster asked for during a render — a first raster, a resolution change —
  saw the region's offset as world and painted the raster for another place;
  the placement watch only caught it when the text moved.
  `placement.ts → sceneTransform` multiplies the local transforms below the
  root and is used for every placement.

### Turned, flipped and shrunk boxes (2026-10-28)

The edit overlay draws a text box through transformed elements: the rig,
turned and flipped about the box's centre, and in a shrinking box the frame,
scaled from its corner (`ui/TextEditOverlay.tsx`). An engine does not paint
such text as the product of the matrices: it snaps a transformed element's
offset first and rounds the baselines inside it, then rasterises every glyph
through the whole transform. `runText/pagePlacement.ts` is that model, held
against synthetic pages with a Canvas2D drawing of it (black text, DPR 1 and
2, 0°, 15°, 90°, 180°, a frame at 0.64, fractional offsets: pixel-identical
in both engines, a worker's `OffscreenCanvas` included):

- WebKit (`RenderLayer::paintLayerByApplyingTransform`): the layer's offset
  in its parent, plus the fraction carried in from the layers above, is
  rounded to a device px of the parent's coordinates (halves up,
  `LayoutUnit.h`), and what rounding took away is painted _inside_ the
  transform; baselines are rounded to a device px of the innermost layer.
  The rig's matrix is the engine's own (`DOMMatrix` of the overlay's CSS: a
  quarter turn given in radians comes out exact, `Math.cos(π / 2)` does not,
  and Core Graphics places a quarter-turned glyph otherwise than a nearly
  quarter-turned one).
- Blink: the offset is rounded to a whole px and the fraction dropped; the
  baseline to a whole px of the innermost layer.

Such a text's raster is painted in device px — the layout in the innermost
layer's coordinates, drawn through the page's transform, so the canvas's
Core Graphics or Skia places and rasterises each glyph as the page does —
and drawn upright, texel on device pixel: the quad is the raster's
rectangle, packed through the text's group transform times the inverse of
the one it was painted for (`runTextSystem.ts → hookQuadTransform`), so it
follows a moving box until the placement watch paints it again. Used for
WebKit's turned, flipped and shrunk boxes and Blink's shrunk ones. Blink's
turned boxes are composited instead — the compositor turns a raster of the
upright rig (a synthetic page with the WebGL canvas behind the rig differs
from the paint model by 0.1–0.9 px) — and are painted as that layer is
(2026-10-30, The residue below). WebKit at DPR 1, fitted zoom:
rot15 0.53 → 0.02, rot90 0.68 → 0.12, rot180 0.79 → 0.01, the tall-font
autofit box 1.02 → within, every shrunk box within.

Open: Playwright's WebKit screenshots are the page painted flat (a
compositing trigger changes nothing in them); Safari on screen composites
the turned rig with Core Animation, which may turn an upright backing
instead — to be checked by eye in Safari. (A WebKit box at exactly half a
px, which kept its baseline where the model moved it by a px, is resolved:
the baseline from the font's unrounded ascent, The residue below.)

### Fonts the folder brings (2026-10-27)

- **A worker's canvas keeps a font string's first resolution.** A text
  rasterised in a worker before its family's face had arrived there kept the
  fallback for every later raster in that font string (same family, weight,
  size), at the custom face's positions — garbled text, found by the
  custom-font gate. Each worker registers a family's faces under an alias
  that changes with every change to the family (`fontAliases.ts`,
  `textRasterWorker.ts`) and rewrites each paint's font strings to it.
- **No first raster in a fallback.** A text whose family has a face
  downloading, or — while the folder's font list has not arrived — a family
  neither registered nor installed on the system, holds its raster until the
  face is there (at most 6 s; `fontChanges.ts` → `markHtmlTextFacePending`,
  `setFontListPending`, `whenFamiliesSettled`; counted as
  `text.raster.heldForFace`). Pixi keeps drawing a text's previous texture
  meanwhile.

### Position gates (2026-10-27)

Where a text sits is held against the page, not against HTMLText:

- `e2e/text-edit-parity.spec.ts` — every corpus text (and the custom-font
  slide, table cells, rotated boxes; `TEXT_EDIT_PPTX=<file>|corpus` for an
  imported deck) at the fitted zoom, 100 % and ≈2.2×: the canvas text against
  the edit overlay, both as differences from the canvas without the text
  (any colour on any fill), compared by ink centres (`inkCentres.ts`: word x,
  line y; a line's x centre moves with mere weight). Tolerance 0.5 device px.
  Lines are the overlay's own line boxes (its text's range rects grouped by
  line), the rows between two lines split midway (2026-10-28: lines found as
  bands of ink split where one picture had a faint row between two lines and
  the other not, and a band's margin pulled the next line's top pixels into a
  word — 1.83 px on a shrunk box, measured, not drawn).
  DPR 1, both engines: in tolerance the largest offsets are 0.46 / 0.48 px
  (Chromium) and 0.28 / 0.47 px (WebKit), 120 of 145 texts. Not within it,
  and why:
  - the overlay drew differently (editor-ui, `ui/TextEditOverlay.tsx`) —
    fixed 2026-10-27 (`ui/textEditOverlayLook.ts`): it turns and flips
    about the box's centre, paints the fill with its alpha, the box's
    opacity, the stroke (`paint-order: stroke`), shadow and blur, clips as
    the mask does (a wrapping box at its sides only, a cell at its edge),
    and focuses without scrolling. After: rotated boxes 0.2–0.43 px
    (Chromium) / 0.21–0.79 (WebKit; were 34–227 px), stroke, alpha, line
    height 0.75 and translucent boxes within 0.13 px, no stage scroll;
  - a shrunk autofit box is a full-size raster minified on the canvas; the
    overlay lays it out at full size in a frame `1 / scale` as large,
    scaled by a transform (was CSS `zoom`, which laid it out at the small
    size): 0.5–1.0 px left, the canvas's (its raster is not placed —
    rasterTop returns null for a scaled node);
  - underlines at the fitted zoom (0.85–0.98 px): the overlay drew each
    underline twice — the editable root's `text-decoration` and the run's
    `<u>` — and at a fractional zoom the two antialiased bands darkened each
    other (row coverage 0.70 / 0.88 against one band's 0.45 / 0.65). The
    canvas's rule is the page's: a plain page at 0.54, 1, 1.5, 2.2 and
    3.49× puts the band at whole CSS px, its height floored (probe
    2026-10-27). Fixed 2026-10-27 (editor-ui): the root carries no
    decoration, each run's `<u>` is the only line (it is also the only one a
    plain run inside an underlined box can drop), and typed text the browser
    leaves outside its run (an empty paragraph, a replaced selection) or a
    box-wide change made while editing rebuilds the markup
    (`ui/textEditDom.ts` → `domShowsHtml`; e2e `text-edit-commands.spec.ts`).
    Underline slide at fit, Chromium: Δx 0.85–0.98 / coverage 1.07–1.18 →
    every box ≤ 0.09 px, coverage 1.00, except `u-box-arial` (Δx 0.68): the
    canvas skips ink 1–2 px wider than the page around descenders in the
    first underline row — the canvas's skip-ink geometry, unmasked once the
    second band was gone. WebKit: Δx 0.82–1.56 / Δy ≤ 0.52 → 0.29–0.76 /
    ≤ 0.20; left over `u-italic` 0.68 and `u-georgia` 0.59–0.76, where the
    canvas's band is lighter than the page's at fit (one row at coverage
    0.41; the page's 0.51 plus 0.04 on the row below) — the WebKit
    decoration rule, which
    also puts underlines 1–4 device rows from the page's when zoomed
    (probe: 12–24 px at 1×, 2.19× and 3.47×). WebKit's page also
    underlines a wrapped line's hanging space (Chromium's does not; a plain
    page and an editable one alike), the canvas does not: `u-small`'s first
    line is one space longer in the overlay, which the gate's word match
    turns into Δx 21.96 in two runs of three (0.43 in the other);
  - Times New Roman bold at 1× (0.62 px): words moved by misleading pen
    estimates — fixed above (Kerning);
  - at 349 % one no-wrap line 1.06 px — the canvas's, not the overlay's.
    The suspected cause, the overlay being snapped as a composited layer of
    its own, is disproved: the overlay paints into the artboard's layer
    (`translate(−2306.137, −3968.137) scale(3.4903)`, the bleed's corner),
    and the same markup on a page with nothing composited, in a
    `will-change` layer, or in a layer at the bleed's corner draws on the
    overlay's rows in every probe (Chromium: 90, at 1.5, 2.2 and
    3.40–3.55×; WebKit: 16, at 0.55, 1, 2.19 and 3.47×; 2026-10-27). The
    text is `nowrap-left` (22 px at 430, 860) at 100 % plus five wheel
    steps (3.490342855×): its
    baseline is at device 499.5017, which the page rounds to 500 and the
    canvas to 499 — a canvas rounding 0.0017 px from a half (at 3.4903×
    both draw it on the same row). Fixed 2026-10-28: the canvas's texel
    grid phase (`canvasRegion.ts → gridFraction`) was quantised to 1/64 px,
    "the layout's precision" — but the world's origin lies 400 × 3.4903… px
    from the artboard's corner, at any fraction: 0.140625 for 0.137187, and
    the painter put that baseline at texel 90.4984 instead of 90.5018. Now
    to 1/4096 px (past the DOMRects' float32 noise): 0.06 px.
- `e2e/text-edit-transition.spec.ts` — entering and leaving edit mode (Esc,
  a click on the pasteboard), each before and after typing, every painted
  frame observed in the page: never a frame without the text, with a stale
  raster, or with the text elsewhere than it settles. 48 / 48 transitions
  in Chromium and in WebKit — after: the edit fade is alpha 1/1024
  (`editedTextAlpha.ts`; at 0 Pixi skipped the node and never rasterised what
  was typed), the text is shown again in the next frame's `prerender`, and a
  raster still in a worker is painted on the page there
  (`rasterStaleTextNow`).
- `e2e/text-export-parity.spec.ts` — `deck.exportPng` and `deck.exportPdf`
  (the render worker) against the editor canvas at 100 %: 236 texts, the
  largest shift 0.02 px.
- Imported decks (`TEXT_EDIT_PPTX`): `import-test.pptx` 3/3 within
  (0.06 / 0.25 px); the real deck (tests/fixtures/pptx, not in the repo) 40 of
  54 within, the rest at the capped zoom; the corpus exported to .pptx and
  imported again shows the native corpus's cases.
  `e2e/text-import-parity.spec.ts` reports how far the runs moved from
  HTMLText's places on those decks (up to ~1 px: the placement above).

### The residue (2026-10-28 – 2026-10-30)

What the position gate still found after the placement above, by cause.
Every item was reproduced on a synthetic page before the painter changed;
the numbers are the gate's (`text-edit-parity`, tolerance 0.5 device px)
unless named otherwise.

- **WebKit paints a baseline from the font's unrounded ascent** (2026-10-28):
  `TextBoxPainter::textOriginFromPaintRect` adds
  `metricsOfPrimaryFont().ascent()` to the text box's top, where the painter
  took the layout's baseline (an inline-block's): ≈0.01 px apart, a device
  row whenever the sum sits at a rounding (Georgia italic at the fitted
  zoom, page 737.4995 against 737.496; Inter 16 px, page 148.5003 against
  148.4925). `fontBox.ts → paintAscent` reads it as the content height
  times the canvas's em-height share (`emHeightAscent` is size × ascent /
  (ascent + descent) in WebKit), the height laid out 16× larger where the
  share does not change with size; WebKit's LayoutUnit(float) truncates
  before it rounds (`RasterPlace.truncate`).
- **Underlines as WebKit draws them** (2026-10-28): the thickness is a
  sixteenth of the size ceiled to a device px of the text's own space
  (`resolveTextDecorationThicknessForPaintingBox`; drawn unrounded before:
  a lighter band at the fitted zoom), the offset is the font's unrounded
  ascent plus the gap (`computedUnderlineOffset`; the canvas reports the
  ascent rounded), and the space hanging at a wrap is underlined. Blink cuts
  its ink skip with the line's own rectangle outset by 1 px of the text's
  own space (`TextPainter::ClipDecorationsStripe`), rows rounded: at the
  fitted zoom a partly covered first row keeps its line. After: underlines
  at fit, 100 % and 400 %, DPR 1 and 2, both engines, within 0.30 px.
- **A raster larger than a texture** (2026-10-30): at 400 % and DPR 2 a
  120 px line across the slide is a ~15 000 texel raster, past the GPU's
  largest texture (the pooled one rounds up to 16 384), and was drawn as a
  black block. Such a raster is now painted for the part of the world the
  canvas draws (ADR 0020's region, `CUT_MARGIN` around it) at full density:
  the texture's `orig` is the whole raster, its `trim` the part, so the quad
  is anchored as before; the placement watch paints it again when a scroll
  moves the region past what it covers. Where there is no region (a
  thumbnail, the render page) or the text is not on the device grid, the
  resolution is lowered to what a texture holds. `e2e/text-raster-oversize`
  (fails without it, both engines).
- **Blink's turned boxes, composited** (2026-10-30): the overlay's rig is a
  composited layer over the WebGL canvas, and the compositor turns a raster
  of the upright layer. That raster starts at the layer's bounds — the
  rig's 2 px edit outline (`RIG_OUTLINE`), not the box's corner — at the
  canvas resolution, and Blink rounds the baseline to a whole px of the
  layer. The painter does the same (`devicePlan`, the Blink rig branch): an
  upright raster on that grid, turned by the quad. A synthetic page with the
  outline and a WebGL canvas behind it: pixel-identical at 15°, −45°, 90°
  and 180° for every fractional offset (≤ 4 px differing, Δ ≤ 0.007 px);
  from the box's corner instead, 90° and 180° texts were 0.13 px off, and
  unrounded baselines a px off past a half. The gate keeps the outline,
  transparent: hidden, it gave the layer other bounds than in use. Gate
  rows at the fitted zoom, DPR 1: rot15 0.15 → 0.09, rot−45 0.40 → 0.07,
  rot90 0.13 → 0.12 (0.26 between), rot180 0.32 → 0.12; DPR 2 ≤ 0.13.
- **WebKit truncates a box to LayoutUnits** (2026-10-30): a text box's
  position and width are `LayoutUnit`s (1/64 px, truncated), the remainder a
  float the painter keeps (`glyphRuns.ts → placeLayout`, WebKit only). The
  alignment slide: 0 of 27 rows over, zoomed included.
- **The underline's ink skip on a large glyph** (2026-10-30): the mask that
  finds where a glyph crosses the underline is sampled 8× per device px; at
  400 % and DPR 2 a 64 px glyph's mask was cut at its width cap and the
  crossings landed in the wrong place (u-big Δx 3.29). The samples are now
  lowered per glyph to what the mask holds: 0.01.
- **WebKit uploads a bitmap straight** (2026-10-30): WebKit's WebGL ignores
  `UNPACK_PREMULTIPLY_ALPHA_WEBGL` for an `ImageBitmap` — the colours come
  in unpremultiplied — and Pixi blends premultiplied, so every partly
  covered pixel of non-black text was drawn too bright or too dark: the
  same bitmap over a fill, WebGL against Canvas2D's `drawImage`, carried
  0.84× the ink (grey on light), 1.48× (white on navy), black exact; a
  canvas element uploads right. That, not font smoothing, was WebKit's
  "lighter non-black text" (Fidelity) and the table rows' coverage
  (0.66 and 1.45). `runTextSystem.ts → premultipliesBitmaps` asks each
  renderer once (a 1×1 half-transparent white bitmap, read back), and where
  bitmaps upload straight the raster is drawn into a canvas that is
  uploaded instead. Since 2026-10-30 that is Pixi's upload extension point
  (`ExtensionType.TextureUploaderWebGL`, `narrative-run-raster`,
  `runText/runRasterUpload.ts`): the
  bitmap stays the texture's resource and is drawn into a scratch canvas of
  its size, kept per size (8 canvases, 8 Mpx at most), at every upload — a
  canvas per raster cost a fixed 0.25–0.6 ms each (WebKit microbench: 256 ×
  64 0.81 → 0.44 ms a raster, 2048² 11.4 → 9.0 ms; the bitmap's own
  upload 0.19 and 13.3 ms). WebKit DPR 1: tables 0.33–0.77 px →
  ≤ 0.02, coverage 1.00; 7 → 5 of 264 rows over (measured with a canvas per
  raster, before the extension). The extension's first registration,
  `extensions.add({ extension, ref: uploader })`, never reached the texture
  system: Pixi takes any object with an `extension` key for the extension
  itself, so it registered the wrapper, which has no `upload` — every run
  raster in WebKit threw in `onSourceUpdate` and stayed an empty texture, no
  canvas text at all (WebKit DPR 1 parity: 125 of 130 rows with no canvas
  ink, 2026-10-31). The uploader now carries `extension`, `id` and `upload`
  itself, as Pixi's own do; `runRasterUpload.test.ts` checks the
  registration against the real Pixi (the unit-test mock's
  `extensions.add` had accepted the wrapper).
- **What is left is the engines' own painting, not placement** (2026-10-30):
  - WebKit paints HTML text heavier than its canvas once a glyph is larger
    than ~180 device px (a plain page, 48 px Inter: at 3.7× identical, at
    3.8× the canvas carries 0.955× the ink; DPR 1 and 2, black and grey
    alike). In the app at 400 % the overlay and plain HTML agree (1.046× the
    canvas at DPR 1, 1.024× at DPR 2; Chromium 1.000). The page's stems are
    ~0.8 device px wider, more to the left, which moves ink centres by
    0.5–1 px: the zoomed rows over at WebKit DPR 2 (and sizes 48–120 px
    zoomed at DPR 1) are this. No Canvas2D setting reaches it.
  - Chromium's HTML paint cuts a colour emoji's bitmap (the rocket's nose,
    2–3 px at 26 px and 0.54×) where its canvas draws all of it: sc-emoji at
    the fitted zoom, DPR 1, 0.58 px. A clip to the canvas's `measureText`
    bounds comes close but is not the engine's rule.
- **A digit at a direction boundary** (2026-10-30): for each character the
  bidi split asks for its client rect; at a direction boundary WebKit gives
  a character two — its glyph's and a zero-width one at the neighbouring
  box's edge, in that order — and the split took the last, so the "1" of
  "עברית 123" went into the Hebrew run, drawn there, and "23" took its
  place (Chromium gives one rect). The split takes the widest
  (`readRuns.ts → bidiRunsOf`): `sc-mixed-bidi` at the fitted zoom, WebKit,
  0.43 / 0.66 px (DPR 1 / 2) →
  within (no longer among the rows over).
- **HTMLText past a texture, too** (2026-10-30): Pixi's own HTMLText raster
  (the `html` engine and the runs' per-text fallback) drew an oversize text
  as the same black block; it is rasterised at the largest resolution a
  texture holds (`patchHTMLTextRace.ts → withinTexture`, counter
  `text.raster.softened`). `e2e/text-runs-artboard` had passed at 400 %
  only because both of its pages were black; a state where the HTMLText
  reference had to soften is now reported, not compared.

The gate after all of the above (2026-10-30, 264 rows per run; in
tolerance, the largest line Δy / word Δx):

| engine   | DPR | rows over | in tolerance | the rows over                                                                                |
| -------- | --- | --------- | ------------ | -------------------------------------------------------------------------------------------- |
| Chromium | 1   | 0         | 0.08 / 0.34  | —                                                                                            |
| Chromium | 2   | 0         | 0.10 / 0.47  | —                                                                                            |
| WebKit   | 1   | 5         | 0.39 / 0.32  | sizes 48–120 px at ≈2.2× (glyphs past ~180 device px), sc-emoji (fit 0.77, zoomed 0.53)      |
| WebKit   | 2   | 33        | 0.38 / 0.50  | 31 at 400 % (every glyph past ~180 device px: word Δx 0.6–1.3, ink 1.03–1.05×), sc-emoji fit |

(At the start of the round: Chromium 2 / 1 of 147 rows over at DPR 1 / 2;
WebKit 13 of 147 at DPR 2 after the unit fix, 81 before it.) WebKit's
`sc-emoji` (0.77–0.95 px) and the large `line Δx` of some 400 % rows (a
line seen in part) were not taken further: the colour emoji's rule is
the engine's, as in Chromium. `text-edit-transition`, `text-import-parity`
and `text-raster-oversize` pass in both engines, `text-export-parity` and
`text-runs-parity` in Chromium; `text-export-parity` in WebKit compares a
WebKit editor with the render worker's headless Chromium and finds 204 of
the texts 0.5–1.15 px apart vertically — the two engines' layouts, not a
painter's. **Accepted (Petr, 2026-10-31):** an export is one picture for
every viewer, drawn by the render worker's Chromium; a WebKit editor
(Safari, the Tauri app) may sit up to ~1 px from it. The spec skips WebKit
with this reason; a WebKit render worker is not planned.

### Line breaks and the edit overlay (2026-10-28)

- **A soft break that ends a paragraph starts a line**, as in PowerPoint
  and Keynote (the paragraph's end sits on it). `a<br>` ending its block
  draws no line in HTML, so the canvas and the overlay drew `"a\n"` as one
  line; `buildListedHtml` now holds that line open with a placeholder
  `<br data-empty="1">`. The model is unchanged (the PPTX writer and
  reader never see the HTML: `<a:br/>` stays one break).
- **Placeholders are no characters** (`ui/textEditDom.ts` →
  `isPlaceholderBr`, `textChars`): the block's last break when it holds
  nothing else or follows a break — the document's `<br data-empty>`, and
  the browser's own (`<br>` in an emptied block, `a<br><br>`, and in
  pre-wrap text Chromium's `"a\n\n"`). Counted, Shift+Enter at a
  paragraph's end became a new paragraph and an emptied box kept a `"\n"`.
- **Shift+Enter is a command** (`text.edit` inserting `"\n"`), as Enter is,
  and **undo / redo while editing are the document's history** (the
  UndoManager the commands write to, caret at the change), not the
  browser's, which replayed its own DOM edits against markup rebuilt since
  (after Shift+Enter it did not take the break back). e2e:
  `text-edit-commands.spec.ts`, `table-commands.spec.ts` (a cell), both
  engines.

### Fidelity, as measured (2026-10-26)

`e2e/text-runs-artboard.spec.ts`: the corpus deck in two pages (HTMLText,
glyph runs), the artboard's canvas pixels compared channel by channel at the
fitted zoom (≈0.53×), 100 % and ≈2.2×, and the thumbnails.

**Chromium** (156, DPR 1): bit-identical everywhere for spacing, alignment,
autofit, lists, runs and transforms, tables and the 121-text crowded slide;
sizes, families and underline when zoomed. Left, measured:

| where                              | max Δ (of 255) | pixels | cause                                                                                     |
| ---------------------------------- | -------------- | ------ | ----------------------------------------------------------------------------------------- |
| Times New Roman at 1× (fit, 100 %) | 169            | 1 446  | its layout places glyphs after an em dash 0.6–1.4 px from the canvas's pen; exact at 2.2× |
| 8 px and 9 px text at 0.53×        | 236            | 2 280  | drawn one device px higher (glyphs under 5 device px); exact at 1× and 2.2×               |
| Japanese, Chinese                  | 238            | 424    | residue after per-character placement                                                     |
| underline                          | 238            | 2–12   | single pixels at gap edges; exact at 2.2×                                                 |

**WebKit**: not reproducible with Canvas2D text. WebKit draws HTML text with
CoreGraphics font smoothing (`CGContextSetShouldSmoothFonts(true)`,
`FontCascadeCoreText.cpp`) and canvas text without it, in any canvas
configuration; smoothing dilates the outlines of non-black text (black text
is exact: the crowded slide at 1×), so the difference (Δ 35–46 at 1× on dark
grey text, more when zoomed) is not a coverage curve the painter could
apply. Petr accepted it (2026-10-26): WebKit — Safari, the Tauri shell —
draws runs too, its non-black text a shade lighter than its HTML text; the
position gate holds there as in Chromium (ink centres, not pixels).
Corrected 2026-10-30 (The residue): the shade was WebKit's WebGL uploading
the raster's bitmap unpremultiplied, not font smoothing — a plain page draws
HTML and canvas text alike below ~180 device px, coloured or not — and is
fixed; what remains is WebKit's heavier HTML glyphs above that size.

### Cost, as measured in the app (2026-10-26)

Chromium 156, MacBook M3 Pro on AC, production builds of one tree with
`VITE_TEXT_ENGINE=html` and `=runs`, the perf driver's interleaved A/B, 5
runs a side (`~/.cache/narrative-perf/round-logs/F1.md` has the run):
`table.mount.styled` longest frame 83 → 17 ms, long tasks 70 → 0 ms;
`viewport.zoom.commit.table` long tasks 230 → 60 ms; `viewport.zoom.commit`
settle 505 → 419 ms; `deck.open.cold.100` all settled 5.9 → 4.7 s;
`present.advance.text` ready 1.23 → 1.09 s; embedded font CSS per raster
gone (`text.raster.fontKb` → 0). `render.ms` grows in the table benches
(26 → 44 ms over 24 keys) with no frame or input cost — to profile before
the flip.

**2026-10-27** (same machine and method). `render.ms` in the table benches
is Pixi's batching: every cell is a run raster of its own where HTMLText
drew a table's cells as one (`htmlTextGroupRaster`), so each structure
rebuild packs more batch elements — about 0.3 ms per frame while typing in a
cell (`table.cell.type` 28.5 → 43.4 ms over 49 frames), no frame or input
cost; grouping a table's run rasters into one atlas would take it back. The
placement watch's own share (≈2 ms over that bench) is skipped for texts
whose transforms did not change. HEAD against the working tree (which also
holds other workstreams' uncommitted changes): `deck.open.cold.100` settled
5715 → 2380 ms; zoom commits settle −14 to −17 % with no long task; but
zooming back out below 100 % now commits too (the canvas at the zoom's
resolution, Placement): `viewport.zoom.commit` frame.max 33 → 83 ms (one
backbuffer reallocation after the gesture), and the wheel benches
re-rasterise after a gesture below 100 % (242 texts, off the main thread;
the light slide settles 22 → 178 ms). `present.advance.text` ready
1170 → 1296 ms: likely the first raster waiting for its face instead of
painting a fallback first (Fonts above) — not yet isolated.
