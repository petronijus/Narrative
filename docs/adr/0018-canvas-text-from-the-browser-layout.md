# ADR 0018 — Canvas text: the browser lays it out, a worker paints the glyph runs

**Status**: Proposed (2026-10-20, renderer; for the tech-lead and Petr). Not
built: the measured spike is on branch `perf/crowded-slide`
(`apps/web/src/renderer/experimental/textEngine/`, the dev-only page
`/text-engine-spike.html`, `e2e/text-engine-spike.spec.ts`).
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

## Decision (proposed)

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
4. **Exact-size textures under the ResourceManager.** A raster is uploaded
   from its `ImageBitmap` into a texture of its own size (not a pooled
   power of two) whose lifecycle the ResourceManager owns, like pictures.
5. **HTMLText stays as the fallback** behind a renderer flag until the
   fidelity spec covers every feature exactly in both engines; the switch
   is per renderer instance, so thumbnails, the editor and present mode can
   move together.

## Consequences

- Per text, the main thread does one contained layout plus a few range
  reads; no serialisation, no SVG document, no font decode, no image load.
  Workers do the painting in parallel. Zoom re-rasters cost a paint and an
  upload, no layout. Texture memory halves (no power-of-two padding).
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
