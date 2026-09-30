# PPTX fixtures

Drop real-world `.pptx` files here to check the importer and exporter
against decks the test suite cannot carry. Files in this directory are
**not committed** — see `.gitignore` at the repo root (client decks stay
out of the repo; a shared one lives in the private overlay).

## What they are for

- **The round trip** — `just pptx-roundtrip <deck>` imports a deck, exports
  it, imports the export and lists every difference
  (`apps/server/src/scripts/pptxRoundtrip.ts`); the target is 0
  differences. Run it on a real deck whenever `apps/server/src/pptx/`
  changes (AGENTS.md → When to run what).
- **The import fidelity capture** — `apps/web/e2e/pptx-import-fidelity.spec.ts`
  imports `<name>.pptx` from here (`PPTX_FIDELITY_DECK=<name>`, needs the
  dev stack) and screenshots every slide; with LibreOffice renders under
  `reference/<name>/`, `tests/pptx-import/generate-report.mjs` stitches
  both into a side-by-side HTML report. A diagnostic, not a regression
  test.

(The Phase 1 spike that used to read every deck here and report tag
histograms, `pptxSpike.ts` in apps/server, was removed on 2026-09-23 when
one OOXML translation replaced the pptxgenjs exporter; the round trip took
its place.)

To exercise the realistic input surface, drop:

1. A **PowerPoint (Microsoft 365)** export — File → Save As → `.pptx`,
   ideally from one of the bundled templates so it carries master +
   layout + theme content.
2. A **Canva** export — pick any deck, Share → Download → PowerPoint
   (PPTX). Canva pptx files tend to have heavy use of grouped shapes
   and rasterised effects.
3. A **Keynote** export — File → Export To → PowerPoint. Keynote's
   exporter is conservative and skews toward shapes + text.

## What a good fixture must exercise (added 2026-09-08, after 0.9.1)

The 0.9.1 bugs were **inheritance** bugs, and a fixture that carries all its
formatting inline will not reproduce them. When picking a deck, prefer one
where:

- **Runs name fonts indirectly** — `<a:latin typeface="+mn-lt"/>` rather than a
  literal family. The parser had no font-scheme resolver until 0.9.1, and 699
  of 955 runs in the reference deck (73 %) came through with no `fontFamily`
  at all.
- **A layout placeholder omits `<a:xfrm>`** and inherits its box from the
  master. Entry-level replacement (instead of per-property merge) made the
  frame come out `0×0`, which word-wrapped the text at width 0 — measured
  4704 px tall on a 720 px slide — and the clip mask removed the rest, so the
  slide-1 title was simply invisible.
- **`theme1.xml` carries a real `<a:fontScheme>`**, with distinct major and
  minor faces so `+mj-*` vs `+mn-*` resolution is observable.

Template-derived exports (PowerPoint's own bundled templates, corporate
templates) satisfy all three; hand-built one-slide decks usually satisfy none.
Regression tests: `apps/server/src/pptx/parser.test.ts`.

## Committed coverage

What must hold for every deck is tested without fixtures: the feature
matrix round trip (`apps/server/src/pptx/roundtrip.test.ts`) and the
ECMA-376 schema validation of every exported part
(`apps/server/src/pptx/ooxml/validate.test.ts`).
