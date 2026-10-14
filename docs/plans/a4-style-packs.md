# A4 — style packs: a brand becomes Narrative's own building blocks

Execution plan for phase A4 of [`agentic-layer.md`](./agentic-layer.md) §7
and §10. Written 2026-10-12, at v0.10.30.

## Goal

A style pack turns a client's brand into the things a designer uses by
hand, so an agent builds and restyles slides from them and people keep
editing the result with the normal tools (§7):

- **folder tokens and fonts** — colour and text-style tokens (with
  per-level list styles), the brand fonts;
- **a few components** — pagination, headline, subline, copy, divider
  slides, a recurring column grid; never one per template;
- **layouts as data** — the brand's templates stay records in the pack
  (regions, slots, text styles), applied with `slide.applyLayout`;
- **a checker** — `query.check` reports what breaks the brand, the fit
  measured by the render worker (A3's `overflow`).

Five packs are bootstrapped into their folders: Contoso 2026, Fabrikam, Tailspin
Tailspin, Wingtip house, Wingtip Labs. Done when the A4 part of `knownMissing.ts`
is empty, the five packs build a slide of every layout that `query.check`
passes, and `A4` is in `FINISHED_PHASES`.

## Decided (Petr, 2026-10-12)

- **Brand fonts reach share-link visitors, as today.** Folder sharing
  (a6adabb) and 8eb320b let a deck guest and a share-link visitor load the
  folder's fonts through presigned URLs; that stays, so a client opening a
  link sees the deck in its faces. §7.6's "never served to anonymous
  share-link viewers" is withdrawn, and so is its "gap to fix in A4"
  (deck-scoped font access): it is already closed.
- **Layers across all five brands**, not one brand end to end: the
  slide-model and the pack schema are settled for every brand before the
  compiler, so the schema is not rewritten per brand.
- **PPTX import and export do not change.** No real masters on export, no
  layout provenance on an ordinary import — it would break the round trip
  that is at 0 new differences. The master reader is a bootstrap tool only:
  from a client master it derives the pack's layouts (data) and, where the
  skill or the deck makes it worthwhile, components — headline, subline,
  divider slides and the like. §7.3's "fixes flattening for ordinary
  imports" is withdrawn.
- **Release per step**, as in A2 and A3.

## What is there already (surveyed 2026-10-12)

| §7.2 item                                    | State                                                                                                                                                                                                                                                      |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 layout / slot / component provenance       | missing. A stamp has no link to its master (`stampComponent.ts` "The result has no link to the component"); named master objects act as slots (`components.ts` `slotsOf`, `stampMaster`)                                                                   |
| 2 autofit                                    | missing; PPTX import ignores `spAutoFit`/`normAutofit`, export writes `<a:noAutofit/>`                                                                                                                                                                     |
| 3 per-level list styles on text-style tokens | missing; list attributes live per paragraph (`ParagraphAttrs`) and a legacy frame-wide `listStyle`; no bullet colour, scale, indent                                                                                                                        |
| 4 furniture                                  | partial: `isSlideNumber` (`object.slideNumber.set`), `locked` (editor-only); no `role: 'furniture'`                                                                                                                                                        |
| 5 font stretch (`wdth`)                      | missing in text objects, the renderer and the folder font model (family, weight, style, postscriptName)                                                                                                                                                    |
| 6 deck-level variant                         | missing; the deck Y.Doc root holds `slides` and `guides` only                                                                                                                                                                                              |
| 7 `textStyleId`                              | done (A0)                                                                                                                                                                                                                                                  |
| 8 component commands                         | `component.list/get/rename/delete/stamp/promote` exist; `component.create` (wraps `POST /folders/:id/components`) and `component.restamp` are the two A4 entries of `knownMissing.ts`                                                                      |
| grid                                         | deck guides only (`guide.add/update/remove`); no margins or columns                                                                                                                                                                                        |
| MCP resources                                | playbooks and `narrative://capabilities`; no pack resources                                                                                                                                                                                                |
| tools/list                                   | 184,714 of 185,500 bytes (138 tools) after A3 — no room for A4's tools                                                                                                                                                                                     |
| source material                              | the skill library at `29f9367` (HEAD on this Mac): Contoso `layouts.json` (58 layouts, 23 families, grid, palette, fonts) and both masters; `Audi_Template.pptx`; `tailspinr-master.pptx`; Wingtip `test-presentation.html` + SKILL.md 1.8; Wingtip Labs design doc |
| fonts                                        | Contoso Head/Text Office, Acme Type VF 4.04 and Northwind Sans ST Pro are installed on the MacBook (`~/Library/Fonts`), none in the brain repo                                                                                                              |
| image pools                                  | Fabrikam (293 files) and Contoso (134) on the Wingtip shared Drive, reachable through the Drive desktop mount                                                                                                                                              |

## Where packs live

- **Schema** in `packages/shared` (`schema/stylePack.ts`, zod), so the
  server, the web app, the commands and the bootstrap tools validate the
  same shape.
- **Storage: the folder document**, a `stylePack` map next to the tokens.
  A pack is folder content like tokens and components: collaborative, live
  in Folder Settings, written through commands and the sync server only
  (hard rule), read by deck guests' agents the way 8eb320b reads tokens.
  One pack per folder (a folder is the brand boundary, §7.1). A pack too
  large for the folder document (Contoso's 58 layouts are ≈ 350 KB as the
  brain's JSON, far less as a pack) is measured in A4.2 before this is
  settled; the fallback is a Postgres row read through a command.
- **Client-derived data stays out of this repo**: the bootstrapped pack
  JSON, the masters and the font files go into the private overlay
  (`private/packs/<brand>/`), with the provenance (brain commit, source
  paths, the calls of §7.4) inside each pack. The importers live here
  (`tools/style-packs/`) and read the brain from a configured root. <!-- docs-check: ignore -->

## Steps

Each step ends green on `just check` plus its rows of the AGENTS.md table,
goes through `agent-parity`, and ships as its own release.

### A4.0 Room in tools/list

Measured 2026-10-12: 184,790 bytes in url mode, 138 tools — descriptions
75 KB, schemas 88 KB (`object_create` alone 11.6 KB: every object type's
create schema), the rest 22 KB. The list was compacted after A2 (shared
shapes, the field vocabulary); without cutting guidance only ≈ 1–2 KB is
left to take, the largest piece the confirmation line repeated on 18 tools
(≈ 0.9 KB once said in the instructions). A plan of ≈ 12 new tools
(≈ 15 KB) does not fit that.

**Decided (Petr, 2026-10-12): fewer tools.** A4 adds as few tools as the
capabilities allow:

- new object, token and deck properties (`slot`, `role`, `autofit`,
  `fontStretch`, list levels) go through the tools that already write
  their kind — `object.update`, `text.setBoxTypography`, `token.update` —
  never a tool per property;
- the pack is reached through two tools with an operation discriminator,
  the way `object.crop.set` takes five crop operations: `style.pack.get`
  (`part`: summary, layouts, one layout, the whole pack) and
  `style.pack.edit` (`op`: set, update, compile);
- the deck side is one tool, `style.deck.apply` (pack, variant;
  furniture regenerated), beside `slide.applyLayout` and `query.check`;
- with `component.create` and `component.restamp` (already counted in
  `knownMissing.ts`) that is seven tools for the whole phase.

**A4.0 closed without a trim (2026-10-12).** The one repeat worth naming,
the confirmation line, is per client mode on purpose (`mcp.test.ts` "describes
each confirmation the way this kind of client gets it": a client handed a
link is never told Narrative "asks"); the server instructions are built
before initialize, so they cannot say it for one client. One mode-free line
would save ≈ 0.8 KB and lose that accuracy, a tighter per-mode wording
≈ 0.35 KB — neither worth it. The budget rises with each A4 step by what it
measures, dated in `toolListBudget.test.ts`; seven tools at ≈ 1–1.5 KB put
the end of A4 near 194,000 bytes.

### A4.1 Provenance and components

Object provenance and the two missing component commands. `slide.layout`
comes with `slide.applyLayout` (A4.4), the only writer it has.

- **On every object** (`BaseSlideObject`, its zod schema, written through
  `object.update` — no new tool):
  - `slot?: string` — the brand's slot name (`title`, `pagenum`,
    `bullets2`, …: Contoso alone has 30). A component's slots are its objects'
    `slot ?? name`, so masters named before A4 keep working.
  - `role?: 'title' | 'subtitle' | 'body' | 'picture' | 'chart' | 'table' |
'caption' | 'footnote' | 'furniture'` — small and generic on purpose:
    what restyle maps by (a Contoso `statement` is `body`, its `pagenum`,
    `footer`, `classification` and `logo` are `furniture`), while `slot`
    keeps the brand's own name.
  - `component?: { id, objectId, instance, origin: { x, y } }` — set by a
    stamp: the master, the master object this one copies, one id per
    stamp (two stamps of a master on one slide stay apart, as group tokens
    do), and where the master object stood at stamp time. `object.x −
origin.x` is the stamp's offset, so a stamp people moved is restamped
    where they put it.
- **Carried and dropped**: duplicating or pasting a stamp keeps the link
  with a fresh `instance` per operation; `component.promote` drops
  `component` from what becomes a master (a master links to nothing) and
  keeps `slot`/`role`; PPTX export writes none of the three, import sets
  none (decided above) — a round-trip matrix case shows they leave no
  noise.
- **`component.stamp`** records `component` on every stamped object and
  fills slots by `slot ?? name`.
- **`component.create { name }`** (folder scope, wraps
  `POST /folders/:folderId/components`): an empty master, filled with the
  object commands pointed at it (`componentId`).
- **`component.restamp { componentId, slide? }`** (deck scope, editor):
  re-applies the current master to every stamp of it on that slide, or the
  whole deck. Per stamp: objects whose master object still exists are
  updated **in place, ids kept** (slide animations reference them) — every
  field from the master, placed at the stamp's offset, the group remapped
  to the stamp's own token — except **slot content**: a text slot keeps
  its text (the master's formatting applied as `component.stamp` does), a
  picture slot keeps its picture. A master object new since the stamp is
  added in master order; one deleted from the master is deleted from the
  stamp, its animations with it. `origin` is updated. One transaction, one
  undo step. Output: per slide, the stamps restamped and the objects
  updated / added / removed.
- **Decided (Petr, 2026-10-12): a stamp is detached once placed; restamp
  is an explicit reset to the master.** Changing a master never touches a
  deck by itself, so older decks stay as they were. `component.restamp`
  runs only when the user asks to bring stamps up to date, and then
  resets them to the master: every master object comes back — also one a
  person deleted from the stamp or a partial copy lacks — local edits to
  the stamps (colour, size, name, lock, link, inline formatting of text
  slots) are overwritten, and only slot content survives: a text slot's
  text, a picture or video slot's media and crop (scaled with the frame),
  a table slot's cells with its grid and frame size. The agent asks before
  restamping a whole deck (basics playbook).

### A4.2 Text and deck properties

Built and released in vertical slices (2026-10-12), each from the data to
the renderer, so no property is writable before something draws it:
A4.2a autofit (with the text-style `minSize`); A4.2b list levels on text
styles, `list: 'none'` and PPTX export of the resolved level; A4.2c font
stretch; A4.2d deck meta and variant/surface colour tokens (alpha
included); A4.2e the remaining text-style fields (`lineSpacing`, `align`)
and compile provenance (`origin`).

**Decided (Petr, 2026-10-12): a growing box is drawn at its text's height,
and its stored height follows people.** Only a browser can lay text out.
The renderer draws a `grow-down` box as tall as its laid-out text whatever
`height` says (hit testing and the selection use that height); the editor
writes it into the document after a person changed the box, in the same
undo step. An agent's or another client's change is drawn right away but
leaves `height` as it was until someone edits the box — so `height` can be
stale after an agent run, and the agent is told to look (query.render).
A4.4 closes the gap for laid-out slides: the render page then reports a
growing box against its region, with the height it is drawn at.

- **Autofit** on text boxes: `autofit?: 'grow-down' | 'fixed' | 'shrink'`
  (`fixed` = today). `grow-down` grows the box to its laid-out text (the
  measurement A3 built, `laidOutTextBottom`); `shrink` scales the type down
  to fit, never below the role's minimum. Renderer, the inspector control,
  a command, and the render page's `overflow` reporting a `grow-down` box
  against its region instead of its own height.
- **Per-level list styles on text-style tokens**: per level 1–9 — bullet
  glyph, colour (a colour token or a value), scale, indent, hanging indent,
  space before. Paragraphs keep their own attributes as overrides; the
  token's level style is the default the renderer and PPTX export read.
- **Font stretch**: `fontStretch?` (the `wdth` axis, 50–200) on text and
  text-style tokens; folder fonts record a variable face's axes.
- **Deck meta**: a `meta` map at the deck document root with `variant`,
  set by `style.deck.apply` (A4.4).
- **Furniture**: `role: 'furniture'` objects, which `style.deck.apply`
  regenerates (A4.4); pagination stays `isSlideNumber` inside the pack's
  pagination component.

### A4.3 Pack schema, storage, CRUD

- `StylePackSchema` (§7.1: tokens with variants and colour roles, fonts
  with roles and axes, text styles with levels, grid, furniture, layouts
  with regions, components, imagery, editorial, qa, archetypeMap,
  provenance), its validator with cross-references (a region's text style
  and component exist, rects inside the canvas, every variant covered).
- `style.pack.get` (`part`: a summary, the layouts in brief, one layout,
  the whole pack) and `style.pack.edit` (`op: 'set'` — the whole pack,
  validated; `op: 'update'` — a JSON-merge patch, e.g. one accent colour
  or one layout; `op: 'compile'` comes in A4.4).
- The pack as an MCP resource, `narrative://folders/<id>/pack`, and its
  layouts summarised for a model (id, purpose, slots), not the whole JSON.

### A4.4 Compiler and layouts

- `style.pack.edit { op: 'compile' }`: a pack becomes folder tokens (colour, text styles
  with levels), folder fonts (the pack names them; uploading the files is
  the bootstrap's) and its short list of component masters — idempotent,
  updating what an earlier compile made (matched by provenance), never
  touching tokens or components people made by hand.
- `slide.layout?: { packId, layoutId, variant }` on the slide, written by
  `slide.applyLayout` and cleared when the slide stops following it.
- `slide.applyLayout { slide, layoutId, content? }`: places the layout's
  regions as token-styled objects or the pack's components, with `slot` and
  `role`; on a slide that already has a layout, moves each slot's content
  into the new layout's slot of the same role.
- `style.deck.apply`: every slide with a layout re-laid with this
  folder's pack (the restyle core A5 builds on), furniture regenerated, the
  deck's variant set.
- Grid → deck guides (margins, columns, the title / content / footer
  tops), so people see the pack's grid in the editor.

### A4.5 `query.check`

The pack-driven checker of §7.5, ported from Contoso's `check_deck.py` and the
Fabrikam HTML checker: fit (A3's measurement; a `grow-down` box against the
next region or the footer, half a line of slack), partial overlaps, grid,
one variant per deck, the text-colour whitelist, required furniture,
placeholder sentinels, editorial rules, a missing picture on a picture
layout. A font that does not load → "fit not verified", a failure.
Results per slide and object, errors and warnings.

### A4.6 Style pack tab in Folder Settings

The pack read in Folder Settings: tokens and variants, fonts and their
roles, layouts as small previews (drawn from the region data), components,
editorial and QA rules; editing the values people tune (colours, a
layout's region, an editorial rule) through `style.pack.edit`; Compile.
JSON import/export of the whole pack for the rest.

### A4.7 Bootstrap the five packs

- Importers in `apps/server/src/stylePacks/bootstrap/` (`just style-pack`;
  they reuse the server's PPTX parser and the shared schema, so they live
  next to them rather than in `tools/`), output into `private/packs/`: <!-- docs-check: ignore -->
  - **Contoso** from `layouts.json` (58 layouts → pack layouts, almost field
    for field; the grid, palette, fonts, `–` bullet; `check_deck.py`'s
    rules → `qa`/`editorial`); `layouts.json` wins over `vw_deck.py`
    (§7.4).
  - **Fabrikam** and **Tailspin** through the **master reader**
    (`apps/server/src/pptx/masterReader.ts`, reusing the parser's
    placeholder, txStyles, list-level and theme helpers, exported for it):
    walks `sldMasterIdLst` → every layout (also those no slide uses), each
    layout's `type` and name, placeholders → regions (rect fractions of
    `sldSz`, slot/role from the placeholder type, text style from the
    txStyles bucket), the master theme (resolved through its rels, not
    `theme1.xml`) → tokens; recurring blocks (title, subtitle, divider) →
    component candidates. The master wins over the Fabrikam HTML skill; Tailspin's
    theme wins over the dashboard ramp (§7.4).
  - **Wingtip** by hand from `test-presentation.html` + SKILL.md 1.8 (contoso/vh
    → px); **Wingtip Labs** extends it (lime accent, decoration, chart palette).
- Fonts uploaded into each brand folder from the MacBook's installed
  faces (Acme Type VF whole, not the latin subset).
- Into production: create the folders, `style.pack.edit` (set, then compile), upload
  the fonts — through the command API with a personal access token, at
  Petr's go per brand.

### A4.8 Playbooks, eval, close

- A `build-with-pack` playbook (pick a layout by purpose, fill slots, use
  the pack's components, never create a component for a one-off, look and
  check after each slide), `restyle-lite` updated to `style.deck.apply`.
- Eval scenarios per pack: build a slide of a given purpose and pass
  `query.check`; restyle a slide Contoso → Fabrikam keeping slot content; fix a
  check finding.
- `FINISHED_PHASES += 'A4'`, the A4 handoff, `agentic-layer.md` updated.

## Open questions (decided as each step starts)

- Image pools (§7.6): an ingestion command in A4.7, or left to A5's
  builder.

Settled 2026-10-12 with the schema design
([`a4-style-pack-schema.md`](./a4-style-pack-schema.md) §6): packs in the
folder document (Contoso 47 KB encoded), `shrink` autofit stays in A4,
per-variant colour tokens with fixed extras, list levels inherited from
the text style, one text style per size.

## Where we stand

2026-10-12: plan written; decisions above. Baseline on the MacBook at
`ed5618e` (0.10.30 + the exact-fit e2e): the full `just e2e` 205 passed,
2 failed — the known `component-promote-stamp` cleanup timeout and
`multi-client-collab`'s "three clients converge" — both green rerun with
one worker (4/4).

**A4.0 done (2026-10-12):** measured, no trim worth its cost; Petr chose
fewer tools (seven for the phase, see A4.0).

**A4.1 built (2026-10-12, unreleased):** `slot`, `role`, `component` on
objects; stamp provenance; a fresh `instance` on duplicate, copy and
paste; `component.create`, `component.restamp` (reset to the master, per
the decision above) — the A4 part of `knownMissing.ts` is empty. Reviewed
by `code-reviewer` (table-slot grid, group tokens, crop scaling, the
other-folder message and `component.create`'s validation fixed) and
`agent-parity` (an `object.update` example and role list, the restamp
description, `basics.md`, eval scenarios `component-restamp` and
`component-create-pagination`, not yet run). tools/list 187,928 of
188,000 bytes, 140 tools. Verified: `just check`; `just e2e -g
"component"` 14 passed; `multi-client-collab` green on rerun (its known
flake once); `just pptx-roundtrip` on the reference deck 0 differences
(`just mutate` broken since 2026-09-26). `just eval` at `2c103a9`: 58/58
passed, $8.42, 19m46s — `component-restamp` and
`component-create-pagination` passed on their first live run;
`component-promote-headline` is live-only, so it has no recording to
refresh. Released as 0.10.31 (2026-10-12). Next: A4.2.

**A4.2a released as 0.10.32 (2026-10-12):** `autofit` (`grow-down`,
`shrink`) and `minFontSize` on text boxes, `minSize` on text styles
(propagated to linked boxes, not to tables); the renderer draws a growing
box at its laid-out height and finds a shrinking box's scale by halving
(memoised; autofit boxes are laid out again when a webfont finishes
loading); SceneGraph hit testing, bounds, instance leaves and snapping use
the drawn height; the editor measures a box a person changed at once, on a
node of its own, and writes its height in the same undo step
(`state/autofitHeights.ts` — an undo, a peer's or an agent's change is
never written back); the edit overlay follows both; the Inspector's
Autofit control and shrink floor (H locked on a growing box), Folder
Settings' "Min size"; PPTX export writes `spAutoFit` / `normAutofit`, a
growing box anchored at the top, and the extension (import unchanged); the
render page's `overflow` skips growing boxes and measures shrinking ones as
drawn. Eval scenarios `text-autofit-grow` and `style-shrink-floor`
(recorded, both passed first time). Reviewed by `agent-parity` (examples,
command tests, scenarios added) and `code-reviewer` (the write-back moved
from the next frame to the transaction's own tick after it split an
Inspector click into two undo steps, webfont re-layout, snapping, the H
field, the export anchor). tools/list 188,673 bytes (budget 189,000).
Verified: `just check`; `text-autofit` 20/20 repeated; `just e2e` with two
workers 207 passed, 2 failed (canvas-sharpness, htmltext-texture-isolation)
that passed 3/3 alone — the machine was at load 62 from a kernel build;
`just pptx-roundtrip` on the reference deck 0 differences.

**A4.2b–A4.8 built (2026-10-12/13, unreleased; Petr: "the whole of A4,
no deploy, test at the end"):**

- **A4.2b list levels:** `listLevels` on text boxes and `levels` on text
  styles (glyph, bullet colour and scale, px indents, per-level font, size,
  colour, weight, line spacing, space before; list kind `none`); the
  renderer, Inspector list control, `text.list`, PPTX lstStyle and the
  extension follow; `listLevels` stayed off `text.setBoxTypography` (the
  tools/list budget).
- **A4.2c font stretch:** `fvar` axes read on upload (`font_axes`, migration
  0035, `fontAxesBackfill`); `font-stretch` in @font-face and the renderer;
  a variable face covers its weight range; Inspector → Width.
- **A4.2d deck meta and colours:** `DeckMeta` (variant, fields, lang) and
  `Slide.layout`; colour tokens with alpha, `byVariant`, `bySurface`,
  resolved per deck variant and slide surface in the editor, thumbnails,
  the render page and PPTX export.
- **A4.2e:** `lineSpacing` and `align` on text styles.
- **A4.3 the pack:** schema (`shared/schema/stylePack.ts`), whole-pack
  validation (§3), an example pack, storage in the folder document
  (nested maps, merge patches, layouts and components by id),
  `style.pack.get` / `style.pack.edit` with an exact inverse for undo, the
  MCP resource `narrative://folders/{folderId}/pack`.
- **A4.4 compile and layouts:** compile to tokens (deterministic ids,
  origin) and masters; an axis value a layout pins as its surface gets
  `bySurface` values too (found with Contoso's chart slide); `planLayout`
  (regions with insets, content moved by slot and role, furniture, decor,
  backgrounds); `slide.applyLayout`, `style.deck.apply`.
- **A4.5 `query.check`:** the rules of §7.5 in `stylePack/check.ts`; the
  render page measures growing boxes (`grown`, alongside `overflow`); the
  render service's `measure` runs sheets of 20 slides, up to 100.
- **A4.6:** Folder Settings → Style pack (`pages/StylePackTab.tsx`): view
  everything, edit colours, layout regions and rules, compile, import and
  export JSON — through `POST /commands` with `style.pack.edit`, the
  agent's door.
- **A4.7:** the master reader (each master's own theme and `clrMap`,
  layouts no slide uses, inherited placeholder geometry and levels, group
  transforms, SVG blips), a generic template mapper (Fabrikam, Tailspin), Contoso from
  `layouts.json`, Wingtip measured from the render in headless Chromium,
  Wingtip Labs derived from Wingtip and computed from its spec. `just style-pack`
  validates each pack, lays out every layout on an empty slide and checks
  it; `just style-pack-import` puts one into a folder over the command API
  (pack, compile, logos into a pack master, asset ids). Sizes: Contoso 23
  layouts / 86 regions, Fabrikam 31 / 194, Tailspin 21 / 81, Wingtip 13 / 126,
  Wingtip Labs 5 / 42. Left out and recorded in each pack's `calls`: the Contoso logo
  (master artwork), Tailspin's WMF logo and freeform waves, Wingtip's Data Story
  and Hero Case Study (not in the test deck). The fonts come from the
  MacBook (private/HANDOVER.md); production imports wait for Petr, brand by brand.
- **A4.8:** the `build-with-pack` playbook, `restyle-lite` rewritten for
  packs, eval scenarios `pack-build-slide`, `pack-deck-variant`,
  `pack-fix-check` (memory world models packs), `FINISHED_PHASES += A4`.

**Stopped 2026-10-13 00:40, committed and pushed unreleased; finished
2026-10-13 evening (the blocker, the reviews, the test round) and released
as 0.11.1 (0.11.0, tagged first, never deployed: its server image did not build).**

- **The blocker, fixed:** not the token colour. HTMLText measures and
  rasterises with the family's `@font-face` CSS put into the document, so
  every measurement of text in an embedded face (the bundled Inter, every
  folder font) added `FontFace` objects that loaded at once and fired
  `document.fonts` `loadingdone`; `SceneGraph.relayoutAutofitText` treated
  each as news and re-laid every autofit box out, which measured again: the
  render page never settled on a slide with an autofit box in such a face
  (since 0.10.32). `createFontLoadFilter` (renderer/fontChanges.ts) lets a
  load through only for a face whose descriptors have not loaded before.
  Regression e2e: `query-render` "an autofit text box in an embedded face
  settles" (fails without the fix).
- **Reviews.** `agent-parity`: `query.deck` returns the deck's `meta`,
  `query.deck` / `query.slide` each slide's `layout`; `fontStretch` in
  `text.setBoxTypography`'s description and validated against the family's
  `wdth` range; `list: "none"` and level inheritance in the body vocabulary
  and `text.list`; token examples for `byVariant`, alpha and `levels`;
  `fontStretch` in the PPTX matrix, `Slide.layout` / `DeckMeta` documented
  as not carried; Folder Settings' export goes through `style.pack.get`;
  three new eval scenarios (`pack-edit-colour`,
  `list-level-plain-paragraph`, `token-by-variant`). `code-reviewer`: a
  merge patch's nulls inside a new subtree are no longer stored
  (`folderPack.toY`); a compile replaces its tokens' fields
  (`updateFolderToken` `{ replace: true }`) and linked text drops a width,
  levels and floor its style stopped setting; a bullet under a numbered
  level exports with its glyph; the stored pack is validated where it is
  used (`storedStylePack`: layout, check, compile); `style.deck.apply`
  re-lays a slide whose surface is gone on the default (`surfaceReset`) and
  leaves another pack's layout alone; logo `byRole.files` keys are colour
  references, validated and compiled; one style-pack snapshot per folder
  provider instead of one per `useCommand`. Compile stays an op of
  `style.pack.edit` (A4.0: few tools); its description says how it is
  undone (pack back, compile again; what a first compile created stays).
- **Harness fixes found on the way:** `just eval` could not start
  (`packHelpers` imports `@narrative/shared`; the script now passes the
  eval's tsconfig to tsx); recording needs `replay: true` first; replay
  pairs listed records by name, type and value instead of by position (the
  live folder lists its colours in document order); the memory world
  checks a named run's scope as the server does, and the server's message
  for a deck run on a folder command says to drop `runId`; `just size`
  builds with `NODE_ENV=production` (the dev `.env` made it measure React's
  development bundle, 800 kB first paint instead of 727); the render-page
  "never shows as a collaborator" e2e waits for the editor's own entry
  before counting (it read 0 on a loaded machine).
- **Verified:** `just check`; `just integration` 109/109; full `just e2e`
  213 passed after the blocker fix — later full runs on a machine at load
  30–46 (another session's Flutter tests) failed 10–12 specs, every one
  green when rerun with two workers; `just pptx-roundtrip` on the reference
  deck: 49 slides, 0 differences; `just style-pack all`; `just size`:
  first paint 726.99 kB (+4 kB, the pack validation), Tiptap 132.81 kB
  (pre-existing); `just eval` 66/66, $9.51, 20m28s, with
  `pack-deck-variant`, `pack-edit-colour`, `list-level-plain-paragraph`
  and `token-by-variant` recorded; `pack-build-slide` and `pack-fix-check`
  stay live-only (the agent measures with `query.check`; the memory world
  has no renderer). Not run: `just load`, `just lighthouse` (no hot edit or
  render-path change beyond the font-load filter), `just mutate` (broken
  since 2026-09-26).
- The packs themselves live only in the private overlay
  (`private/packs/`, regenerated by `just style-pack`; not committed there).
- Next: at Petr's go per brand, `just style-pack-import` into production
  folders plus the MacBook font/logo handover (private/HANDOVER.md).
