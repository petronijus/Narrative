# ADR 0009 — PowerPoint: one translation, both directions

**Status**: Accepted (2026-09-23).
**Scope**: `apps/server/src/pptx/` — the `.pptx` importer (`parser.ts`,
`writer.ts`) and exporter (`ooxml/writeDeck.ts`), the export route
(`routes/pptxExport.ts`), and the export dialog's compatibility list
(`apps/web/src/lib/pptxCompat.ts`).
**Supersedes**: the pptxgenjs-based exporter (`pptx/export.ts`, M28 phase 2).

## Context

Import and export were two unrelated translations. The importer was a
hand-written OOXML reader; the exporter drove pptxgenjs, a library that
writes PowerPoint from its own option objects, plus a post-processing pass
that patched the XML it could not produce. Every meaning had to be kept in
step by hand in two vocabularies that never met — and they drifted:
rotation units, gradient angles, paragraph breaks, bullet glyphs, crops,
custom geometry, line ends. On the Proseware client deck, import → export →
import changed **6 173** values in 61 kinds. An exported deck opened in
PowerPoint looked broken, and the same file imported back into Narrative was
not the deck that had been exported.

pptxgenjs cannot be made exact: it has no notion of many model fields, it
converts through inches, and it owns the XML it writes.

## Decision

1. **One OOXML layer, read and write side by side.** `pptx/ooxml/` holds
   every element's reader next to its writer — units (`units.ts`),
   enumerations (`vocabulary.ts`, bijections checked at load time), colour,
   fill, line, effects, geometry, text bodies, tables, transitions, timing,
   notes. The exporter writes the package itself (`writeDeck.ts`); pptxgenjs
   is gone. The parser uses the same readers, so a value has one meaning in
   both directions.

2. **The invariant is tested, not hoped for.** `roundtrip.test.ts` builds a
   deck covering every object type and every model field in at least one
   non-default state (`roundtripMatrix.ts`) and requires
   model → export → import to give the model back, field for field, speaker
   notes included; a second export of the imported deck must be
   byte-identical. `scripts/pptxRoundtrip.ts` runs the other direction
   (import → export → import) on real decks that cannot live in the repo.
   `ooxml/validate.test.ts` validates every exported part against the
   ECMA-376 schemas with `xmllint` (vendored in `ooxml/__schemas__/`).

3. **Native first, then Narrative's own extension.** Everything OOXML can
   express is written natively — that is what PowerPoint shows and what the
   importer reads. A value the native form cannot carry exactly (a field
   OOXML has no place for, `false` where only `true` has a form, a value it
   would round, a fallback colour next to a gradient) goes into an extension
   inside the file, OOXML's own mechanism for application data
   (`<a:extLst>` / `<p:extLst>`), which PowerPoint keeps and ignores:
   - per object on `<p:cNvPr>` (`ooxml/objectExt.ts` decides, per field and
     object type, what goes there);
   - per slide, run, paragraph, timing tree and notes page.

   An extension only applies while the native XML it was written next to is
   unchanged — the shape's frame, the picture's crop, the paragraph's
   bullets, the notes' text. Something edited in PowerPoint since is read
   from the native XML; the stale extension is ignored. Fields the import
   would fill with defaults the model did not have are named with the value
   the export produced (`implicit`) and dropped only while they still hold
   it.

4. **The extension is untrusted input.** It comes out of an uploaded file.
   Every field is validated against its model type (`extSchema.ts`,
   `objectExt.ts`); identity and linkage fields (ids, asset ids, text,
   hyperlinks) are never read from it; notes documents are allowlisted to
   the notes editor's node and mark types; animation parameters are bounded.
   Asset references never travel in it — pictures are always native, and
   the import resolves its own assets from them.

## Consequences

- The Proseware deck round-trips with **0** differences (was 6 173); the
  feature matrix with 0. LibreOffice renders the export of the Proseware deck
  about five times closer to the original than the pptxgenjs export (mean RMSE
  0.033 vs 0.163 per slide).
- Building the invariant exposed importer bugs that PowerPoint decks hit on
  their own, fixed with it: runs inheriting the formatting of the run to
  their left, character references (`&#233;`) left undecoded, cells after a
  horizontal merge shifted a column, text insets ignored, geometry dropped
  from text-bearing ellipses and other non-rectangles, empty transitions
  imported as fades, straight lines imported 1 px tall.
- A new model field is not done until both sides handle it: the matrix
  fails otherwise. Add it to `roundtripMatrix.ts` in a non-default state.
- The extension format is permanent: files in the wild carry it. The URIs in
  `narrativeExt.ts`, `text.ts`, `timing.ts` and `notes.ts` must never change;
  new fields are added, old ones keep being read.
- The export dialog lists what PowerPoint _shows_ differently, not what is
  lost: nothing is (`pptxCompat.ts`).
- Tests need `xmllint` (macOS ships it; Linux: `libxml2-utils`).
