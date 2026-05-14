# M28 — PowerPoint import & export — plan

**Status**: planning, not yet implemented.
**Branch**: `plan/m25-powerpoint-import-export` (path predates noticing
M28 already exists in `BUILD_PLAN.md` with PPTX export parked).
**Supersedes**: the "PPTX export: parked" note in the current M28
entry — this plan un-parks export and adds import as the headline
delivery.

## Goal

Round-trip a deck between Narrative and Microsoft PowerPoint with
acceptable fidelity for content-focused decks (text, images, basic
shapes, layouts). Animations / transitions / charts / SmartArt are
**explicitly out** of MVP — they're a long-tail rabbit hole that can
eat the whole milestone.

Two flows:

1. **Import**: user drags a `.pptx` onto a folder → it materialises as
   a Narrative deck.
2. **Export**: user clicks "Export → PowerPoint" on a deck → a `.pptx`
   downloads.

## Honest framing

`.pptx` is a ZIP of XML files following the **PresentationML** schema
(part of the OOXML spec). The spec is 5000+ pages. Every shape has
dozens of properties; every formatting run can carry its own style;
slide layouts cascade into masters; themes carry colour palettes and
font schemes. **100% fidelity is not achievable without writing
something the size of LibreOffice Impress.** Every successful PPT-
import tool (Google Slides, Keynote, Canva) is lossy and ships
documented caveats.

The right framing is: pick the smallest subset that handles 80% of
real-world content decks (no marketing-grade animations), ship that,
add features as concrete user requests roll in.

Round-tripping (import → export of the same file) is a separate
quality bar. We should target "looks recognisably the same" for the
MVP subset, not byte-perfect.

## Scope

### In MVP

| Feature                                                        | Import                       | Export         |
| -------------------------------------------------------------- | ---------------------------- | -------------- |
| Plain text frames (one style per frame, no per-run formatting) | ✅                           | ✅             |
| Images embedded in slides                                      | ✅ extract + upload to MinIO | ✅ embed bytes |
| Rectangle / ellipse / line shapes with solid fill + stroke     | ✅                           | ✅             |
| Slide background (solid fill, image fill)                      | ✅                           | ✅             |
| Slide order                                                    | ✅                           | ✅             |
| Deck title (from file name)                                    | ✅                           | n/a            |
| Position + size (EMU → px)                                     | ✅                           | ✅             |
| Rotation                                                       | ✅                           | ✅             |

### Deferred (post-MVP, in priority order)

| Feature                                                                 | Note                                                                                                                                                                   |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-run text formatting (mixed bold/italic/color within one text frame) | Tiptap supports this in our model; matching to PPTX runs requires a richer mapper.                                                                                     |
| Slide layouts / masters                                                 | PPTX inherits style from `slideLayout*.xml` → `slideMaster*.xml`. Until we model layouts, every slide imports as a "Blank" layout with all properties resolved inline. |
| Theme colour + font schemes                                             | PPTX's `theme1.xml` defines accent1..6 + body/heading fonts. We could map to Narrative's folder-scoped colour tokens + uploaded fonts.                                 |
| Tables                                                                  | Significant rendering work — PPTX tables are styled per-cell.                                                                                                          |
| Charts                                                                  | Bound to embedded XLSX data. Out of scope for a long time.                                                                                                             |
| Animations / transitions                                                | PPTX's animation timeline schema is fundamentally different from our GSAP DSL. Mapping would lose information in both directions.                                      |
| SmartArt                                                                | Generated from a small graph + rules. Not worth chasing.                                                                                                               |
| Video, audio                                                            | Embedded media in PPTX = base64 inline. Doable but heavy.                                                                                                              |
| Speaker notes                                                           | Trivial when we add M19 (notes feature).                                                                                                                               |
| Slide groupings / sections                                              | PPTX has section dividers. We don't have a model for these.                                                                                                            |

## Architecture

Both flows are **server-side**. Reasons:

- Import inherently writes Yjs state authoritatively → same pattern as
  M16 AI generation. Doing it client-side would require shipping the
  whole parser bundle + handling network failures mid-write.
- Export needs to fetch media bytes from MinIO. Client-side could
  fetch via presigned URLs but then the SPA carries pptxgenjs (~200KB)
  just for this feature.
- Symmetry: keeping both on the server means one code path knows the
  mapping rules in both directions, easier to unit-test.

### Import pipeline

```
SPA: drag .pptx onto folder
  ↓
POST /api/folders/:id/import (tus, mime application/vnd.openxmlformats-officedocument.presentationml.presentation)
  ↓
server-side onUploadFinish:
  1. Validate file (mime, size cap 100 MB, ZIP magic bytes).
  2. Insert deck row (title = filename).
  3. Enqueue BullMQ job { deckId, storageKey }.
  4. Return 200 { deckId, jobId } immediately.
  ↓
worker (apps/server-or-new-worker/src/pptx/import.ts):
  - Stream .pptx from MinIO.
  - Walk ppt/slides/*.xml in order.
  - For each slide:
    a. Parse XML → intermediate JSON.
    b. Resolve sp (shape) → Narrative object (rect/ellipse/text/image).
    c. Convert EMU coordinates (914400/inch) → px (96 DPI).
    d. For image refs: extract from /ppt/media/*, upload to MinIO via
       existing tus client OR direct s3 PutObject, attach assetId.
    e. Emit Y.Doc updates via server-side Yjs client (same pattern as
       packages/slide-model/.../mutations + onUpdate broadcast).
  - On finish: mark deck ready, send Sentry breadcrumb, emit log line.
  - On error: roll back deck row, surface to SPA via job status.
  ↓
SPA: polls GET /api/decks/:id/import-status?jobId=… until 'done' →
  navigates to /deck/<deckId>.
```

### Export pipeline

```
SPA: editor toolbar "Export → PowerPoint" OR folder kebab → "Export"
  ↓
GET /api/decks/:id/export.pptx
  ↓
server route handler:
  1. Auth → editor+ role on deck.
  2. Load Y.Doc state (deck_updates aggregate, same path as renderer).
  3. For each slide, for each object:
     - text → pptxgenjs addText(...)
     - image → fetch bytes from MinIO via signed URL (server-side),
       pass Buffer to pptxgenjs.addImage({ data: ... }).
     - shape → pptxgenjs addShape(...)
     - rect/ellipse/etc. → matching pptxgen primitive.
  4. Build the .pptx in memory (pptxgenjs ~10-50 MB working RAM for
     typical decks).
  5. Stream as application/vnd.openxmlformats-…-presentation with
     Content-Disposition: attachment; filename="<deck.title>.pptx"
  ↓
browser: downloads file.
```

For decks >200 slides or with many videos we may need to chunk —
re-evaluate after we measure real-world cases.

## Library choices

### Export — `pptxgenjs`

- Most-starred / actively maintained JS pptx writer.
- JSON-shaped API that maps naturally to our slide → objects → properties model.
- Outputs valid pptx that Microsoft + Google + Keynote all open.
- ~200 KB minified. Server-only here, so no SPA bundle impact.

### Import — **custom parser** built on `jszip` + `fast-xml-parser`

Considered but rejected:

- **Existing npm pptx parsers** (`pptx-parser`, `pptxtojson`, etc.):
  varying quality, mostly built for very narrow use cases (text
  extraction), don't expose enough of the shape graph for what we
  need. Could be useful as a reference implementation but not as a
  dependency.
- **LibreOffice headless** in a Docker sidecar (`unoconv` /
  `soffice --convert-to`): battle-tested but heavyweight (JVM-ish
  startup, ~1 GB RAM per worker process), and the intermediate format
  we'd parse (PDF / HTML / FODP) is its own reverse-engineering job.
  Not worth the operational complexity for our scale.

Custom parser is bounded — we only handle the elements MVP-scoped
above (slides, sp/pic/txBody for the shape types we support, image
refs, simple fills). Everything else is logged as "ignored: <kind>"
and the import continues. **Spike (see below) needs to confirm the
XML schema is tractable in <1 day of code.**

## Data model mapping

PowerPoint EMU coordinates: 914 400 EMU = 1 inch = 96 px.

```
PPTX                                  Narrative
----                                  ---------
<p:sld>                               slide (Y.Map in slides Y.Array)
<p:cNvPr id name="…">                 object.id (we generate fresh)
<p:xfrm>/<a:off x y>                  object.x, object.y  (EMU → px)
<p:xfrm>/<a:ext cx cy>                object.width, object.height
<p:xfrm rot="…">                      object.rotation (60000ths-of-a-degree → degrees)
<a:solidFill><a:srgbClr val="…"/>     fill: { kind: 'solid', color: '#RRGGBB' }
<a:gradFill>                          fill: { kind: 'linear-gradient', stops: [...] }
<a:blipFill>                          image object — extract embed, upload, link by assetId
<p:txBody>/<a:p>/<a:r>/<a:t>          TextObject.text (concatenated)
<a:rPr b="1" i="1" sz="…">            TextObject style overrides (single style; per-run deferred)
<p:bg>/<p:bgPr>                       slide.background
<p:sp>/<p:spPr>/<a:prstGeom prst="rect">     RectObject
<p:sp>/<p:spPr>/<a:prstGeom prst="ellipse">  EllipseObject
<p:sp>/<p:spPr>/<a:prstGeom prst="line">     LineObject
<p:pic>                                       ImageObject
animations + transitions              IGNORED (logged)
charts / SmartArt / tables            IGNORED (logged)
```

Anything not in this table is dropped on import (logged). Anything
not in this table is not represented on export.

## Phases

### Phase 1 — Spike (1 day, branched off this plan)

**Before** committing to the milestone, prove the unknowns:

- [ ] Can `pptxgenjs` produce a deck with a text box, image (from a
      `Buffer`), and a rectangle that PowerPoint opens without
      complaint? → small script, save sample output, open in
      PowerPoint Online + Keynote.
- [ ] Can `jszip` + `fast-xml-parser` extract a slide's shape graph
      from a real-world .pptx (Microsoft template, Canva export,
      Keynote-exported pptx — three samples)? → log the schema we
      see, confirm it matches what's in the mapping table above.
- [ ] What does Google Slides do with our test pptx (export side)?
      → confirms fidelity bar.

Outcome: GO / NO-GO on the custom-parser approach. If NO-GO, fall
back to LibreOffice sidecar and re-plan.

### Phase 2 — Export MVP (3 days)

- [ ] `apps/server/src/pptx/export.ts` module.
- [ ] Route `GET /api/decks/:id/export.pptx` with editor-role guard.
- [ ] Wire MinIO byte-fetch helper so the route can stream image
      bytes into pptxgenjs.
- [ ] Mapping for: text frame (single style), image, rect, ellipse,
      line, slide background (solid, image).
- [ ] EMU coordinate conversion + rotation.
- [ ] SPA: "Export → PowerPoint" button in the editor toolbar +
      folder kebab.
- [ ] Server tests: snapshot the .pptx XML for a known-deck fixture.

### Phase 3 — Import MVP (5 days)

- [ ] `apps/server/src/pptx/import.ts` module.
- [ ] BullMQ queue `pptx-import` + worker (reuses existing video-
      worker infra).
- [ ] Route `POST /api/folders/:id/import` (tus, .pptx mime).
- [ ] Parser: jszip + fast-xml-parser, slide-by-slide streaming
      (don't load whole pptx into memory).
- [ ] Mapper: produces an array of `SlideObject` ready for
      `mutations.addObject()`.
- [ ] Image extraction → upload to MinIO via existing helper, attach
      via `assetId`.
- [ ] Server-side Yjs writer: applies the mapped slides into a fresh
      deck Y.Doc, persists via existing onStoreDocument path.
- [ ] Job-status endpoint `GET /api/decks/:id/import-status?jobId=…`.
- [ ] SPA: import button on folder grid, progress modal, navigate to
      deck on completion.
- [ ] Server tests against three fixture .pptx files (Microsoft,
      Canva, Keynote).

### Phase 4 — Fidelity passes (open-ended)

Pick from the deferred list above based on actual usage signals. Each
adds ~1-3 days. No reason to gate the milestone close on these.

## Risks & open questions

1. **Library quality unknown until spike**. Highest-impact unknown.
   Spike-first protocol below.
2. **Memory bloat on large decks**. Real-world .pptx with embedded
   video can hit 200+ MB. Streaming parse + per-slide processing is
   the answer; need to validate.
3. **Image format compatibility**. PPTX embeds PNG, JPEG, EMF, WMF,
   SVG. We support PNG / JPEG / WebP via imgproxy. EMF / WMF
   (vector) would need rasterisation — for MVP, log and skip with a
   placeholder.
4. **Theme + token unmapping**. Imported decks won't pick up the
   target folder's colour tokens automatically; everything is
   inlined as literal hex. Acceptable for MVP; flagged as a follow-
   up if users care.
5. **Round-trip drift**. Importing a .pptx and immediately
   re-exporting it will not produce a byte-identical file. We should
   document this expectation in the UI ("PowerPoint files imported
   into Narrative may render slightly differently when exported
   back").
6. **License clarity**. Pptxgenjs is MIT. Jszip is MIT. fast-xml-
   parser is MIT. All clean for our deployment.
7. **Yjs server-side writer**. We have this infrastructure (`packages/
slide-model` + the patterns used by AI generation), but the
   bridge to the import worker needs care — applying ~30 slides of
   updates to a fresh doc, then triggering onStoreDocument once at
   the end, is the right pattern. Verify nothing assumes a single
   active connection.

## Spike checklist (Phase 1)

A small `apps/server/scripts/pptx-spike.ts` script (or `tests/spike/`)
that:

1. Builds a known deck with `pptxgenjs` covering the MVP feature
   set. Opens in PowerPoint Online + Keynote → screenshot diff
   against the source Narrative deck.
2. Parses three real-world fixtures (Microsoft, Canva, Keynote) and
   prints what schema elements appear vs. what's in the mapping
   table. Quantifies the long tail.
3. Measures: peak memory for the largest fixture, parse time, RAM
   during pptxgenjs export.

Report the findings inline in this doc before starting Phase 2.

## Spike findings (2026-05-14) — partial GO

Implemented `apps/server/src/scripts/pptxSpike.ts`. Run with
`pnpm --filter @narrative/server pptx:spike`.

### What the spike covered

Built a 3-slide synthetic deck via `pptxgenjs` exercising every MVP
shape (text frame with one style, image from a PNG `Buffer`, rect with
solid fill + stroke, ellipse, line, rect with rotation, solid-colour
background, image background) and immediately parsed it back through
`jszip` + `fast-xml-parser`, scoring observed XML elements against the
mapping table in this plan.

### Numbers (Node v25, M3 Max-class laptop, no real-world fixtures yet)

```
export: build + write spike-export.pptx      22 ms   peakRSS  99.3 MB   Δheap  2.1 MB
parse:  spike-export.pptx                     7 ms   peakRSS 101.0 MB   Δheap  1.5 MB
```

- Output `.pptx`: **56.6 KB** for 3 slides (~19 KB/slide; would
  scale roughly linearly with text + small images, much larger with
  embedded photos).
- ZIP entries: 49 (slides, rels, theme/master/layout boilerplate, the
  embedded image, content-type registry, etc.).
- Distinct XML tags observed in `ppt/slides/slideN.xml`: 50.

### Mapping table coverage

- **MVP elements observed: 38 / 44.** The remaining 6 are things
  `pptxgenjs` simply doesn't emit for our test shapes (e.g.
  `p:cxnSp` with a non-trivial geometry, `a:bgRef`). They'll show up
  when real-world fixtures arrive.
- **Deferred elements seen: 0.** `pptxgenjs` output is "clean" w.r.t.
  the post-MVP list — no leaking of `a:gradFill`, `a:tbl`, `c:chart`,
  `p:timing`, `p:transition`, `dgm:relIds`, etc. So our writer never
  generates the long tail by accident — only readers will encounter it.
- **Unknown (not in either set): 12** — all small auxiliary properties,
  none structural:

  | element               | what it is                                                     | action                                                                   |
  | --------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
  | `a:effectLst`         | drop-shadow / glow / soft-edge effect chain                    | **Ignore on import** for MVP (no Narrative model). Re-evaluate post-MVP. |
  | `a:srcRect`           | image source-rect = cropping                                   | Ignore — Narrative has no image cropping yet either.                     |
  | `a:prstDash`          | preset dash pattern on a line/outline                          | Ignore on import (solid lines only); export emits solid by default.      |
  | `a:buNone`            | paragraph: explicitly no bullet                                | Cosmetic — pptxgenjs writes it; ignore on import.                        |
  | `a:chOff` / `a:chExt` | child group offset/extent (we don't group)                     | Ignore — we never produce groups; on import we'd flatten anyway.         |
  | `a:lum`               | luminance modifier (colour tint variant)                       | Ignore for MVP; tint resolution is theme-token work.                     |
  | `a:masterClrMapping`  | inherit colour map from master                                 | Ignore — masters are deferred.                                           |
  | `p:blipFill`          | the `p:` namespace variant of image fill (slide-level use)     | **Add to MVP table.** Same semantics as `a:blipFill` at the shape level. |
  | `p:cNvGrpSpPr`        | non-visual group-shape props on the spTree root                | Already implicit in `p:nvGrpSpPr`; add for completeness.                 |
  | `p:clrMapOvr`         | slide-level colour-map override                                | Ignore — theme work.                                                     |
  | `p:nvPr`              | additional non-visual metadata (placeholder type, custom data) | Ignore unless we care about `<p:ph>` for layout inheritance (deferred).  |

  Net: no structural surprises. The mapping table needs a one-line
  addition for `p:blipFill` (slide-bg variant). Everything else is
  cosmetic and safely ignored on import.

### What this tells us

- **Custom-parser approach is tractable.** The XML schema reaching
  the parser for pptxgenjs-emitted decks is small (50 distinct tags
  across 3 slides) and the long tail is auxiliary, not structural.
- **pptxgenjs export is fast and small enough** for typical decks.
  20 ms / 56 KB for 3 slides means 200 ms / 600 KB for a 30-slide
  text-heavy deck is realistic, modulo embedded media size.
- **`fast-xml-parser` preserveOrder mode** works fine for walking
  the shape tree (no surprises on namespace prefixes, no issues with
  attribute extraction).

### What's still UNKNOWN (gates the full GO)

This spike only round-tripped pptxgenjs's own output. It has not yet
been fed:

1. A **PowerPoint-saved** `.pptx` (Office 365 → Save As `.pptx`).
2. A **Canva**-exported `.pptx`.
3. A **Keynote**-exported `.pptx`.

These three are what we'll actually encounter in import. They will
include slide layouts/masters, theme colour mapping, possibly
embedded fonts, tables, charts, transitions. The mapping table needs
to survive that exposure before Phase 2.

**Action**: drop the three samples into `tests/fixtures/pptx/` (the
script auto-picks them up) and re-run `pnpm --filter @narrative/server
pptx:spike`. The script will print per-file long-tail histograms and
the report will land at `<tmp>/narrative-pptx-spike/spike-findings.md`.

### Also unverified — needs human-in-the-loop

- [ ] Open `<tmp>/narrative-pptx-spike/spike-export.pptx` in
      **PowerPoint Online** — does it render without warnings? Are
      positions / colours / rotation correct?
- [ ] Same in **Keynote**.
- [ ] Same in **Google Slides** (confirms the fidelity floor).

Until those three open without complaint, we don't actually know
pptxgenjs's output is consumer-ready.

### Recommendation

**Partial GO**, contingent on the two remaining checks above. The
library stack works and the parse surface is bounded; the open
question is fidelity of the output in third-party readers and the
shape of real-world input. Run those checks; if they pass, **Phase 2
(Export MVP) can start immediately** with the mapping table
augmented per the table above (`p:blipFill` added).

## Where this slots in

This rewrites **M28** in `BUILD_PLAN.md`. The current entry parks both
PPTX and video export and offers PDF / PNG export only. After this
plan ships:

- M28 = **PPTX import + export** (MVP, plus the spike & deferred list
  above).
- PDF / PNG export and view-only share link can stay parked or move
  to their own milestone — they're a different shape of work (browser
  rendering, not OOXML parsing).
- "Video export: parked" stays parked.

Promoted to **next milestone to ship** per the user's stated priority
on 2026-05-14, ahead of the still-conceptual M20-M27 entries.
