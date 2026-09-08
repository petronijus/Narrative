# PPTX fixtures

Drop real-world `.pptx` files here to feed the M28 spike + future import
tests. Files in this directory are **not committed** — see `.gitignore`
at the repo root.

## What to drop for the Phase 1 spike

The spike (`apps/server/src/scripts/pptxSpike.ts`, runnable via
`pnpm --filter @narrative/server pptx:spike`) auto-picks up every
`*.pptx` in this directory and runs the parser against it, printing
per-file long-tail histograms.

To exercise the realistic input surface, drop:

1. A **PowerPoint (Microsoft 365)** export — File → Save As → `.pptx`,
   ideally from one of the bundled templates so it carries master +
   layout + theme content.
2. A **Canva** export — pick any deck, Share → Download → PowerPoint
   (PPTX). Canva pptx files tend to have heavy use of grouped shapes
   and rasterised effects.
3. A **Keynote** export — File → Export To → PowerPoint. Keynote's
   exporter is conservative and skews toward shapes + text.

Three samples are enough to validate the mapping table. More can be
added later.

## What the spike reports

For each file: ZIP entry count, slide count, distinct XML tags, hits
on the M28 mapping table (MVP-covered / deferred / unknown), per-slide
shape + fill + rotation breakdown. The output report lands at
`<tmp>/narrative-pptx-spike/spike-findings.md`.

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

## Beyond the spike

Once Phase 2/3 land, this directory becomes the home of the
`*.snapshot.json` golden files for the import tests. At that point we
may commit a small (single-digit MB) curated subset to make CI
reproducible. For now, fixtures are caller-supplied.
