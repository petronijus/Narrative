# A2 — extraction: the editor writes only through commands

Execution plan for phase A2 of [`agentic-layer.md`](./agentic-layer.md) §10
(Appendix B is the checklist it works through). Written 2026-09-28, at
v0.10.1.

## Goal

"State = Yjs, **written only through commands**" (ADR 0010) becomes true in
the editor, not just for agents:

- every document write in `apps/web/src` goes through `useCommand()` (the BrowserHost), so each user gesture is a
  registered command with the same validation and the same logic an agent
  gets over MCP;
- the web-only logic that decides _what_ to write (defaults, geometry, rules)
  moves into `packages/commands` handlers, where agents reach it too;
- token seeding and text-style propagation move to the server, so they reach
  decks nobody has open;
- the A2 part of `knownMissing.ts` (32 entries) is empty and `A2` is in
  `FINISHED_PHASES`.

## Starting point (measured 2026-09-28)

- `useCommand()` exists (`apps/web/src/state/useCommand.ts`) and nothing
  calls it.
- 22 web files import slide-model writers; 9 call `doc.transact` directly
  (`FolderDocProvider` 8×, `TableInspector` 5×, the text-edit helpers).
- 94 commands, 32 A2 known-missing entries.

## Mechanisms

### The lint rule, on from the first step, with a shrinking exemption list

"Per directory" (plan §9.1) would leave `ui/` — most of the editor — without
the rule until the very last step. Instead:

- `no-restricted-imports` (writers of `@narrative/slide-model`) and a
  `no-restricted-syntax` ban on `.transact(` apply to all of
  `apps/web/src/**` (tests excepted) from step 1 — wider than plan §9.1's
  four directories, so state/ helpers cannot launder a writer either;
- files not migrated yet are listed in `ONE_DOOR_PENDING`
  (`apps/web/eslint.one-door.js`), each with the step that migrates it; the config ignores the rule for
  exactly those files;
- a test fails when a listed file no longer violates the rule (so a migrated
  file must leave the list) — the list only shrinks, like `knownMissing.ts`;
- new files are covered automatically.

The writer list is not hand-written: it is generated from
`SLIDE_MODEL_EXPORTS` (`kind === 'writer'`), so a new writer is banned in the
UI the moment it is classified.

### Gestures and undo

A continuous gesture (drag, resize, rotate, scrub) dispatches one command
per pointer move, as it writes one mutation per move today. Each dispatch is
one `LOCAL_ORIGIN` transaction; the editor's `Y.UndoManager` keeps merging
them within its capture window exactly as now, so undo granularity does not
change. Where a gesture writes several things per move (move + imageRect),
that becomes one command (or one `batch`), which is strictly better than
today's separate transactions.

### Live-binding editors

Rich-text typing on the canvas (`TextEditOverlay`) and the speaker-notes
editor (Tiptap + y-prosemirror) write through an editor binding per
keystroke, not through a one-shot mutation.

- Canvas text: typing becomes a `text.edit` command (splice ops at
  character offsets with formatting) — useful to an agent too (a precise
  edit inside a long box without resending it). Paragraph patches and
  indent become `text.paragraphs.*` / `text.list`.
- Speaker notes stay on the y-prosemirror binding (it is a CRDT binding,
  not a slide-model writer, and re-implementing ProseMirror steps as
  commands buys nothing); the capability reaches agents as
  `slide.notes.get` / `slide.notes.set` (markdown in, markdown out), which
  write the same `Y.XmlFragment`. Recorded in the allowlist
  (`parity/allowlist.ts`, "Speaker-notes live editing"), since the lint
  cannot see the binding's writes.

### Server-side token work

Folder tokens live in the folder document (`folder:<id>`), which the server
host can already open. `token.*` commands get the `folderDoc` effect and
run on the server; the Folder Settings UI calls them through the command
API. Propagation of a changed text style / colour to linked objects runs
server-side over every deck in the folder (a service the command calls), so
it no longer depends on an open `DeckShell`.

## Steps

Each step: commands + contract tests + eval scenario for every new command,
the UI switched, its files off the lint exemption list, its known-missing
entries gone, `pnpm capabilities`, the auto-run table green, `agent-parity`
invoked, release. Steps are ordered so the riskiest UI (text, tables) comes
after the mechanism has been proven on simpler surfaces.

| #     | Step                                   | Commands (new ✚ / existing)                                                                                                                                                                                                                                                                                                      | Web files                                                                                           |
| ----- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A2.1  | Guard rails                            | —                                                                                                                                                                                                                                                                                                                                | `eslint.config.js`, `apps/web/eslint.one-door.js` + `src/oneDoor.test.ts`                           |
| A2.2  | Slides, notes, slide copy, deck copy   | slide.\* existing; ✚ `slide.notes.get`, `slide.notes.set`, `slide.copyTo`, `deck.duplicate`                                                                                                                                                                                                                                      | `SlidesPanel`, `slideHelpers`, `slideClipboard`, `SlideItemMenu`                                    |
| A2.3  | Guides                                 | guide.\* existing                                                                                                                                                                                                                                                                                                                | `Rulers`                                                                                            |
| A2.4  | Object creation and structure          | object.create/delete/duplicate/group/ungroup/layer/align/distribute/move/update existing, creation defaults moved into `object.create`                                                                                                                                                                                           | `EditorLayout`, `EditorContextMenu`, `Toolbar`, `UploadDropZone`, `EditorVideoPreview`, `DeckShell` |
| A2.5  | Transforms                             | ✚ `object.resize`, `object.rotate`, `object.flip`, `object.alignToSlide`, `object.crop.set`                                                                                                                                                                                                                                      | `TransformHandles`, `CropOverlay`, Inspector geometry                                               |
| A2.6  | Paths and lines                        | ✚ `object.path.create`, `object.path.fromShape`, `object.path.setAnchors`, `object.line.setEndpoints`                                                                                                                                                                                                                            | `PathPointsOverlay`, `LineEndpointHandles`, pen session in `EditorLayout`                           |
| A2.7  | Clipboard                              | ✚ `object.copyTo` (clipboard.ts becomes a thin UI)                                                                                                                                                                                                                                                                               | `state/clipboard.ts`, paste paths                                                                   |
| A2.7a | Agent file upload (Petr, 2026-09-28)   | ✚ `media.uploadSession`: opens a one-time, deck-scoped, short-lived session on the existing tus upload (`/api/uploads`) and returns its URL + token, so an agent with a shell (Claude Code) streams a local file with `curl` and gets the asset id back — no base64 through the model's context, same checks as a browser upload | — (server + commands; `media.upload` keeps URL / small base64)                                      |
| A2.8  | Fill, effects, slide number            | ✚ `object.fill.gradient`, `object.effects.shadow`, `object.slideNumber.set`                                                                                                                                                                                                                                                      | Inspector fill/effects, `SlideNumberPromptDialog`                                                   |
| A2.9  | Animation                              | animation.\* existing; ✚ `animation.retarget`                                                                                                                                                                                                                                                                                    | `AnimationTimeline`, `MoveToTargetOverlay`, Inspector animation                                     |
| A2.10 | Tables                                 | table.\* existing; ✚ `table.setSize` (the planned `table.cell.setText` was dropped: see Progress)                                                                                                                                                                                                                                | `TableChrome`, `TableInspector`, `TableCellEditor`                                                  |
| A2.11 | Text                                   | ✚ `text.edit`, `text.setBoxTypography`, `text.style.apply`, `text.replace`, text.set with formatting                                                                                                                                                                                                                             | `TextEditOverlay`, `textEditSelection`, `textListOps`, Inspector typography                         |
| A2.12 | Tokens, components, server propagation | ✚ `token.{color,textStyle,effectStyle}.{create,update,delete}`, `token.seedDefaults`, `text.style.createFromObject`, `component.promote`; propagation server-side                                                                                                                                                                | `FolderDocProvider`, `FolderSettings`, `DeckShell` propagation, `writeComponentMasterTree`          |
| A2.13 | Close                                  | parity guard enumerates shortcuts and menu action ids; exemption list empty; `FINISHED_PHASES += 'A2'`; ADR 0010 status; handoff note                                                                                                                                                                                            | `useShortcuts`, menus, `testApi` (dev-only test hooks go through commands too)                      |

## Progress

- 2026-09-28: plan written.
- 2026-09-28: **A2.1 done** — the one-door rule is on for all of
  `apps/web/src` with 26 files on the pending list; it caught
  `state/applyShapeMask.ts` re-exporting a writer.
- 2026-09-28: **A2.2 done** — `SlidesPanel` dispatches commands only
  (`useCommand().run / tryRun / group`); new `slide.copyTo`,
  `slide.notes.get` / `.set` (Markdown, converter loaded lazily),
  `deck.duplicate`; `deck.insertFrom` takes chosen slide ids. Decisions made
  on the way:
  - **Cross-deck slide paste runs on the server** (`POST
/decks/:id/insert-slides` → the `deck.insertFrom` service): media is
    deck-scoped, and the old browser paste left pasted images pointing at
    the source deck's assets. Consequence: a cross-deck paste reaches the
    editor as a remote change, so Mod+Z does not undo it (like a `.pptx`
    dropped into the panel); a same-deck paste (`slide.copyTo`) is one local
    undo step.
  - The clipboard holds a reference (deck + slide ids), not content; paste
    reads the live source.
  - Outline rules moved into `packages/commands/src/outline.ts`; every
    structural slide command normalises the outline.
  - `runGroup` / `useCommand().group` for multi-command gestures: one
    transaction, one undo step, no fork (an atomic batch forks the whole
    deck, too slow per gesture), not all-or-nothing.
  - The notes editor keeps its y-prosemirror binding (not a command,
    allowlisted); `slide.notes.set` is the agent's door to the same fragment.
    `getSlideNotes`, which installed a fragment when a pre-M19 slide was
    merely viewed, is gone: `getSlideNotesFragment` only reads, and the
    notes panel offers "Add speaker notes" (→ `slide.notes.set`) instead.
  - New eval scenarios: `slide-notes-talking-points`, `slides-copy-block`,
    `slides-outline-nest` (recorded, replay free) and `deck-duplicate-named`
    (live only). The replay guard now fails when a replayable scenario has
    no recording.
- 2026-09-28: **A2.3 done** — `Rulers` / `GuideOverlay` write through
  `guide.add` / `.update` / `.remove`; `useDeckGuides` is read-only. Found on
  the way: "Delete guide" in a guide's context menu did nothing with the
  mouse (React bubbled the portal's pointer events to the line's drag
  handler and the canvas, which captured the pointer); new e2e
  `guides.spec.ts` covers drag-out, move, drag-off and the menu.
- 2026-09-28: **A2.4 done** — object creation (tool drag, context-menu
  insert, toolbar table, uploaded / dropped media), delete, duplicate
  (Mod+D, menu, Alt-drag), group / ungroup, layer order, arrow-key nudge,
  lock toggle, mask-with-shape, the context menu's table row / column /
  merge / split and the video mute toggle all dispatch commands.
  `EditorVideoPreview` is off the exemption list; the other files stay on
  it, re-tagged with the step that removes their last direct write
  (EditorLayout: drag A2.5, pen A2.6, paste A2.7; EditorContextMenu: paste
  A2.7; Toolbar / UploadDropZone: component stamping A2.12; DeckShell:
  style propagation A2.12). Decision: the folder "Primary" colour a new
  shape gets is an editor default the UI passes to `object.create`
  explicitly, not command behaviour — an agent picks colours itself
  (preferably folder tokens, as the basics playbook says).
  - tools/list budget 132,000 → 136,000 bytes; A2 will keep adding ~1–1.3 KB
    per new command.
- 2026-09-28: **A2.5 done** — `object.resize`, `object.rotate`,
  `object.flip`, `object.alignToSlide`, `object.crop.set` (ops set / pan /
  zoom / rotate / reset). `TransformHandles`, `CropOverlay`, the canvas drag
  and the Inspector's geometry, layer order, layers panel and multi-select
  actions dispatch commands; `TransformHandles` and `CropOverlay` are off
  the exemption list, the `applyShapeMask` re-export is deleted. Decisions:
  - **Geometry is shared, not duplicated**: `packages/commands/src/geometry.ts`
    (`resizeFromHandle`, `placeResized`, `scaleCrop`, `visualBounds`) is what
    the handles compute a drag with and what `object.resize` applies, so the
    two cannot drift.
  - **A handle drag sends the snapped box explicitly** (`object.resize` with
    x / y / width / height) — snapping is an editor affordance, the command
    only applies the box and scales the crop.
  - **Continuous gestures stay absolute and idempotent**: the canvas drag
    writes `object.update` positions from the pointer-down snapshot (the
    crop rule moves a picture by the frame's change against the live value);
    a multi-object handle drag sends `object.move` for the not-yet-applied
    part of the travel. Each frame is one command, one transaction; the undo
    manager's capture window still merges a gesture into one step.
  - **The crop overlay writes nothing on entry.** The picture moves with
    `object.crop.set` (frame-relative); the frame moves or resizes with
    `object.update` carrying the current `imageRect`, which also makes an
    implicit crop explicit at the first real change.
  - Behaviour now matching the handles: Inspector W / H scale a crop and
    keep a rotated object's top-left corner; align-to-slide uses the
    rotated outline.
  - tools/list budget 136,000 → 142,000 bytes (`object.crop.set` is 2.4 KB:
    its union of five ops).
- 2026-09-28: **A2.6 done** — `object.path.create`, `object.path.fromShape`,
  `object.path.setAnchors`, `object.line.setEndpoints`. The pen, the point
  editor, the line end handles and double-click shape-to-path dispatch
  them; `PathPointsOverlay` and `LineEndpointHandles` are off the exemption
  list. Decisions:
  - **Points go in slide px, the object keeps its rotation and mirroring.**
    The commands fit the box around the given points in the object's own
    axes (`fitAnchors`, the exact inverse of how the renderer places local
    points), so a point lands where it was given. That makes every drag
    frame absolute and idempotent (snapshot on pointer-down + pointer
    travel), and an agent never converts frames. Stored anchors / p1 / p2
    stay relative to the box, as before.
  - **Shape-to-path keeps the object** (`replaceObject` in slide-model: same
    id, same index, one transaction) instead of delete + create on top, so
    animations, Magic Move pairing and stacking survive; paint, shadow,
    blur, link and group carry over; rounded corners and ellipses are traced
    with cubic arcs.
  - Found on the way: the line handles and the point editor ignored
    rotation / mirroring, and the slide observer never re-emitted an object
    replaced in place (a delete + insert of one id was always taken for a
    reorder). Both fixed, with tests.
  - **A path's box is what it draws** (`drawnBounds`: anchors plus each
    cubic's turning points, following the renderer's segment rules), not
    the bounding box of its handles as the pen and point editor used to
    make it — alignment and the selection box follow the stroke.
  - `setAnchors` also takes `moves` (anchors by index to slide points); the
    point editor sends only the dragged anchor, so a 20,000-anchor PPTX
    path (`MAX_PATH_ANCHORS`, now in `@narrative/shared`) edits cheaply.
  - Open question for Petr: the canvas draws a triangle inscribed in its
    box's ellipse while PowerPoint's triangle fills the box, so a PPTX
    triangle looks smaller in Narrative. Not changed here (it would resize
    every existing triangle); shape-to-path follows the canvas.
    **Resolved 2026-09-29** (Petr: fix it): a triangle now fills its box like
    PowerPoint's; one outline definition in `@narrative/shared`
    (`shapeGeometry.ts`) serves the renderer, masks, preview, shape-to-path
    and the PPTX writer.
  - tools/list budget 142,000 → 152,000 bytes (`object.path.create` is 4.1
    KB: its `object` field is the path's create schema).
- 2026-09-28: **A2.7 done** — `object.copyTo`, `object.insert`,
  `object.insertFromDeck` (+ `POST /decks/:id/insert-objects`). Canvas copy /
  cut / paste dispatch them; `EditorLayout` and `EditorContextMenu` are off
  the exemption list. Decisions:
  - **The object clipboard keeps content, not only a reference** (unlike
    the slides panel's): objects can be cut, and after a cut the sources are
    gone. It stores the ids AND the objects as `query.slide` read them.
    Paste takes the most faithful path that still applies: `object.copyTo`
    (exact, live) in the same document while the sources exist; the
    snapshot through `object.insert` after a cut; the server's
    `object.insertFromDeck` into another deck.
  - **`object.insert` takes exactly the query shape** (text `paragraphs`,
    table cells with theirs), validated per type with the strict create
    schemas; only required properties take type defaults, so a read-then-
    insert round trip is exact (tested on the whole fixture slide).
  - **Cross-deck objects reuse the slide-copy staging**: the planned objects
    are built in a scratch document and rewritten there (`rewriteForTarget`,
    extracted from `stageCopy`: slide links, media and fonts, tokens), then
    cloned onto the target slide in one server write. The command is
    server-only (browser commands cannot load asynchronously); the editor
    calls the route, so a cross-deck paste reaches it as a remote change.
  - Parity review follow-ups fixed before release: inserted objects are
    also checked against the storage schema (grid, merges, borders, trim,
    asset — what the field-wise create schema cannot see) plus the 100-track
    table cap; a cut that could not be pasted back is refused; `fromDeck`
    equal to the target is refused; media references the source deck does
    not own count as skipped; component masters get their own clipboard
    identity (`documentKey`, `component:<id>`).
  - **For A2.12:** pasting between a component master and a deck goes
    through `object.insert` without copying pictures (master media is
    scoped `component:<id>`); bring masters into the server-side staging
    when components move onto the server.
  - tools/list budget 152,000 → 157,000 bytes.
- 2026-09-28: **A2.7a added** at Petr's request: MCP can call `media.upload`
  only with a public URL or base64 the model writes out itself — a local
  picture of any real size does not fit through the context. The tus upload
  the browser uses already exists; the command opens it for an agent.
- 2026-09-28: **A2.7a done** — `media.uploadSession`. Decisions:
  - **The existing tus upload, not a new endpoint**: tus creation-with-upload
    takes the file in the creating POST and answers with the finish hook's
    asset JSON, so one `curl` line is the whole upload, with the editor's
    checks.
  - **A dedicated one-time credential** (`nus_`, table `upload_sessions`)
    rather than handing out a personal access token (agents may not mint
    those) or a signed stateless token (single use needs state that
    survives a restart): hash-only storage, 15 min to start, bound to its
    first upload by an atomic claim, 2 h to finish it, media into its own
    deck only, and recognised by tus alone.
  - The eval harness gained per-scenario workspace files and a shell, so the
    scenario runs the returned curl exactly as Claude Code would.
- 2026-09-29: **A2.7a hardened after a security review** (released 0.10.10):
  - **A session is bound to the declared file** — the agent passes
    `sizeBytes` (from `wc -c`), the server stores size and kind, tus refuses
    a different `Upload-Length`, a deferred length or another kind. This also
    took the `$(wc …)` substitution out of the curl line: Claude Code's
    permission rules refuse command substitution, so the restricted eval
    shell (`curl` and `wc` only) could not run it.
  - Sessions die with the credential that opened them (PAT or MCP grant)
    and with the account kill switch; 10 unused per user; the owner's
    sign-in policy is re-checked on every use; GET of an upload is 404.
  - An agent's upload proves its type (`strictContent`), per-kind size caps
    apply before reading.
  - One list of credential prefixes (auth/credentialPatterns.ts) feeds the
    Sentry scrubber, the audit log, the eval recordings and reports, and
    the WebSocket, which now refuses every agent credential.
  - PUBLIC_API_URL must be https except on loopback.
- 2026-09-29: **A2.8 done** (released 0.10.11) — `object.fill.gradient`,
  `object.effects.shadow`, `object.slideNumber.set`. Decisions:
  - **Commands read folder tokens** (`CommandContext.folderTokens`,
    `readsFolderTokens`): resolving a token fill before seeding a gradient
    and applying the page-number text style both need them, and so will
    `text.style.apply` (A2.11) and the token commands (A2.12). The browser
    passes FolderDocProvider's snapshot once synced (`synced` flag — before
    that it is an empty placeholder, not "no tokens"); the server reads the
    folder document for the commands that declare the flag, also inside an
    `ops.apply` batch (agent/folderTokens.ts). Absent tokens → `conflict`,
    never a guess.
  - **One text-style mapping** (commands `text/textStyle.ts`) for the
    editor's TextStylePropagator and every command that links a style. The
    Inspector's old page-number dialog wrote its own subset and stored the
    colour as a hex string; the command writes what propagation writes.
  - Gradient: without `stops` a new gradient seeds from the shape's colour
    (token resolved and unlinked first), an existing one keeps its stops, so
    Linear ↔ Radial no longer reseeds. Table defaults keep patching through
    FillBody's fallback (same `seedGradientStops`) until A2.10.
  - A latent race in the fill picker fixed on the way: a second mode change
    before React re-rendered was compared with the stale render's mode and
    dropped (`fill-mode-switch` "rapid" e2e failed under load).
  - The Claude Code plugin's version now follows the Narrative release
    (generated by `pnpm --filter @narrative/commands skill`): at 0.1.0
    forever, installed skills were never updated.
  - tools/list budget 159,000 → 164,000 bytes.
- 2026-09-29: **Triangle geometry** (Petr: fix the open question from A2.6)
  — a triangle fills its box like PowerPoint's; see the A2.6 entry.
- 2026-09-29: **A2.9 done** (released 0.10.12) — `animation.retime`, `animation.retarget`;
  `query.slide` / `query.object` report each step's `start`. The timeline
  (remove, trigger and easing pickers, bar drag, edge resize, video clip
  drag), the move-to handle and the Inspector's animation section dispatch
  commands; `AnimationTimeline` and `MoveToTargetOverlay` are off the
  exemption list, `useAnimations` is read-only. Decisions:
  - **The timeline's sequence model is a command.** Dragging a bar used to
    compute, in the component, each step's trigger and delay from absolute
    times and reorder the list; `animation.retime` does that now, and an
    agent says "start at 2 s" instead of working out triggers. The drag
    sends every bar (the dragged one at its new time, the others at their
    drag-start times), so each frame is absolute and idempotent.
  - **onClick steps are pushed, not refused.** A click step cannot start
    before its predecessor ends; retime moves it to that end (re-sorting,
    since it may now follow steps that start earlier) and keeps every other
    step's time. Found by the parity review: the first version timed the
    steps after a pushed click step from its requested start.
  - **The layout lives in `@narrative/shared`** (`layoutAnimationSteps`):
    `@narrative/animation` loads GSAP at import, which the server-side
    commands must not. Its test against the compiler moved to
    packages/animation.
  - **Plan appendix B's `animation.setMoveTarget` and
    `animation.videoTiming` are not separate commands**: a moveTo target is
    `animation.update` params (merged, so `{ targetX, targetY }` alone), a
    video clip's timing is `object.update` `videoTrigger` / `videoDelay`,
    now explained in its description (caveat 6). A video delay is never
    negative (object schema); the clip drag stops at its anchor instead of
    storing an invalid negative delay.
  - Found on the way: resizing a bar stuck to where the previous frame put
    it (the magnet snapped to the next step's live start, which had moved
    with the edge) — snap targets are now frozen at drag start; viewers got
    enabled animation controls in the Inspector; a 0 s duration could be
    typed there.
  - **Open (not changed):** present mode ignores `videoTrigger` /
    `videoDelay` — it starts a video by `autoplay` / `playOnClick` — so the
    timeline's video clip timing is display and PPTX export only. Making
    playback honour it is a feature of its own.
  - tools/list budget 164,000 → 167,000 bytes (the new "Animation step id"
    shared field takes back a little).
- 2026-09-29: **A2.10 done** (released 0.10.12) — `table.setSize`; `table.style.table`
  `overrideCells`; `object.fill.gradient` on tables (whole table or
  `cells`). The chrome (move, boundary drag, add / remove handles), the
  table Inspector and the cell editor dispatch commands; `TableChrome`,
  `TableInspector` and `TableCellEditor` are off the exemption list, and
  FillBody's seeded-patch fallback is gone (every host passes
  `setGradient`). Decisions:
  - **No `table.cell.setText`.** `text.set` / `text.format` / `text.list`
    already address a cell (`target.cell`, since A0); a second command for
    the same write would only split the agent's choice. The Inspector's
    whole-cell format fallback is `text.format` on the cell.
  - **The row / column count loops are `table.setSize`**, absolute: the
    steppers send the count they want, the add / remove handles the count
    the pointer is at, so a repeated frame changes nothing (plan appendix
    B6's `table.setSize`). A boundary drag is `table.resizeColumn` /
    `resizeRow` with `keepTableSize` and the dragged track's size from the
    pointer-down snapshot, clamped so both tracks keep `MIN_TRACK_PX`.
  - **"Paint the whole table" is command behaviour** (`overrideCells`):
    the table-wide fill used to clear the cells' overrides in the component
    before setting the default; an agent asked to recolour a table meets the
    same problem.
  - **Table gradients go through `object.fill.gradient`**, not a table
    command, so the seeding / token-unlink / keep-the-stops rules exist
    once. Per cell they start from the colour the cell shows (its override,
    else the default); a whole-table gradient takes the cells' own gradients
    away like a table-wide fill. Tables paint a gradient with `fillAlpha`,
    so a "no colour" (alpha 0) table or cell gets alpha 1 with it — shapes
    ignore `fillAlpha` under a gradient and are unaffected.
  - **The routing stays in the Inspector** (range, else the active cell's
    merge origin, else the table): it follows the editor's selection, which
    an agent names itself; a Typography change that writes cells and
    defaults is one `group`.
  - Found on the way (pre-existing, both fixed): Tab into the next cell
    reused one TextEditOverlay across cells, so it showed the previous
    cell's text and the first keystroke's diff wrote that text into the new
    cell; and after Tab / Cmd+Enter appended a row, the editor closed for a
    frame (the slide snapshot is rAF-batched), losing keys typed at once.
    The overlay is now keyed by cell and the editor reads a cell the
    snapshot lacks from the document. e2e `table-commands` pins both.
  - Still in the Inspector for A2.11: a text-style preset on a table writes
    its fields through `table.style.table` but the preset mapping itself is
    the Inspector's `applyTextStyle` (`text.style.apply` should take tables
    too).
  - Parity review follow-ups fixed before release: the fill picker's
    Image mode wrote a placeholder image fill without a picture
    (`assetId: ''`), which the table style commands refuse — so Image did
    nothing on a table (and on a shape stored an invalid fill). The picker
    now shows the chooser as a local draft and writes the fill once the
    upload has an asset (e2e "Image fill on a table …"). A whole-table
    gradient now always takes the cells' own `fillStyle` and `fillAlpha`
    and never their `fill` (it took whatever the gradient happened to
    write, so a token default also wiped the cells' colours).
    `overrideCells` got a schema description; the `text.style.apply`
    known-missing entry now says it must take tables.
  - tools/list budget 167,000 → 169,000 bytes.

- 2026-09-30: **A2.11 done** (released 0.10.13) — `text.edit`, `text.replace`,
  `text.setBoxTypography`, `text.style.apply`; the context carries the
  folder's font faces (`readsFolderFonts`, `ctx.folderFonts`). The
  Inspector (every remaining patch, the Typography section, lists, the
  slide's transition and background), the family / weight pickers, the text
  selection and list helpers and the canvas text editor dispatch commands;
  `Inspector.tsx`, `TextEditOverlay.tsx`, `textEditSelection.ts` and
  `textListOps.ts` are off the exemption list. Done in two parts (a: the
  Inspector and typography, b: typing), released together. Decisions:
  - **Typing is `text.edit`, in display offsets.** The editor diffs the DOM
    as before and sends one splice per input event; Enter, the list
    Backspace and paste are `text.edit` too (`key: "Enter" | "Backspace"`),
    Tab is `text.list` `indent`. The Enter / Backspace list rules moved into
    the command (`text/edit.ts`); splitting a paragraph is a new slide-model
    writer, `splitParagraphAt`. Offsets are the ones queries report (a
    paragraph break counts 2), so an agent edits what it read; the editor
    converts its stored-text offsets (`displayRangeOf` / `rawOffsetOf` in
    `@narrative/commands`). Each keystroke is one command and one
    transaction; the undo manager still merges typing as before.
  - **"\n\n" inserted is a paragraph** (continuing the list it splits), as
    in `text.set`; a single "\n" is a line break.
  - **Box typography is one command with the editor's rules**
    (`text.setBoxTypography`): the inline formatting of the attributes it
    sets is removed, a new family keeps the weight on a cut it has, and on a
    box linked to a text style the fields become overrides. Override
    tracking and the weight rule used to live in the Inspector
    (TypographySection's patch wrapper, FontFamilySelect); both now also
    apply to a table's defaults through `table.style.table`. The Inspector
    keeps only the routing: the selected part of the text being edited gets
    `text.format`, otherwise the box gets `text.setBoxTypography`
    (`useTextFormat`). Change: a box-wide change made while editing with a
    collapsed caret now also removes the inline formatting of that
    attribute, as it always did from a selected box.
  - **The font rules moved to `packages/commands`** (`text/fontWeights.ts`,
    was `apps/web/src/ui/fontWeights.ts`), so the pickers and the command
    share them. The server reads a folder's faces from its font assets
    (`agent/folderFonts.ts`); a family that is not a system stack with the
    faces unknown is refused (`conflict`), never guessed.
  - **Text styles are applied by id or name** (`text.style.apply`), to text
    boxes and to tables' defaults; an unknown name answers with the
    folder's style names, so an agent needs no token command to find them
    (those are A2.12). `reset` also removes inline formatting (and, in a
    table, the cells' own text styling); `null` unlinks. The Preset
    picker's "Update preset" and "Create new text style" still write the
    folder document through FolderDocProvider (A2.12).
  - **Image mode writes nothing until a picture is chosen**, for fills
    (A2.10) and now for the slide background, which had no way to pick a
    picture at all: it gets the fill's upload chooser.
  - Found on the way: pasted multi-line text built paragraphs the diff read
    back wrongly (an empty paragraph and a stray line break) — paste is now
    one `text.edit`; the transition duration could exceed the schema limit
    and viewers could change the transition (both guarded). Tests of UI
    helpers that no longer write were moved onto the commands
    (`textFormatUndo.test.ts` → `typography.test.ts`, the preset picker test
    reads the document).
  - Parity review follow-ups fixed before release: a range may no longer
    start or end between the two characters of a paragraph break
    (`text.edit` refuses it, `text.replace` does not match across half a
    break — both could cut a break in half); the browser keeps serving the
    folder's font list while it refetches after an upload (a family change
    was refused as "fonts unknown" meanwhile); `text.edit`'s second example
    and three descriptions that still sent box typography to
    `object.update` were corrected.
  - Open: `text.style.apply` has no eval scenario yet — eval folders have no
    text styles until A2.12 seeds tokens on the server. The inline font
    picker stores only a stack's primary family, while `text.format` /
    `text.set` store the family as given (pre-existing; normalise in the
    command).
  - Verified: full e2e 167 passed / 15 skipped; full agent eval 39/39
    ($4.77, the first full costed run).
  - tools/list budget 169,000 → 177,000 bytes.

## Where we stand (2026-09-30, after A2.11)

Done and released: A2.1–A2.11 and A2.7a (0.10.2–0.10.13; A2.11 in 0.10.13,
2026-09-30). `ONE_DOOR_PENDING` holds 6 files (A2.12: `Toolbar`,
`UploadDropZone`, `DeckShell`, `FolderDocProvider`,
`writeComponentMasterTree`; A2.13: `testApi`), `knownMissing` 12 A2 entries
(19 in all: A3 5, A4 2). 121 commands (74 document, 47 server-only).

**tools/list headroom is ≈ 470 bytes.** Measured 2026-09-30 during A2.11,
before the last example tweak: ≈ 175,569 (form) / 176,529 (url) /
176,433 bytes (link) for 121 tools against the 177,000 budget (was 169,000
after A2.10). A2.11 added ≈ 7.7 KB: `text_setBoxTypography` 2,638,
`text_edit` 2,416, `text_style_apply` 1,343, `text_replace` 1,334. Not
re-measured after the tweak; the next command needs the per-step raise
Petr agreed for A2.

Next, in order:

1. **A2.12 Tokens, components, server propagation** — `token.*` CRUD and
   `token.seedDefaults` on the server (folders an agent creates have no
   tokens until someone opens them in a browser: no page-number style,
   `folderTokens` null), `text.style.createFromObject`, `component.promote`
   (the page-number dialog's component branch still calls
   `promoteSelectionToComponent`), text-style propagation server-side
   (DeckShell's TextStylePropagator), media copy when pasting between a
   master and a deck. Also:
   - the Inspector's Preset picker "Update preset" and "Create new text
     style" still write the folder document through FolderDocProvider —
     they move onto the token commands here;
   - `text.style.apply` needs an eval scenario once tokens are seeded
     server-side (eval folders have no text styles until then).
2. **A2.13 Close** — parity guard over shortcuts and menu ids, empty
   exemption list, `FINISHED_PHASES += 'A2'`, ADR 0010 status, handoff note;
   then the holistic tools/list size review (budget 177,000 today).

Open, outside the steps:

- a running Claude Code session only sees new MCP tools after `/mcp` →
  Reconnect (documented in the plugin README);
- present mode ignores `videoTrigger` / `videoDelay` (see the A2.9 entry);
- the timeline draws an `onClick` step at its predecessor's end, while the
  compiler anchors the click pause at the end of everything before it
  (`tl.duration()`); the two differ after an overlapping `withPrevious`, so
  such a bar is drawn earlier than it plays. Pre-existing, not changed in
  A2.9; `packages/animation/src/__tests__/timelineLayout.test.ts` leaves
  onClick out of its contract for that reason.
