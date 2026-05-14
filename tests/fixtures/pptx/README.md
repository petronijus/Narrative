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

## Beyond the spike

Once Phase 2/3 land, this directory becomes the home of the
`*.snapshot.json` golden files for the import tests. At that point we
may commit a small (single-digit MB) curated subset to make CI
reproducible. For now, fixtures are caller-supplied.
