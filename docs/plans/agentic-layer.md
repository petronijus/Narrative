# Agentic Narrative: every capability callable by an agent, plus Woodgrove style packs

Status: **accepted**, 2026-09-26. **A0, A1 and A2 done**: A0 on
2026-09-26 and A1 on 2026-09-27 (released together as 0.10.0), A2 closed
on 2026-09-30 with A2.13 (A2.1–A2.12a released in 0.10.2–0.10.14; A2.12b
and A2.13 uncommitted on 2026-09-30, to ship as 0.10.15). Handoffs:
[A0](../handoff/A0-agentic-foundations.md),
[A1](../handoff/A1-mcp-and-server-host.md),
[A2](../handoff/A2-extraction.md). Next: the holistic tools/list size
review, then MCP work, then A3 ([`a2-extraction.md`](./a2-extraction.md),
"Where we stand"). (Was "A0 done, not yet released. Next: A1" until
2026-09-30; "Not started" until A0 landed.) The agent surface is
**MCP only**; an in-app agent is deferred (§13). Replaces the AI milestones
(M16–M18 in BUILD_PLAN, renumbered M20–M22 in
`docs/handoff/polish-phase-plan.md`); BUILD_PLAN now points here. Petr's
decisions are recorded in §12.

This plan is based on two read-only surveys done on 2026-09-26:

- a full capability inventory of this repo at `00890b0` (v0.9.29);
- the presentation skills in the Woodgrove skill library
  (`Woodgrove/internal/woodgrove-ai-brain`, commit `29f9367`): litware-fabrikam-pptx,
  litware-fabrikam-html, litware-contoso-presentation, tailspinr-pptx, html-presentation-slides,
  html-document, html-to-pptx, global-deck-editing-enable,
  gamma-deck-builder, adatum-analysis / adatum-key-insights,
  presentation-narrative-standard.

## 1. Goals

1. **Full parity.** An agent can do everything a user can do in Narrative:
   build a whole deck, and also make small targeted edits, for example
   "copy this", "move that", "change this text", "change the font",
   "export", or "insert that other deck after slide 4 and restyle it to
   match".
2. **Brand styles as data, owned by Narrative.** Decks in Narrative must
   be able to look the way Woodgrove's current decks look (Fabrikam, Contoso, Tailspin, the Woodgrove house style, Adatum). The skill library are the
   **inspiration and the starting material**, not a source Narrative
   stays in sync with. Narrative's own **style packs** and its own
   mechanics (the playbooks the MCP server serves, the `narrative`
   skill) become the
   way Woodgrove builds decks. An agent uses a pack to build and restyle decks
   and to check them against the brand.
3. **Parity cannot silently rot.** When a feature is added, it has to
   reach the agent surface too, or the build fails. A dedicated
   `agent-parity` Claude agent (modelled on `narrative-docs`) reviews
   every feature change for agentic coverage.
4. **MCP is the agent surface.** Claude Code and claude.ai drive
   Narrative through an MCP server. The model runs in the user's own
   Claude client, so Narrative has no Anthropic dependency and no API
   bill. The same registry also backs a batch HTTP API for scripts. An
   in-app chat agent was considered and deferred (§13).

## 2. Non-goals (for this plan)

- Charts as an object type. The Contoso `graph` layout and Adatum decks need
  them, but a chart object is a separate feature. Once it exists, it goes
  through the parity machinery like any other feature.
- Version history and comments. These are separate milestones. Section 6
  covers what agent undo needs on its own, without depending on them.
- Generating images. If image generation is added later, the Contoso
  AI-labelling rule in §7.6 applies to it.

## 3. What the surveys found (the facts this plan rests on)

**What already helps:**

- `packages/slide-model`, `packages/shared` and the animation compiler run
  headless: all their tests run in Node.
- The server already writes to live decks with slide-model mutations,
  through `hocuspocus.openDirectConnection(deckId)` in
  `apps/server/src/pptx/appendDeck.ts`.
- There is a headless read path: `media/replayDoc.ts` plus the token
  scanners.
- The PPTX round-trip matrix is a strong oracle for checking what an agent
  built.
- `tests/load/yjsClient.ts` is a Node client for the sync server.
- BullMQ and Redis are already deployed, so background jobs are available.

**What blocks parity (the full list is in Appendix B):**

- **There is no runtime schema.** No zod anywhere. `updateObject` writes
  any keys it is given.
- **A lot of behaviour exists only in React:**
  - the clipboard, for objects and for slides;
  - duplicate with group remapping;
  - move and nudge, including the `imageRect` rule for cropped images;
  - align to slide;
  - flip;
  - creation defaults;
  - pen and path geometry;
  - text-style apply, detach and reset;
  - token CRUD and default seeding;
  - the list rules;
  - table routing between range, cell and table defaults;
  - animation defaults;
  - writing a component master;
  - every thumbnail.
- **Text-style token propagation is web-only.** It is
  `DeckShell:TextStylePropagator`, so a deck only catches up with a changed
  style when someone opens it in a browser.
- **A folder created over the API has no tokens.** Default tokens are
  seeded only when a browser opens the folder.
- **There is no machine identity.** No API tokens, no service accounts, no
  rate limit, no audit log.
- **Undo does not fit agents:**
  - Every writer uses the one `LOCAL_ORIGIN` symbol.
  - Server writes reach clients as remote updates, so users cannot undo
    them.
  - Hocuspocus runs a direct-connection callback without wrapping it in a
    single transaction, so one server write arrives as many small updates.
  - In five places a nested `doc.transact` with no origin silently drops a
    write from undo history.
  - Two writes happen just because something is viewed: the font-weight
    auto-adjust and the timeline's onEnter migration.
- **Reordering deletes and re-inserts a clone.** This applies to layers,
  slides and animations. A collaborator's concurrent edit to the moved item
  is lost. An agent that reorders a lot makes this worse.
- **There is no server-side renderer.** An agent-built deck has no
  thumbnail, there is no PNG/PDF export, and the server cannot measure
  whether text fits.
- **There is no layout or slot concept.** A slide is a flat list of
  objects, and PPTX masters and layouts are flattened on import. So the
  server has nothing to go on when asked to restyle a slide or re-lay it
  out.

**What the skill library gives us:**

- **Contoso has the model to copy.** `litware-contoso-presentation` ships:
  - `references/layouts.json`: 58 layouts, each with slot geometry,
    per-level text styles, anchors, autofit, insets, and background/text
    per colour cut;
  - one **deck spec** (`vw_deck.py: Deck.to_dict()`) that renders to both
    PPTX and HTML;
  - a measurement-based fit and collision checker.

  This is the template for the Narrative style-pack format.

- **Fabrikam (50 layouts × light/dark) and Tailspin (22 layouts)** can be read from
  their `.pptx` masters. Their slot geometry is already extracted in the
  survey's scratch output.
- **The Woodgrove house style, Fabrikam HTML and Adatum** are CSS tokens plus
  class recipes, sized with viewport units. They convert to fixed
  1920×1080 regions: 1vw = 19.2 px, 1vh = 10.8 px.
- **`presentation-narrative-standard` is the storyline stage upstream of
  every builder.** It hands off a per-slide table with these columns:
  title direction, body, sub-line, format archetype, claim type, move and
  notes. That table maps directly onto the deck spec.
- **The skills contradict each other in places.** Fabrikam HTML and Fabrikam PPTX
  differ in title size, footer position, rings, margins and bullets. The
  Woodgrove `template.html` contradicts its own SKILL.md. Each pack has to name
  one source of truth (§7.4).

## 4. Architecture

```
                    ┌────────────────────────────────────────────────┐
  clients           │ Editor UI (humans)     MCP server     HTTP API  │
                    └──────┬─────────────────────┬──────────────┬────┘
                           │                     │              │
                    ┌──────▼─────────────────────▼──────────────▼────┐
  L2 hosts          │ BrowserHost (local Y.Doc)  │  ServerHost        │
                    │  LOCAL_ORIGIN              │  agentOrigin(run)  │
                    │                            │  + changesets      │
                    └──────────────┬─────────────┴─────────┬──────────┘
                                   │                       │
                    ┌──────────────▼───────────────────────▼──────────┐
  L1 commands       │ packages/commands — THE capability registry      │
                    │ id · zod input · output · role · effects ·       │
                    │ undo policy · description · examples · handler   │
                    └──────────────┬───────────────────────┬──────────┘
                                   │                       │
                    ┌──────────────▼──────────┐ ┌──────────▼──────────┐
  L0 model/services │ slide-model (Yjs)       │ │ server services      │
                    │ shared (types + zod)    │ │ decks, pptx, media,  │
                    │ animation compiler      │ │ share, render worker │
                    └─────────────────────────┘ └─────────────────────┘
```

### 4.1 The rule that makes parity structural

**Every user-visible mutation goes through a command.** The editor stops
calling slide-model mutations and web-only helpers directly; it dispatches
commands. An agent gets the same registry. When the UI and the agent can
only change state through one door, "the agent can do what the user can"
is true by construction. The remaining job is to make sure no second door
appears, and §9 enforces that.

This goes beyond the "state = Yjs only" invariant: the rule becomes
"state = Yjs, **written only through commands**". Record it as an ADR
(§11).

### 4.2 `packages/commands`: the capability registry

A new headless package. It depends on slide-model, shared, animation and
zod, and **never** on React, Pixi or the DOM.

```ts
interface CommandDef<I, O> {
  id: string // 'object.duplicate', 'text.setStyle', 'deck.exportPptx'
  domain: Domain // deck | folder | slide | object | text | table | animation |
  // guide | media | component | token | share | style | query | editor
  title: string // human label (also the UI menu label source where it fits)
  description: string // written for a model: when to use, what it does NOT do
  input: z.ZodType<I> // validated at every host boundary
  output: z.ZodType<O>
  role: 'viewer' | 'editor' | 'owner'
  effects: ('doc' | 'folderDoc' | 'componentDoc' | 'server' | 'render' | 'external')[]
  undo: 'undoable' | 'irreversible' | 'n/a' // share/invite/delete-deck/export are irreversible
  confirm?: 'always' | 'bulk' | 'never' // human-in-the-loop policy for agents
  hosts: ('browser' | 'server')[] // where the handler can run
  examples: { input: I; note: string }[] // few-shot for tool descriptions + contract tests
  handler(ctx: CommandContext, input: I): Promise<O> | O
}
```

- **Addressing is explicit.** Commands take ids or **selectors**, never
  "the current selection":

  ```ts
  type SlideRef = { id } | { index } | { number } | 'current' | { name }
  type ObjectSel =
    | { ids }
    | {
        slide: SlideRef
        where: {
          type?
          name?
          textContains?
          slot?
          role?
          textStyleId?
          tokenRef?
          groupId?
        }
      }
  ```

  The agent learns what "this" means from `editor.context`: the calling
  user's open editor already publishes its selection in awareness, and
  gains an `activeSlideId` field; the server reads the awareness states of
  that user's connections (§4.5). So "this" resolves to real ids before
  any command runs, never inside a handler.

- **Batching.** `ops.apply({ ops: CommandInvocation[], atomic: true })`
  runs many commands in one Yjs transaction and one undo step. This is the
  main tool the agent calls, because it saves round trips and keeps an
  agent action to one undo step.
- **Queries are commands too:**
  - `query.outline` (a compact deck digest built for LLM context);
  - `query.find`, `query.object`, `query.slide`, `query.tokens`,
    `query.fonts`;
  - `query.render` (a PNG of a slide, for vision);
  - `query.check` (brand/QA report, §7.5).

### 4.3 Hosts

**BrowserHost** runs commands against the editor's local Y.Doc. It serves
the human UI only, with `LOCAL_ORIGIN`, so the editor's undo keeps working
exactly as it does today.

**ServerHost** runs every agent command: MCP, the HTTP API, and anything
else that is not a person clicking.

- It opens `openDirectConnection(deckId)`, checks access first (the
  connection skips `onAuthenticate`), and wraps each invocation or batch in
  **one** `doc.transact(fn, agentOrigin(runId))`, so clients receive one
  update instead of many.
- It records a **changeset** (§6).
- Server-only commands call the existing services directly: import,
  export, share, media, render.
- **Undo consequence:** an agent write reaches open editors as a remote
  update, so Mod+Z in the editor does not undo it. Agent changes are
  undone per run instead (`agent.revert`, §6). Making agent edits
  Mod+Z-undoable would need the agent to execute inside the browser,
  which is exactly the deferred in-app agent (§13).

### 4.4 Agent guidance: playbooks over MCP

Narrative does not run a model. What it provides is **guidance**, so any
Claude client driving it builds decks the Woodgrove way:

- **Playbooks** live as markdown in `packages/commands/playbooks/`: build
  deck, edit, restyle, insert-and-restyle, fix slide, translate, shorten.
  They are Narrative's own, written using the skill library as
  inspiration (§8).
- The MCP server serves them as **MCP prompts**, so claude.ai users get
  them without installing anything.
- The **`narrative` Claude Code skill** is generated from the same files,
  so the skill and the prompts never drift apart. It ships from this repo as
  the plugin `claude-plugin/narrative/` (decision 2026-09-27: everything
  Narrative stays in the Narrative repo, nothing in woodgrove-plugins).
- **Style packs** are served as **MCP resources**: tokens, layouts,
  editorial rules. The agent reads the active pack before it builds.
- **Tool descriptions** come from the registry and are written for a
  model: when to use the command, what it does not do, and one example.

### 4.5 MCP server

- `apps/server/src/mcp/` exposes the registry as MCP tools over
  streamable HTTP at `/api/mcp`, using the official MCP TypeScript SDK.
- **Authentication:**
  - Claude Code uses a **personal access token** sent as a header,
    created in Narrative's account settings. This ships first.
  - claude.ai custom connectors need the MCP OAuth flow (authorization
    server metadata, Client ID Metadata Documents with dynamic client
    registration as the fallback, PKCE, `offline_access` refresh tokens).
    It comes second, in the same phase. It reuses the existing Google
    sign-in as the login step. Details, redirect allowlist and discovery
    routes: [`docs/mcp.md`](../mcp.md).
- **Tools** are generated from the registry. Each tool carries its
  command's zod schema as JSON Schema and **annotations** from its
  metadata:
  - `readOnlyHint` for queries;
  - `destructiveHint` for irreversible commands;
  - `idempotentHint` where it holds.
- **Confirmation** for `confirm: 'always'` commands (share, invite,
  delete deck or folder) and URL downloads (`confirmWhen`) uses **MCP
  elicitation**. Clients that cannot elicit get `confirmation_required` with a
  Narrative confirmation page the signed-in user approves on, and retry with
  the server-issued `confirmationId` (no model-settable flag; docs/mcp.md
  "Confirmation").
- **Images:** `query.render` returns slide PNGs as MCP image content, so
  the agent can look at its own work.
- **Presence:**
  - The agent joins the deck's awareness as a peer named "Claude (MCP)",
    with its own colour and selection. You watch it work live on the
    canvas, as you would a colleague.
  - `editor.show` sends a Hocuspocus stateless message to the calling
    user's open editors, to jump to a slide and highlight objects ("show
    me what you changed").
- **Session scope:** an MCP session is bound to one user. Every command
  runs with that user's deck role, never more.

### 4.6 Render worker (a prerequisite, and three user features)

- A BullMQ worker running headless Chromium loads the real web bundle in a
  **render mode** route (`/render/:deckId?slide=`) under the **production
  CSP**. It returns a PNG per slide, plus a PDF.
- **Why it has to be the real renderer:** text fidelity depends on the
  browser's text shaping and on the folder fonts. And 9 of the 10 0.9.x
  defects appeared only under production CSP.
- **What it unlocks:**
  1. thumbnails for decks nobody has opened;
  2. **PNG/PDF export**, which does not exist today;
  3. `query.render`, which gives the agent eyes (below);
  4. **text-fit measurement.** The page reports each text box's laid-out
     height, so the brand checker (§7.5) measures with the real fonts, as
     the Contoso checker does with Pillow.
- **The agent can screenshot and see.** `query.render` is the agent's
  eyes, returned as MCP image content that Claude looks at directly:
  - `{slide}`: one slide at full size (1920×1080, downscaled to what the
    model can read, about 1568 px on the long edge);
  - `{slides | 'all', sheet: true}`: a contact sheet of many slides in one
    image, for pacing, repetition and consistency across the deck;
  - `{slide, region}`: a crop at full resolution, to check small type, a
    table or an alignment detail;
  - `{slide, compare: 'before'}`: before and after side by side, the
    "before" being the state at the start of the current run (§6).
  - Renders are taken from the **live** document through the sync
    server, not from the saved snapshot, so a screenshot right after a
    command already shows that command's effect.
  - The build, restyle and fix playbooks require a look after every
    visible change (§8.2). Tool descriptions say so too.
- Playwright cannot install browsers on Ubuntu 26.04 (see CLAUDE.md), but
  the worker image uses the official Playwright Docker base, so this only
  affects local runs.

## 5. Command catalogue: full coverage

Every row of the inventory maps to a command. The **complete** mapping,
with source locations, is Appendix A. Here is the shape by domain:

| Domain    | Commands (abridged; `*` marks new capabilities, not just extraction)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| deck      | `list`, `get`, `create`, `rename`, `delete`, `moveToFolder` (+ token rebinding\*), `duplicate`\*, `importPptx`, `insertFrom` (pptx **or** another Narrative deck, at N)\*, `exportPptx`, `exportPdf`\*, `exportPng`\*, `refreshThumbnail`\*, `activeEditors`                                                                                                                                                                                                                                                                                                                                    |
| folder    | `list`, `create`, `rename`, `delete`, `moveDecks`; `fonts.list/upload/delete`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| token     | `color.list/add/update/delete`, `textStyle.list/add/update/delete`, `usages`, `seedDefaults`\*, `delete` with replace-or-detach\*                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| slide     | `add` (optionally from a layout\*), `duplicate`, `delete`, `move`, `moveBlock`, `indent`, `collapse`, `skip`, `rename`, `setTransition`, `setBackground`, `copyTo` (same or another deck, at N; replaces the clipboard and keeps name, notes, indent\*), `notes.get/set` (markdown)\*, `applyLayout`\*                                                                                                                                                                                                                                                                                          |
| object    | `create` (per type, with defaults), `delete` (also deletes its animations\*), `update` (validated patch), `rename` (unique per slide), `lock`, `duplicate` (group remap\*), `copyTo`, `move`/`nudge` (with `imageRect`), `resize`, `rotate`, `flip`, `align`, `alignToSlide`, `distribute`, `layer` (front, back, forward, backward, toIndex), `group`, `ungroup`, `mask.apply/remove`, `crop.set/reset`, `path.create/fromShape/setAnchors`, `line.setEndpoints`, `fill.solid/token/unlinkToken/gradient/image`, `stroke.set`, `effects.shadow/blur`, `hyperlink.set/clear`, `slideNumber.set` |
| text      | `set` (plain, markdown subset, or delta), `replace` (find/replace across slide or deck\*), `formatRange`, `clearFormat`, `setBoxTypography`, `list.toggle/indent/outdent/setGlyph/setFormat/setStart`, `style.apply/detach/reset`, `style.updateFromObject`, `style.createFromObject`                                                                                                                                                                                                                                                                                                           |
| table     | `insert`, `row.insert/delete`, `col.insert/delete`, `setSize` (rows × cols), `resizeTrack`, `merge`, `split`, `cell.setText`\*, `style.cell/range/table`, `border.preset/segment`                                                                                                                                                                                                                                                                                                                                                                                                               |
| animation | `add` (with defaults), `update` (incl. the moveTo target), `remove`, `reorder`, `retime` (absolute times)\*, `retarget`\*; a video's timing is `object.update`                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| guide     | `list`, `add`, `update`, `remove`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| media     | `upload` (bytes or URL, with SSRF guard), `status`, `url`, `delete`; `image.insert` (native size, fit into rect, or into a slot)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| component | `list`, `get` (master with slot map\*), `create` (from objects or a spec\*), `promote` (keeps rich text\*), `stamp` (fills slots, keeps provenance\*), `restamp`\*, `rename`, `delete`, `master.*` (the object/text commands pointed at a component doc)                                                                                                                                                                                                                                                                                                                                        |
| share     | `permissions.list/invite/setRole/revoke`, `invites.list/cancel`, `links.list/create/revoke`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| style     | `pack.list/get/import/validate`, `deck.applyPack`, `slide.relayout`, `slides.restyle`, `check`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| query     | `outline`, `find`, `object`, `slide`, `tokens`, `fonts`, `render`, `check`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| editor    | `context` (the user's active slide and selection, from awareness)\*, `show` (point the user's open editor at slides/objects)\*, `present.link` (`?slide=N`\*)                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Excluded from the agent surface, on purpose and in writing.** These live
in `packages/commands/src/parity/allowlist.ts`, each with a reason:

- zoom, pan, stage background, rulers toggle, active tool, group isolation;
- cheatsheet, FPS overlay;
- present-mode navigation, fullscreen, and the presenter window: human
  runtime, not document state. The agent gets `present.link`.

The allowlist is the only place a capability can be left out, and adding
to it is a reviewed change (§9).

## 6. Agent changes: preview, undo, audit

**Decision (2026-09-26): the agent applies changes directly by default**,
for every kind of run, and relies on per-run revert. Propose mode is an
opt-in flag on `ops.apply` and the style commands, for anyone who wants
to review first.

A **run** is one MCP session's work on one deck, split into a new run when
the agent calls `agent.startRun` (the playbooks do this per user request)
or after 10 minutes of inactivity.

- **Direct (default).** Commands apply live.
  - Every change is recorded in the run's changeset. `agent.revert` undoes
    a whole run or its last N ops, while the document is loaded
    (`unloadImmediately: false` keeps it loaded while anyone is
    connected). It uses a server-side `Y.UndoManager` scoped to
    `agentOrigin(runId)`, so a revert removes only the agent's changes
    and keeps edits people made in the meantime.
  - The editor gets one small piece of UI: an **Agent activity** popover
    listing recent runs on this deck (what, when, how many ops) with a
    **Revert** button. So a human can undo an agent without going back to
    Claude.
- **Propose (opt-in).** Review before anything touches the live deck.
  1. Fork the live document: a new Y.Doc seeded with
     `encodeStateAsUpdate(live)`.
  2. Run the commands on the fork and render before/after thumbnails.
  3. Return the per-slide before/after renders to the agent, which shows
     them to the user in the Claude conversation.
  4. **Apply** sends
     `encodeStateAsUpdate(fork, stateVectorAtFork)` to the live document
     with the agent origin, via `agent.applyProposal`. Because it is a
     CRDT delta, concurrent human edits made in the meantime survive.

  The old `ai-integration.md` principle "never mutate the Y.Doc without
  user confirmation" is superseded by the direct-by-default decision; the
  brief was rewritten in A0 (and moved to Opus, per CLAUDE.md).

Irreversible commands (`share.*`, `deck.delete`, `folder.delete`,
invite emails) are the exception to direct mode: they always ask for
confirmation (`confirm: 'always'` in the registry), through MCP
elicitation (§4.5).

**Changesets and audit.** A new table `agent_runs` records the run id, the
user, the surface (MCP or API), the client name the MCP session reported,
the user's request as the agent stated it in `agent.startRun`, the status,
and the style pack. A second table `agent_ops`
records the run id, a sequence number, the command id, the input, the
result or error, and the time.

This gives:

- revert while the doc is loaded;
- replay: re-running the recorded ops on a fork is deterministic, because
  commands take explicit ids;
- an audit trail of what agents did to which deck.

Durable revert after the doc unloads needs version history (M18). It is
out of scope here and noted as a known limit.

## 7. Style packs: tokens, a few components, and layouts as data

**Decisions (2026-09-26): brand styles are translated into Narrative's own
building blocks, and the agent works with those — but components are used
sparingly.** A style pack is not a second styling system next to the
editor. Applying a pack to a client's folder produces three things.

1. **Folder tokens and fonts.** Colour tokens, text-style tokens (headline,
   subline, copy, footnote, … with per-level list styles, §7.2) and the
   brand fonts. Almost all styling reaches objects through these tokens.
2. **A small, curated set of components**, only for blocks that recur on
   many slides and that people want to change in one place:
   - pagination (the page number);
   - headline, subline and copy text blocks;
   - a repeated column or grid layout (e.g. the brand's three-column or
     card grid);
   - little else. A brand with 100 templates does NOT become 100
     components: that library would be unmaintainable.
3. **Layouts as data.** The brand's templates stay in the pack as layout
   definitions: region geometry, which slot goes where, which text style
   and component each slot uses. They are not components. A deck with
   100 templates is 100 small data records, not 100 masters.

The agent builds a slide by picking a layout, then placing the pack's
components (headline, subline, copy, pagination, a column grid) and plain
objects styled with the folder's tokens into the layout's regions. It
restyles by re-placing the same slots with another pack's layouts, tokens
and components. The result is made of the things a designer uses by hand:
token-styled objects plus the few shared components, so people keep editing
an agent-built deck with the normal tools, and a component a designer
improves in Folder Settings is what the agent uses next time.

**Rule for the agent, written into the playbooks and tool descriptions:**
use the pack's existing components for the roles they cover; never create
a component for a one-off; propose a new component only when a block
repeats across several slides, or when the user asks for one.

The pack JSON keeps everything else: layouts, editorial rules, QA rules,
the archetype → layout map, the variant list, imagery rules and
provenance.

### 7.1 Format

A style pack is JSON validated by zod, stored per folder. In Narrative a
folder is the natural brand or client boundary: it already owns tokens,
fonts and components. The schema is the one proposed by the survey,
condensed here:

- `tokens`:
  - colours and colour roles (for example Contoso allows only
    `{dark_blue, white}` as text colours);
  - theme slots;
  - **variants** (Fabrikam light/dark, Contoso white/nh/dc, Woodgrove dark/light × one
    of 8 accents);
  - chart palette.
- `fonts`: the role (`head`, `text`, `text_bold`, `display`), weights,
  axes (Fabrikam's single variable font has `wdth` 100/105/130), fallbacks,
  `synthesizeBold: false`.
- `textStyles`: map to folder text-style tokens, **plus per-level list
  styles** (bullet glyph, bullet colour, bullet scale, indent, hanging
  indent, space before).
- `grid`: margins, content band, columns, halves, gutter, the tops of the
  title / content / footer areas. These map to deck guides.
- `furniture`: the slide chrome the pack draws, not the author: logo
  placements per layout, a footer template with fields
  (`Page {page} | Creation date: {created} | …`), page number,
  classification marking, rules, and decoration (Adatum spheres and
  rings).
- `layouts[]`: `id`, `family`, `variant`, `tone`, `purpose`,
  `needsPicture`, `background`, and `regions[]`. Each region has a `slot`,
  a `role`, a `rect` as a fraction of the canvas, a `textStyle` (a folder
  token), an optional `component` (one of the pack's few components, e.g.
  the headline block), `align`, `anchor`, `autofit` (`grow-down` / `fixed`
  / `shrink`), `insets`, `aspect`, `maxLines`, `maxChars`, `required` and
  `fillOrder`. **Layouts stay data** — however many templates a brand
  has.
- `components[]`: the short list of blocks that become component masters
  (pagination, headline, subline, copy, a recurring column/grid). Anything
  used once or twice stays a recipe the builder draws with token-styled
  objects.
- `imagery`: a pool reference plus rights, slot aspect ratios, minimum
  dpi, default focus, whether scrims are allowed, an AI-label rule, and
  icon style.
- `editorial`:
  - title mode: `action-title` for Fabrikam, Contoso and Adatum; `label +
message-subtitle` for Tailspin;
  - title word limits and "no trailing period";
  - no caps, no italics;
  - bullet glyphs;
  - an accent budget (Fabrikam red once per slide);
  - eyebrow policy;
  - minimum body size;
  - typography: quote style, en dash, em dash, NBSP before units, no emoji;
  - banned phrases, register (du/Sie), languages, the bilingual marker
    (`{de|en}`).
- `qa`: fit check with real fonts, partial-overlap errors, stay inside the
  grid, text-colour whitelist, one variant per deck, required furniture,
  and placeholder sentinels (`I/XX`, `xxxx-xx`, `Bitte Fußzeile
einfügen`).
- `archetypeMap`: maps a narrative archetype to layout ids in preference
  order.

### 7.2 Slide-model changes a pack needs

These land before the importers, and every one of them goes through the
command layer and the parity check.

1. **Layouts, slots and component provenance.**
   - A slide built from a pack layout records
     `layout?: { packId, layoutId, variant }`.
   - An object placed into a layout region gets `slot?: string` and
     `role?: 'title' | 'subtitle' | 'body' | … | 'furniture'`.
   - A stamped component keeps `component?: { id }` on its objects. Today
     stamping forgets where the objects came from.

   This is the equivalent of Contoso's `data-contoso-slot`. It turns restyle and
   re-layout into lookups instead of guesses: "use the other pack's
   equivalent layout and move each slot's content across". PPTX export can
   then also fill a real master's placeholders when the pack has one.

2. **Autofit semantics on text boxes:** `grow-down` / `fixed` / `shrink`,
   matching `spAutoFit`.
3. **Per-level list styles on text-style tokens.** Today list attributes
   live only on paragraph runs.
4. **Furniture objects:** `role: 'furniture'`, regenerated by
   `style.deck.applyPack`. Pagination is one of the pack's components and
   reuses `isSlideNumber`; other furniture (logo, footer) is placed from the
   layout data. Furniture may be locked for people in the editor; agents
   ignore locks (§12, decision 9).
5. **Font stretch** (a `wdth` axis) on text, for Fabrikam Type.
6. **Deck-level variant** (Contoso's rule of one variant per deck), with
   `style.deck.setVariant`.
7. **Schema debt found by the survey:** add `textStyleId` to `TextObject`.
   It is written today through a type cast. (Done in A0.)
8. **Component commands the agent needs** for the few components a
   folder has:
   - `component.list` and `component.get` (master content with its slot
     map);
   - `component.stamp` with slot content filled in the same step;
   - `component.create` from objects or from a spec;
   - editing a master (the object and text commands pointed at a
     component document);
   - `component.restamp`, which re-applies a changed master to the stamps
     that came from it, keeping their slot content.

### 7.3 Where packs come from, and who owns them

**Decision (2026-09-26): Narrative owns its packs.** The skill library
are inspiration: the goal is that the same visual works in Narrative, not
that Narrative mirrors the skills. So:

- The importers below are **one-time bootstrap tools** that produce a
  first version of each pack from the skill material. After that, the
  pack is edited in Narrative and nowhere else. There is no sync back to
  the brain and no "stale brain commit" check. The pack records where it
  was bootstrapped from (brain commit `29f9367`, file paths) as
  provenance only.
- Packs are **editable in Narrative**: a "Style pack" tab in Folder
  Settings, backed by `style.pack.*` CRUD commands. That means packs are
  covered by the parity machinery like every other feature, so an agent
  can edit a pack too ("make the Contoso accent a touch darker", "add a
  three-column layout").
- The long-term way Woodgrove builds decks is Narrative's own playbooks and
  the `narrative` skill (§4.4, §4.5), not the per-client brain skills.

| Pack          | Bootstrap from                                                                                                             | Visual reference to match                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Contoso 2026       | `layouts.json` → pack, almost field for field; the Contoso deck spec informs Narrative's own DeckSpec                           | `VW_Master_2026_{DE,EN}.pptx`                                                |
| Fabrikam          | new PPTX master/layout reader (extends the M28 parser; ADR 0009 "one translation both directions")                         | `Audi_Template.pptx`, **not** the HTML skill (they disagree; see the survey) |
| Tailspin | the same master reader, plus the diagram builders as components                                                            | `tailspinr-master.pptx`                                                          |
| Woodgrove house   | hand-authored from `test-presentation.html`, **not** `references/template.html` (v1 contradicts SKILL.md v1.8); vw/vh → px | `test-presentation.html` / SKILL.md v1.8                                     |
| Adatum        | extends Woodgrove: lime accent, decoration, chart palette                                                                      | `adatum-deck-design.md`                                                      |

**The PPTX master reader is a real deliverable.** It turns a client
master's layouts into pack layout data (and its theme into tokens); it does
not turn them into components. It also fixes "masters and layouts are
flattened on import" for ordinary PPTX imports: slides imported from a
branded deck keep their layout and slot provenance.

### 7.4 Contradictions resolved at bootstrap

The skill material contradicts itself in places. Each bootstrap makes one
explicit call, recorded in the pack's provenance notes:

- **Fabrikam:** the PPTX master wins. The HTML skill's values become a
  separate `web` variant, if anyone wants it.
- **Woodgrove:** SKILL.md v1.8 and `test-presentation.html` win.
- **Contoso:** `layouts.json` wins over the off-by-one level comment in
  `vw_deck.py`.
- **Tailspin:** the master theme wins over the dashboard-builder ramp
  (`#002B46`, not `#003D7A`).
- **Title philosophy:** this is a per-pack setting (`editorial.titleMode`),
  not a global one.

### 7.5 Brand/QA checker (`query.check`)

This ports `vw check_deck.py` into a pack-driven checker. It reports
errors and warnings per slide and per object:

- **Fit:** the rendered height from the render worker is compared with
  the region. A `grow-down` box may grow until the next region or the
  footer, with half a line of slack.
- **Collisions:** partial overlap is an error; full containment is fine.
- **Grid, variant and colours:**
  - everything stays inside the grid;
  - one variant per deck;
  - text colours come from the whitelist.
- **Content rules:**
  - required furniture is present;
  - placeholder sentinels are flagged;
  - editorial rules are enforced (caps, italics, bullet glyphs, a title
    ending in a period, the accent budget, typography);
  - a missing picture on a picture layout is flagged;
  - `[SOURCE NEEDED]` claims block the deck when the proof standard is
    Rigorous.

If a font cannot be loaded, the checker reports **"fit not verified"** and
treats it as a failure, as the Contoso checker does.

### 7.6 Fonts, masters and rights

**Decision (2026-09-26): Narrative may host the brand fonts** (Contoso Head/Text
Office, Fabrikam Type, Northwind Sans ST Pro) as folder fonts.

- Brand fonts are uploaded as **folder fonts** of the client's folder.
  They are scoped to the folder and are never served to anonymous
  share-link viewers.
- **Gap to fix in A4:** an editor on a shared deck cannot load the
  folder's fonts today (folder routes are owner-only), so a collaborator
  would see fallback faces. Deck-scoped font access fixes it.
- **Contoso Head/Text Office** are not in the brain repo (the skill
  deliberately links rather than ships them); they have to be uploaded
  from Woodgrove's own font files.
- **Fabrikam Type:** the variable font is uploaded whole, not the latin subset
  the HTML skill embeds, so German and other diacritics outside the subset
  render correctly.
- The render worker loads folder fonts exactly as the editor does, so fit
  checks measure with the real faces.
- **Client masters** (`.pptx`) are client IP. The derived JSON (geometry,
  tokens) lives in the pack. The binary master is stored as a private
  folder asset, used only for "export via master".
- **Image pools** (Fabrikam: 291 files; Contoso: 72 press images) stay on Drive. A
  pack references them, and an ingestion step copies selected images into
  media along with their rights metadata.
- **Contoso AI labelling:** since 2026-08-02, AI-generated or AI-modified
  imagery must be labelled. The Contoso pack carries the rule, and assets carry
  an `aiGenerated` provenance flag.

## 8. Building decks and restyling

### 8.1 Deck spec (the agent's build format)

This generalises the Contoso spec:

```ts
interface DeckSpec {
  pack: { id: string; variant: string }
  lang: string[] // bilingual via {de|en}
  meta: { title: string; classification?: string; footer?: Record<string, string> }
  slides: {
    layout: string // pack layout id
    archetype?: string // narrative archetype (provenance)
    message?: string // the one-line job of the slide (QA + notes)
    slots: Record<string, Paragraph[]> // {text, level, marks?}
    pictures?: Record<string, { asset: AssetRef; focus?: Focus }>
    drawn?: Primitive[] // box | text | rule | arrow | number, in pack grid units
    notes?: string // markdown
    provenance?: { claim: 'sourced' | 'source-needed' | 'illustrative'; source?: string }[]
  }[]
}
```

Here `layout` is a pack layout (resolved by id, or through `archetypeMap`
from `archetype`), and `drawn` primitives are the exception, used only when
no layout region fits.

`style.buildFromSpec` turns a spec into objects in one transaction:

- each slide places its layout's regions: a region that names a component
  (headline, subline, copy, a column grid) stamps it and fills it; other
  regions become plain objects styled with the folder's tokens;
- pagination and other furniture are placed per the pack's rules;
- styling comes from the folder's tokens and the pack's components, never
  from literal values in the spec;
- every object records its slot (and component, when it came from one).

Because a spec is data, the agent can revise it and rebuild. The spec is
stored on the run, so a deck can be rebuilt with another pack.

### 8.2 Build playbook (Narrative's own, inspired by the skill library)

1. **Narrative.** Modelled on `presentation-narrative-standard`: scope (mode,
   depth, ownership, tone, room, decision, slide count), then three story
   directions, then a per-slide handoff table. For client decks the brain's
   voice-unknown protocol applies: ask for samples, never invent a voice.
2. **Map.** Each row becomes a DeckSpec slide: the archetype goes through
   `archetypeMap` to a layout; title and body go into slots; claim type
   goes into provenance.
3. **Build:** `style.buildFromSpec`, applied directly (or into a fork
   when the user switched propose mode on).
4. **Check:** `query.check`. Fix the errors: edit, group or split before
   shrinking type, as the Contoso and Woodgrove composition rules say.
5. **Look:** `query.render` on each slide at full size, then a contact
   sheet of the whole deck for pacing and repetition (Contoso's two-pass
   review). Whatever looks wrong goes back to step 4, and the agent looks
   again after fixing it. For small edits the playbooks require at least
   one screenshot of the changed slide before the agent reports done.
6. **Report.** Summarise what was built and what `query.check` still
   flags. The whole build is one changeset, revertible in one step.

### 8.3 Insert another deck after slide N and restyle it

This is `deck.insertFrom({source: deckId | pptxUpload, range?, at})`
followed by `style.slides.restyle({slides, pack, variant, mode})`:

- **Deterministic part**, for slides that carry layout and slot provenance:
  - pick the target pack's equivalent layout (same layout family, or
    through `archetypeMap`) and move each slot's content into its region;
  - replace the source pack's components (headline, pagination, …) with
    the target pack's, and remap the other objects to the target folder's
    tokens by role;
  - apply the target variant.
- **Judgment part**, for slides without provenance (an old deck, a plain
  PPTX):
  - the agent classifies objects into slot roles (title, body, picture,
    and so on) and picks a layout through `archetypeMap`;
  - `slide.applyLayout` moves the classified objects into the layout's
    regions, using the pack's components where the layout names them;
  - `query.check` verifies the result.
- Slides built from a pack, or imported through the master reader, never
  need the judgment part.

## 9. Keeping parity from drifting

There are three layers. The mechanical ones fail the build; the agent
catches what they cannot.

As of A0 (2026-09-26): guards 3 and 5 below are in place; guard 4 runs
every example and a missing-id check over every command, but the
convergence property suite has no agent ops yet; guard 2 covers
slide-model writers, command metadata and the known-missing/allowlist
hygiene, and routes through the server's route guard
(`apps/server/src/routes/agentParity.test.ts`, which enumerates the real
Fastify route table via `apps/server/src/http/registerRoutes.ts`; 45 routes),
but not yet shortcuts or menu actions (A2); guard 1, the lint rule, is
switched on directory by directory in A2.

As of A1 close (2026-09-27): the route guard sees **69 routes**, every one
claimed by a command or allowlisted; 94 commands, 39 known-missing entries
(A2 32, A3 5, A4 2 — no A0 or A1 entry left, both phases are in
`FINISHED_PHASES`), 18 allowlisted. New registry rules since A0: target
metadata (`acceptsComponent`, `commandTargetProblems`: every document edit
must accept a component master, only deck-scoped commands may), and
`undoneBy` (every server-side `undoable` command names its counter-command).
The contract suite now also checks idempotence against the server fakes'
state and result (not only the document), and runs every deck command
against a component master in both directions (accepts ↔ `acceptsComponent`).
`apps/server/src/mcp/toolListBudget.test.ts` caps `tools/list` at 132,000
bytes (160 KB at A1 close; lowered 2026-09-28 when the shared field
vocabulary brought the list to ≈ 129 KB, see §10).
(A lock policy — commands
refusing locked objects unless `force: true` — was built and removed the
same day, 2026-09-26: locks are editor-only and agents ignore them, §12
decision 9.)

As of A2 close (2026-09-30, A2.13; uncommitted, to ship as 0.10.15): every
guard below is in place except the convergence suite's agent ops (guard 4).
129 commands, 7 known-missing entries (A3 5, A4 2; `FINISHED_PHASES =
['A0', 'A1', 'A2']`), 20 allowlisted. Guard 1 covers all of
`apps/web/src` with an empty `ONE_DOOR_PENDING` (since A2.13; the only
non-test exemption is the dev-only `state/testApiLegacyFixtures.ts`).
Guard 2's shortcut / menu part is the **action catalog**
(`apps/web/src/actions/catalog.ts`, checked by `catalog.test.ts`, not by
`parity.test.ts`). It lists 82 actions, each naming the commands that
carry its effect, an `editorOnly` reason or `planned`. The tools/list
budget is 189,000 bytes (188,697 measured in url mode on 2026-09-30),
raised step by step through A2 and due for one holistic review.

### 9.1 Mechanical guards (run by `pnpm -r test` + `pnpm lint`)

1. **One door, enforced by lint.**
   - An ESLint `no-restricted-imports` rule forbids `apps/web/src/{ui,
components,editor,pages}` from importing slide-model mutations,
     `richText` writers, `tableMutations`, `animationMutations`,
     `deckGuides` writers, or `Y.Doc.transact`.
   - The UI must use `useCommand()`.
   - Read-side imports stay allowed.
   - As built (A2.1, 2026-09-28): the rule covers all of `apps/web/src`
     (tests excepted), not only the four directories. The writer list is
     generated from `slideModelExports.ts`. Files not migrated yet sat
     on `ONE_DOOR_PENDING` (`apps/web/eslint.one-door.js`), which has been
     empty since A2.13 (2026-09-30).
2. **Parity test** (`packages/commands/src/parity/parity.test.ts`):
   - every exported writer in slide-model is referenced by at least one
     command handler, or appears in the allowlist with a reason;
   - every Fastify route (enumerated from the server's route table) is
     backed by a command or allowlisted;
   - every shortcut in `useShortcuts.ts` and every context-menu or toolbar
     action id dispatches a command id that exists. As built (A2.13,
     2026-09-30), this part is not in `parity.test.ts` but in the web app:
     - every shortcut binding (`ShortcutBinding.action`) and every Radix
       menu item (`components/ui/{context-menu,dropdown-menu}.tsx`, an
       `action` prop) names an action of `apps/web/src/actions/catalog.ts`;
     - each action lists the commands that carry its effect, or is
       `editorOnly` / `planned` with a reason;
     - `actions/catalog.test.ts` checks that the named commands exist,
       that no action is unused, and that every toolbar button carries a
       `data-action`.

     It also requires a catalog `data-action` on every element with a
     `menuitem` role in the web app (hand-rolled menus). Not covered: raw
     key handlers, Inspector controls and canvas gestures (the one-door
     rule still covers their writes);

   - every command has a description of at least 40 characters, at least
     one example, and a contract test.

3. **Schema coverage test.** Every property of every object type in
   `shared/slide.ts` exists in its zod schema (a compile-time exhaustive
   check through `z.infer` equality), so a new property cannot be missing
   from agent input.
4. **Contract tests per command.** Each example runs against a fixture
   doc, and the resulting `listSlides()` is compared **structurally** (no
   CRDT byte equality, per CLAUDE.md). The property-based convergence
   suite gains agent ops: batch apply, concurrent human and agent edits,
   and propose-then-apply over concurrent edits.
5. **Generated manifest.** `pnpm capabilities` writes
   `docs/capabilities.md` and `packages/commands/capabilities.json` (ids,
   roles, effects, descriptions). Both are committed, and a test fails if
   the committed copy is stale. So every capability change shows up in the
   diff that Petr reads.

### 9.2 The `agent-parity` Claude agent

A new file, `.claude/agents/agent-parity.md`, set to `model: opus`. It is
built like `narrative-docs`: a sweep with a ledger at the end, and it never
commits. It is invoked after any feature work, and in the same breath as
the docs sweep.

1. **Ground itself:** `git diff` / `git log`, and the files that changed.
2. **Classify every change:**
   - new or changed user capability;
   - new object property;
   - new route;
   - new shortcut or menu action;
   - a change to the style-pack schema or a pack.
3. **For each change, check that it exists and is good:**
   - the command, with a model-quality description;
   - the zod schema;
   - the examples;
   - the contract test;
   - an eval scenario (§9.3);
   - the manifest regenerated;
   - style-pack mapping if it affects appearance (for example a new text
     property must be representable in `textStyles`);
   - PPTX round-trip, if relevant.
4. **Run the guards:** the parity test, the schema test, the command
   contract tests, and `pnpm capabilities --check`.
5. **Return a ledger:** covered, missing (with the exact file:line to add
   it), and deliberately allowlisted (with the reason). It may **write**
   missing commands, schemas and tests when asked. By default it only
   reports.

Two supporting edits:

- **CLAUDE.md** gets a row in the auto-run table (done: the parity row
  landed with A0, and an `agent:eval` row for playbooks / tool descriptions
  with A1): any change under
  `apps/web/src/{ui,components}`, `packages/slide-model/src`,
  `apps/server/src/routes`, or `packages/commands` → run the parity guards
  and invoke `agent-parity`. You edit CLAUDE.md yourself, or ask me to.
  The docs agent must not.
- **`narrative-docs`** gets one line: when a capability changed, check
  that `docs/capabilities.md` was regenerated.

### 9.3 Agent eval suite (`pnpm agent:eval`)

Scenario prompts, each with a starting fixture and a **deterministic
grader over the resulting document** (structural checks, not LLM
judgment), for example:

- "duplicate slide 3 and change its title to X";
- "make every heading on this slide Inter Bold";
- "export to PDF";
- "insert deck B after slide 4 and restyle it to Contoso nh";
- "build a 10-slide Fabrikam deck from this brief".

For the last one the grader runs `query.check`: zero errors, all required
slots filled.

How they run: `pnpm agent:eval` runs against an already running local
stack (`pnpm dev`; as built in A1 the harness never starts it — planned here
as starting it), mints test tokens, and drives each scenario through
**headless Claude Code** (`claude -p` with only the Narrative MCP server
configured and ToolSearch on, so MCP tools are deferred as in a user's
session — since 2026-09-28, before that without ToolSearch and the whole
tool list on every request), then grades the resulting document. That
exercises the real MCP surface and the real playbooks, on the developer's
own Claude subscription; Narrative still needs no API key.

- They run on demand: before a release, and after any change to
  playbooks, prompts or tool descriptions.
- A small smoke subset replays recorded MCP tool-call transcripts
  against the commands in `pnpm -r test`, with no model involved.
- Every new command adds at least one scenario. The parity agent checks
  this.

## 10. Phases

Each phase ends green on the CLAUDE.md auto-run table and is a separately
releasable version.

Progress (2026-09-27): **A0 and A1 done**, released together as v0.10.0
(2026-09-27) — 94 commands (53 of
them also work on a component master), 39 known-missing entries (A2 32, A3 5,
A4 2), 18 allowlisted; all 69 server routes are claimed (route guard). At A0
close (2026-09-26) it was 50 commands, 81 known-missing (A1 42, A2 32, A3 5,
A4 2), 12 allowlisted. What A0 left for later is listed under
"Deviations" in
[`docs/handoff/A0-agentic-foundations.md`](../handoff/A0-agentic-foundations.md);
in short: the lint rule (A2), `useCommand()` wired into the UI (A2) and
shortcut / menu enumeration are not in place yet (all three done in A2: the lint rule from A2.1, `useCommand()` surface by surface, the action catalog in A2.13 on 2026-09-30). The eval suite is (A1:
`pnpm agent:eval`, 14 scenarios, 14/14 on 2026-09-27 and on 2026-09-28
with ToolSearch on; 11 replay free in
`pnpm -r test`). A1 handoff:
[`docs/handoff/A1-mcp-and-server-host.md`](../handoff/A1-mcp-and-server-host.md).
"Ends green" did not fully hold for A0: `pnpm size` (Tiptap chunk), the
real-deck PPTX round trip (5 differences) and Stryker (runner incompatible
with vitest 4) were already red at `4e3c503`.

| Phase                             | Deliverable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Notes                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A0 Foundations**                | ADRs (§11). zod schemas for every type in `shared`. `packages/commands` skeleton with `ops.apply`, BrowserHost, `useCommand`. `agentOrigin(runId)`. Fix the 5 origin-dropping nested transactions and the 2 writes caused by viewing. Add `textStyleId` to the schema. Fix the bugs the survey found: `duplicateObject` keeps `groupId`; `imageRect` is not moved by nudge, Inspector X/Y, align or distribute; the "Send back"/"Send backward" labels are swapped; merged-cell pointers are not shifted on row/col insert or delete; `stamp`/`promote` flatten rich text; videos in an appended .pptx are never transcoded. Wrap every existing headless slide-model mutation as a command. Parity test, allowlist and manifest wired up from day one (with a known-missing list that shrinks). `agent-parity` agent brief; repurpose the `ai-integration` brief to own the MCP surface and playbooks (and set it to Opus).                                                                                                   | No user-visible agent yet.                                                                                                                                                                                                                                                                                                                                                 |
| **A1 Server host, identity, MCP** | Personal access tokens: hashed, scoped, with expiry, created in account settings, accepted in `authPreHandler` and the tus upload handler (never on the WebSocket — agents write through the server host; security review 2026-09-27). ServerHost with single-transaction wrapping. Runs and changesets (`agent_runs` / `agent_ops`), `agent.revert`, the Agent activity popover. `activeSlideId` in awareness; `editor.context`, `editor.show`; the agent as an awareness peer. **Component commands the agent works with (§7.2 item 8):** `component.list`, `component.get` with the slot map, `component.stamp` with slot content, editing a master (the host opens `component:<id>`). `POST /api/commands` (batch). Rate limit (`@fastify/rate-limit`). **`/api/mcp`**: tools from the registry with annotations, elicitation for confirmations, the first playbooks as MCP prompts, and the `narrative` Claude Code skill as a plugin in this repo (`claude-plugin/narrative/`). Then MCP OAuth for claude.ai connectors. | **Done 2026-09-27.** MCP ships here, per the 2026-09-26 decision: Claude Code can drive Narrative with every command A0 wrapped. Security review (`security-reviewer`). Agent edits to a component master are runs like any other (listed and revertible in the master editor's Agent activity popover). `tools/list` compacted from 235 KB to ≈ 148 KB.                   |
| **A2 Extraction**                 | Move every web-only item in Appendix B into commands and switch the UI over. Turn the lint rule on per directory as each is migrated. Move **token seeding and text-style propagation to the server**: a Hocuspocus extension, or a command run on token update, so propagation reaches decks nobody has open. Add the notes API, `deck.duplicate`, `slide.copyTo` / `object.copyTo` (the clipboard becomes a thin UI over them), `text.set` with formatting, and `table.cell.setText` (not added, A2.10 2026-09-29: the text commands take `target.cell`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | **Done 2026-09-30** (A2.13; A2.1–A2.12a released in 0.10.2–0.10.14, A2.12b + A2.13 to ship as 0.10.15): no A2 known-missing entry, `ONE_DOOR_PENDING` empty, 129 commands. Plan and steps: `a2-extraction.md`; handoff `docs/handoff/A2-extraction.md`. The biggest phase. Each extracted command appears in MCP automatically. Done when the known-missing list is empty. |
| **A3 Render worker**              | Headless Chromium worker; `/render` route under the production CSP, reading the live document. Thumbnails for unopened decks. `deck.exportPng` (`deck.exportPdf` moved to A5, Petr 2026-10-10). `query.render` with single slide, contact sheet, region crop and before/after. Text-fit measurement API.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The agent can see what it built. Also three user-facing features apart from agents.                                                                                                                                                                                                                                                                                        |
| **A4 Style packs**                | Pack schema and validator. The slide-model changes in §7.2 (component provenance and slots, `component.create`, `component.restamp`). `style.pack.*` CRUD and the Style pack tab in Folder Settings. Packs served as MCP resources. **The pack compiler: a pack becomes folder tokens, folder fonts and its short list of components (pagination, headline, subline, copy, recurring column/grid); layouts stay pack data.** PPTX master/layout reader turning client masters into layout data (in the parser, so ordinary imports keep layouts too). Bootstrap Contoso, Fabrikam, Tailspin, Woodgrove and Adatum into their folders; upload their brand fonts. Deck-scoped font access for shared-deck editors. Pack-driven `query.check`. `style.deck.applyPack`, `slide.applyLayout`.                                                                                                                                                                                                                                                         | Visual target: the decks Woodgrove builds today.                                                                                                                                                                                                                                                                                                                               |
| **A5 Deck builder + restyle**     | Deck spec and `style.buildFromSpec`. The build playbook, modelled on `presentation-narrative-standard`, with the render-and-look loop. `style.slides.restyle` over `deck.insertFrom` (which already shipped in A1). The full eval suite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The "whole deck from a brief" goal.                                                                                                                                                                                                                                                                                                                                        |

A1 follow-up (2026-09-28, after v0.10.0, unreleased): `tools/list` compacted
further to ≈ 129 KB — field descriptions shared across tools said once in the
server instructions (`mcp/vocabulary.ts`), example calls only where the input
needs one, the confirmation procedure said once — and no dynamic toolsets.
Decision and measurements: the A1 handoff, "Known TODO".

A2 close (2026-09-30): A2.1–A2.13 done, A2 in `FINISHED_PHASES`. 129
commands (was 94 at A1 close), 7 known-missing entries (A3 5, A4 2), 20
allowlisted. The editor writes documents only through commands
(`ONE_DOOR_PENDING` empty), and the action catalog
(`apps/web/src/actions/catalog.ts`) closes guard 2's shortcut / menu
part. The tools/list budget rose from 132,000 to 189,000 bytes during A2
and gets one holistic review before the MCP work. Step log:
[`a2-extraction.md`](./a2-extraction.md); handoff:
[`docs/handoff/A2-extraction.md`](../handoff/A2-extraction.md).

## 11. ADRs to write

- **0010:** the command layer is the only writer (state = Yjs, written
  only through commands). The registry is the capability source of truth.
- **0011:** agent execution over MCP: the server host, origins,
  single-transaction server writes, runs and per-run revert,
  direct-by-default with opt-in propose-mode fork-and-delta, awareness
  presence and `editor.context`.
- **0012:** style packs: Narrative-owned packs bootstrapped from the AI
  Brain skills compile into folder tokens, fonts and a few recurring
  components; layouts stay pack data; slot and component provenance; the
  agent builds and restyles through tokens, layouts and those components,
  and uses components sparingly.
- **0013:** the render worker as the one server-side renderer
  (thumbnails, PDF/PNG, fit measurement), running under the production CSP.
- **Later, a known risk:** reorder by delete-plus-clone loses concurrent
  edits. A fractional-index order field fixes it but changes the model. Not
  a prerequisite; revisit if agent-heavy use shows lost edits.

## 12. Decisions (Petr, 2026-09-26)

1. **Fonts:** yes. Narrative may host Contoso Head/Text Office, Fabrikam Type and
   Northwind Sans ST Pro as folder fonts (§7.6).
2. **Autonomy:** the agent applies changes directly, for every kind of
   run. Propose mode stays as an opt-in (§6). Irreversible commands still
   ask.
3. **MCP:** now, and it is the only agent surface. It ships in A1, right
   after the foundations, and grows with every command A2 extracts (§10).
4. **Style packs:** the skill library are inspiration only. The goal is
   that the visual Woodgrove uses today works in Narrative too; after
   bootstrap, packs are owned and edited in Narrative, and Narrative's own
   playbooks and skill become how decks are built (§7.3).
5. **Model cost:** none for Narrative. The model runs in the user's
   Claude client (Claude Code or claude.ai), which the user already pays
   for.
6. **Numbering:** this plan replaces the AI milestones in BUILD_PLAN, with
   phases A0–A5.
7. **In-app agent:** not needed now; MCP is enough (§13).
8. **Screenshots:** the agent screenshots slides and looks at them
   (`query.render`, §4.6), and the playbooks make it look after every
   visible change.
9. **Locks are editor-only.** `locked` stops canvas drag, resize, nudge
   and delete for a person; commands and agents ignore it.
10. **Styles become Narrative tokens and a few components; templates stay
    data.** A pack compiles into folder tokens, fonts and only the
    components that recur (pagination, headline, subline, copy, a repeated
    column/grid). Templates stay layout records in the pack, however many
    there are — 100 templates must not become 100 components. The agent
    uses the existing components, and proposes a new one only for a block
    that repeats or when asked (§7).

## 13. Deferred: an in-app agent

A chat panel inside the editor, running the model on Narrative's server,
was considered and deferred on 2026-09-26. Recorded here so it is not
re-derived from scratch.

**What it would add over MCP:**

- people without a Claude client could use an agent;
- "select something and ask" without naming it;
- agent steps undoable with Mod+Z, because the agent would execute in the
  browser (BrowserHost with `agentOrigin`, tracked by the editor's
  UndoManager with `stopCapturing()` between agent actions).

**What it would cost:**

- an Anthropic API key on the server, and a bill: roughly $0.02–0.10 per
  small edit and $2–8 per whole deck on `claude-opus-5`, an unmeasured
  estimate;
- an agent runtime in `apps/server/src/agent/` on the TypeScript SDK Tool
  Runner, with streaming over SSE, prompt caching, tool search over the
  registry, BullMQ for long runs, cost logging and a daily cap;
- the chat panel UI.

**Why it is cheap to add later:** it would reuse the registry, the
playbooks, the render worker and the style packs unchanged. Nothing in
A0–A5 has to be built differently to keep the door open.

---

## Appendix A: inventory → command mapping

Source: capability inventory, 2026-09-26, sections B1–B14. Layer codes
say where the logic lives today:

- **SM:** a slide-model mutation, already headless.
- **SRV:** an HTTP route.
- **WEB:** logic in React/web code; must be extracted.
- **REND:** needs the renderer or a browser.

**Slides (B1)**

| Capability                     | Today                | Command                                              |
| ------------------------------ | -------------------- | ---------------------------------------------------- |
| add slide                      | SM `addSlide`        | `slide.add`                                          |
| duplicate slide(s)             | SM + WEB ordering    | `slide.duplicate` (multi, ordered)                   |
| delete slide(s)                | SM + WEB next-active | `slide.delete` (returns suggested next)              |
| reorder / move block           | SM + WEB drag rules  | `slide.move`, `slide.moveBlock` (depth rules inside) |
| indent / outdent               | SM + WEB depth cap   | `slide.indent` (cap inside)                          |
| collapse                       | SM                   | `slide.collapse`                                     |
| skip                           | SM                   | `slide.skip`                                         |
| rename                         | SM                   | `slide.rename`                                       |
| transition                     | SM                   | `slide.setTransition` (+ clearing `direction`)       |
| background                     | SM + WEB defaults    | `slide.setBackground` (defaults inside)              |
| copy/paste slides, cross-deck  | WEB clipboard        | `slide.copyTo` (keeps name, notes, indent, skip)     |
| speaker notes                  | WEB Tiptap           | `slide.notes.get/set` (markdown)                     |
| read slides / number / observe | SM                   | `query.slide`, `query.outline`                       |
| insert .pptx at N              | SRV                  | `deck.insertFrom`                                    |

**Objects (B2)**

| Capability                    | Today                   | Command                                                      |
| ----------------------------- | ----------------------- | ------------------------------------------------------------ |
| create shape / text           | SM + WEB defaults       | `object.create` (per-type defaults, folder Primary colour)   |
| pen path                      | WEB                     | `object.path.create` (anchors in, bbox normalised)           |
| shape → path                  | WEB                     | `object.path.fromShape`                                      |
| edit anchors / line endpoints | WEB                     | `object.path.setAnchors`, `object.line.setEndpoints`         |
| insert table                  | SM + WEB sizing         | `table.insert`                                               |
| insert image/video            | SRV + WEB placement     | `media.upload` + `image.insert` / `video.insert`             |
| delete                        | SM (orphans animations) | `object.delete` (removes its animations)                     |
| update property               | SM, unvalidated         | `object.update` (zod-validated)                              |
| rename                        | SM + WEB uniqueness     | `object.rename`                                              |
| lock                          | SM                      | `object.lock`                                                |
| hide                          | not implemented         | — (becomes a command when the feature ships)                 |
| page number                   | SM + WEB flow           | `object.slideNumber.set` (+ style/component choice as input) |

**Geometry, arrangement, grouping (B3)**

| Capability                    | Today            | Command                                                      |
| ----------------------------- | ---------------- | ------------------------------------------------------------ |
| move / nudge                  | WEB              | `object.move` (moves `imageRect` too)                        |
| numeric X/Y/W/H, aspect       | SM + WEB ratio   | `object.resize` / `object.update`                            |
| resize with handles           | WEB              | `object.resize` (anchor, aspect, group resize)               |
| rotate                        | WEB + SM         | `object.rotate` (degrees in, radians stored)                 |
| flip                          | WEB rule         | `object.flip`                                                |
| align to each other           | SM               | `object.align`                                               |
| align to slide                | WEB              | `object.alignToSlide`                                        |
| distribute                    | SM               | `object.distribute`                                          |
| layer order                   | SM               | `object.layer` (front, back, forward, backward, toIndex)     |
| group / ungroup               | SM               | `object.group` / `object.ungroup`                            |
| duplicate / Alt-drag          | SM (groupId bug) | `object.duplicate` (group remap, optional animations)        |
| mask                          | SM               | `object.mask.apply` / `object.mask.remove`                   |
| crop                          | WEB              | `object.crop.set` / `object.crop.reset`                      |
| snapping                      | WEB (pure)       | used inside `object.move` and `object.resize` (`snap: true`) |
| guides                        | SM               | `guide.*`                                                    |
| zoom / pan / stage background | UI               | allowlisted (view state)                                     |

**Fills, strokes, effects, links (B4)**

| Capability             | Today             | Command                                                                |
| ---------------------- | ----------------- | ---------------------------------------------------------------------- |
| solid fill / no colour | SM + WEB rule     | `object.fill.solid` (`none` → alpha 0)                                 |
| token link / unlink    | SM + WEB resolve  | `object.fill.token` / `object.fill.unlinkToken`                        |
| gradients              | SM + WEB defaults | `object.fill.gradient` (+ radial centre and radius)                    |
| image fill             | SRV + SM          | `object.fill.image`                                                    |
| stroke                 | SM + WEB default  | `object.stroke.set`                                                    |
| line caps              | SM                | `object.stroke.set` (`startCap` / `endCap`)                            |
| corner radius          | SM + WEB clamp    | `object.update` (clamped in schema)                                    |
| opacity                | SM                | `object.update`                                                        |
| shadow / blur          | SM + WEB defaults | `object.effects.shadow` / `object.effects.blur`                        |
| hyperlink              | SM                | `object.hyperlink.set` / `object.hyperlink.clear` (sanitised on write) |

**Text (B5)**

| Capability                         | Today              | Command                                                                                                                                                                                                                                                  |
| ---------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| type or replace text               | SM                 | `text.set`; `text.edit` (A2.11: splices at query offsets, and the editor's Enter / Backspace list rules — the canvas editor types through it; not in the original catalogue); `text.replace` (A2.11: deck, slide or objects, text boxes and table cells) |
| inline format on a range           | SM + WEB targeting | `text.format` (A0: `set` and `clear` in one command, ranges by offset or match; planned as `text.formatRange` / `text.clearFormat`)                                                                                                                      |
| box typography                     | SM + WEB routing   | `text.setBoxTypography` (A2.11: removes the inline formatting it would hide, keeps the weight on a cut the new family has, fields become overrides on a box linked to a text style); tables through `table.style.table`                                  |
| lists                              | SM + WEB rules     | `text.list` (one command: `kind` / `toggle` / `level` / `indent` / `bulletChar` / `numberFormat` / `startAt`; planned as `text.list.*`)                                                                                                                  |
| apply / detach / reset preset      | WEB                | `text.style.apply` (A2.11, by id or name, text boxes and tables' defaults): `style: null` detaches, `reset: true` resets (planned as `text.style.apply` / `detach` / `reset`)                                                                            |
| update / create preset from object | WEB                | `text.style.createFromObject` / `token.textStyle.update` — A2.12, known-missing (planned as `text.style.updateFromObject` / `createFromObject`); the Inspector's Preset picker still writes through FolderDocProvider                                    |
| token propagation                  | WEB (critical)     | server-side propagation on `token.textStyle.update` (A2.12)                                                                                                                                                                                              |
| available fonts                    | WEB list           | `folder.fonts.list` (A1, server); since A2.11 commands that need a folder's font faces declare `readsFolderFonts` and read `ctx.folderFonts` (server: the folder's font assets) — no `query.fonts`                                                       |

**Tables (B6)**

| Capability                 | Today            | Command                                                                                        |
| -------------------------- | ---------------- | ---------------------------------------------------------------------------------------------- |
| rows / cols                | SM (merge bug)   | `table.row.*`, `table.col.*`, `table.setSize` (A2.10)                                          |
| resize track               | SM + WEB         | `table.resizeColumn` / `table.resizeRow` with `keepTableSize` (planned as `table.resizeTrack`) |
| merge / split              | SM               | `table.merge` / `table.split`                                                                  |
| cell text                  | SM low-level     | `text.set` / `text.format` / `text.list` with `target.cell` (planned as `table.cell.setText`)  |
| cell / range / table style | SM + WEB routing | `table.style.cell` / `range` / `table`; `table.style.table` `overrideCells` (A2.10)            |
| cell / table gradient      | WEB              | `object.fill.gradient` on a table, whole or `cells` (A2.10)                                    |
| borders                    | SM               | `table.border.preset` / `table.border.segment`                                                 |

As built (A2.10, 2026-09-29): the track resize shipped in A0 as two
commands, `table.resizeColumn` / `table.resizeRow`, never as
`table.resizeTrack`; `table.cell.setText` was deliberately not added, because
the text commands have addressed a cell (`target.cell`) since A0 (`9e0e853`) and a second
command for the same write would only split the agent's choice. The
Inspector's range / cell / table routing stays in the editor: it follows the
editor's selection, which an agent names itself. Decisions:
[`a2-extraction.md`](./a2-extraction.md), the A2.10 entry.

**Animations (B7)**

| Capability    | Today             | Command                                   |
| ------------- | ----------------- | ----------------------------------------- |
| add step      | SM + WEB defaults | `animation.add` (defaults inside)         |
| edit step     | SM                | `animation.update`                        |
| reorder       | SM + WEB layout   | `animation.reorder`; `animation.retime`   |
| remove        | SM                | `animation.remove`                        |
| retarget      | missing           | `animation.retarget`                      |
| moveTo target | SM                | `animation.update` params (A2.9)          |
| video timing  | SM                | `object.update` videoTrigger/Delay (A2.9) |
| preview       | REND              | `query.render` (frame sampling later)     |

**Clipboard (B8):** objects → `object.copyTo`; slides → `slide.copyTo`.

**Components (B9)**

| Capability             | Today                      | Command                                |
| ---------------------- | -------------------------- | -------------------------------------- |
| promote                | SM plan + SRV + WEB + REND | `component.promote`                    |
| stamp                  | SM                         | `component.stamp`                      |
| edit master            | SM                         | `component.master.*`                   |
| list / rename / delete | SRV                        | `component.list` / `rename` / `delete` |

As built (A2.12b, 2026-09-30, unreleased at the time): `component.promote`
runs on the server (`POST /decks/:id/promote-component`, slide-model
`writeComponentMaster`), and the browser's `writeComponentMasterTree` is
gone. `component.stamp` stages the master's media in `load`, and the editor
reaches it through `POST /decks/:id/stamp-component`. Pasting between a
master and a deck is `object.insertFromDeck` (`fromComponent`, or a master
target). A component owns its pictures and videos, which are copied
whenever they cross an owner ([ADR 0012](../adr/0012-component-owned-media.md)).
Decisions: [`a2-extraction.md`](./a2-extraction.md), the A2.12b entry.

**Folder design system (B10)**

| Capability    | Today                                       | Command                                             |
| ------------- | ------------------------------------------- | --------------------------------------------------- |
| seed defaults | WEB                                         | `token.seedDefaults` (server, on folder create)     |
| colour tokens | WEB                                         | `token.color.*` (24 cap in schema)                  |
| text styles   | WEB                                         | `token.textStyle.*` (+ replace-or-detach on delete) |
| usages        | SRV (misses shadows, tables, `textStyleId`) | `token.usages` (scanner fixed)                      |
| fonts         | SRV                                         | `folder.fonts.*`                                    |

**Folders and decks (B11)**

| Capability           | Today                    | Command                                                            |
| -------------------- | ------------------------ | ------------------------------------------------------------------ |
| folders CRUD         | SRV                      | `folder.*`                                                         |
| decks CRUD           | SRV                      | `deck.*` (create also hydrates the document)                       |
| move decks           | SRV (no token rebinding) | `deck.moveToFolder` (rebinds tokens)                               |
| duplicate deck       | missing                  | `deck.duplicate`                                                   |
| import / export pptx | SRV                      | `deck.importPptx` / `deck.exportPptx` (from live state, not saved) |
| thumbnail            | REND                     | `deck.refreshThumbnail` (render worker)                            |
| PDF / PNG            | missing                  | `deck.exportPdf` / `deck.exportPng`                                |
| active editors       | SRV                      | `deck.activeEditors`                                               |

**Sharing (B12):** `share.*`. Every command is marked irreversible and
requires confirmation.

**Present mode (B13):** `editor.present.link` (new `?slide=N`). Navigation,
fullscreen and the presenter window are allowlisted as human runtime.

**Media (B14):** `media.*` (`media.upload` accepts a URL, behind an SSRF
guard).

## Appendix B: web-only logic to extract (A2 checklist)

1. Object creation defaults and placement: `EditorLayout`, `Toolbar`,
   `EditorContextMenu`, `UploadDropZone`, `useDefaultObjectFill`.
2. Path geometry: pen commit, shape → path, anchor editing, line
   endpoints.
3. Transforms: move and nudge with `imageRect`, resize, rotate, group
   resize, aspect, flip, align to slide, Inspector ratio math, snapping
   (`editor/snap.ts` is already pure).
4. Clipboard for objects and slides: rich-text save, new ids, group remap,
   offsets.
5. Duplicate with group remap and optional animation copy.
6. Text:
   - range, box or clear routing;
   - which paragraphs a list change hits;
   - the Enter/Tab/Backspace list rules;
   - apply/reset/update/create a preset;
   - override tracking;
   - the page-number flow;
   - **token propagation**.
7. Fill and background starting values: gradient stops, stop insertion,
   token unlink, "no colour", stroke default, radius clamp, shadow and blur
   defaults.
8. Table logic: range/cell/defaults routing, table-wide fill, row and
   column count loops, reading border presets, Tab adding a row, track
   resize.
9. Animation defaults, `layoutSteps`, turning a drag into trigger and delay
   values, the onEnter migration (made explicit, never written on view).
10. Slide rules: next active slide after delete, outline drag and indent
    rules, duplicate ordering.
11. Components: master write, thumbnail, stamp placement.
12. Folder tokens: CRUD, seeding, migrations.
13. Speaker notes as text or markdown.
14. Validation: name uniqueness per slide, the 24-colour cap, the maximum
    slide depth.
15. Thumbnails, PNG and PDF: render worker (A3).
