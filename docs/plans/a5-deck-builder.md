# A5 — deck builder and restyle: a whole deck from a brief, any deck into the brand

Phase A5 of [`agentic-layer.md`](./agentic-layer.md) (§8, §10 row **A5**).
Previous phase: [`a4-style-packs.md`](./a4-style-packs.md) (released in
0.11.1), handoff [`A4-style-packs.md`](../handoff/A4-style-packs.md).

## Goal

1. **Build.** An agent turns a brief into a whole deck in the folder's brand.
   The narrative comes first (scope, story direction, a slide-by-slide
   table the person approves). The deck is then described as data, a
   **deck spec**, and built in one step that can be reverted in one step.
   Finally it is checked (`query.check`) and looked at (`query.render`)
   until it is clean.
2. **Restyle.** Slides from another deck or a PowerPoint file, inserted
   after slide N, take the target folder's brand:
   - **deterministically**, where the slides carry layout and slot
     provenance (built or laid out with a pack);
   - **with the agent's judgment**, where they do not (old decks, every
     PPTX).
3. **PDF export** (moved here from A3): a raster PDF of the slides, for
   agents and in the editor's Export menu.
4. **The full eval suite** for building and restyling.

## Decided already

- **Few tools** (A4.0, Petr 2026-10-12): a new capability is an operation
  of an existing tool where it fits; `style.pack.edit { op: 'compile' }` is
  the precedent.
- **PPTX import stays without provenance** (A4 "Decided", 2026-10-12): the
  master reader is a pack bootstrap, not part of ordinary imports. §8.3's
  line "slides imported through the master reader never need the judgment
  part" is therefore void. **Every imported slide takes the judgment
  path.**
- **PDF is raster**, a PDF of the slide PNGs (`knownMissing.ts:45`, Petr
  2026-10-10). A vector PDF would need a second renderer, which the A3 plan
  rules out.

## Decisions D1–D7

Petr took every recommendation on 2026-10-14, then changed D5 the same
day: no release per step — the whole of A5 is built first; the release
waits for Petr's word after A5.8.

| #   | Question                                                                                                                                                                                  | Decision                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Shape of the build.** A new tool `style.buildFromSpec`, or `style.deck.apply { spec }`?                                                                                                 | **An op on `style.deck.apply`** (`spec`). It is the tool that already sets variant, fields and re-lays slides; the build is the same act over a whole deck. About 0.8 kB of tools/list against 1.5–2 kB for a new tool, and the spec's schema lands in one place.                              |
| D2  | **Shape of the restyle.** `style.slides.restyle`, or `style.deck.apply { relayout }`?                                                                                                     | **`style.deck.apply { slides?, relayout: 'archetype' }`.** Today `style.deck.apply` lists slides laid out with another pack as `unmatched`; the restyle is "re-lay those too". No new tool.                                                                                                    |
| D3  | **Where the spec lives.** On the run (`agent_ops.input` already keeps it 90 days), in a new `agent_runs.spec` column, or on the deck?                                                     | **On the deck**, in the document's `meta` map (`meta.spec`), replaced on every build. Runs close after 10 minutes and are per session; a deck lives as long as it does. Rebuilding with another pack (§8.1) is then "read the spec, build again". Size cap 256 kB (the document cap is 32 MB). |
| D4  | **The table merges in the tools/list review.** Merge `table.row.*`/`table.col.*` into axis tools, `table.style.cell` into `table.style.range`, `object.path.create` into `object.create`? | **Not in A5.** The review without changing any command id (A5.0 items 1–5) frees about 7–9 kB, enough for A5. The merges change command ids that the catalog, playbooks, eval scenarios and recordings name, so they are their own change, after A5.                                           |
| D5  | **Releases.** Per step, as in A2/A3, or in one go, as at the end of A4?                                                                                                                   | **Per step from A5.1 on** — changed by Petr the same day: the whole of A5 first, released on his word (see above).                                                                                                                                                                             |
| D6  | **PDF in the editor:** who may export (owners only, like PPTX, or every reader, like PNG)?                                                                                                | **Every reader**, like a slide PNG. A PDF holds nothing the reader cannot already screenshot; PPTX is owner-only because it is the editable source.                                                                                                                                            |
| D7  | **Skipped slides in a PDF.**                                                                                                                                                              | **Left out by default** (as presenting does), with `includeSkipped: true` to keep them; the result says how many were left out.                                                                                                                                                                |

## What is there already (surveyed 2026-10-14)

Four read-only surveys: build, restyle, PDF and tools/list, playbooks and
eval. The evidence, with `file:line`:

**Building**

- `slide.applyLayout` (`commands/layouts.ts:91-114`, `stylePack/layout.ts`)
  lays a slide out in the command's transaction:
  - text regions become boxes linked to the compiled text style, with
    paragraphs, levels and runs (`text/body.ts:115-133`);
  - pictures become images with `fit: 'cover'` and **no crop**: the
    region's `focus` is in the schema (`shared/schema/stylePack.ts:285`)
    but unread, as are `aspect`, `maxChars` and `fillOrder`;
  - chart and table regions become a placeholder rectangle (`layout.ts:329-338`);
  - furniture is regenerated from `meta.fields` (`:346-483`).
- **`archetypeMap` is never resolved in code.** It is only validated,
  summarised (`commands/stylePacks.ts:62`) and named in the playbook. All
  five brand packs fill it (Contoso, Fabrikam, Tailspin, Woodgrove; Adatum through Woodgrove).
- **No home for the spec's provenance and narrative fields.**
  `SlideLayoutRef` is `{packId, layoutId, surface}` (`shared/src/deck.ts:144`).
  There is no archetype, message or claim provenance; `DeckMeta` has no title
  (the title is a database field, `deck.rename`).
- **No bilingual text, no drawn primitives in grid units.** `editorial.bilingual`
  exists in the schema (`stylePack.ts:415`); the grid has margins, columns,
  gutter and bands (`:182-196`), no grid unit.
- **Notes:** `slide.notes.set` takes Markdown (`commands/slides.ts:487`). It
  has a `load` phase, so it cannot run inside `ops.apply` (`run.ts:316-325`):
  20 slides means 20 calls.
- **Pictures:** `media.upload` returns an `assetId` (`commands/media.ts:37-97`,
  25 MB, at most 2 URL downloads at once) and is not batchable.
- **`ops.apply`:** 1–500 ops, run on a fork and applied as one update
  (`run.ts:384-444`). `slide.add` then `slide.applyLayout` works within a
  batch. The body limit is 4 MB (`apps/server/src/index.ts:162`).
- **A 20-slide deck today** takes an estimated 45–70 tool calls:
  - deck, run, pack, about 8 uploads;
  - one large `ops.apply`;
  - `query.slide` for each picture slide, then crops;
  - 20 `slide.notes.set` calls;
  - the checks and renders.
- **Runs:**
  - `agent_runs` has no payload column; `agent_ops.input` is full jsonb,
    with results capped at 16 kB (`db/schema.ts:677-735`,
    `services/runs.ts:78`);
  - runs close after 10 minutes idle, and are deleted 90 days after their
    last activity (`agent/runtime.ts:51-53`);
  - revert history is in memory: 20 runs per document, 24 h.
- **Revert misses the deck meta.** The run's UndoManager tracks `slides`
  and `guides` only (`services/runs.ts:509`), and so does the editor's
  (`slide-model/src/undo.ts:29`). A reverted `style.deck.apply` leaves the
  variant, fields and language behind. The same would apply to a build.

**Restyling**

- `deck.insertFrom` clones slide maps verbatim (`services/deckInsert.ts:743`):
  - `Slide.layout`, `slot`, `role` and `component` survive the copy;
  - media and the deck's fonts are copied; tokens, components and the pack
    are not.
- **Across folders, token references are rebound by name only**
  (`services/tokenRebind.ts:13-35`; its own comment wants role matching
  first):
  - compiled role tokens all share generic names ("Text", "Accent"), so a
    hand-made "Text" in the target hijacks them;
  - an unmatched reference becomes a literal resolved **without** the
    variant or surface (`:74-79`).
- **The role move in `planLayout` needs a current layout.** It moves
  content by role only when the slide already had a layout (`layout.ts:212-222`).
  On a plain slide the new regions are drawn on top of the old objects, and
  `restyle-lite` step 2 claims otherwise.
- **Bugs found:**
  - (c) content moved by role into a **component** region is dropped
    (`:238`, `:260-261`);
  - (d) several regions with the same role take objects in object order,
    not by position (`:215-221`).
- **Slot names differ between packs** (Contoso `bullets2`, Woodgrove `hero-title`), so
  across packs only roles carry content. `family` values are pack-local.
  `archetypeMap` is the shared vocabulary between packs.
- **Nothing classifies objects at run time.** `titleGuess` is outline-only.
  The PPTX parser resolves the placeholder type and discards it
  (`pptx/parser.ts:1136`, `:2136`).

**PDF**

- `deck.exportPng` (`commands/render.ts:36-94`, `services/render.ts:705`):
  - at most 20 slides a call;
  - a work budget of 20 s + 2.5 s per slide;
  - 1.1 s per slide on the worker after `?paint=off`;
  - about 544 MiB flat, 1200 MB limit.
- `measure` already loops 20-slide jobs up to 100 slides (`render.ts:743-786`).
- No PDF library is in the lockfile; `sharp` is a server dependency.
- `pickSlides('all')` includes skipped slides.
- The editor has PNG per slide (`SlideItemMenu.tsx:246`, catalog `slide.exportPng`)
  with an in-browser render in a hidden frame first (`state/browserSlideExport.ts`).
  PPTX sits behind one owner-only Export button (`Toolbar.tsx:836-905`).

**tools/list** (measured 2026-10-14)

- 145 tools, 199,977 of 200,000 bytes (url mode): descriptions 81.6 kB,
  schemas 95.5 kB, "Example:" lines 8.3 kB.
- The A4 handoff already says a holistic review is due before A5 adds tools.

**Playbooks and eval**

- Seven playbooks (21 kB, `basics` prepended to each). `build-with-pack`
  covers §8.2 steps 2, 4 and 6, and part of 1 and 5:
  - it has no scoping, no story directions, no handoff table and no voice
    protocol;
  - it does not run "look again after fixing";
  - it builds slide by slide.
- The procedure to model is `presentation-narrative-standard` (Woodgrove core
  plugin; the brain copy is in `woodgrove-ai-brain/strategy/skills/`):
  - phases: 10 scoping questions, then shift / belief gap / controlling
    idea, then **three genuinely different directions**, then a per-slide
    table `# | title (≤10 w) | body (≤25 w) | format | claim | move`;
  - claims are named source, `[SOURCE NEEDED]` or `[ILLUSTRATIVE]`;
  - acts at 12 or more slides;
  - **the voice-unknown protocol**: no client voice samples → ask; derive
    only on opt-out, and tag it.
  - Its format archetypes (title-reveal, compare-and-contrast, data-viz,
    big-quote, …) are not Narrative's `ARCHETYPES` (`stylePack.ts:454`),
    so a mapping is needed.
- The Contoso precedent (`woodgrove-ai-brain/clients/LITWARE/skills/litware-contoso-presentation/references/example_deck.py`):
  - `Deck(variant, lang, title, classification).footer(...)`;
  - `add(family).set(slot=…)` with `(text, level)` paragraphs and
    `{de|en}` text;
  - `.picture(asset, focus)`.
    §8.1's spec maps onto it one to one.
- Eval:
  - scenarios are deterministic graders over 6–14 turns, with an 8-minute
    step timeout;
  - the last full run was 66/66, $9.51, 20.5 minutes;
  - `pack-build-slide` (one slide) costs $0.31;
  - the memory world models packs but not renders, masters or media;
  - **the example pack has 3 layouts**, too few for a deck build.

## The deck spec

`packages/commands/src/stylePack/deckSpec.ts` (zod; first planned in `shared`, see A5.2). It generalises §8.1 and <!-- docs-check: ignore -->
the Contoso precedent:

```ts
interface DeckSpec {
  schemaVersion: 1
  packId: string // must be the folder's pack; checked
  variant?: Record<string, string> // axis → value, as style.deck.apply
  lang?: string // the deck's language; `{de|en}` text picks it
  fields?: Record<string, string> // footer fields (classification is one)
  slides: SpecSlide[] // 1..60
}
interface SpecSlide {
  layout?: string // a pack layout id …
  archetype?: Archetype // … or an archetype, resolved through archetypeMap
  message?: string // the slide's one-line job (QA, notes, the report)
  slots?: Record<string, SpecText | SpecPicture>
  drawn?: SpecPrimitive[] // box | text | rule | arrow | number, in grid units
  notes?: string // Markdown
  claims?: Array<{
    kind: 'sourced' | 'source-needed' | 'illustrative'
    text: string
    source?: string
  }>
  surface?: string // when the layout offers a choice
}
type SpecText = TextBody // as text.set: string or { paragraphs }; "{de|en}" in any run
type SpecPicture = { assetId: string; focus?: 'center' | 'top' | 'bottom' | 'left' | 'right' } // as a pack region's
```

- **Validation against the pack, as a whole, before anything is written**
  (as `style.pack.edit` does):
  - every layout or archetype resolves;
  - every slot exists in its layout and has the right kind (text or
    picture);
  - required slots are filled;
  - pictures exist in the deck's or folder's media;
  - variant values exist.
    One error lists every problem with its path (`slides.3.slots.title`).
- **Grid units:**
  - `x`/`w` are column indices of `grid.columns` (`[from, to]`);
  - `y` is a band name (`title`, `subtitle`, `content`, `footer`) plus an
    offset in px;
  - this is enough for the Contoso and Woodgrove "drawn" cases (a box per column,
    a rule under the title band).
- **`{de|en}`:** a run's text `"Umsatz{de|en}Revenue"` keeps the part for
  `lang` (the Contoso convention); without `lang` the first part.

## Steps

Each step lists what changes, where, and how it is verified. "Verified" is
on top of `just check` and the rows of AGENTS.md "When to run what" that
the step's files match.

### A5.0 Room in tools/list (no command id changes)

The holistic review the A4 handoff asks for. These items keep every
command id (savings are the survey's estimates, to be measured):

1. `animation.add` / `animation.update`: the shared description (presets,
   triggers, rotation) and the shared schema parts move into the
   vocabulary. About 1.4 kB.
2. The confirmation sentence ("Irreversible: Narrative opens a confirmation
   page…", 18×) and the URL-download sentence (4×) are said once in the
   instructions; each tool keeps a short marker. About 1.6 kB.
3. `token.create` / `token.update` share the text-style shape, with
   `SHAPE_MIN_TOOLS` lowered to 2 for named shapes. About 1.5–2 kB.
4. `text.format` / `text.list` share the selection target. About 0.7 kB.
5. Trivial examples such as `{"deckId":"<deckId>"}` are dropped from
   descriptions. About 1–2 kB.

- **Done 2026-10-14:** 199,977 → 193,154 bytes (link mode, now the
  largest), budget 194,200. What it took differs from the estimates: the
  confirmation line is already per mode and a test keeps it accurate per
  client, so it only got shorter (−0.4 kB); token_create and token_update
  share no subtree (every update field is nullable, and the list-level
  item differs from object_create's), so item 3 became trimmed prose
  (−0.2). The rest came from the compactor: nullable fields and
  string-constant unions as one schema (−1.2), shared descriptions stripped
  before inlining (−0.3), and shared shapes matched through `$ref`s plus
  two new ones, the file input and the text range (−2.8). Animations −1.1,
  trivial examples −0.5. The "Needs the editor role" sentence stays: a
  test requires every folder tool to say its role.
- **Budget:** lowered to the measured size plus 1 kB with a dated note. Then it is raised per A5 tool change,
  itemised, as in A2 and A4.
- **Verified:**
  - `toolListBudget.test.ts`;
  - `just capabilities`;
  - `just eval` once (descriptions changed);
  - `agent-parity`.

### A5.1 Groundwork: revert, provenance, the layout fixes

Small, independent fixes the build and the restyle both stand on.

1. **The deck meta takes part in undo and revert.** Add `doc.getMap('meta')`
   to the run's UndoManager (`services/runs.ts:509`) and the editor's
   (`slide-model/src/undo.ts:29`). A reverted `style.deck.apply` then
   restores the variant, fields and language. Tests:
   - slide-model undo;
   - a runs service test (apply, revert, meta as before);
   - e2e `agent-activity` revert.
2. **Slide provenance.** `SlideLayoutRef` gains `archetype?` (set by
   `applyLayout` when the layout was picked by archetype, or looked up in
   the pack's `archetypeMap`). `Slide.brief?: { message?, claims? }` moved
   to A5.3, with the build that writes it: in A5.1 nothing would.
   - Writers go in `mutations`/`slides.ts`, are classified in
     `slideModelExports.ts`, and are named by the commands that use them.
   - The PPTX round trip leaves them out, documented with `layout` and
     `meta` in `pptx/README.md`.
3. **`archetypeMap` resolved.** `slide.applyLayout` accepts `archetype`
   instead of `layoutId`. The pack's first layout for it is used, or the
   first whose required slots the given content fills. `query.check` warns
   on a deck that repeats one layout on more than half its slides (the
   narrative standard's rhythm rule; level `warn`).
4. **The role move without a current layout.** `planLayout` moves content
   by role whenever objects carry `role`, not only when the slide had a
   layout (`layout.ts:212-222`). Classifying a plain slide is then
   `object.update {role}` plus `slide.applyLayout` in one `ops.apply`.
   - Objects without a role stay where they are and are reported
     (`unplaced` in the result).
   - So do the earlier layout's objects the new one has no place for, as
     PowerPoint keeps a placeholder's text the new layout lacks; before,
     they were deleted with their content. Only empty text boxes and
     picture placeholders go.
   - Types must fit: text moves only into text regions (and a component's
     first text object), anything else only into picture, chart and table
     regions. A picture, table or chart moves in place (id and animations
     kept) instead of being re-created.
5. **Bug (c):** content moved by role into a component region is placed in
   the component's first text object, not dropped (`layout.ts:238`,
   `:260-261`).
6. **Bug (d):** several regions with one role take the objects by position
   (reading order: top, then left), not by document order.
7. **Picture focus.** A region's `focus` (or the content's `focus`) sets the
   image's `focus`. Not an `imageRect` as first planned: object.crop.set
   works in frame px and never knows the picture's own size, which a crop
   kept to one side needs. An image's `focus` (`top | bottom | left |
right`, absent = centred) is drawn by the renderer's fit
   (`mediaFit.applyFit`) and exported as the fitted picture's srcRect
   (`fittedRect`), carried in the PPTX extension; it survives a resize and
   a picture swap.
8. `restyle-lite` step 2 is corrected to what (4) makes true.

- **Verified:**
  - unit tests per item (layouts, undo, runs);
  - `just e2e -g "style-pack|agent-activity|multi-client-collab"`;
  - `just eval --filter pack-` (re-record where behaviour changed on
    purpose);
  - `agent-parity`.
- **Release** (with A5.0).

### A5.2 The deck spec

1. `packages/commands/src/stylePack/deckSpec.ts` (planned in `shared`; moved next to the text body schema): the schema above, with <!-- docs-check: ignore -->
   `validateDeckSpec(spec, pack)` (pack-relative rules, every problem by
   path), and an example spec for the example pack, used by tests and
   command examples.
2. `packages/commands/src/stylePack/buildPlan.ts`: a pure function, spec + <!-- docs-check: ignore -->
   pack + tokens + current deck → a plan per slide. It reuses `planLayout`
   per slide and adds:
   - archetype resolution;
   - `{de|en}`;
   - grid units → px for `drawn`;
   - a picture's focus → the image's `focus` (A5.1);
   - footer fields and variant into the meta.
     Unit tests on the example pack and on a richer fixture pack (see A5.6).
3. **A richer example pack** in `shared` (no client data): about 8 layouts
   covering cover, agenda, chapter, content, two-column, picture, quote
   and closer, with a component, so tests and eval exercise real decks.
   The existing 3-layout pack stays for the small tests.

- **Verified:** unit tests, `just check`. No release (nothing user-facing
  yet).

### A5.3 Build: `style.deck.apply { spec }`

1. `style.deck.apply` takes `spec` (D1).
   - **The deck's slides become the spec's**, in one transaction:
     - slides with `layout` provenance are matched to spec slides by
       position and re-laid (ids kept where slots match);
     - extra slides are added;
     - surplus slides are removed only with `replace: true` (otherwise
       refused, naming them).
   - Notes are written through the Markdown loader. This makes the command
     non-batchable, which is acceptable: it is the batch.
   - The meta is written (variant, fields, lang, and `spec`, D3).
   - **Furniture is laid out after every slide is placed**, so `{page}`
     templates read the final order.
2. **Output:**
   - per slide: id, index, layout, archetype, and any slots left empty or
     not placed;
   - the check's error count without measuring (`fit: false`), so the
     agent knows where to look first.
3. **Description and examples:**
   - one example that builds the example spec;
   - one that rebuilds the deck's stored spec with another variant.
4. **Rebuild with another pack** (§8.1):
   - the agent reads the stored spec through `query.deck { spec: true }`;
     without the flag, `query.deck` returns only the count of spec slides;
   - it rewrites `layout`/`archetype` for the new pack and builds again;
   - archetypes make most slides carry over unchanged.
5. Limits: 60 slides, 256 kB spec. Pictures by `assetId` only; uploading
   stays `media.upload`.

- **Memory world:** models the build (no render, no media checks beyond
  the seeded assets).
- **Verified:**
  - contract tests (examples, idempotence, nothing written on an invalid
    spec);
  - `just e2e -g "style-pack"`, extended: build a 6-slide spec through the
    command API, then check it with `query.check` measured;
  - `just eval` scenario `deck-build-from-spec`;
  - `agent-parity`;
  - `security-reviewer` (a new large input on a write path).
- **Release.**

### A5.4 Restyle, deterministic: `style.deck.apply { relayout }`

0. **Carried over from the A5.1 review:** re-laying a slide on the same
   layout and slot (a variant switch) rewrites a picture's frame with
   `imageRect: undefined` and the region's `focus`, so a crop or focus the
   user chose is lost (as before A5.1, when the picture was re-created).
   Keep both when the slot and layout are unchanged.

1. `style.deck.apply { slides?, relayout: 'archetype' }` (D2) re-lays the
   given slides (default: every `unmatched` slide, those laid out with
   another pack's layout):
   - **Target layout:** by the slide's recorded `archetype` (A5.1-2); if
     there is none, by the source layout's archetype found in the source
     pack's `archetypeMap`, which `deck.insertFrom` records on the slide
     while it still reads the source folder (`deckInsert.ts:443`); if that
     fails too, by family name.
   - **Content:** by role (A5.1-4).
   - **Colours:** each `{ $token }` that points at a compiled token of the
     source pack is remapped by its `origin.key`:
     - `role:*` → the target pack's role token;
     - `color:<id>` → the target colour of that id if it exists;
     - otherwise a literal resolved **with the source variant and surface**.
   - The target variant is applied; slides it cannot map are reported, not
     touched.
2. `services/tokenRebind.ts`: across folders, match by `origin` first, then
   by name. Literalise with the variant and surface the slide was drawn
   with (`:74-79`).
3. Run-level colours in copied bodies are remapped the same way.

- **Verified:**
  - unit tests on two packs (example and the richer one) and a cross-folder
    `deck.insertFrom` integration test;
  - `just e2e -g "insert|style-pack"`;
  - eval `insert-restyle-pack` (the Contoso→Fabrikam-style case A4.8 promised, on
    the two fixture packs);
  - `agent-parity`.
- **Release.**

### A5.5 Restyle by judgment: plain decks and PPTX

1. Classification stays the agent's (no classifier in code). It sets `role`
   (and `slot` where it wants a specific region) with `object.update`, then
   `slide.applyLayout`, in one `ops.apply` per slide (A5.1-4 makes this
   work on plain slides).
2. **PPTX hints, not provenance:**
   - `deck.importPptx` and `deck.insertFrom` from a PPTX return, per slide,
     the placeholder type of each object that had one (`title`,
     `subTitle`, `body`, `pic`, …), from what the parser already resolves
     and discards (`parser.ts:1136`, `:2136`);
   - this is returned in the result, not stored, which keeps the A4
     decision.
3. The `restyle-lite` playbook is rewritten around this. A new playbook,
   `insert-restyle`, covers "insert deck B after slide N and make it look
   like ours": `deck.insertFrom`, then `relayout` for slides with
   provenance and judgment for the rest, then `query.check`, then
   `query.render` (a sheet before and after).

- **Verified:**
  - eval `restyle-no-provenance` (a plain deck classified and laid out);
  - eval on a PPTX insert (live);
  - `just pptx-roundtrip` on the Proseware deck (0 differences: the hint is
    not stored).
- **Release.**

### A5.6 `deck.exportPdf`

1. **The PDF writer** in `packages/shared`:
   - a small writer that embeds JPEGs as-is (DCTDecode), one page per
     slide on a 960 × 540 pt page (PowerPoint's widescreen; the pictures stay 1920×1080 px);
   - about 100 lines, no new dependency, unit-tested by parsing its own
     output (page count, image sizes) and against `qpdf --check` if
     present.
2. **Server:**
   - `services/render.ts` renders 20-slide jobs one after another, as
     `measure` does, up to 40 slides a call;
   - PNG → JPEG (quality 85) through `sharp`, one slide at a time
     (memory);
   - the PDF goes to storage and is delivered as `url` by default; `base64`
     only under 8 MB;
   - skipped slides are left out unless `includeSkipped` (D7).
3. **Command** `deck.exportPdf` (reader role, D6):
   - route `GET /decks/:id/export.pdf`, rate-limited like PNG;
   - the `knownMissing` entry is removed.
4. **Editor:**
   - the Export button becomes a menu: PowerPoint (owners) and PDF
     (readers);
   - catalog action `deck.exportPdf`;
   - the PDF is built in the browser from the hidden render frame first
     (as slide PNG does), with the server route as the fallback.

- **Verified:**
  - unit tests (writer, slide picking);
  - e2e `render-export` extended (a 3-slide PDF: page count and a sampled
    pixel per page);
  - a 40-slide timing on the render worker recorded in "Where we stand";
  - `security-reviewer` (a new route and download);
  - `agent-parity`.
- **Release.**

### A5.7 The build playbook

`packages/commands/playbooks/build-deck.md` (about 5 kB; arguments `brief`, <!-- docs-check: ignore -->
`slides`, `ownership`), modelled on `presentation-narrative-standard`
without importing it:

1. **Scope.** Ask once, in one message, only what the brief leaves open:
   - ownership, tone, room and decision, slide count;
   - the variant, the footer fields.
2. **Voice.** For a client deck with no voice samples, ask for them. Derive
   only when the person declines, and say so in the report.
3. **Directions.** Offer three genuinely different story directions, three
   lines each, and recommend one.
4. **Handoff table.** Show `# | archetype | title | message | claim`. Mark
   claims `[SOURCE NEEDED]` or `[ILLUSTRATIVE]`. **Wait for approval**;
   nothing is written before it.
5. **Spec.** Map the table onto a deck spec. Pictures are uploaded first
   (`media.upload`).
6. **Build.** `style.deck.apply { spec }`.
7. **Check.** `query.check`. Fix by editing, grouping or splitting before
   shrinking type.
8. **Look.** `query.render` on each slide, then a contact sheet. Look again
   after every fix.
9. **Report.** What was built, what the check still flags, which claims
   need sources, that the build reverts in one step.

Also in this step:

- **Archetypes.** The narrative standard's format archetypes map onto
  Narrative's archetypes in the playbook's own table (title-reveal → cover
  or chapter, data-viz → chart, big-quote → quote, …).
- `build-with-pack` stays for adding a few slides; its description says so.
- A size test for playbooks (6 kB each), next to the tools/list budget.

- **Verified:**
  - eval `deck-build-voice-unknown` (asks, writes nothing; replayable);
  - eval `deck-build-from-brief` (live: two steps, brief then "go with
    direction B"; step 1 writes nothing);
  - the generated skill is up to date.

### A5.8 Eval suite and close

| Scenario                     | What it grades                                                                                                                                                                          | Replay | Est. cost |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------- |
| `deck-build-from-spec`       | a given spec built exactly: slide count, layouts, slots, notes, claims, meta                                                                                                            | live   | $0.30     |
| `deck-build-from-brief`      | 10–12 slides from a brief in two steps; every slide laid out; distinct titles; no layout on more than half the slides; check errors 0; a render per slide and a sheet in the transcript | live   | $2–3      |
| `deck-build-voice-unknown`   | asks for voice samples, writes nothing                                                                                                                                                  | yes    | $0.15     |
| `deck-rebuild-other-variant` | the stored spec rebuilt in the dark variant; content unchanged                                                                                                                          | live   | $0.40     |
| `insert-restyle-pack`        | deck B inserted after slide 4 and restyled; check errors 0; B unchanged                                                                                                                 | live   | $0.50     |
| `restyle-no-provenance`      | a plain deck classified and laid out                                                                                                                                                    | live   | $0.40     |
| `deck-export-pdf`            | a PDF of the deck, link returned                                                                                                                                                        | live   | $0.20     |

- The full suite grows to about 73 scenarios, about $14–15 and 27–30 minutes.
- `deck-build-from-brief` needs `maxTurns` about 60 and a 15-minute step
  timeout.
- The richer example pack (A5.2) is the fixture.
- **Close:**
  - `FINISHED_PHASES += 'A5'`; `knownMissing` has no A5 entry;
  - the handoff `docs/handoff/A5-deck-builder.md`; AGENTS.md and <!-- docs-check: ignore -->
    `agentic-layer.md` status;
  - full `just e2e`, `just eval`, `just pptx-roundtrip`;
  - `code-reviewer` and `agent-parity` on the phase.

## Not in A5

- The table and path tool merges (D4): their own change, after A5.
- A runtime object classifier: the agent classifies, and PPTX import gives
  hints.
- Stamped components in built slides as real stamp instances (the memory
  world does not model masters; `planLayout` places a component's objects
  from the pack). Decide when a pack needs restamping across built decks.
- Importing the brand packs into production folders: at Petr's go, brand by
  brand (A4 open item), independent of A5.
- Vector PDF.

## Risks

- **Large inputs.** A spec of 50–200 kB goes into `agent_ops.input` on
  every build. Acceptable (90-day retention), but watch the table's
  growth; `meta.spec` adds the same to the deck document once.
- **tools/list.** The spec schema could be 3–6 kB on `style.deck.apply`. If
  A5.0 frees less than measured, D4's merges come forward.
- **Build time.** A 40-slide build is one transaction of maybe thousands of
  Yjs operations. Measure in A5.3 (target under 2 s on the server) before
  raising the limit beyond 60 slides.
- **The brief eval is expensive and non-deterministic.** Grade structure
  only; keep it out of replay; run it before releases, not on every change.

## Where we stand

2026-10-14: plan written from four read-only surveys (build, restyle, PDF
and tools/list, playbooks and eval). Petr took D1–D7 as recommended the
same day, and moved the release to the end of A5 (D5). A5.0 done
(tools/list 193.2 of 194.2 kB). A5.1 done: reviewed (code-reviewer,
agent-parity; their findings fixed — content given for a slot replaces the
earlier layout's object of its role, a component part still showing its
master's text counts as empty, content of the wrong kind or for a missing
slot is refused, `archetype` reaches query.slide / query.deck, query.check
unmeasured has no slide cap so rhythm reaches big decks), full e2e green
(214), the Proseware deck round-trips with 0 differences, two new live-only
eval scenarios (pack-archetype-cover, pack-plain-slide-roles) pass with the
other pack ones (tools/list 193.8 of 194.2 kB). A5.2 done: the spec lives in `packages/commands/src/stylePack/deckSpec.ts`
(not `shared`: its slot text is the commands' text body), `planBuild` in
`buildPlan.ts`, `richExampleStylePack` in `shared` (eight layouts). Decided
on the way: a required picture may be left for later (the check flags its
placeholder), required text may not; deck slide `i` is reused when it is a
layout's (any pack: a rebuild with another pack) or empty, else `replaced`;
a slide named by `layout` gets the first archetype the pack maps it to;
drawn objects carry the slot `drawn-<n>`, which re-lays leave alone and a
rebuild replaces; planLayout reports `emptySlots`. A5.3 done:
`style.deck.apply { spec, replace }` builds in one transaction (meta, spec,
slides reused / added / removed in the spec's order, notes, briefs, guides)
and returns each slide built and the unmeasured check; its `load` loads the
notes converter and checks every picture with the media service, so the
command is no longer batchable or synchronous (no editor caller);
`query.deck` returns `specSlides` (`spec: true` the spec), `query.slide`
the `brief`. The rich pack's cover and closer moved to the dark surface
after looking at a built deck (navy text on the accent read badly).
tools/list 198.3 of 199.0 kB (the spec's schema is ≈ 4 kB, not the 0.8 kB
estimated). e2e builds the example spec and checks it measured.
Security review of A5.3, fixed: the size cap, a master target and the
pack check run in `load` before any media lookup; pictures are checked
against the deck's media (`owner`), at most 60; at most 32 slots a slide
and 300 drawn primitives a spec; a refusal names its first 50 problems;
`agent_ops` keeps an input over 64 kB as size and digest and bounds the
error; at most 6 builds a minute per user (ServerHost); query.deck returns
the stored spec only when it is a valid one (`specInvalid` else) and briefs
are clamped on read; the MCP instructions name deck specs and briefs as
data; `spec: null` forgets the spec (deck content every viewer has);
`removed` lists titles; the outline is normalised after a build. A5.4
done: `style.deck.apply { relayout: 'archetype', slides? }` restyles slides
on another pack's layouts (layout by archetype, else the same id; content
by slot and role; tokens by `origin.key` — slide-model `rewriteTokenRefs`,
shared with the server's tokenRebind, which now matches by origin before
name and literalises on the deck's variant and the slide's surface);
`deck.insertFrom` across folders records the source archetype; a re-lay on
the same layout keeps a picture's crop and focus. A5.5 done: the parser
names the placeholder a slide shape fills (`placeholderType`, "obj" when
untyped), the writer reports it per slide by object id, and
`deck.importPptx` / `deck.insertFrom` return it as `placeholders` (not
stored: the Proseware deck still round-trips with 0 differences);
`restyle-lite` points at it, and the new `insert-restyle` playbook covers
"insert deck B and make it ours" (insert, relayout by archetype, judgment
for the rest, check, look). tools/list 198.9 of 199.0 kB. Their eval
scenarios run with A5.8's. A5.6 done: shared `buildImagePdf` (JPEGs as
they are, DCTDecode, 960 × 540 pt pages; `qpdf --check` clean), the
render service's `buildPdf` / `exportPdf` (jobs of 20, PNG → JPEG 85 with
sharp one slide at a time, at most 40 slides), `deck.exportPdf` (any
reader; skipped slides left out unless `includeSkipped`), GET
/decks/:id/export.pdf (4 a minute), the toolbar's Export menu (PowerPoint
for owners, PDF for readers; the PDF built in the browser from the render
page, the route when it cannot render). Measured on the dev stack
2026-10-14: a 40-slide build 119 ms on the server, its PDF 10.3 s, 1.5 MB.
tools/list 199.9 of 200.0 kB. A5.7 done: the `build-deck` playbook
(scope, voice, three directions, the approved table, spec, build, check,
look, report; the narrative standard's formats mapped onto archetypes),
`build-with-pack` pointed at it, playbooks capped at 6 kB (basics 9 kB).
A5.8 done: nine scenarios — `deck-build-voice-unknown` recorded and
replayed; `deck-build-from-spec`, `deck-rebuild-other-variant`,
`deck-build-from-brief`, `insert-restyle-pack`, `restyle-no-provenance`,
`deck-export-pdf`, `pack-archetype-cover`, `pack-plain-slide-roles` live
(the agent looks with query.render or checks measured, which the memory
world cannot replay). `insert-restyle-pack` first failed: the agent left
an unmatched slide on the other pack's layout; deck.insertFrom and
`unmatched` now name the path. FINISHED_PHASES has A5, knownMissing is
empty, the handoff is `docs/handoff/A5-deck-builder.md`.
Phase review (code-reviewer, agent-parity), fixed: a rebuild reused deck
slides by position, so an inserted spec slide inherited the displaced
slide's notes and text — slides now carry the digest of the spec slide
that built them (`Slide.specKey`): an unchanged spec slide keeps its
slide, edits included, a changed one is built fresh, an earlier build's
leftovers go without `replace`; `{de|en}` per line and paragraph; one
deadline for a whole PDF passed into every render job; a folder's invalid
stored pack no longer breaks a cross-folder insert; moved tokens prefer the
destination's current pack; refused specs do not count against the build
limit; the editor says plainly when a PDF over 40 slides cannot fall back
to the server. Open: the release, on Petr's word.
