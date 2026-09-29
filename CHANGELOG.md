# Changelog

All notable changes to Narrative follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

---

## Unreleased

### Changed

- **A triangle fills its box, as in PowerPoint.** Narrative drew a triangle
  inscribed in its box's ellipse (base at three quarters of the height,
  87 % of the width), while PowerPoint's triangle — which Narrative imports
  and exports it as — runs from the top centre to both bottom corners, so an
  imported triangle looked smaller than in PowerPoint. Canvas, thumbnails,
  image masks, the drawing preview and "Edit Object" (shape to path) now
  draw the box-filling triangle. Existing triangles keep their box and grow
  inside it to fill it. Regular polygons are unchanged.

### Internal

- One outline definition for triangles and regular polygons
  (`@narrative/shared` `shapeGeometry.ts`) replaces five copies in the
  renderer, the image mask, the drawing preview, `shapeOutline` and the
  PPTX writer; a sampled-thumbnail e2e pins the triangle's bottom corners.

## 0.10.11 — Gradients, shadows and page numbers through commands (2026-09-29)

### Added

- **Agents can give shapes a gradient, objects a shadow, and turn a text
  box into the page number** — with the editor's rules:
  - `object.fill.gradient` — linear or radial; without explicit stops a new
    gradient starts from the shape's own colour and a darker tint of it,
    and an existing one keeps its colours when only the kind, angle or
    centre changes;
  - `object.effects.shadow` — switches on the editor's default shadow, or
    merges the given fields into the current one; `null` removes it;
  - `object.slideNumber.set` — the live slide number, optionally with the
    folder's "Footnotes and pages" text style linked and applied.

### Changed

- **Switching a gradient between Linear and Radial keeps its colours**
  instead of starting over from the solid fill.

### Fixed

- **"Apply Footnotes and pages text style" in the page-number dialog**
  applied only part of the style and stored its colour in a form the style
  link did not use; it now applies the style exactly as editing the style
  does (paragraph spacing and "none" transforms included).
- **A gradient started from a fill linked to a folder colour began from
  white**; it now starts from that colour.
- **Picking two fill types in quick succession could leave the first one
  applied** (Linear, then Solid before the editor redrew).

### Internal

- A2.8: commands can read the target folder's design tokens
  (`CommandContext.folderTokens`, `readsFolderTokens`): the editor passes
  its synced folder snapshot, the server reads the folder document for the
  commands that need it (agent/folderTokens.ts), also inside `ops.apply`.
- One text-style mapping (commands `text/textStyle.ts`) for style
  propagation and the commands that link a style.
- The Claude Code plugin's version is the Narrative release (generated with
  the skill), so `/plugin update narrative` fetches each release's skill.
- Eval scenarios `badge-gradient`, `card-soft-shadow`,
  `footer-page-number`; e2e `inspector-appearance-commands`.
- MCP tools/list budget 159,000 → 164,000 bytes.

---

## 0.10.10 — Agents upload local files; snapping can be switched off (2026-09-29)

### Added

- **`media.uploadSession`: an agent with a shell uploads a local picture,
  video or font** without writing its bytes through the model (which only
  worked for tiny files as base64). It gets a one-time token and a ready
  `curl` command that sends the file in one request to the tus upload the
  editor uses; the answer carries the asset id. The token is stored only as
  a hash, works for one upload into one deck for 15 minutes (2 hours to
  finish a started one), authenticates nothing but that upload, and is
  redacted in the agent audit log. The agent names the file's size when it
  asks, and the token then takes exactly that file. The `basics` playbook
  points agents at it for local files.
- **Snapping can be switched off**: a magnet toggle next to the rulers
  button in the toolbar (on by default, remembered per browser). Holding
  ⌘ (macOS) / Ctrl during a drag or a resize inverts it for as long as it
  is held — with snapping on the object moves freely, with it off it snaps.
  "Free" means no snapping at all: not to other objects, not to guides and
  not to the 10 px grid the drag used to fall back to; a free move stays on
  whole slide pixels. The keyboard-shortcuts cheatsheet (Mod+/) lists the
  drag modifiers in a new "While dragging" section.

### Changed

- **Drag modifiers act without moving the mouse**: pressing or releasing
  Shift or ⌘ / Ctrl mid-drag re-applies the frame at once instead of on the
  next pointer move.

### Security

- **An upload token uploads exactly the declared file**: its size and kind
  are fixed when it is issued; a different size, another kind, a deferred
  length, a GET of the upload, or HEAD / PATCH / DELETE of any other upload
  are refused.
- **Revoking an access token or an MCP connection ends its upload
  sessions**, and so does the account kill switch; a user holds at most 10
  unused ones.
- **An agent's upload must prove its type** (image signature or readable
  dimensions, video container signature, a font that parses); sizes are
  capped per kind before any byte is read.
- **The collaboration WebSocket refuses every agent credential**, not only
  personal access tokens (MCP OAuth tokens and codes, upload tokens).
- **Every credential format is masked** in error reports, the agent audit
  log and the agent eval's recordings and reports.
- **The server refuses to start with a non-https PUBLIC_API_URL** (except
  localhost / 127.0.0.1 / [::1]): bearer tokens travel to it.

### Internal

- A2.7a: `upload_sessions` table (migration 0024), media/uploadSessions.ts,
  tus accepts `nus_` bearers (claim-once, deck-bound, media-only);
  `MediaService.openUploadSession`; the public API base (PUBLIC_API_URL)
  reaches the services. The agent eval harness can give a scenario files
  and a shell (`workspace`); new scenario `local-logo-upload`, e2e spec
  `agent-upload-session` runs the returned curl line for real.
- Migration 0025 binds an upload session to its credential, size and
  kind; the credential key reaches command handlers
  (`AgentSessionInfo.credential`); auth/credentialPatterns.ts lists every
  credential prefix for the scrubbers and the WebSocket. The eval shell is
  `curl` and `wc` only.
- Snapping: `SnappingContext` (toggle, per-browser), `useDragModifierReplay`
  re-applies a drag frame when Shift or ⌘ / Ctrl changes; the toggle is on
  the parity allowlist (a view preference, not a document write).
- MCP tools/list budget 157,000 → 159,000 bytes.

---

## 0.10.9 — Copy and paste objects through commands (2026-09-28)

### Added

- **Agents can copy objects between slides and decks**:
  - `object.copyTo` — an exact copy of objects onto another slide of the
    deck (formatted text, tables, crops), placed by `offset` or with their
    combined box centred `at` a point.
  - `object.insert` — objects from their JSON, exactly as `query.slide` /
    `query.object` return them, validated like `object.create`: read
    anything, recreate it elsewhere.
  - `object.insertFromDeck` — the same for objects read from another deck:
    the pictures, videos and fonts they use are copied into this deck,
    tokens rebound across folders, links to the other deck's slides removed.

### Fixed

- **An image pasted into another deck showed a broken picture**: the paste
  kept the source deck's asset, which the target deck cannot load (media is
  deck-scoped). Pasting into another deck now copies the picture — and any
  video or font the objects use — into that deck, and rebinds colour and
  text-style tokens when the decks are in different folders.
- **"Paste" from the canvas menu put the objects far off from where you
  clicked** (their old position plus the click point); the pasted block is
  now centred on the point.
- **Pasting did not move a cropped image's crop with it**, so a pasted
  picture showed another part of the image.

### Changed

- The object clipboard keeps both what was copied and how it read: a copy
  pastes as an exact copy of the live objects while they exist (so an edit
  made after copying is pasted too); after a cut (or once they are deleted)
  it pastes what was copied. A paste that cannot be done now says why, over
  the canvas.
- Cutting objects that could not be pasted back (some imported ones hold
  values outside today's rules, e.g. a gradient with more than 10 stops) is
  refused with a message — copy them instead — rather than deleting them.
- A paste into another deck is done by the server, like pasting slides
  there: Mod+Z in the target deck does not undo it (delete the objects).
- Known limit: pictures pasted between a component master and a deck are
  not copied across (they stay the source's); components move onto the
  server in A2.12.

### Internal

- A2.7: copy, cut and paste on the canvas dispatch `object.copyTo` /
  `object.insert`, or call `POST /decks/:id/insert-objects` across decks;
  `EditorLayout` and `EditorContextMenu` are off the one-door exemption list
  (15 files left). New slide-model writer `copyObjectsTo` (duplicate is a
  copy onto the same slide); the server's slide-copy staging
  (`rewriteForTarget`: links, media, fonts, tokens) serves object inserts
  too. Clipboard entries from before this version are ignored.
- MCP tools/list budget 152,000 → 157,000 bytes; agent-eval scenarios
  `objects-copy-to-slide` and `objects-from-other-deck`; an
  `object-clipboard` e2e spec.

---

## 0.10.8 — Paths and lines are commands (2026-09-28)

### Added

- **Agents can draw and reshape paths and move line ends**, with points
  given in slide pixels — where they are drawn — whatever the object's
  rotation or mirroring:
  - `object.path.create` — a free-form path through anchors (the pen tool).
  - `object.path.fromShape` — a rectangle (rounded corners included),
    ellipse, triangle or polygon becomes a path with the same outline, as
    the same object.
  - `object.path.setAnchors` — move chosen points by index (the rest stay
    where they are drawn) or replace them all; the box is refitted.
  - `object.line.setEndpoints` — move a line's or arrow's start and/or end.
- **Ellipses can be edited point by point** too: double-click one, like a
  rectangle.

### Fixed

- **The end handles of a rotated or mirrored line sat off the line**, and
  dragging one moved the wrong point. They now sit on the drawn ends and a
  drag moves that end under the cursor. The point editor's handles were off
  the same way on a mirrored path.
- **Double-clicking a shape to edit its points replaced it with a new object
  on top of the slide**: it lost its place in the stacking order, its
  animations and Magic Move pairing, its gradient or image fill, shadow,
  blur and link, and rounded corners became square. It now stays the same
  object with all of those, rounded corners traced as arcs.
- **An object replaced in place did not update on screen** until a reload —
  a collaborator's shape-to-path conversion, for example. The slide
  observer took any delete + insert of one id for a reorder and only
  re-drew it when the order changed. (Replaced and then deleted in the same
  moment, it also stayed on screen as a ghost.)
- **A path's box now fits the curve it draws**, not its bezier handles: a
  drawn S-curve used to get a selection box several times taller than the
  stroke, which also threw off alignment and centring. Paths get the tight
  box whenever they are drawn or their points are edited.
- **Converting a triangle to a path made it bigger**: the canvas draws a
  triangle inscribed in its box's ellipse, the conversion traced the whole
  box. It now traces the triangle you see.
- **A mirrored line or arrow exported to PowerPoint pointing the other
  way.** The connector now goes out in the direction it is drawn (and comes
  back into Narrative exactly as it was).

### Internal

- A2.6: the pen, the point editor, the line end handles and shape-to-path
  conversion dispatch the new commands; `PathPointsOverlay` and
  `LineEndpointHandles` are off the one-door exemption list (17 files
  left). Placement math (rotation + mirroring, fitting a box around slide
  points, shape outlines) lives in `packages/commands/src/geometry.ts`;
  `replaceObject` in slide-model swaps an object under its id and index.
- MCP tools/list budget 142,000 → 152,000 bytes; three new agent-eval
  scenarios (`pen-triangle-path`, `shape-corner-to-path`, `line-end-move`)
  and a `path-editing` e2e spec; the `edit` playbook maps drawing and
  reshaping onto the new commands.

---

## 0.10.7 — Transforms are commands (2026-09-28)

### Added

- **Agents can resize, rotate, flip, align to the slide and crop** with five
  new commands, carrying the rules the editor applies so a handle drag and
  an agent's request land on the same result:
  - `object.resize` — a new width / height with an anchor that stays put
    (along the object's own, possibly rotated axes), or an exact box;
    `keepAspect`; a cropped picture scales with its frame.
  - `object.rotate` — degrees, absolute or `relative`.
  - `object.flip` — mirrors in place: toggles `flipH` / `flipV` and negates
    the rotation, like the editor's Flip buttons.
  - `object.alignToSlide` — an edge or the centre of the slide, several
    objects as one block, measured on the visible (rotated) outline.
  - `object.crop.set` — place, pan, zoom or turn the picture inside its
    frame, frame-relative, or reset the crop.
- The `basics` and `edit` playbooks point agents at the transform commands.

### Fixed

- **Resizing a path did not change the drawing**, only its selection box:
  paths (pen drawings, imported PowerPoint shapes) draw from their anchor
  points, which a resize never scaled. A resize now scales the anchors and
  their curve handles; a line or arrow scales its end points (stroke width
  stays). This also makes the Inspector's Width / Height work on lines and
  arrows.
- **"Reset crop" left a turned picture turned**; it now also straightens
  the picture, like resetting from crop mode. "Reset crop" and "Remove shape
  mask" now go through `object.crop.set` / `object.mask.remove`.

### Changed

- **Inspector Width / Height on a cropped image now scale the crop with the
  frame**, as dragging a resize handle always did (they used to trim the
  picture instead). On a rotated object they keep its top-left corner in
  place along the object's own axes instead of shifting it.
- **Inspector alignment to the slide aligns what you see**: a rotated
  object's rotated outline touches the edge (it used to be its unrotated
  box).
- **Entering crop mode no longer writes to the document.** An image that
  fills its frame used to get an explicit crop on entry, which put an empty
  step on the undo stack; the crop now becomes explicit only when the frame
  actually moves or resizes.

### Internal

- A2.5: the transform handles, the crop overlay, dragging objects on the
  canvas, and the Inspector's position, size, rotation, flip, alignment,
  layer order, layers panel and multi-select actions (align, distribute,
  group, ungroup, mask with shape) dispatch commands. The resize math lives
  in `packages/commands/src/geometry.ts`, shared by the handles and
  `object.resize`. `TransformHandles` and `CropOverlay` are off the one-door
  exemption list and the `state/applyShapeMask.ts` re-export is gone (19
  files left; the Inspector is re-tagged A2.11).
- Missing hook dependencies in the canvas pointer handlers (`command`,
  `isViewer`, the object defaults) added.
- MCP tools/list budget 136,000 → 142,000 bytes; four new agent-eval
  scenarios (`photo-resize-centered`, `photo-crop-zoom`,
  `badge-rotate-align`, `shape-flip-in-place`).

---

## 0.10.6 — Creating and arranging objects writes through commands (2026-09-28)

### Internal

- A2.4: creating objects (drawing with a tool, Insert from the canvas menu,
  the table picker, uploaded and dropped images and videos), deleting,
  duplicating (Mod+D, the menu, Alt-drag), grouping, layer order, arrow-key
  nudges, lock, mask-with-shape, the canvas menu's table row / column /
  merge / split actions and the video preview's mute toggle now dispatch
  the same commands agents use (`object.*`, `table.*`). No change in
  behaviour intended; `EditorVideoPreview` is off the one-door exemption
  list, the rest are re-tagged with the step that removes their last
  direct write (22 files left).

---

## 0.10.5 — Guides write through commands (2026-09-28)

### Fixed

- **"Delete guide" in a guide's right-click menu did nothing when clicked**
  (the keyboard worked). The menu renders in a portal, but React bubbled its
  pointer events up to the guide line — which started a drag — and on to
  the canvas, which captured the pointer so the item never got its click.
  The menu now keeps its pointer events to itself.

### Internal

- A2.3: the rulers and guide lines write only through `guide.add`,
  `guide.update` and `guide.remove` (the commands agents use); dragged
  positions are clamped to the slide; `useDeckGuides` is read-only. Off the
  one-door exemption list (23 files left).
- New e2e `guides.spec.ts`: drag a guide out of each ruler, move it, drag it
  off the slide, delete one from its menu — read back from the document.

---

## 0.10.4 — Connecting Claude Code over OAuth, really (2026-09-28)

### Fixed

- **Allow on the MCP consent page still failed after 0.10.3.** The page
  also sets its referrer policy in `<meta name="referrer">`, which overrides
  the HTTP header 0.10.3 changed, so Chrome kept posting the form with
  `Origin: null` (Caddy's access log of the failed attempts). The meta tag
  now says `same-origin` on the consent page (every other OAuth page keeps
  `no-referrer`); a refused decision now logs the origin it came from.
- **The consent page showed "[email protected]"** instead of your address:
  Cloudflare's Email Obfuscation rewrote it and the page's CSP blocked the
  decoding script. The address is now marked `email_off`.
- New e2e spec `mcp-oauth-consent`: the whole authorize → consent → Allow →
  callback flow in a real browser, with Claude Code's own client metadata.
  It does not reproduce the production failure (headless Chrome on the dev
  stack sent the real origin even under the old meta tag).

---

## 0.10.3 — Connecting Claude Code over OAuth works (2026-09-28)

### Fixed

- **Approving an MCP connection answered "This request did not come from
  Narrative."** The consent page sent `Referrer-Policy: no-referrer`, under
  which a browser posts the page's own form with `Origin: null`, and the
  decision endpoint refuses an opaque origin. Every Claude Code / claude.ai
  connection over OAuth failed at the Allow button; the tests set the
  `Origin` header themselves and never saw it. The consent page now uses
  `same-origin` (the Referer still never leaves Narrative), and the tests pin
  both the header and the refusal of `Origin: null`. The console's CSP
  errors on the error page were Cloudflare's injected beacon and fonts,
  blocked as intended.

---

## 0.10.2 — The slides panel writes through commands (2026-09-28)

First steps of phase A2 (`docs/plans/a2-extraction.md`): the editor stops
writing the document directly and dispatches the same commands agents use.

### Added

- **Duplicate a deck.** The deck menu in a folder has _Duplicate_: a new deck
  of yours with every slide, the speaker notes, the guides, the preview and
  the media the slides show (copied, since media belongs to one deck). It
  lands next to the original when you own the folder, else in Drafts.
  Agents: `deck.duplicate`; API: `POST /decks/:id/duplicate`.
- **Speaker notes for agents.** `slide.notes.get` reads a slide's notes as
  Markdown with their formatting, `slide.notes.set` replaces them (headings,
  nested lists, quotes, code, bold/italic/strike/underline, links; a newline
  is a line break). The notes model moved from the PowerPoint module into
  slide-model (`setSlideNotes`, `getSlideNotesDoc`).
- **`slide.copyTo`**: copy slides as a block to a position in the same deck,
  keeping object ids (Magic Move) and fitting their outline levels.
- `deck.insertFrom` takes exactly the chosen slides of another deck
  (`source: { deckId, slides: [...] }`) as well as a range.

### Changed

- **Pasting slides into another deck brings their images along.** A pasted
  slide used to keep the source deck's asset ids; media is deck-scoped, so
  its images and videos showed broken in the target. Paste now copies the
  slides on the server (`POST /decks/:id/insert-slides`, the service behind
  `deck.insertFrom`): media is copied into the target deck, token references
  are rebound across folders, links to slides that came along follow them.
  Copying slides out of a deck needs editor access to it, as exporting does.
  Pasting within one deck is one undo step (`slide.copyTo`) and now keeps
  notes, name and outline level, which the old paste dropped.
- The slide clipboard holds which slides of which deck were copied, not a
  copy of their content: a paste takes the slides as they are when pasted.
  A clipboard from an earlier version is ignored.
- **Every slides-panel gesture is a command**: add, duplicate (a multi-slide
  duplicate is one undo step), delete (lands on the slide `slide.delete`
  names), rename, skip, collapse, and the drag, which moves the block and
  shifts its outline levels in one `slide.move`. Moving, deleting, copying
  and re-indenting slides now keeps the outline well formed (no slide more
  than one level below the slide above it), whoever does it.
- A right-click on another slide while the slide menu is open retargets the
  menu to that slide.
- Two `.pptx` files dropped at the same gap land in drop order (the second
  used to take the first's original index and land above it).
- The MCP tool list budget is 136,000 bytes (was 132,000) for the four new
  tools.

### Internal

- **One-door lint rule** (`apps/web/eslint.one-door.js`): no slide-model
  writer import and no `.transact(` anywhere in `apps/web/src`, generated
  from the parity table. Files not migrated yet are on a list that may only
  shrink (24 files, each with the A2 step that migrates it; a test fails when
  a listed file no longer needs its exemption). It already caught a web
  module re-exporting the `applyShapeMask` writer.
- `useCommand()` gains `tryRun` (a collaborator's race is logged, not
  thrown) and `group` (several commands as one transaction and one undo
  step, without the fork an atomic batch makes); `runGroup` in the runner.
- Outline rules live in `packages/commands/src/outline.ts`; the panel's drag
  preview uses them too (it used to index the list without the dragged
  slides by a position counted with them).
- `PLAYWRIGHT_CHROME_EXECUTABLE` works: the path is now a launch option
  (`use.executablePath` was silently ignored).
- Node ≥ 22.18 (the ESLint config imports the TypeScript parity table
  directly, which needs Node's type stripping).
- Viewing a slide never writes any more: `getSlideNotes` installed an empty
  notes fragment on slides from before the notes editor when they were
  merely looked at (viewers too). It is replaced by the read-only
  `getSlideNotesFragment`; on such a slide the notes panel offers _Add
  speaker notes_, which runs `slide.notes.set`. The PowerPoint import and
  export use `setSlideNotes` / `getSlideNotesDoc`, and
  `writeNotesIntoFragment` is internal to slide-model.
  The first slide of a new deck now gets its notes fragment when the deck is
  created (a second, older copy of the slide factory left it out, which the
  lazy install had hidden), so the button shows only on slides of decks made
  before this release.
- The speaker-notes editor binding is on the parity allowlist (it is the one
  editor write the lint cannot see).
- Agent eval: four new scenarios (`slide-notes-talking-points`,
  `slides-copy-block`, `slides-outline-nest`, `deck-duplicate-named`); the
  whole suite passed 17/17 on 2026-09-28 (opus, $1.96), plus the fourth new
  one recorded afterwards. The replay guard fails when a replayable scenario
  has no recording.

---

## 0.10.1 — A lighter tool list for agents (2026-09-28)

### Changed

- **Agents start with a smaller tool list.** Narrative's MCP tool list, loaded
  into the model's context when a client connects, is ≈ 129 KB instead of
  ≈ 150 KB (form-mode clients 148,207 → 128,349 bytes; link-mode 151,119 →
  129,213). It only changes how Narrative presents itself over MCP. Commands,
  their input schemas and the capability manifest are unchanged, and the
  server still validates every call against the full schema:
  - field descriptions repeated across tools (the slide reference is on 45
    of them, as well as object and table ids, text bodies, fonts and colours,
    fills, file inputs, share roles) are said once in the server
    instructions instead of on every tool (`mcp/vocabulary.ts`, 27 fields;
    a test fails when a reworded description would put one back on every
    tool, or when a new widely repeated one is missing);
  - an example call only on tools whose input needs one (several forms, a
    nested object or list, more than two fields), and without its title;
  - each confirming tool now says only how this client asks the user; what
    a declined, dismissed or unanswerable question means, and the retry
    with `confirmationId`, are said once in the instructions;
  - identical alternatives in a schema union are said once (mostly
    `object_create`).

  The instructions grow to 3,945 bytes, so a session starts ≈ 17.5 KB
  (form) to ≈ 19.5 KB (link) lighter. The size budget test now caps the
  list at 132,000 bytes (was 160,000).

- **The agent eval runs Claude Code as users do, with ToolSearch.** Claude Code
  then defers MCP tools and loads a tool's schema only when the model needs
  it, instead of sending the whole tool list with every request. On
  2026-09-28 (opus, Claude Code 2.1.283) all 14 scenarios passed: 13 in the
  full run for $1.62 list-price equivalent (was ≈ 2 USD), and
  `selected-slide-context`, whose browser failed to start there, on a rerun
  with the system Chrome.

---

## 0.10.0 — Agents over MCP (2026-09-27)

Phases A0 and A1 of the agentic layer ([`docs/plans/agentic-layer.md`](./docs/plans/agentic-layer.md)).
A0 (`9e0e853`): the foundations — the command registry, runtime schemas,
parity guards — plus the editor bugs the capability survey turned up. A1
(`624a3bd`, `e27e9bc`): Claude Code and claude.ai can now drive Narrative
over MCP. Handoffs:
[`docs/handoff/A0-agentic-foundations.md`](./docs/handoff/A0-agentic-foundations.md),
[`docs/handoff/A1-mcp-and-server-host.md`](./docs/handoff/A1-mcp-and-server-host.md).

**Before deploying this:** production needs the new secret
`AGENT_PRINCIPAL_KEY_SECRET` in `infra/.env.prod` (and in the encrypted
`env.prod.sops`) — without it `build-push.sh`, `deploy.sh` and the server all
refuse to start. Eight migrations (`0016`–`0023`) run on deploy; the Caddyfile
gains the OAuth discovery and client-IP blocks. Checklist:
[`docs/deploy.md`](./docs/deploy.md) "Releasing the agentic layer (A1)".

### Added (A1 — agents over MCP)

- **Drive Narrative from Claude Code or claude.ai.** An MCP server at
  `https://<domain>/api/mcp` exposes every command as a tool — 94 of them,
  generated from the registry, never hand-written — with read-only,
  idempotent and destructive hints, one example call each, and a size budget
  on the whole tool list. Claude Code connects with a personal access token
  (or signs in with OAuth); claude.ai adds Narrative as a custom connector
  and signs in with Google through Narrative's consent page. Setup:
  [`docs/mcp.md`](./docs/mcp.md), local:
  [`SETUP.md`](./SETUP.md) §9.
- **Personal access tokens** (account menu → **Access tokens**). Scoped to
  `mcp` or `api`, expiring after 30, 90 or 365 days (never "never"), at most
  20 active per person, stored only as a hash and shown once. A token stops
  working the moment its owner could no longer sign in, and revoking a
  person's access revokes their tokens and connected apps with it. The same
  page lists **Connected apps** (claude.ai connections) with a Disconnect
  button, and flags one whose refresh token was replayed.
- **The agent works in the deck like a colleague.** It appears as a peer
  named "Claude (MCP)" with its own colour and selection; your own agent is
  labelled "working for you". It can read which slide and objects you have
  selected ("make this bold"), jump your editor to a slide and highlight
  objects, and hand you a presenter link.
- **Agent activity** (a popover in the editor, and in the component master
  editor): every agent change belongs to a run you can see and **revert**,
  undoing exactly what that run changed and nothing a person did meanwhile,
  component masters included. Revert works while the deck is loaded on the
  server (someone has it open or a run is active); after a server restart
  or an unload it is no longer possible. Each agent command reaches your
  editor as one update, not a burst of partial states. Mod+Z still undoes
  only your own edits.
- **Nothing irreversible happens without you.** Sharing, invitations,
  deleting decks, folders, fonts, media or components, and moving a deck ask
  first — in the Claude client when it can ask, otherwise on a Narrative
  confirmation page you approve in your signed-in browser. The question is
  written by Narrative from the exact call (titles, recipient, role), never
  by the model. Downloading a file from a URL asks too, naming the host.
- **Agents can work beyond one deck**: list, create, rename, move and delete
  decks and folders; import a .pptx or insert slides from another deck or a
  .pptx; export the live document to .pptx (a download link); upload images,
  videos and fonts; list, stamp, rename and delete components and edit a
  component master; manage share links, invitations and collaborators; read
  token usages. Routes and agent commands share one implementation per
  action, so the web app and an agent cannot drift apart.
- **An audit trail.** Every agent command is logged with its run, what it
  targeted, how it was confirmed and every host it downloaded from — inputs
  redacted (file bytes and `data:` URLs become size + hash, URL query strings
  stripped), deleted 90 days after the run's last activity.
- **`POST /api/commands`** runs one command or an atomic batch for scripts,
  with an `api`-scoped token or the browser session.
- **Playbooks** (`packages/commands/playbooks/`: basics, edit, find-replace,
  restyle-lite, shorten, translate) served as MCP prompts and resources, and
  the generator of the `narrative` Claude Code skill
  (`pnpm --filter @narrative/commands skill`).
- **`pnpm agent:eval`**: 14 scenarios driven through headless Claude Code
  against the local stack and graded deterministically from the resulting
  document (14/14 passing on 2026-09-27, ≈ 2 USD list-price equivalent per
  run); 11 of them also replay free, without a model, inside `pnpm -r test`.
- **`db:revoke-user`** (`revokeUserAccess` in the image): one command cuts a
  person off — sessions, tokens, OAuth grants — and warns if they could still
  sign in again.

### Changed (A1)

- **Presence no longer publishes who you are to share-link viewers.** Editors
  broadcast a random per-tab id and their display name instead of their
  Google account id and email; read-only and share-link connections receive
  awareness with ids replaced and email-looking values removed.
- **Rate limits** (`@fastify/rate-limit`) on the API: per session or token for
  signed-in callers, per client IP otherwise, with agent bearer tokens
  budgeted per token so claude.ai users behind Anthropic's shared egress do
  not share one budget.
- **Uploads by URL or base64 from an agent are capped lower than browser
  uploads** (.pptx and video 200 MB with a 120 s deadline, images 25 MB,
  fonts 8–10 MB), downloaded through an SSRF guard to a temp file, at most two
  at a time per person.
- **A deck moved to another folder keeps its look.** Its colour and
  text-style references pointed into the old folder's tokens; they now move
  to the destination's token of the same name, or become the literal colour
  they showed (a text-style link without a match is detached, keeping its
  typography). Slides inserted from a deck in another folder get the same
  treatment (`services/tokenRebind.ts`).
- **Error reports no longer carry credentials**: Sentry events are scrubbed
  of `Authorization` / `Cookie` headers, personal access tokens and session
  cookie values.

### Fixed (A1)

- **Live editor connections knew who they were again.** A race in how
  Hocuspocus 2.15 copies the connection context meant a connection often ran
  with no user id or role, so revoking someone's sessions did not close
  their open editor, and the "who is editing" bubbles could miss people. The
  context is now set where it survives.
- **Personal access tokens are refused on the collaboration WebSocket**
  instead of falling back to a cookie or share link: agents write only
  through the server, where every change is validated, confirmed where
  needed, attributed and logged.

### Added (A0)

- **The command registry (`packages/commands`).** Every document change an
  agent will be able to make is a command with a validated input, a required
  role, an undo policy and a description written for a model: 50 commands
  across slides, objects, text, tables, animations, guides and read-only
  queries, plus `ops.apply`, which runs a batch of them as one change — all
  of it or none of it. The list of what exists and what is still missing is
  generated into [`docs/capabilities.md`](./docs/capabilities.md)
  (`pnpm capabilities`); a test fails when it is stale, another when a new
  slide-model mutation reaches no command, and another when a new server
  route is not claimed by a command, the known-missing list or a reasoned
  exclusion. Object locks do not restrict commands: a lock is an editor-only
  flag that stops a person dragging, resizing, nudging or deleting an object
  on the canvas, and agents ignore it (decided 2026-09-26; an earlier draft
  of the same day had commands refuse locked objects unless the caller
  passed `force: true` — removed before release)
  ([ADR 0010](./docs/adr/0010-command-layer-is-the-only-writer.md),
  [ADR 0011](./docs/adr/0011-agent-execution-over-mcp.md)). The editor does
  not dispatch through it yet (phase A2).
- **Runtime schemas for every object type** (`packages/shared/src/schema`,
  zod). Agent input is checked against them; the typecheck fails when a
  property is added to a type but not to its schema.

### Changed (A0)

- **A new animation starts "after previous"** instead of the legacy "on
  enter" trigger the pickers no longer offer. The first animation on a slide
  still starts with the slide, so playback is the same.

### Fixed (A0)

- **Alt-drag copies can be undone.** Undo after Alt-dragging a copy slid the
  copy back onto the original and left it there; the copy was never on the
  undo stack. The copy and the drag are now one undo step.
- **Duplicating selects the copies**, from Ctrl/⌘+D, the context menu and
  Alt-drag alike — all three ended with nothing selected. The context menu's
  Duplicate is also one undo step for several objects instead of one per
  object.
- **A duplicated group is a new group.** Copies kept the original's group,
  so duplicating a group grew the original instead of making a second one;
  a lone copy of a group member is now ungrouped.
- **A cropped image keeps its crop when it moves.** The arrow-key nudge, the
  Inspector's X/Y fields, align to slide, align/distribute, and the 20 px
  offset of a duplicate moved the frame but left the crop behind, so the
  picture slid inside its frame (only a mouse drag carried it).
- **The layer items in the context menu say what they do.** "Send back" and
  "Send backward" were swapped; the items now read Bring to front, Bring
  forward, Send backward, Send to back, with their shortcuts.
- **Undo covers every formatting gesture.** A table-wide fill change, list
  changes (bullets, numbering, indent), and clearing a run's own formatting
  when setting a box-wide value were missing from the undo history, or only
  half in it. Each is now exactly one undo step, as is changing a table's
  row or column count with the steppers.
- **Opening a deck no longer edits it.** Viewing a text box whose stored
  font weight its family lacks rewrote the weight, and opening the animation
  timeline rewrote legacy "on enter" steps — each write landed on the
  viewer's undo stack, went out to every collaborator, and (for the
  timeline) could change playback. The weight picker now shows the face the
  browser actually renders; the timeline shows legacy steps where they play.
- **Inserting or deleting table rows and columns keeps merged cells.**
  Merged cells kept pointing at their old positions, and the table did not
  grow or shrink with the row or column. Merges now extend, shrink or move
  the way PowerPoint does them; deleting the row or column a merged cell
  starts in keeps its text and styling; borders stay on their lines and the
  outer edge stays outside.
- **A text box keeps its link to a folder text style through PowerPoint.**
  Exporting to .pptx and importing the file again kept which fields the box
  overrides but dropped the style it is linked to, so later changes to the
  style no longer reached it.
- **Components keep rich text.** Making a component from a selection, and
  stamping one onto a slide, flattened text boxes and table cells to plain
  text — bold runs, colours and lists were lost.
- **Videos in an appended .pptx play.** Inserting a PowerPoint deck into an
  existing one never asked for its videos to be transcoded, so they stayed
  "processing" forever. The append now registers its media through the same
  code as a new import, before the slides appear in the deck, so an editor
  never sees a slide whose media the server does not know yet. A failed
  append says whether any slides may already be in the deck.

---

## 0.9.29 — Duplicated slides that draw (2026-09-25)

### Fixed

- **A duplicated slide draws, keeps its text, and gets its thumbnail.**
  Duplicating a slide (Ctrl/⌘+D or the thumbnail menu) left the copy's
  canvas blank — objects could be selected but nothing drew — and after a
  reload its text boxes were empty. The copy re-used the original's live
  text objects, which the collaboration layer cannot share between two
  slides; it is now cloned whole — text with its formatting, tables,
  speaker notes, transition, background — in one step, which is also one
  undo step. The blank canvas itself came from images: the copy picked up
  a texture the editor was just unloading, and every frame after that
  failed. Textures are now kept briefly after their last use and never
  handed out while unloading, and a render failure is reported instead of
  silently freezing the canvas. Slides duplicated before this release lost
  their texts on the server; duplicate them again.
- **Thumbnails of new slides no longer wait for the whole deck.** Right
  after a deck opens, every thumbnail renders in turn; a slide added or
  duplicated meanwhile waited for all of them (~12 s on a 56-slide deck).
  What you do now renders first.

---

## 0.9.28 — Duplicate a slide from the keyboard (2026-09-25)

### Added

- **Ctrl+D (⌘D on a Mac) duplicates the selected slide** in the slides
  panel, the way the thumbnail menu's "Duplicate" does: every selected slide
  when several are, each copy placed right after its original, and the
  editor moves to the copy. While the slide list has the focus it takes the
  key over from the canvas, where Ctrl+D still duplicates the selected
  objects, and the browser's own Ctrl+D (bookmark) no longer fires there.

### Fixed

- **A viewer can no longer delete or paste slides from the keyboard.** The
  slides panel hid those actions from its menus for viewers, but its Delete
  and Ctrl+V shortcuts still acted on the deck.

## 0.9.27 — No outline where PowerPoint draws none (2026-09-24)

### Fixed

- **Imported shapes keep "no outline".** A shape's `<p:style>` names a line
  and a fill from the theme, which PowerPoint uses only where the shape does
  not set its own. The importer took the style's line whenever the shape had
  no colour for it — including when the shape said explicitly that it has no
  line (`<a:ln><a:noFill/>`), and it took an `idx="0"` reference ("none") as
  the theme's first line. The Proseware deck's slide 7 wireframe drew 33 grey
  boxes with a 1 px red accent outline PowerPoint never shows. A declared
  fill of either kind now wins over the style, and index 0 means none. The
  deck has to be imported again to pick it up.
- **Two exports of one deck are identical byte for byte.** Every zip entry
  was stamped with the moment it was written, and JSZip added an entry for
  each folder; exports that straddled a tick of the zip's two-second clock
  differed, which made the round-trip stability test fail now and then under
  load. Entries now carry the export's own date, and the package holds parts
  only, as PowerPoint writes it.

## 0.9.26 — Lines as tall as their text (2026-09-24)

### Fixed

- **Text is spaced for the size it is set in.** A line's height — single
  spacing, or a multiple such as the Proseware titles' 68 % — was always
  computed from the frame's default size. Text set smaller than that default
  came out with its lines far apart: slide 3's title (60 pt text in a frame
  whose default is 88 pt) ran ~45 % too loose against PowerPoint. Each
  paragraph is now laid out for its own largest font, as PowerPoint spaces
  each line for the text on it; the paragraph also takes that size itself so
  the browser does not add the gap between the two fonts' baseline positions
  to every line. Indents and list gutters stay where they were (they are
  measured in the frame's size). Rendering and text editing share the same
  layout. Exposed by 0.9.25, which imports a frame's default size from its
  list style as PowerPoint does instead of from its first run.

## 0.9.25 — PowerPoint, both ways (2026-09-23)

### Changed

- **The PowerPoint exporter is rewritten, and import and export are now one
  translation.** Export no longer goes through pptxgenjs: `pptx/ooxml/`
  writes the package itself, with every element's reader next to its writer
  — the same units, the same vocabulary, the same geometry, text, table,
  transition, animation and notes code in both directions (ADR 0009). What
  OOXML can express is written natively, so PowerPoint shows it; what it
  cannot (a radius per corner, numeric font weights, video playback
  settings, …) is written as close as PowerPoint can draw it and kept
  exactly in Narrative's own extension inside the file, which applies only
  while the shape is unedited in PowerPoint. On the Proseware deck,
  import → export → import changed 6 173 values before and changes none now;
  LibreOffice renders the export about five times closer to the original.
- **Exported pictures are cropped as Narrative shows them.** A picture was
  stretched to its frame; it is now fitted (cover / contain) and cropped the
  way the canvas draws it, for pictures, video posters, picture-filled shapes
  and table cells. Picture masks are the picture's own geometry (ellipse,
  rounded rectangle, polygon, path), so PowerPoint clips them too.
- **Speaker notes keep their formatting.** Bold, italic, underline, strike,
  code, links, headings, bullet and numbered lists and quotes are written as
  PowerPoint formatting, and come back exactly. Notes in PowerPoint decks
  import with their formatting and lists instead of as plain lines.
- **The export dialog lists what PowerPoint shows differently** — nothing is
  lost any more; everything comes back when the file is opened in Narrative
  again.

### Fixed

- **Imported text keeps each run's own formatting.** A run with no size or
  weight of its own took the one of the run before it (Yjs inherits
  formatting on insert): "**Colors:** Primary, secondary…" came in bold to
  the end of the line.
- **Text sits where PowerPoint puts it.** Text-box insets (0.1 in / 0.05 in
  by default, or the layout's) were ignored, so imported text sat at the very
  edge of its box. The frame is now the area the text is laid out in.
- **Ellipses, triangles, polygons and paths with text keep their shape.**
  Only rectangles kept their geometry under their text; the Proseware deck's red
  "Wireframe" circle came in as white text on nothing.
- **Character references in the XML are decoded.** `&#233;`, `&#x2014;` and
  line breaks written as references came in as literal `&#…;` text.
- **Table cells after a horizontal merge land in their own column** instead
  of one further right (the last one fell off the table). Cell borders keep
  their dash and transparency; picture fills in cells are imported.
- **Letter spacing and caps from the slide master apply.** The Proseware title
  style's −8 pt tracking was ignored, so titles ran wider than in
  PowerPoint.
- **Slides without a transition have none.** `<p:transition>` carrying only
  advance settings imported as a half-second fade; speeds are PowerPoint's
  (0.5 / 0.75 / 1 s); Morph, Cube and exact durations inside
  `mc:AlternateContent` are read.
- **Straight lines are straight.** A horizontal or vertical line imported
  1 px tall or wide, slightly slanted.
- **More of each shape is read:** rounded corners from the preset's own
  radius (not always half the short side), dashed outlines, flips, alt text,
  aspect locks, picture fills, links on whole shapes and links that jump to
  another slide, bullets declared in a shape's own list style, paragraph
  spacing from it, an explicit "not bold / not italic" on a run, a
  gradient's radial centre, a solid background's transparency, a background
  picture's dimming, Keynote's gradient direction, animation delays.

## 0.9.24 — Bullets you can see (2026-09-23)

### Fixed

- **List markers are drawn.** Every bullet and number since multi-level
  lists (June) was rendered outside the picture: `text-indent` is inherited,
  the marker is an inline-block with a first line of its own, so the
  paragraph's hanging −1.6 em outdent moved the glyph a second time — out of
  its gutter and off the left edge. The gutter was there, the marker was
  not; imported PowerPoint lists (the Proseware deck's slide 8) and lists made
  in the editor alike. The marker now resets `text-indent`. The list smoke
  test used to pass on "the frame has more ink than before", which the
  indent alone satisfied; it now counts ink in the marker gutter itself and
  fails without the fix.

---

## 0.9.23 — The Proseware header, complete (2026-09-23)

### Fixed

- **Numbers in text no longer vanish on import.** fast-xml-parser turns text
  that looks numeric into a number, and every reader only took string text,
  so a run whose whole text was "2", "2026" or "10" disappeared — and
  PowerPoint splits runs at every formatting change, so a bold year inside a
  sentence is exactly such a run. All OOXML parts are now read through one
  parser configuration with `parseTagValue: false`, and the exporter's
  post-processing pass keeps "2.50" and "007" byte for byte instead of
  writing them back as 2.5 and 7.
- **Slide numbers import as live slide numbers.** A frame holding only
  `<a:fld type="slidenum">` becomes a text object with `isSlideNumber`, which
  the renderer fills with the slide's number and the exporter writes back as
  a field. Keynote writes the field with no cached text, so the Proseware
  header's "2" used to come in as an empty rectangle. A number inside other
  text keeps its cached digits.
- **Placeholders inherit their layout's fill.** A slide shape bound to a
  placeholder that declares no fill of its own now takes the layout/master
  placeholder's fill, as PowerPoint does; the Proseware deck's black corner mark
  carries only its path on the slide and came in invisible.

### Added

- **Text that does not wrap.** `TextObject.wrap: 'none'` (PowerPoint
  `<a:bodyPr wrap="none">`, also inherited from a layout/master placeholder):
  lines break only at explicit breaks and extend past the box on the side
  their alignment grows towards; the clip mask follows the line and the edit
  overlay lays it out the same way. Slide numbers sit in boxes sized for one
  digit, so without it "10" broke into "1" / "0". Exported back as
  `wrap="none"`.

---

## 0.9.22 — Drop straight into the folder (2026-09-23)

### Changed

- **A .pptx dropped inside a folder goes straight into that folder.** The
  import dialog used to open on a folder picker with the current folder
  preselected and wait for Import — a question the page had already
  answered. Inside a folder it now opens already uploading into it
  ("Importing into Proseware"), with no folder list and no confirm click; it
  still shows the upload progress, the result and the missing-font uploads,
  and offers Retry if the import fails. A drop on the folders home keeps
  the picker, since there it is a real choice.

---

## 0.9.21 — Lines where PowerPoint puts them (2026-09-23)

### Changed

- **Text sits in its lines the way PowerPoint puts it, everywhere.** A line
  box is usually taller than the glyphs it holds. PowerPoint puts all of the
  spare height above the glyphs — the baseline sits the font's descent above
  the bottom of the line box — while CSS splits it half above and half below.
  With generous spacing the difference is large: the Proseware deck's
  "We made it to our first Camp!" (72 px on exactly 65 pt lines) sat 32 px
  higher here than in PowerPoint. Because the difference is the same for
  every line of a frame, it is one translation of the laid-out text,
  computed once in `lib/fontLineMetrics.ts` (`powerpointLineOffsetPx`) from
  the browser's own ascent/descent and the font file's hhea descent, and
  applied by the renderer (text frames and table cells) and the edit overlay
  alike. Frame heights, wrapping and auto-fit are unchanged; below 100%
  spacing the text moves up and the clip mask opens to follow it. This
  applies to text created in Narrative too, so a deck exported to PowerPoint
  now lays out the same on both sides.

### Fixed

- **A plain paragraph at a deeper outline level is no longer indented.** In
  PowerPoint `lvl` only selects the level whose `marL` applies; on the
  Proseware headline (`lvl="1"`, level-2 `marL` 0, `indent` 0) that is no
  indent at all, but the importer kept the level and the renderer drew it as
  a 1.5 em indent — 108 px to the right. The level's margin is now resolved
  down PowerPoint's chain (paragraph, shape, layout/master placeholder,
  master `txStyles`, `presentation.xml` `defaultTextStyle`) and a paragraph
  without a bullet keeps its level only when that margin is non-zero. List
  paragraphs keep their nesting as before.
- **The table cell editor lays text out like the cell it edits.** It pinned
  line height to 1.2 and ignored the cell's italic, letter spacing, text
  transform and the table's default face, so on any table not at 1.2 — every
  imported one — the caret ran on different lines from the glyphs.

---

## 0.9.20 — Export fits its label (2026-09-23)

### Fixed

- **The toolbar's Export button is as wide as its label.** It reserved the
  width of "Exporting…" at all times so the toolbar would not shift during
  the second or two an export takes, which left the idle button ~30 px wider
  than "Export". The label now stays "Export"; the spinner, the disabled
  state and `aria-busy` show that it is working.

---

## 0.9.19 — One way into a deck (2026-09-23)

### Removed

- **The editor toolbar's Append button.** Dropping a `.pptx` onto the slides
  panel (0.9.16) imports it at the drop position over the same upload route,
  with a progress row in the panel, which made the button redundant. Drop
  below the last thumbnail to append. The server still appends when no
  position is given; `e2e/pptx-append.spec.ts` went with the button, and
  `pptx-drop-into-panel.spec.ts` covers the live-arrival check it made.

---

## 0.9.18 — Imported slides the way PowerPoint drew them (2026-09-22)

### Fixed

- **Imported rotation is right.** The model stores `rotation` in radians — the
  renderer hands it straight to Pixi and the Inspector converts for display —
  but the importer wrote PPTX degrees into it, so a label tilted 7°
  counter-clockwise (`rot` 352.97°) rendered at 352.97 rad ≡ +64° clockwise.
  The exporter made the mirror-image mistake, sending radians out as
  pptxgenjs degrees, which is why an import → export round trip looked
  consistent and hid both. Both boundaries now convert through
  `rotationFromDegrees` / `rotationToDegrees` in `@narrative/shared`, imported
  angles land normalised to (−180°, 180°], and the unit is documented on
  `BaseSlideObject.rotation`. Decks imported earlier keep their stored
  degrees; re-import them to correct rotated objects.
- **Placeholder text keeps its template line spacing.** A slide that restyled
  a title's size in its own `lstStyle` stopped the search there, so the
  layout's `lnSpc` (68% on the Proseware deck's title layout) was never read and
  the text laid out at the font's full normal line height — 47% taller than
  PowerPoint and off the bottom of the slide. Line spacing is now inherited
  down the whole chain — paragraph, the shape's `lstStyle`, the layout and
  master placeholder, the master `txStyles` — and resolved once the frame's
  final font size is known, so an absolute `spcPts` is divided by the size
  the text actually renders at.
- **Picture placeholders take their frame from the layout.** Inheritance
  looked for `<p:ph>` only under `<p:nvSpPr>`; a `<p:pic>` keeps it under
  `<p:nvPicPr>`, so a placeholder picture without its own `<a:xfrm>` came in
  as a 1×1 px image at the slide origin. A layout's own `<p:pic>`
  placeholders are also no longer baked onto every slide, which PowerPoint
  never does.
- **Very large images render.** imgproxy refuses a source over 50 MP (422,
  "Source image resolution is too big"), so a 147 MP background photo never
  loaded and the editor showed its broken-image placeholder. The PowerPoint
  importer and the upload finaliser now downscale any raster over 40 MP or
  16 384 px per side before storing it, in its own format, with EXIF
  orientation applied and the ICC profile kept
  (`apps/server/src/media/storedImageLimits.ts`, using `sharp`). Nothing
  visible is lost — the largest display variant is 2560 px.

---

## 0.9.17 — Select a run of slides (2026-09-22)

### Fixed

- **Shift-click selects a run of slides again.** Click the first, shift-click
  the last, and everything between is selected — the gesture the panel's own
  documentation described but never implemented: shift toggled the single
  slide it was clicking, so "first, then last" selected exactly those two.
  Cmd/Ctrl-click now does the toggling, as it does in Finder, Explorer,
  Keynote and PowerPoint, and the range measures from an anchor that a
  shift-click deliberately leaves in place, so dragging the far end resizes
  one range instead of ratcheting new ones onto it.
- **Delete removes every slide in the selection.** It took only the slide
  under the cursor, which made a multi-selection look broken the moment you
  tried to use it. Delete and Duplicate now follow the rule Copy already
  used: act on the whole selection when the target is part of it, otherwise
  on the target alone. The deck still never reaches zero slides.
- **A click on a thumbnail is no longer dropped while the panel's snapshot is
  behind the document.** `setActiveSlideId` validated the id against the
  provider's own rAF-coalesced slide list, which lags the document by up to a
  frame and is empty for the first moments after a deck opens; a click
  arriving in that window was discarded in silence. It now falls back to the
  live document.

### Infrastructure

- **`build-push.sh` pins `linux/amd64`.** Docker builds for the host
  architecture, so the first release built on the Apple Silicon Mac pushed
  arm64 images and the VM refused them at the pull — `no matching manifest
for linux/amd64` — having already overwritten `:latest` with them. The
  target is now pinned rather than inherited from wherever the build ran
  (`TARGET_PLATFORM=` overrides); on arm64 it builds under emulation.
- **`prune-images.sh` runs on macOS again.** It read the in-use image list
  with `mapfile`, which is bash 4+; macOS ships bash 3.2, so the prune died
  with `mapfile: command not found` on every build there — silently, because
  a failed prune is tolerated by design. The Mac had never pruned a single
  image. Replaced with a `while read` loop.

---

## 0.9.16 — Import where you dropped it (2026-09-22)

### Added

- **Drop a `.pptx` onto the slides panel and it imports where you pointed.**
  Dragging a presentation from the desktop over the thumbnails draws the same
  insertion line a slide reorder does, and the imported slides land in that
  gap rather than at the end of the deck. Several files dropped at once are
  imported in the order they were dropped, each one after the last, and a
  placeholder row holds the gap with the upload percentage while it runs.
  Nothing is imported for a viewer, and a dropped image or video is still the
  canvas's business, not the panel's.
- **A legacy `.ppt` is refused in words that help.** It is the pre-2007
  binary format and the parser reads OOXML out of a ZIP, so it could only ever
  fail — previously with `End of central directory record not found`. Both
  drop targets now recognise it before uploading a byte and say to re-save it
  as `.pptx`. The refusal appears in the gap it was dropped into and stays
  until dismissed.

### Changed

- **One transport for "a .pptx into this deck".** The toolbar's Append button
  POSTed the whole file in one request, which reports no progress and cannot
  resume; it now uses the same chunked tus upload as every other import. The
  upload carries its target as metadata — `folderId` creates a deck,
  `deckId` (+ optional `insertAt`) inserts into one — and the server
  authorises each against the right thing: folder ownership for the first,
  editor role on the deck for the second, so a shared editor can import into
  a deck without owning the folder it sits in. `POST /decks/:id/append-pptx`
  stays for API callers and gained `?at=N`; the pipeline behind both paths
  moved into `apps/server/src/pptx/appendDeck.ts`.

### Infrastructure

- **Every build and deploy cleans up after itself.** The prod VM reached 99%
  disk on 2026-09-21 — sixteen releases of images plus 14 GB of build cache
  from when it still built from source — and a deploy died mid-extract. New
  `infra/scripts/prune-images.sh` keeps the current tag and two releases back
  per image (a rollback window; GHCR holds the rest) and never touches what a
  running container uses. `deploy.sh` runs it after a successful deploy, with
  the build cache included; `build-push.sh` runs it after a successful push,
  keeping the local build cache. Scripts ship by rsync, no version bump.

---

## 0.9.15 — Text clip cleanup (2026-09-21)

### Changed

- **One number sizes the text texture's padding and the clip mask.** The
  mask's extra font-descent row below the box dated from when the mask was
  the only thing sized for glyph overhang; the padded texture has no pixels
  there. The mask is now content + 2 × overshoot, and it is rebuilt on the
  one `layoutAffected` condition instead of a list that repeated it.

---

## 0.9.14 — Line height no longer cuts the glyphs (2026-09-21)

### Fixed

- **A short line height cut the top off the text.** Pixi rasterises HTMLText
  through an SVG exactly the line boxes tall; with a line height below the
  font's own ascent + descent the glyphs overhang their box and the first
  line's overhang was never in the texture — the top of a capital "S" cut
  straight across, worse the lower the line height, and no mask could bring
  it back. The style now carries a `padding` equal to the overhang allowance
  the clip mask already opened, so the texture has the room and the text
  stays where it was.
- **The clip mask is rebuilt on every typographic change.** It used to be
  rebuilt only when the box or the font size changed, so lowering the line
  height in the Inspector left a mask sized for the old one.
- **Font metrics measured against a fallback are forgotten when the real
  face arrives.** `document.fonts` fires no `loadingdone` for a face added
  already loaded, which is how folder fonts are installed; the loader's
  refresh now drops the cached measurements of that family itself.
- **A write to an object in the same tick as its insert reached nobody.**
  The change batch kept the object as read when the insert fired and dropped
  the later patch as redundant, so a font size set right after adding a text
  (an import fix-up, two mutations between frames) stayed invisible until
  the next unrelated write. The patch is now folded into the add.
- **A style change during an in-flight rasterisation no longer gets lost.**
  Pixi's HTMLText pipe clears the dirty flag and then returns early while a
  texture is being generated, and never re-checks the style key once it
  lands — the node kept the old texture under the new style's bounds. The
  renderer now waits for that generation and re-flags the node if its key
  moved on.
- **Padding no longer reaches the paragraphs.** Pixi writes the container
  rule as a bare `div` selector; our paragraphs are divs. The scoped rule is
  now `foreignObject > div`, and the container is pinned to `content-box` so
  the in-page measurement and the detached SVG render agree on the wrap
  width.

### Tests

- `text-glyph-overhang.spec.ts` reads pixels instead of the mask's
  geometry: the ink of "Sell" at line-height 0.5 must be as tall as at 1.5,
  and must start above the box. The previous version passed with the "S"
  still cut.

---

## 0.9.13 — Text at the font's own line height (2026-09-21)

### Fixed

- **Imported text now lays out at the height PowerPoint sized it to.** The
  importer folded percentage line spacing into a font-size multiple with a
  flat ×1.2, right only for fonts whose normal line height is 1.2 em, and the
  exporter sent that multiple back out as a normal-multiple (100% in, 120%
  out). Percentage spacing is now its own field, `lineSpacing`, written by
  the importer, read back by the exporter, and resolved against the font in
  one place shared by the renderer, the edit overlay, the clip mask and the
  Inspector.
- **The font's normal line height comes from the font file.** For a font
  that sets USE_TYPO_METRICS the browser's `line-height: normal` uses the
  typo metrics (0.977 em for Proseware Pro) while PowerPoint uses hhea (1.162),
  so the browser is the wrong source for exactly the fonts that need it. The
  folder-font loader reads `hhea` from the bytes it installs and registers
  it ahead of measurement; measurement remains for system fonts. On the
  reported frame: 616 before, 598 now, PowerPoint 597.8.
- Weights are matched on one numeric scale: a text object saying "normal"
  now finds the folder font registered at 400.

### Known

- WOFF 2 folder fonts cannot be read in the browser (Brotli); they fall back
  to the browser's measured normal. Uploading OTF/TTF/WOFF keeps fidelity.
- Table cells keep the historical ×1.2 fold; the table pipeline has no
  line-height resolver yet.

## 0.9.12 — Clearing up after the hunt (2026-09-21)

### Removed

- **The `?debugSidebar=1` probe from 0.9.9.** It existed to catch the sidebar
  jump on the reporter's machine; 0.9.11 found and fixed the cause, so it is
  gone from the bundle.

### Changed

- The slide panel's `overflow-anchor: none` keeps its place but its note no
  longer blames the thumbnail placeholder swap — the row-height transient
  came from the Pixi style leak, and anchoring only amplified it. The
  0.9.5 stability spec, whose drift check never reproduced anything on a
  generated deck, is folded into the spec that does reproduce the bug.

## 0.9.11 — The sidebar stops jumping, for real this time (2026-09-21)

### Fixed

- **The slide panel threw the reader back up while previews loaded and when a
  slide near the end was clicked.** Reported five times across three
  releases; 0.9.4 and 0.9.5 fixed real defects nearby and neither was this.
  The cause is PixiJS text measurement: every `HTMLText` render appends an
  SVG with a `<style>` to `document.body` for one layout, and that CSS uses a
  bare `div { font-size: 158px; line-height…; width… }` selector. A `<style>`
  is document-global and an unlayered element rule beats every layered
  utility class, so for the length of each measurement every `div` on the
  page is a heading — the panel's rows change height, the list's scroll
  height drops, and with the list at its end the browser clamps the scroll
  position to the new maximum. The style goes away, the content returns, the
  position does not. One clamp per text object, by the thumbnail renderer at
  load and by the canvas on a slide click. Found by bisection: thumbnails of
  empty slides held the position, of everything except text held it, of text
  walked it back 3,216px. The generated selectors are now scoped to
  `foreignObject div`, which matches only Pixi's own measurement markup.
  Verified by a spec that holds the list at the end during load: 3,216px of
  drift before, 0 after.
- **The top of a tall glyph could still be shaved on the reported slide.**
  The mask keeps a quarter-em of room beyond the computed overhang, and font
  metrics measured before a webfont loaded are re-measured once it has.

## 0.9.10 — The font is measured properly now (2026-09-21)

### Fixed

- **Tall glyphs lost their tops.** Reported on an imported slide where the
  word "Sell" is set at 79pt with 75% line spacing: the S was cut flat, and
  entering the text editor showed it whole because the DOM overlay draws
  without the clip mask. A line box is `lineHeight` tall while its ink is
  `ascent + descent`; below that, CSS lets glyphs overhang their own line
  boxes. The mask began at y=0 and shaved the overhang. It now starts above
  it.
- **Font metrics were measured on the wrong font, at every size.**
  `CanvasTextMetrics.measureFont` takes a CSS font shorthand and was being
  passed a `TextStyle` object, so the canvas measured its default ~10px face:
  ascent 10 and descent 2 for a 158px heading instead of 147 and 31. Every
  allowance derived from it — the descender room beneath the mask, and the new
  overhang room above — was about a fifteenth of what it should have been.

## 0.9.9 — A probe for the sidebar jump (2026-09-21)

### Added

- **`?debugSidebar=1` instruments the slide panel.** The jump has survived
  three releases and has never reproduced off the reporter's machine, so the
  panel can now record it in place: every scroll with its geometry and whether
  a real gesture preceded it, a console warning the moment the list moves
  backwards unprompted, and `window.__sidebarProbe()` to dump the buffer.
  Inert without the flag.

## 0.9.8 — Imported text stops being cut off (2026-09-21)

### Fixed

- **Text imported from PowerPoint was sliced off at the box edge.** A frame
  with `<a:spAutoFit/>` carries the height PowerPoint computed for its own
  line spacing; we laid the text out taller and masked away the remainder,
  cutting the last line through the middle of its glyphs. The mask now
  follows whichever is taller, the box or the text in it — PowerPoint never
  clips an overflowing frame, it draws past the shape. Boxes whose text fits
  are unaffected.
- **Paragraph space-before was applied above the first paragraph.**
  PowerPoint applies it only between paragraphs, so every imported frame sat
  one gap too low and ran one gap too long. 20 of the 36 units of overflow on
  the reported slide were this.

### Known, not fixed

- The default line height is a flat 1.2 where PowerPoint uses the font's own
  metrics for "100% line spacing" — 1.162 for the face on the reported slide.
  That is the last 16 units of difference. Changing it moves every text object
  in every deck, so it needs its own change.
- The slide sidebar movement, unchanged. The reproduction now known to matter
  is: cold cache, scroll the previews to the **end**, and it clamps back up as
  they load. Reproduced neither locally nor throttled so far.

## 0.9.7 — Append stops throwing your slides away (2026-09-21)

### Fixed

- **Appending a `.pptx` to a deck did nothing, and destroyed the appended
  slides.** The route replayed `deck_updates` into a detached Y.Doc, appended,
  and inserted the diff as a new row — then answered 200 with a slide count.
  But Hocuspocus holds the deck in memory and never saw that row, and its
  persistence writes a full snapshot and deletes every older row for the
  document, so the next store deleted the append. Three decks appended to this
  way each ended with one row holding the pre-append state; the deck still had
  one slide before and after a reload. The append now goes through
  `openDirectConnection`, so it is an ordinary edit of the live document:
  connected editors see it immediately and it persists like any other change.
  The detached path remains only for processes with no sync server, where
  nothing can compact it away.

### Known, not fixed

- The slide sidebar movement and the imported-text clipping, both unchanged
  from 0.9.6 — see that entry for what has and has not been established.

## 0.9.6 — Drop a deck where you are standing (2026-09-21)

### Added

- **Drop a `.pptx` anywhere inside a folder to import it.** The folders home
  already took a dropped file; the page you land on inside a folder had no
  import at all, which is the page you are on when you go to put a deck
  somewhere. The current folder is offered first, so it is drop then one
  click, and the dialog still lets you send it elsewhere. Both pages now
  share `usePptxImport` rather than keeping two copies of the drag
  bookkeeping.

### Known, not fixed

- **The slide sidebar still moves on its own for at least one deck.** 0.9.4
  and 0.9.5 each fixed a real defect behind this (an editor remount, then
  browser scroll anchoring) and neither turned out to be the reported cause.
  A reproduction attempt this release produced a repeatable 2,488px jump that
  was then shown to be a harness artifact — no scroll event ever fired for
  it — so it is not evidence of anything. What did measure: a deck load
  blocks the main thread for 13.8s of 21.8s, 12.3s of it the panel rendering
  all 47 thumbnails eagerly. Rendering only visible rows cuts that to 5.3s
  but leaves off-screen rows blank when scrolled to, so it was not shipped.
- **Imported text can be clipped where PowerPoint shows it whole**, unchanged
  from 0.9.5. Three measured causes: a fixed 1.2 line height where the font's
  own metrics give 1.162, space-before applied to the first paragraph where
  PowerPoint omits it, and a renderer that masks the overflow PowerPoint
  never clips.

## 0.9.5 — The sidebar stops moving on its own (2026-09-18)

### Fixed

- **The slide panel scrolled itself while a deck loaded.** Reported as "when I
  scroll down it throws me back up". Nothing in the app was moving it:
  instrumenting `scrollIntoView` and the container's `scrollTop` setter across
  a full load recorded one write, the test's own, while the panel drifted
  535px; row heights and `scrollHeight` never changed. It is Chrome's scroll
  anchoring — each finished thumbnail replaces that row's placeholder `<div>`
  with an `<img>`, the browser reads the swap as content shifting under the
  reader and rewrites `scrollTop` to compensate, with no scroll event. The rows
  are a fixed-size grid, so anchoring has nothing it can usefully correct here.
  The panel opts out with `overflow-anchor: none`: same deck, same load, 535px
  of drift became 0.

  This is **not** the same defect as the editor remount fixed in 0.9.4. That
  one was real, but it was never the cause of the jumping, which is why the
  sidebar still moved after 0.9.4 shipped.

### Known, not fixed

- **Imported text can be clipped where PowerPoint shows it whole.** A frame
  with `spAutoFit` carries the height PowerPoint computed for its own line
  spacing; we then lay the text out taller and mask the overflow. Three
  independent causes, measured on one reported slide: the importer maps "100%
  line spacing" to a fixed 1.2 rather than reading the font (Proseware Pro's own
  metrics give 1.162), paragraph space-before is applied to the first
  paragraph where PowerPoint omits it, and the renderer hard-clips the
  overflow where PowerPoint never clips at all. 597.8 units of content in
  PowerPoint against 636 in a 600-unit box here.

## 0.9.4 — Four things that were quietly broken (2026-09-18)

The CSP and Caddy-mount fixes below reached production by rsync on 2026-09-09
without a version bump, so `/version.json` went on reading `v0.9.3+00454ec`
while they were already live. They are folded into this release because the
0.9.4 image is the first artifact that actually carries them. Everything else
here has never been deployed.

### Fixed

- **Opening a deck rebuilt the entire editor a fifth of a second in.**
  `FolderDocGate` returned one element tree while the deck's `folderId` was
  unknown and a different one once the deck-role fetch delivered it. The gate
  sits above SlideDocProvider, the Pixi canvas and the slides panel, so that
  swap is a full React unmount of everything below: the deck Y.Doc reconnects,
  Pixi re-initialises, every thumbnail re-renders. Measured on one open of a
  47-slide deck — editor mounted at 42 ms, `GET /api/decks` resolved at 129 ms,
  subtree removed and re-added at 212 ms, four deck WebSockets and a duplicate
  deck fetch for a single navigation. Reported as the slide sidebar jumping
  during load. The three folder-scoped providers take a nullable `folderId` now
  and the tree stays put.
- **Typing was not undoable.** `Y.UndoManager` only tracks transactions
  carrying `LOCAL_ORIGIN`, and the text-editing overlay passed no origin — so
  moving a text box could be undone but writing the sentence inside it could
  not, and neither could the Enter / Tab structural edits. Also corrects
  `yjsMetrics.onUpdate`, which counted local edits as received-from-remote.
  (`8169b9d`.)
- **Clicking an object selected nothing when the click beat the sync.**
  `subscribeToSlideObjectsWithFlush` returned a no-op subscription for a slide
  that had not arrived yet, which never recovered: the object list stayed
  empty, the stale-selection sanitiser dropped every selection, and the canvas
  had nothing to hit-test. It waits for the slide now. Two more races went with
  it — the deck provider tearing down its Y.Doc on a StrictMode remount, and
  the dev test API binding itself to an already-destroyed doc. (`523c82c`.)
- **A quick Linear → Solid switch left the gradient in the document** while the
  dropdown read "Solid". The fill picker compared the requested mode against
  the mode derived from `obj.fillStyle`, which comes back from Y.Doc a frame
  later, so the second change decided nothing had changed. It compares against
  the mode it last asked for instead. (`dd5f4d3`.)
- **Canvas text ignored the deck's fonts, and every texture load threw** — the
  SPA CSP was two directives too tight for PixiJS. `font-src 'self'` blocked
  HTMLText's font embedding (Pixi builds an SVG whose `@font-face` embeds the
  font as a **data URL** — `pixi.js/lib/scene/text-html/utils/loadFontCSS.mjs`,
  `src: url('${dataSrc}')`), so **every** canvas text fell back to a system
  face regardless of the deck — the render-side half of the 0.9.1 font problem,
  and independent of it. `connect-src 'self'` blocked Pixi's ImageBitmap probe,
  which fetches a 1×1 `data:` PNG inside the texture worker, so
  `checkImageBitmap` threw on every texture load. Both now allow `data:`.
  (PR #72, `931e648`.) Rationale:
  [ADR 0007](./docs/adr/0007-csp-as-a-renderer-constraint.md).
- **A config change could not reach the Caddy container.** Compose mounted
  `./caddy/Caddyfile` as a single file, and a single-file bind mount is pinned
  to the file's **inode**; the deploy syncs config in with rsync, which replaces
  files rather than rewriting them in place. The container kept reading the old,
  unlinked inode while the host file, `caddy validate` and `caddy reload` all
  reported success — which is exactly how the CSP fix above appeared not to
  land, and cost a debugging round the same day. The **directory** is mounted
  now (`./caddy:/etc/caddy:ro`). (PR #73, `e6b4042`.)

---

## 0.9.3 — A stale browser fixes itself (2026-09-09)

### Added

- **Version guard.** The build stamps its version into `/version.json` as well
  as into the bundle; a mismatch means the running document came from an HTTP
  cache while the server moved on, and the tab reloads — via
  `fetch(location.href, { cache: 'reload' })` first, because a plain reload
  would re-serve the stale entry. Checked at startup and on tab focus,
  throttled to once a minute. It refuses to act on an unreadable version and
  reloads at most once per served version, so an offline moment or a proxy
  pinned to an old document can't cost anyone their unsaved work.

  Background: `index.html` is served `no-cache`, but a browser that cached it
  _before_ that header existed applies heuristic freshness from
  `Last-Modified` — about 10 % of the document's age — and can keep serving a
  months-old copy, with the old build's hashed assets, for weeks. Production
  hit exactly that on 2026-09-09.

### Fixed

- `vite.config.ts` resolved the build version twice (once for the
  `__BUILD_VERSION__` define, once for the new asset); two independent calls
  can disagree, which would have reloaded every client once.
- Docker builds have no `.git`, so the version resolver fell back to
  `v<pkg>+build` — identical for every build of a version. `build-push.sh` now
  passes the real tag + sha via `VITE_BUILD_VERSION`.

---

## 0.9.2 — Canvas repaints when you come back to the tab (2026-09-09)

### Fixed

- **A deck could open to a blank canvas until the page was reloaded.** Pixi
  runs with `autoStart: false`, so the first paint is a synchronous
  `renderNow()` and everything after it — the deck's own objects, which arrive
  over the WebSocket after init — goes through `markDirty()` and a rAF. A page
  that isn't visible gets no animation frames, leaving that frame pending
  forever, and `markDirty()` early-returns while one is pending: the
  visibility handler therefore did nothing at exactly the moment a repaint was
  due. It now calls `renderNow()`, which cancels the stalled frame and paints
  synchronously, and also repaints on a bfcache restore (`pageshow` with
  `persisted`), where Pixi never re-initialises and so never gets a first
  paint at all.

---

## 0.9.1 — .pptx import: fonts and invisible text (2026-09-08)

### Fixed

- **Imported decks lost their fonts** — 73 % of the text in a real deck (699
  of 955 runs) arrived with no `fontFamily` and rendered in the browser's
  default face. Two causes, both in the .pptx parser: placeholder inheritance
  replaced the layout's entry over the master's _wholesale_ instead of merging
  per property, and OOXML theme font references (`<a:latin typeface="+mn-lt"/>`,
  how a template names its body font) were skipped outright. `theme1.xml`'s
  `<a:fontScheme>` is now parsed and `+mj-*` / `+mn-*` resolved, and fonts
  inherit the full chain: run → shape → placeholder → master `<p:txStyles>` →
  theme.
- **Text invisible on some imported slides** — same entry-level inheritance
  bug seen from the other side: a layout placeholder without `<a:xfrm>`
  shadowed the master's box, so the frame came out `0×0`. The renderer then
  word-wrapped at width 0 (one glyph per line, 4704 px tall on a 720 px slide)
  and its clip mask removed what was left.

---

## 0.9.0 — Production hardening: it actually runs behind Cloudflare (2026-09-07)

First tagged release since 0.8.1. It carries everything merged in between —
multi-level lists (Keynote/PowerPoint), the .pptx import/export work, the
public-release prep (PolyForm-NC license, PII genericised) and the move to
GHCR-built images — plus the fixes below, which is where the release name
comes from: five defects that only ever appeared on the deployed stack and
were invisible in `pnpm dev`. Full change set: `git log 0.8.1..v0.9.0`.

### Fixed — production-only breakage

- **415 on every upload and on logout** — Cloudflare re-frames a bodyless
  POST (`Content-Length: 0`) as `Transfer-Encoding: chunked`. Fastify's
  `isEmptyBody` check then fails, it looks for a parser for the absent
  `Content-Type` and answers `415 FST_ERR_CTP_INVALID_MEDIA_TYPE` before any
  route or hook runs. A `'*'` fallback parser accepts a genuinely empty body
  and still returns 415 for a real unsupported payload.
- **tus uploads died on the first HEAD** — Caddy rewrites `Host` to the
  upstream hostport and `handle_path /api/*` strips the prefix, so tus
  answered with `Location: http://server:3001/api/uploads/<id>`: a
  Docker-internal name, one path segment short. Answered relative now, so
  scheme and host come from the browser; the stripped prefix is restored from
  `X-Forwarded-Prefix`.
- **Imported decks rendered nothing** — Pixi v8 generates shader code with
  `new Function`, which the CSP (`script-src 'self'`) blocks, so `app.init()`
  threw and the renderer never started. Fixed with Pixi's own eval-free
  polyfill instead of loosening the policy.
- **Images never appeared on the canvas** — `worker-src 'none'` killed the
  Worker Pixi decodes textures in, so `Assets.load()` never settled. Slide
  thumbnails use a direct `Image.decode()` path and kept working, which
  masked it. Now `worker-src 'self' blob:`.
- **Backdrop blur missing under the side panels** — a hand-written
  `-webkit-backdrop-filter` made Lightning CSS drop the standard
  `backdrop-filter` from the minified build; dev, unminified, looked fine.
- **Deploys looked like they did nothing** — nothing set `Cache-Control` on
  the SPA document, so browsers cached `index.html` heuristically off
  `Last-Modified` and kept serving the previous bundle until a hard reload.

### Changed

- **GitHub Actions removed.** Both workflows are gone; checks run locally
  (`pnpm typecheck`, `pnpm lint`, `pnpm -r test`) per CLAUDE.md.

### Fixed — bug-hunt audit (2026-05-29)

Top findings from a whole-repo bug sweep. Details + remaining open
findings in [`docs/handoff/bugfix-audit-2026-05-29.md`](docs/handoff/bugfix-audit-2026-05-29.md).

### Fixed

- **Texture/sprite leak on rapid asset swap** — image and video renderers
  had no abort token for the _reload_ case, so swapping an object's asset
  twice before the first decode finished leaked the first texture's
  ResourceManager refcount (GPU memory) and orphaned its `Container`. Added
  a per-container monotonic load-generation counter; every async
  continuation now bails (releasing any acquired texture) when superseded.
- **Animation panel desync after slide reorder/sync** —
  `subscribeToSlideAnimations` never rebound after the slide's Y.Map was
  deleted-and-reinserted under the same id (`moveSlide`, Hocuspocus sync),
  so animation edits silently stopped reaching the timeline until a slide
  switch. Added the same `ctx.slides` rebind its objects-sibling already had.
- **Media upload provider unmount leak** — in-flight tus uploads and the
  self-rescheduling transcode poll (every 2 s, forever, even on error) were
  never cancelled on unmount, so navigating away mid-transcode left a
  runaway loop calling `setUploads` on an unmounted component. Added unmount
  cleanup + a disposed guard in the poll loop.
- **Folder cascade-delete now transactional** — `DELETE /folders/:id` ran
  the deck delete and folder delete as two separate statements; a crash
  between them caused permanent partial data loss. Wrapped both in one
  `db.transaction`.

---

## 0.8.1 — Visual fidelity & rendering fixes (2026-05-25)

Renderer quality pass focused on canvas sharpness, text fidelity, and
filter antialiasing. Shipped after the major library upgrade (Pixi 8.18,
TS 6, Vite 8, React 19, Tailwind 4) to leverage new Pixi v8 features.

### Fixed

- **Sharp canvas at zoom > 1** — dynamically scale renderer resolution
  (`dpr × zoom`, capped by 25M-pixel budget) so CSS `transform:scale()`
  doesn't upscale fixed-resolution pixels. Debounced 150 ms to avoid
  Pixi's HTMLTextPipe `generatingTexture` race. `forceTextResolutionRefresh`
  walks all HTMLText nodes (including table cells) to reset their GPU
  cache key and trigger re-rasterization at the new resolution.
- **Tab-switch repaint** — listen for `visibilitychange` and
  `markDirty()` when the tab regains focus. With `autoStart: false` the
  canvas never re-paints by itself, so backgrounded tabs came back with
  a partially rendered or blank canvas.
- **Filter FBO antialias** — set `antialias = 'on'` on DropShadowFilter
  and BlurFilter. Pixi v8 defaults to `antialias: "off"` on filter
  intermediate framebuffers, which stripped MSAA from shape edges when
  a shadow or blur was applied.
- **Global mipmaps** — set `TextureSource.defaultOptions.autoGenerateMipmaps = true`
  so large imported images (e.g. 4267×3200 PPTX logos) downscale
  smoothly instead of showing aliased staircase edges.
- **Text word-wrap mismatch** — Pixi's SVG foreignObject used
  `max-width` while the contenteditable overlay uses fixed `width`.
  The subpixel measurement difference compounded across lines, clipping
  the last characters. Fixed by injecting `width: Xpx` via cssOverrides.
- **Paste line breaks lost** — Chrome wraps pasted lines in `<div>`
  elements, but `getElementInnerText` only recognized `<br>` as line
  breaks. Added `<div>`/`<p>` block-boundary detection.
- **ResizeObserver** — uses `clientWidth`/`clientHeight` (CSS-transform-
  independent) instead of `getBoundingClientRect()` which returned
  scaled dimensions inside the zoom wrapper.

---

## 0.8.0 — First-class TableObject (M29) (2026-05-18)

Adds a native `TableObject` to the slide model + editor. Tables can be
inserted from the toolbar, edited inline (per-cell rich text, borders,
fills, padding), and round-trip through the existing M28 PPTX paths
(import / export wired in a follow-up). Replaces the "exploded grid of
RectangleObject + TextObject" workaround that landed with M28.

Full plan: [`docs/plans/m29-table-object.md`](./docs/plans/m29-table-object.md).
Handoff + deploy notes:
[`docs/handoff/0.8.0-table-object.md`](./docs/handoff/0.8.0-table-object.md).

### Added

- **Schema** — `TableObject` with `rows / colWidths / rowHeights /
defaults / borderSegments`. Cells carry per-cell style overrides
  - merge-cell pointers. Borders use a **flat segment-keyed map**
    (`h:<row>:<col>` / `v:<row>:<col>`) so every grid line is one
    value — no more two-cells-own-this-edge ambiguity that double-painted
    shared borders.
- **`getEffectiveBorderSegment`** + `hSegKey` / `vSegKey` exported from
  `@narrative/shared` — explicit `borderSegments` wins, falls back to
  deriving from legacy `cell.border` for back-compat reads.
- **Renderer** (`apps/web/src/renderer/objectRenderers/tableRenderer.ts`)
  — three-pass scene graph (per-cell fill Graphics → per-cell HTMLText
  → shared border Graphics). Outer-rim strokes aligned INSIDE the table
  - per-corner patch fill give clean Keynote/Excel-style corners.
- **Inspector** (`apps/web/src/ui/TableInspector.tsx`) — reuses the
  shape inspector's `IdentitySection`, `PositionSection`,
  `TypographySection` (now exported), `AnimationsSection`, `LayersPanel`.
  Scope-aware: edits dispatch through range → active cell → defaults.
  Folder text-style presets bind to tables via `TableDefaults`.
- **Border preset UX** — clicking a preset _selects_ it and primes the
  Style / Color / Width inputs with the existing segment values
  (shows "Mixed" when targeted segments aren't uniform). Adjusting
  any input restamps the active preset with the new value.
- **Fill support** — linear gradient / radial gradient / image fill on
  tables, routed through the shared `FillBody` + `ResourceManager`
  procedural cache. A table-wide gradient on N cells acquires N refs
  to ONE texture; gradient-stop drag paints one canvas per frame.
- **Per-cell rich-text editor** — `apps/web/src/ui/TableCellEditor.tsx`
  hosts a TextEditOverlay bound to the cell's Y.Text. Enter inserts
  a paragraph (matches text-box behaviour). Cmd/Ctrl+Enter / Tab /
  Shift+Tab still navigate cells.
- **Canvas chrome** — `TableChrome` adds move handle, add-row /
  add-col affordances, col-letter / row-number headers, drag-to-resize
  for column widths + row heights.
- **Gestures** — tap on a selected table enters cell mode; drag moves
  the whole table; drag inside cell-active mode selects a range.
- **Toolbar grid picker** — `TableGridButton` opens a 10×10 popover
  (Word / PowerPoint / LibreImpress style). Hover sizes, click commits
  - drops a table on the active slide. The `K` shortcut still
    activates legacy click-to-place mode for keyboard users.
- **Structural mutations** — `insertTableRow / Col` and `deleteTableRow /
Col` shift `borderSegments` keys so the user's existing border lines
  stay in place after a row / column edit.
- **Tests** — 39 new tests in `packages/slide-model/src/tableMutations.test.ts`
  covering presets, segment shift on structural edits, and the shared-edge
  single-value invariant. 257 / 257 slide-model tests green.

### Changed

- **`Inspector.tsx`** — renamed internal `TextSection` to `TypographySection`,
  exported it with a `features: TypographyFeatures` prop. Table inspector
  passes the same component with text-only features (preset menu /
  paragraph spacing / list style / stroke / color-alpha) gated off as
  needed. Same component now serves both shapes and tables.
- **`fillStyleToPixi.ts`** — `acquireOrPaint` / `releaseProceduralFill` /
  `fillStyleToPixi` gained an optional `slotKey` defaulting to `'_default'`.
  Single-fill renderers (shapes) unchanged; multi-fill renderers
  (the table cell grid) pass per-cell slot keys so the slots don't
  clobber each other. New `releaseAllProceduralFills(container)`
  walks the map for destroy hooks.
- **`imageFillLoader.ts`** — added per-key multi-slot variant
  (`ensureImageFillKeyed` / `releaseImageFillKeyed` /
  `releaseAllImageFillsKeyed`) for tables. Single-slot API unchanged
  for shape renderers.
- **Bundle hash** — `index-DeshjMfs.js` (637 KB, +23 KB vs 0.7.x).

### Fixed

- **`apps/server/package.json`** — promoted `jszip`, `fast-xml-parser`,
  `pptxgenjs` from `devDependencies` to `dependencies`. They were
  imported at runtime by the M28 PPTX parser / exporter but excluded
  from the production image's `pnpm install --prod` pass, so the server
  crashlooped with `ERR_MODULE_NOT_FOUND` for `jszip` on the first
  prod redeploy after M28 landed.

### Why

The M28 PPTX import landed tables as "exploded grids of `RectangleObject` +
`TextObject` shapes sharing a `groupId`". That round-trips a deck through
PowerPoint with acceptable fidelity, but the user can't insert a table
from scratch in Narrative, can't add a row, can't resize columns
independently. M29 adds the native object type so all of that works
inline, then keeps the M28 import / export paths working during the
migration (separate follow-up will retire the exploded-grid heuristic).

### Note on milestone numbering

`BUILD_PLAN.md` originally planned M29 as "performance + observability +
polish". That work has been deferred to a later milestone — the table
object was promoted ahead of it because M28's PPTX round-trip needed a
real table type to be useful. Stale `M29+` references elsewhere in
`README.md` (DRM, video-worker limits, MinIO console restrictions)
refer to the old plan; they belong to a future renumber pass.

---

## 0.7.0 — Sharing rework: invite by email + pending invites (2026-05-13)

Closes the usability gap from M10: invite collaborators by email instead
of by opaque Google `sub`, list pending invites, and show real
names/initials throughout the sharing UI.

### Added

- **`apps/server/drizzle/0013_users_and_invites.sql`** + Drizzle schema entries:
  - `users` table — directory keyed by Google `sub`, with email/name/picture_url. Populated on every `/auth/callback`. Backfilled from existing `sessions` rows on migration so the dialog renders correctly immediately after deploy.
  - `deck_invites` table — pending email invites with 30-day expiry, partial-unique on `(deck_id, LOWER(email))` for non-accepted rows.
- **`apps/server/src/auth/users.ts`** — `upsertUser`, `getUserBySub`, `getUserByEmail`, `listUsersBySubs`.
- **`apps/server/src/auth/invites.ts`** — `createInvite`, `listPendingInvitesForDeck`, `revokeInvite`, `consumePendingInvitesForEmail` (called from `/auth/callback`, converts pending invites to permission rows on first login).
- **`/auth/callback`** now upserts the user directory and consumes pending invites for that email before issuing the session cookie.
- **`POST /decks/:id/permissions`** rewritten to accept `{ email, role }`. Returns `200 { kind: 'granted', user }` when the email matches an existing user, or `201 { kind: 'pending', invite }` when the invitee hasn't signed in yet.
- **`GET /decks/:id/permissions`** enriched with `email` + `name` per row via a single IN-list join.
- **`GET /decks/:id/invites`** + **`DELETE /decks/:id/invites/:inviteId`** for listing and cancelling pending invites.
- **`GET /folders/:id/active-editors`** response shape changed from `{deckId, userIds:[sub]}` to `{deckId, users:[{userId,email,name}]}` so presence bubbles can render real initials.
- **`apps/web/src/ui/ShareDialog.tsx`** rewritten: invite by email with client-side validation, displays name + email per collaborator (with email subtitle when a display name is set), pending-invites section with cancel button, role-change uses the upsert-by-email path.
- **`apps/web/src/pages/FolderDecks.tsx`** `ActiveEditorsBubbles` rewritten to take enriched user objects; tooltip shows `Name (email) is editing`.
- **Tests**: 4 new server route tests covering enriched listPermissions + the granted/pending invite split + invite list/revoke. ShareDialog test rewritten for the email-input + name display + pending-invites flow (11/11).
- **`docs/handoff/0.7.0-sharing-rework.md`** — deploy + verification runbook.

### Changed

- `BUILD_PLAN.md` — M10 split: M10.1 is the server-session cutover (0.6.x), M10.2 is the sharing rework (0.7.0). Original M10 deliverable wording trimmed to match what actually shipped first.

### Why

The 0.6.x server-session migration exposed a UX cliff: every sharing surface displayed the Google `sub` (a 21-digit number) because nothing in the schema tied that sub to a human-readable identifier. Inviting a collaborator required them to send you their `sub`, which they can't even find. 0.7.0 makes the feature actually usable.

---

## 0.6.0 — Server-driven session cookies (2026-05-13)

Replaces the browser-PKCE flow that put the Google `id_token` into
`localStorage` (and only kept users signed in for ~1 h until the
hidden-iframe silent renew failed on Safari / privacy-strict Firefox)
with a proper server-driven OAuth + opaque session cookie flow. The
browser now only holds an opaque session id; the actual tokens never
leave the server.

User-visible: sessions last 30 days with sliding expiry, work in every
browser identically, and survive reboots without re-prompting.

### Added

- **`apps/server/drizzle/0012_sessions.sql`** + **`sessions` table in the Drizzle schema** — `id_hash` (SHA-256 of the cookie value), `user_sub`, `user_email`, `user_name`, `created_at`, `last_used_at`, `expires_at`, `revoked_at`, `user_agent`, `ip`. Indexed on `user_sub` and `expires_at`. A read-only DB compromise can't be used to impersonate active users because the raw cookie value never lands in the DB.
- **`apps/server/src/auth/session.ts`** — `createSession`, `lookupSession`, `revokeSession`, `revokeAllSessionsForUser`, `sweepExpiredSessions`. Every `lookupSession` touches `last_used_at` and slides `expires_at` forward by 30 d in one round-trip via Drizzle's `update().returning()`.
- **`apps/server/src/routes/auth.ts`** — server-driven OAuth: `GET /auth/start` (mints PKCE state + 302 to Google), `GET /auth/callback` (exchanges code → id_token → verifies via existing `JwtVerifier` → INSERTs session + Set-Cookie + 302 to returnTo), `GET /auth/me` (returns session user or 401), `POST /auth/logout` (revokes + clears cookie). State cookie is HMAC-signed via `@fastify/cookie`'s built-in signing.
- **`@fastify/cookie`** plugin registered in `apps/server/src/index.ts` with `SESSION_COOKIE_SECRET` env. CORS gets `credentials: true` so dev cross-origin (5173 → 3001) carries the cookie.
- **`SESSION_COOKIE_SECRET`** required env var (server throws on boot in prod without it). Documented in `.env.example` and `infra/.env.prod.example`.

### Changed

- **`apps/server/src/auth/fastifyAuth.ts`** — `authPreHandler` now reads the `narrative_session` cookie and looks up the session row instead of decoding a Bearer JWT. `AuthPluginOpts` drops the `verifier` field. Same `request.user` shape on the way out so route handlers don't change.
- **`apps/server/src/hocuspocus/index.ts`** — `onAuthenticate` parses the `Cookie:` header from the WS upgrade request instead of consuming a `token` arg from the client. Same-origin (prod) and same-site (dev) automatically carry the cookie on WS upgrade — no client-side token plumbing required.
- **`apps/web/src/state/AuthContext.tsx`** — rewritten. `login()` is a top-level navigation to `${API_URL}/auth/start`. `logout()` POSTs `/auth/logout` then bounces to `/auth/login`. On mount fetches `/auth/me`. `token` is gone from the context value — all API calls use `credentials: 'include'`.
- **`apps/web/src/api/client.ts`** — drops the Authorization header path; all requests now go out with `credentials: 'include'`. `createApiClient()` is a no-arg factory.
- **`apps/web/src/state/{Slide,Folder}DocProvider.tsx`, `state/componentDocCache.ts`, `state/writeComponentMasterTree.ts`** — drop the `token` arg passed to `HocuspocusProvider`. Cookie-based same-origin/same-site auth replaces it.
- **`apps/web/src/renderer/{imageUrl,videoInfo}.ts`** — fetch with `credentials: 'include'`; token-getter args removed.
- **`apps/web/src/state/useMediaUpload.tsx`** — `tus.Upload` now runs with `withCredentials: true`; no more Bearer header on PATCH.
- **CORS** in `apps/server/src/index.ts` gets `credentials: true` so dev cross-origin fetches carry the cookie.

### Removed

- **`oidc-client-ts`** dependency.
- **`apps/server/src/routes/authProxy.ts`** — replaced by the new `/auth/start` + `/auth/callback` routes.
- **`apps/web/src/pages/AuthCallback.tsx`** — the server handles the callback now and 302's straight back to the SPA's `returnTo`. The React Router route for `/auth/callback` is also removed.
- **`VITE_OIDC_*` build-time env vars** (`VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID`, `VITE_OIDC_REDIRECT_URI`) — no longer needed; the SPA does not configure any OIDC client. Removed from `.env.example`, `infra/.env.prod.example`, `apps/web/Dockerfile`, and `infra/scripts/deploy.sh`.
- **`registerComponentDocTokenGetter` / `setComponentDocTokenGetter`** and the cache's `tokenGetters` registry — the WS upgrade carries the cookie automatically.
- **`useAuth().token`** — gone from the public context shape; tests that referenced it have been updated.

### Operational notes

- **Google Cloud Console redirect URIs** must be updated before deploying:
  - Add: `https://narrative.example.com/api/auth/callback` (prod) and `http://localhost:3001/auth/callback` (dev).
  - Remove: the old `https://narrative.example.com/auth/callback` once prod redeploys.
- **`OIDC_CLIENT_SECRET`** must be set on the prod VM (`/home/user/narrative/infra/.env.prod`). Already there from 0.5.x; no change needed.
- **`SESSION_COOKIE_SECRET`** must be added to `.env.prod`: `openssl rand -hex 32`.
- Migration `0012_sessions.sql` runs automatically on next prod deploy via `migrate.js`.
- All existing sessions invalidate at cutover: users will need to log in once more. Subsequent logins last 30 days sliding.

### Why

The browser-PKCE flow needed third-party cookies + a hidden iframe to refresh the id_token, which is increasingly broken (Safari since 2020, Firefox ETP-strict, eventually Chrome). Sessions effectively maxed out at 1 h. The id_token also sat in localStorage which is XSS-readable. The server-driven session cookie addresses all of that and is the pattern every grown-up SaaS uses (Linear, Notion, GitHub, Vercel…).

---

## Google OIDC end-to-end + first production deploy (2026-05-12)

First public deployment of Narrative. Live at
`https://narrative.example.com` via a Cloudflare Tunnel on the
home-lab. Auth is real Google OIDC with PKCE; the `client_secret`
required by Google's "Web application" client type lives only on the
server, so the SPA bundle stays clean.

### Added

- **`apps/server/src/routes/authProxy.ts`** — `POST /api/auth/google/exchange`. Browser sends `code` + `code_verifier`; server adds `OIDC_CLIENT_SECRET` (env-only) and forwards to Google's token endpoint. The SPA points `oidc-client-ts`'s `token_endpoint` here via `metadataSeed`, declaring `token_endpoint_auth_methods_supported: ['none']` so the library treats the client as public and skips its "client_secret is missing" guard.
- **`infra/docker-compose.prod.shared-tunnel.yml`** — new prod topology for hosts that share an upstream Cloudflare Tunnel (e.g. the one already routing nextcloud + others on the home-lab docker VM). Caddy publishes on host:80 (so the external tunnel can reach it via LAN IP); the bundled `cloudflared` service is profile-gated out via `profiles: [internal-tunnel]`; internal services drop their `127.0.0.1:` host-port publishes via `ports: !reset []` (sidesteps a Docker 29.4 port-bind race on rapid container recreate); OIDC + media env vars are explicitly piped from `.env.prod` into the server container; `narrative-server` healthcheck overridden to use `127.0.0.1` (BusyBox `wget` resolves `localhost` to IPv6 first, which Fastify doesn't bind).
- **`apps/web/e2e/prod-oauth-smoke.spec.ts`** — non-destructive smoke test that hits the prod URL, confirms the login redirect, parses the Google OAuth URL, and asserts client_id / redirect_uri / PKCE params without actually completing Google's consent screen.
- **`docs/handoff/google-auth-handover.md`** — operating notes for the deploy target (VM 103 `narrative` on Proxmox, SSH jump path, architecture diagram).
- **Server-side `apps/server/src/db/migrate.ts`** rewritten as a custom per-file-transaction migrator (~50 lines). Each migration runs as its own implicit transaction via node-postgres simple query protocol, so `ALTER TYPE ... ADD VALUE 'font'` commits before subsequent migrations reference the new enum value. Drizzle's built-in migrator wraps all pending migrations in one outer transaction, which Postgres rejects with `unsafe use of new value … of enum type` (error 55P04) — this hit `0009_m16_consolidate_fonts` on every fresh deploy. Tracking table layout (`drizzle.__drizzle_migrations`) matches drizzle's so the built-in could resume if needed.

### Fixed

- **`packages/shared`** missing `yjs` declaration — `src/slide.ts` did `import type * as Y from 'yjs'` but `yjs` wasn't in the package's deps. Worked in dev via pnpm hoisting, broke in Docker's isolated `--frozen-lockfile` install. Added as devDependency.
- **`apps/web`** missing `y-protocols` — same class of bug. Added.
- **`apps/server/Dockerfile`** runtime `CMD` pointed at `apps/server/dist/index.js`, but tsc emits with workspace-root rootDir (cross-package imports include files outside `apps/server/src/`) so the actual entry is `apps/server/dist/apps/server/src/index.js`. Same path mismatch for `db/migrate.js` (used by deploy.sh). Both paths corrected.
- **`apps/server/Dockerfile`** workspace package resolution — `pnpm install` symlinks `node_modules/@narrative/*` to `packages/<pkg>/`, where `package.json` says `"main": "./src/index.ts"`. Node can't load `.ts` at runtime. Mirrored the video-worker Dockerfile pattern: copy compiled JS from the builder stage on top of the symlinked source dir, then `sed` `package.json` to point at `./src/index.js`. Applied to `@narrative/shared` and `@narrative/slide-model`.
- **Drizzle migrations path** — compiled `migrate.js` lives 4 dirs deeper than expected, so `path.resolve(__dirname, '../../drizzle')` resolved wrong. Dockerfile now copies `drizzle/` to BOTH the original `apps/server/drizzle/` and the deeper `apps/server/dist/apps/server/drizzle/` location.
- **pnpm 10 `[ERR_PNPM_IGNORED_BUILDS]`** in Docker — pnpm 10 fails the install if any package's postinstall script isn't explicitly whitelisted. Web Dockerfile uses `--ignore-scripts` (esbuild's postinstall just verifies a platform binary that's already in `@esbuild/linux-x64`; skipping is safe). Root `package.json` declares `pnpm.onlyBuiltDependencies: [esbuild, @swc/core, msgpackr-extract]` as a longer-term fix.
- **`apps/web/Dockerfile`** missing `VITE_OIDC_*` build args — Vite bakes `import.meta.env.VITE_*` at build time. Added `VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID`, `VITE_OIDC_REDIRECT_URI`, `VITE_IMGPROXY_URL` as ARG + ENV. `deploy.sh` passes them via `--build-arg` derived from `${DOMAIN}` and `.env.prod`.
- **Auth callback race** — `apps/web/src/pages/AuthCallback.tsx` previously created its own `UserManager` and listened for events that the `AuthProvider`'s separate `UserManager` instance never received. Plus, even when the right instance got the event, `navigate('/')` raced the React state commit so `<ProtectedRoute>` rendered with `user=null` and bounced back to `/auth/login` — requiring a second login attempt. Fixed by routing the callback through `AuthProvider.completeSignin()` (single shared `UserManager`) and using `flushSync` to commit the user state before navigating.
- **AuthError page** — was hardcoded "session expired" text. Now reads `location.state.error` and renders the actual `signinRedirectCallback` error message in a red pre block, so unknown failures are debuggable without DevTools.
- **`oidc-client-ts` `loadUserInfo: true`** — was triggering an extra round-trip to Google's userinfo endpoint after the token exchange. The id_token JWT already carries `sub` / `email` / `name`, so the call is redundant — and any failure (CORS, rate limit) was fatal to the whole sign-in. Disabled.

### Changed

- **`infra/scripts/deploy.sh`** — new `USE_SHARED_TUNNEL=1` flag toggles the override compose file, skips the bundled-cloudflared healthcheck, and probes server health via `docker exec` (no host port published in shared-tunnel mode).
- **Top toolbar** — `apps/web/src/components/EditorLayout.tsx` — the toolbar now spans the full width above the side panels (was previously squeezed between them). Slides + Inspector panels start at `top: topBarH`; toolbar at `z-20` over the panels.

### Infrastructure

- **VM 103 `narrative`** on Proxmox `pve` — Ubuntu 24.04 cloud image provisioned via `qm create` + cloud-init from this machine over SSH (Proxmox MCP can inspect but not create). 4 vCPU / 4 GB RAM / 40 GB disk on the `data` lvmthin pool. `petr` user, ed25519 key auth, NOPASSWD sudo, Docker 29.4.3 + Compose v5.1.3, qemu-guest-agent reporting IP to Proxmox.
- **OPNsense dnsmasq static reservation** — `BC:24:11:18:A0:ED → 192.0.2.147` so the LAN IP stays put and the Cloudflare Tunnel public-hostname mapping (`narrative.example.com → 192.0.2.147:80`) doesn't break on lease renewal.

### Removed

- Stale Playwright artifact directories at `apps/test-results/` and `test-results/` (also added to `.gitignore`).

---

## Audit + test debt cleanup (2026-05-09)

Multi-stage codebase audit and test-suite consolidation. Eight commits
on `main`: `1e53cf5` (Tier 1 security/leaks/bundle), `7081697`
(Tier 2 render storms / animation lifecycle / observer race), `229658d`
(centralised Pixi mock), `778bab1` (web suite cleanup + e2e migration),
`d8ed687` (testing strategy doc), `d026e68` (Tier A), `7edebd9`
(Tier B), `d504f83` (Tier C).

### Added

- **`/CLAUDE.md`** — project guide telling Claude sessions which test commands to auto-run for which kinds of changes (renderer, mutations, auth, etc.) and the architecture invariants not to violate.
- **`docs/testing-strategy.md`** — strategy + roadmap doc, all three tiers (A/B/C) marked complete.
- **`packages/slide-model/src/convergence.property.test.ts`** — fast-check property-based CRDT convergence (3 properties, 400 random op sequences per run): disjoint+sync, three-client star topology, offline-then-reconnect.
- **`apps/server/src/hocuspocus/lifecycle.test.ts`** — server doc-cache leak guard (cache returns to 0 after debounce, 50× open/close stays bounded, reopen reuses cached entry).
- **`apps/web/e2e/keyboard-shortcuts.spec.ts`** — replaces 14 jsdom-misplaced unit tests; covers Toolbar (R/O/T/V), input-focus suppression, present-mode entry, slide nav, present-layout exit.
- **`apps/web/e2e/renderer-visual.spec.ts`** — sampled-thumbnail visual regression (always-on) + opt-in pixel-perfect baselines (`RUN_VISUAL_BASELINES=1`).
- **`apps/web/e2e/destructive-flows.spec.ts`** — deck delete + cascade, share-link revoke happy + IDOR guard, folder cascade, Drafts protection.
- **`apps/web/e2e/multi-client-collab.spec.ts`** — three browser contexts converging through real Hocuspocus + offline/online catch-up via `setOffline`.
- **`apps/web/e2e/inspector-flows.spec.ts`** — full Inspector e2e replacing deleted DOM-presence component tests.
- **`apps/web/src/test/pixiMock.ts`** + **`apps/web/src/test/renderWithProviders.tsx`** — single-source-of-truth mock factory and provider wrapper (replaces ~20 inline copies).
- **`tests/load/runAll.mjs`** — load-test harness with absolute thresholds + 20% drift warnings vs `tests/load/baselines.example.json`.
- **`.lighthouserc.json`** + `pnpm lighthouse` script — Core Web Vitals on the editor route (warn-level FCP/LCP/TBT/CLS/TTI).
- **`packages/slide-model/stryker.config.json`** + `pnpm --filter @narrative/slide-model mutate` — Stryker mutation-testing pilot targeting `mutations.ts` + `slides.ts`.
- **`pnpm size`** — size-limit budgets per chunk + total first-paint ≤ 800 KB gz (currently 747).
- Vite `manualChunks` split — main app chunk down from 836 KB gz to 189 KB gz.

### Fixed

- **Tier 1**: security blockers (auth bypass paths, IDOR on share-link revoke, missing rate-limits on auth endpoints), server resource leaks (Hocuspocus doc-cache eviction with `unloadImmediately:false` + `debounce:2000`), bundle hygiene.
- **Tier 2-A**: render storms — memoised `SelectionContext`, `SlideDocProvider`, `EditorLayout` array refs.
- **Tier 2-B**: server-side leaks — Hocuspocus lifecycle settings, doc cache returns to 0 after disconnects.
- **Tier 2-C**: animation lifecycle — Magic Move `onComplete` chained via `eventCallback('onComplete')` instead of overwriting; `playTransition` snap-final-state guard restored.
- **Tier 2-E**: `subscribeToSlides` race — `slideObserve` no longer fires partial state during transactions.
- **`InputBridge`** listener leak — single-overwrite replaced with `Set<cb>` broadcast.
- **`videoRenderer`** shared `containerRegistry` race — registry keyed by node id, cleared on unmount.
- **`useMediaUpload` tests** — switched mock from `getHeader` to `getBody` (server moved metadata to JSON body because browser CORS strips custom headers).

### Changed

- **Web test suite**: 102 failures → 0; 61 skipped → 23 (all remaining skips have rationale comments in-file). Total across all packages: 1,219 unit + integration tests pass, 0 fail.
- **`pnpm dev`** — now starts web + server + video-worker (was only web + server). Added `pnpm dev:no-worker` for the old behaviour.
- **`hls.js`** — moved back to static import after lazy-import broke video rendering on first play; vendor-hls chunk split kept.
- **`bullmq` + `ioredis`** — Node 25 ESM compat fix: default-import + destructure named exports.

### Removed

- ~80 DOM-presence component tests (`getByText('Fill')`, `expect(button).toBeInTheDocument()`) — replaced by e2e or deleted as no-signal.
- 6 `objectRenderers/*.test.ts` files asserting Pixi mock-call shapes — replaced by sampled-thumbnail e2e.
- 14 jsdom keyboard-shortcut tests — moved to `apps/web/e2e/keyboard-shortcuts.spec.ts` (real focus model required).
- 6 `FillTokenTab.test.tsx` skips for retired UX (Token tab folded into colour-picker popover during M16-P8).
- Empty `describe` blocks left over after deletions.

### Technical decisions

- `Y.encodeStateAsUpdate` is **not** canonical (clock entries serialise in insertion order). Property-based convergence asserts structural deep-equality of `listSlides()` output (with `JSON.parse(JSON.stringify(slide))` to strip live `Y.Text` / `Y.XmlFragment` refs).
- Visual regression is two-tier: sampled-thumbnail tests run always (cross-platform robust); pixel-perfect baselines opt-in via env var (avoid baseline-churn from font-rendering differences).
- Lighthouse + Stryker are NOT on every PR — `pnpm size` and `pnpm load:all` are. Slow gates run nightly / pre-release.
- Sub-agents in this repo MUST run on Opus (memory-noted): Sonnet output needed reviewer rework on M16 P5/P6.

---

## M1 — Scene graph + resource manager (2026-04-19)

### Added

- **`pixi.js` v8** — PixiJS v8 přidán jako production dependency do `apps/web` (WebGL/WebGPU renderer, hoistován přes pnpm workspace)
- **`vitest` + `jsdom`** — Test runner a browser environment pro unit testy renderer vrstvy
- **`apps/web/src/renderer/Canvas.tsx`** — React komponenta pro mount/unmount Pixi Application; StrictMode safe (ref guard), ResizeObserver, HiDPI (resolution=DPR, autoDensity=true), Pixi v8 API (`app.canvas`, `app.init()`)
- **`apps/web/src/renderer/SceneGraph.ts`** — Scene graph wrapper; ID-based diff reconciler (add/update/remove); žádné přímé Pixi mutace mimo renderer modulů
- **`apps/web/src/renderer/ResourceManager.ts`** — Centrální správce GPU zdrojů; ref counting pro textury; `acquireTexture` / `releaseTexture` / `destroyAll`
- **`apps/web/src/renderer/types.ts`** — `SlideObjectData` discriminated union; `RectangleObject`; `BaseSlideObject`; připraveno na rozšíření v M2
- **`apps/web/src/renderer/coords.ts`** — DPR-aware coordinate transforms; `worldToScreen` / `screenToWorld`; dokumentuje povinnou DPR compensation (Spike C nález)
- **`apps/web/src/renderer/objectRenderers/rectangleRenderer.ts`** — První object renderer; Pixi Graphics fill; pivot na středu objektu pro správnou rotaci
- **`apps/web/src/renderer/objectRenderers/index.ts`** — Renderer registry (Map<type, renderer>); připravena na rozšíření v M2
- **`apps/web/src/data/demoSlide.ts`** — Hardcoded demo data: dva obdélníky (modrý + červený, různá opacity a rotace)
- **`apps/web/src/renderer/ResourceManager.test.ts`** — 10 unit testů: ref counting, acquire/release, destroyAll, textureCount
- **`apps/web/src/renderer/SceneGraph.test.ts`** — 9 unit testů: ID diff add/update/remove, destroy, edge cases
- **`docs/adr/0002-renderer-architecture.md`** — ADR pro renderer architekturu (PixiJS v8, SceneGraph, ResourceManager, DPR transforms, StrictMode safety)

### Changed

- **`apps/web/src/components/EditorLayout.tsx`** — Canvas placeholder nahrazen `<Canvas slideData={demoSlide} />` — center pane nyní mountuje živý Pixi canvas
- **`apps/web/vite.config.ts`** — Přidán `build.target: 'esnext'` (top-level await pro Pixi v8 `app.init()`); přidána `test` sekce pro vitest s jsdom environment

### Technical decisions

- Vitest spouštěn přes `node ../../node_modules/vitest/vitest.mjs run` (Windows pnpm hoisting nenechá `.bin/vitest` fungovat bez full path)
- `rectangleRenderer` ukládá Graphics referenci přes Symbol property na Container — `any` cast s komentářem; vylepšeno v M2
- `objectRenderers/index.ts` registry Map používá `any` pro generické varianty ObjectRenderer — nutné pro heterogenní registry; vylepšeno v M2
- ResourceManager testován s Pixi Assets mock — testy nepotřebují GPU ani browser

---

## M0 — Foundation (2026-04-19)

### Added

- **Monorepo** — pnpm workspaces with `apps/web`, `apps/server`, and four `packages/*` shells (`shared`, `slide-model`, `animation`, `ui`)
- **`apps/web`** — React 18 + Vite 6 + TypeScript strict + Tailwind CSS v3; 3-pane editor layout shell (Slides sidebar, Canvas center, Inspector sidebar)
- **`apps/server`** — Fastify 5 + TypeScript ESM skeleton; `GET /health` endpoint with pino structured logging on port 3001
- **`tsconfig.base.json`** — Shared strict TypeScript config (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`)
- **`eslint.config.js`** — Flat ESLint 9 config with `@typescript-eslint/recommended`, `react-hooks/recommended` for web, `@typescript-eslint/no-explicit-any: error`
- **`.prettierrc`** — `singleQuote: true`, `semi: false`, `printWidth: 100`
- **`.github/workflows/ci.yml`** — CI pipeline: lint → typecheck → build → test on every push/PR to `main`; Node 22 + pnpm 10; dependency caching
- **`infra/docker-compose.yml`** — Postgres 16 Alpine with named volume, health check, `POSTGRES_PASSWORD` required from env
- **`.env.example`** — Env var template with comments for all current and future variables
- **Husky v9 + lint-staged** — Pre-commit hooks: ESLint + Prettier on staged `.ts`/`.tsx` files
- **`docs/adr/0001-monorepo-layout.md`** — ADR for monorepo structure, why pnpm workspaces (not Turborepo yet), why single `apps/server` app

### Technical decisions

- `shamefully-hoist=true` in `.npmrc` to resolve Windows pnpm symlink issues (documented in spike-A handoff)
- `concurrently` for parallel dev startup (`pnpm dev` starts both web and server)
- Server uses `--experimental-strip-types` for dev (no separate tsc compile step in dev mode); production build is separate
- No PixiJS in M0 — canvas placeholder only; PixiJS mounts in M1
