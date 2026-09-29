# PowerPoint import and export

Decision record: [ADR 0009](../../../../docs/adr/0009-pptx-one-translation-both-directions.md).

```
.pptx ──parser.ts──▶ ParsedPptx ──writer.ts──▶ Y.Doc (the model)
  ▲                                                  │
  └──────────────── ooxml/writeDeck.ts ◀─────────────┘
```

Both directions translate through `ooxml/`, one module per concern, reader
next to writer:

| Module                                            | Reads and writes                                                                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `units.ts`                                        | EMU, points, angles, percentages ↔ canvas px (exact: 1 canvas px = 6 350 EMU)                                                                   |
| `vocabulary.ts`                                   | every enumeration (alignment, anchors, autonumbering, caps, line ends, dashes, polygons, transitions, animation presets) as a checked bijection |
| `read.ts` / `xml.ts`                              | parsing (character references decoded) and serialising (escaping, invalid characters dropped)                                                   |
| `color.ts`, `fill.ts`, `line.ts`, `effects.ts`    | colours, solid / gradient fills, outlines, blur and shadow                                                                                      |
| `shapes.ts`                                       | frames, preset and custom geometry, pictures (fitted crops), picture masks, video                                                               |
| `text.ts`                                         | text bodies: frame tier (`lstStyle`), paragraphs, runs, insets                                                                                  |
| `table.ts`                                        | tables, merges, cell borders and fills                                                                                                          |
| `transition.ts`, `timing.ts`                      | slide transitions (incl. Morph / Cube via Markup Compatibility), animations                                                                     |
| `notes.ts`                                        | speaker notes as the notes editor's document                                                                                                    |
| `package.ts`                                      | the package's fixed parts (content types, masters, theme, properties)                                                                           |
| `narrativeExt.ts`, `objectExt.ts`, `extSchema.ts` | Narrative's extension: what the native XML cannot carry, and its validation                                                                     |

## The rule

Write every value natively where OOXML can say it — that is what PowerPoint
shows. Where it cannot say it exactly, write the best native approximation
**and** the exact value in the extension; the extension applies only while
the native XML next to it is unchanged. `objectExt.ts` is the single table of
which fields go where; read it before adding a field.

## Checking changes

```bash
pnpm --filter server test                    # includes the three below
npx vitest run src/pptx/roundtrip.test.ts    # model → export → import = model (feature matrix)
npx vitest run src/pptx/ooxml/validate.test.ts   # every part against ECMA-376 (needs xmllint)

# A real deck (client decks stay out of the repo): import → export → import
npx tsx src/scripts/pptxRoundtrip.ts deck.pptx [--out exported.pptx] [--detail]
# The feature matrix, with the exported file to inspect
npx tsx src/scripts/pptxRoundtrip.ts --matrix --out matrix.pptx
```

Adding a model field: put it in `roundtripMatrix.ts` in a non-default state;
the round-trip test fails until both directions carry it.

Shape outlines: a triangle is written as `prstGeom triangle` and a regular
polygon as custom geometry from `regularPolygonVertices`
(`@narrative/shared` `shapeGeometry.ts`, the outline the canvas draws). Since
2026-09-29 the canvas draws a triangle as PowerPoint does — filling its box
— so an imported triangle keeps its size on screen (was: drawn inscribed in
the box's ellipse, smaller than in PowerPoint). The model is unchanged, so
the round trip is too: the Proseware deck (49 slides) reported 0 differences
both before and after that change (2026-09-29, MacBook).

Known state (2026-09-26): the real-deck script is **not** at 0 differences.
It reports 5 at `v0.9.29` (`4e3c503`, clean checkout) — `fillStyle.centerY`,
`text.length`, and `fontSize` 27.99 → 28 — while 0.9.25 recorded 0 on the
Proseware deck. Not bisected; which real deck produced the 5 was not recorded.
Until it is fixed, "0 differences" means "no differences beyond these 5".

Other real decks are further off, and were already at `v0.9.29` (checked
2026-09-27, identical reports at `v0.9.29` and at 0.10.0): a Tailspin brand deck
(12 slides) shows 22 differences (`fontSize` 27.99 → 28 in objects and runs,
one `text.length`), a Contoso deck (36 slides) 41 (`text.length`, `strokeWidth`,
geometry, and run `attrs` lost on 4 slides). For a change to this module,
"no new differences" is measured against the same deck at the previous
release, not against 0.

Visual check against an independent renderer:

```bash
soffice --headless --convert-to pdf original.pptx exported.pptx
pdftoppm -r 40 -png original.pdf a; pdftoppm -r 40 -png exported.pdf b
compare -metric RMSE a-01.png b-01.png null:
```
