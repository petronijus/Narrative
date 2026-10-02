# A2 — extraction: the editor writes only through commands

Execution plan for phase A2 of [`agentic-layer.md`](./agentic-layer.md) §10
(Appendix B is the checklist it works through). Written 2026-09-28, at
v0.10.1. **Closed 2026-09-30 with A2.13** (see "Where we stand" at the end;
handoff: [`../handoff/A2-extraction.md`](../handoff/A2-extraction.md)).

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
change. (Since 2026-10-02 the gesture's pointer boundaries decide instead of
the capture window — `state/undoGestures.ts`, [`dev-speed.md`](dev-speed.md).) Where a gesture writes several things per move (move + imageRect),
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
    manager's capture window still merges a gesture into one step (its
    pointer boundaries since 2026-10-02, `state/undoGestures.ts`).
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
    formerly in apps/web's `ui/`), so the pickers and the command
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

- 2026-09-30: **A2.12a done** (released 0.10.14) — folder tokens on the
  server. A2.12 is split: **a** tokens and propagation, **b** components
  (`component.promote`, browser stamping, master ↔ deck media). New
  `token.create` / `token.update` / `token.delete` / `token.seedDefaults`,
  `text.style.createFromObject` / `text.style.updateFromObject`,
  `token.list`. `DeckShell` and `FolderDocProvider` are off the exemption
  list. Decisions:
  - **One command per verb, the category in the input** — not the planned
    `token.{color,textStyle,effectStyle}.*` nine: the categories share every
    rule (owner only, one folder document, the same undo) and differ only in
    fields, which a discriminated union carries. Nine tools would have cost
    ≈ 3× the tools/list bytes for no extra safety.
  - **The folder document has one reader and one set of writers**
    (slide-model `folderDoc.ts`), used by the server, the fakes and the
    editor; the default tokens moved there from `apps/web`. The server's
    `tokensSnapshot` (which kept malformed entries and live `Y.Map` params)
    is gone; a token's id is its key in the category map.
  - **Seeding happens when a folder is created** (and Drafts when it is
    provisioned); existing folders are brought up to date by a **one-time
    data migration** that runs after the server starts. Data migrations are
    new infrastructure (`services/dataMigrations.ts`, table
    `app_data_migrations`, migration 0026): they change documents, so they
    must go through the sync server like any edit, which a SQL migration
    cannot; a completed one is recorded with its report, a failed one is
    not and runs again on the next start. On the dev database the first
    one found 17 folders, all already seeded (browsers had opened them),
    and re-styled one linked text box that lagged its style.
  - **Propagation is the server's.** A text-style change (or a colour a
    style uses) re-styles the linked text boxes **and table defaults** in
    every deck and component master of the folder, open or not
    (`propagateToFolder`: a dry run on a copy, the live write only when it
    changes something, `TOKEN_PROPAGATION_ORIGIN` — on nobody's undo stack,
    in no agent run). The browser's `TextStylePropagator` only reached
    decks someone opened later, never tables, and wrote on every open.
    Undo of a token change is `token.update` back, which propagates the
    same way.
  - **The page writes tokens through routes the commands claim**
    (`POST/PATCH/DELETE /folders/:folderId/tokens/…`), not through
    `POST /commands`: that door runs as an agent (a run in the Agent
    activity popover), and a person's edit in Folder Settings is not one.
    `state/folderTokenWriter.ts` validates with the command's schema, keeps
    one request in flight per token and merges what changed meanwhile into
    one follow-up (a colour-picker drag sends a handful of requests, each
    re-styling the folder), and shows pending changes over the document's
    tokens until the document has them. The Inspector's preset actions wait
    for the folder document to show the new style (`whenTokens`) and then
    link the box with `text.style.apply`, given those tokens explicitly
    (`useCommand().run(…, { folderTokens })`) — the snapshot the click's
    render captured is older.
  - **`token.list` was missing**: nothing told an agent a token's id, so
    `token.update` / `token.delete` were unusable except right after
    `token.create`. First drafted as a document query (`query.tokens`,
    viewer role); the security review pointed out it would hand every deck
    viewer the whole owner-only folder, and the parity review that an empty
    folder could not be read at all — so it is a folder-scope, owner-only
    server read. `restyle-lite` reads it first (the folder is `deck.get`'s
    `folderId`).
  - **Effect styles are read and deleted, not created or changed**: nothing
    applies one (no renderer, no UI), so offering to make them would promise
    an effect that never appears. The folder document keeps them.
  - **Validation lives in the store, not in the doors.** The security
    review found `text.style.createFromObject` / `updateFromObject` passing
    a box's raw values (any collaborator can write those) into the folder
    and on into every deck. `parseNewTokenFields` / `parseTokenPatch`
    (commands `tokens.ts`) run in the TokenService for every caller, and
    the page's writer uses the same parser. A family name may not contain
    `; { } < > \` or control characters, and the renderer now escapes
    family names in the HTMLText SVG's CSS whatever their source.
  - **Bounded propagation**: a change that changes nothing writes and
    re-styles nothing; propagation runs one per folder, requests arriving
    meanwhile merge into one next run that reads the folder afresh (also
    keeps two quick changes from leaving decks on different values); the
    routes are rate-limited (120/min) and need Narrative's origin for a
    session (`requireSameOrigin`, as `POST /commands`).
  - **Undo of token changes**: `token.update` and
    `text.style.updateFromObject` return the previous values and
    `token.delete` the removed token (so they are in the agent's op log);
    `token.seedDefaults` is honestly irreversible (confirm always) — its
    styles are built in and cannot be deleted. Styles made by a person are
    stored `builtin: false`, so a later seed never takes one named "Body"
    for a default.
  - **Data migrations try at most three times** (`attempts`, `last_error`
    in `app_data_migrations`): a document that can never be migrated would
    otherwise make every restart sweep every folder.
  - **Text style names are unique in a folder** (create and rename refuse a
    taken name, `conflict`). Found by the first live run of
    `quote-style-from-box`: the default styles include "Quote", the agent
    made a second "Quote" from the box, and `text.style.apply` by name then
    linked the other quotes to the old one. The Inspector's dialog already
    refused a taken name; Folder Settings now names a new style
    "New style 2", "New style 3", … . Existing duplicates are left as they
    are (by-name lookup takes the first).
  - The eval's memory world models folder tokens (seeded folders, the
    token service, propagation into its decks), so the three new scenarios
    replay.
  - Found on the way: Folder Settings silently ignored "System default"
    family and "As typed" case (both sent an empty change), and rewrote a
    style's weight as soon as it was opened when its family lacked that cut
    — now the weight stays listed, marked. Deleting a component wrote a
    `deletedComponentIds` signal and a window event nothing had read since
    component instances were dropped; both removed.
  - The dev server's automatic migration is drizzle's own migrator, which
    skips a journal entry whose `when` is older than the newest recorded
    migration; `db:migrate` records the time it ran, so hand-written
    entries need the current time (drizzle README). `db:migrate` itself
    fails on the local database at 0003 (the file changed after it was
    applied) — pre-existing, dev only.
  - Verified: full e2e 169 passed / 15 skipped before the review fixes
    (new `folder-tokens.spec.ts`: a Folder Settings change reaching an open
    and a closed deck, the Inspector's two preset actions); full agent eval
    42/42 ($5.52) after them — `heading-one-font` failed once because its
    grader compared a whole family stack ("Inter, system-ui, sans-serif",
    what the Inspector's picker stores for Inter) with "Inter"; it now
    compares the stack's primary family.
  - tools/list budget 177,000 → 187,000 bytes: 186,157 measured (url
    mode, 128 tools) — `token_update` 2.8 KB, `token_create` 2.3,
    `text_style_createFromObject` 1.1, `text_style_updateFromObject` 1.1,
    `token_delete` 1.0, `token_seedDefaults` 0.9, `token_list` 0.6.
- 2026-09-30: **A2.12b done** (uncommitted on 2026-09-30, to ship as
  0.10.15). Components now go through commands on the server. The new
  command is `component.promote` (`POST /decks/:id/promote-component`), and
  129 commands exist now. `component.stamp` stages the master's media, and
  `object.insertFromDeck` crosses between masters and decks. `Toolbar` and
  `UploadDropZone` are off the exemption list, and
  `writeComponentMasterTree.ts` is deleted. Decisions:
  - **A component owns its pictures and videos**
    ([ADR 0012](../adr/0012-component-owned-media.md)). Migration 0027 adds
    `media_assets.component_id` (FK, cascade). A media row has one owner: a
    deck, a component master or, for fonts, a folder. Component keys live
    under `components/<id>/uploads|videos/…` (`media/mediaOwner.ts`).
    Access requires owning the component's folder (`canUseComponentMedia`,
    the rule of the `component:<id>` document), and share tokens never
    reach component media. The reason: a master used to point at the
    promoting deck's assets, so it lost them with that deck, and nobody
    without access to that deck could see them, not even in their own deck
    where the component was stamped.
  - **Media is copied whenever it crosses an owner.** This covers promote
    (deck → component), stamp (component → deck) and paste (deck ↔ master,
    master ↔ master), the same model as the A2.2 cross-deck slide paste. No
    font is copied into or out of a component, because a master has no
    fonts of its own.
  - **Promote runs on the server.** Slide-model `writeComponentMaster`
    builds the master in a scratch document from the live deck. The
    service copies the media and removes links to slides; the slide is not
    changed. The component row and its media rows commit in one
    transaction, and only then is the master written through the sync
    server (`services/componentStaging.ts`). The editor first waits for
    `whenSaved()` (slide-doc context, `state/providerSaved.ts`: the
    provider synced and no `hasUnsyncedChanges`), so an edit made a moment
    earlier (naming a box, flagging the page number) is in the master. It
    gives up after 10 s instead of promoting from a stale deck.
  - **Stamp runs on the server too.** `component.stamp`'s `load` copies the
    master's media into the deck (`ComponentService.prepareStamp`). The
    handler is the exported `stampMaster`, which
    `POST /decks/:id/stamp-component` shares; the Toolbar picker and canvas
    drag use that route (`state/useStampComponent.ts`). Consequence: a
    stamp reaches the editor as a remote change, so Delete removes it and
    Ctrl+Z does not undo it (like a cross-deck slide paste).
  - **Every cross-document object paste goes through the server.**
    `object.insertFromDeck` gains `fromComponent` and accepts a master as
    its target. The routes are `POST /decks/:id/insert-objects` (body
    `sourceDeckId` | `sourceComponentId`) and the new
    `POST /components/:id/insert-objects` (`routes/insertObjects.ts`).
  - **Uploads into a master work** for the first time. The master editor
    used to send tus the made-up deck id `component:<id>`, which the server
    refused. The upload now carries tus metadata `componentId`. Only images
    and videos are accepted (fonts and `.pptx` get 415).
    `media.upload/url/status/delete` and `media.uploadSession` accept a
    component-master target. An upload session may belong to a component
    (migration 0029: `upload_sessions.deck_id` nullable, `component_id`,
    CHECK `upload_sessions_one_owner` = exactly one). This was added late
    in the step (the working tree at 16:18 on 2026-09-30); the step's brief
    had said sessions stay deck-only. The video worker takes its output
    prefix from the storage key (`videoOutputPrefix`), no longer from a
    deck id.
  - **The component create route stopped trusting the client.**
    `POST /folders/:folderId/components` no longer accepts an id, and it
    writes the empty master slide on the server. Its route claim moved to
    the A4 `component.create` known-missing entry (source `route`: the
    empty-master route that the tests and the eval seed with), so
    `knownMissing` has 7 entries (A2 0, A3 5, A4 2). Migration 0028 adds
    `components_id_storage_safe` (`^[A-Za-z0-9_-]{1,64}$`, `NOT VALID`,
    because legacy ids were client-chosen) and the validated
    `media_assets_one_owner`. `isStorageSafeId` / `mediaOwnerPrefix` and
    the bucket cleanup refuse an unsafe id rather than widen a prefix into
    another owner's keys.
  - **Cleanup**: deleting a component or a folder purges
    `components/<id>/` plus the master's tus originals. Their keys lie
    outside the prefix, so they are read before the FK cascade.
  - **Legacy masters are adopted by a data migration**
    (`2026-09-30-component-media`, `adoptMasterMedia`). Media belonging to
    decks in the component's own folder is copied into the component and
    the master is re-pointed. Other references stay unresolved and are
    counted in the report, because a master can contain any typed asset id
    and copying it would hand the folder owner a picture they could not
    see.
  - **Security review fixes**:
    - A per-user media copy budget of 60 a minute (429,
      `services/mediaCopyBudget.ts`) covers every server-side copy
      (promote, stamp, paste, slide insert and duplicate), browser and
      agent alike.
    - The command framework gets `CommandDef.release(loaded)` and
      `PreparedInvocation.abandon()`, so media staged in `load` is
      discarded when the ServerHost never reaches the write.
    - tus naming reads empty ids as absent (`||`, as `onUploadCreate`
      does), and the upload key must lie in the namespace of the owner that
      was authorised (`requireKeyOfOwner`).
    - `GET /api/media/:id/url` answers `Cache-Control: private`.
    - No font is copied into a component.
  - **Open, for Petr to decide (not done)**:
    - a per-owner storage quota (the budget limits rate, not total);
    - whether stamping a private component into a deck with other
      collaborators or share links should need a confirmation. Stamping
      discloses the master's media to that audience (review L2, the same
      policy as `deck.insertFrom`).
  - Tests:
    - new e2e `component-promote-stamp.spec.ts` (promote → stamp, each
      owner gets its copy; a deck → master paste) and
      `component-master-upload.spec.ts`;
    - `component-picker-search-settings` and `m16-component-flows` seed
      their own folder and components, so the "hardcoded Drafts folder id"
      known failure is gone (AGENTS.md updated with the change);
    - eval scenarios `component-promote-headline` and
      `component-master-picture` run live only (the memory world does not
      model component documents), for 44 scenarios;
    - web skips 27 (was 28).

    The suite totals, the full e2e run and the live eval results were not
    recorded in this sweep.

  - tools/list budget 187,000 → 189,000 bytes: 188,407 measured (url mode,
    129 tools). The additions are `component_promote` 1.4 KB,
    `object_insertFromDeck`'s `fromComponent`, and the media commands on a
    component master.

- 2026-09-30: **A2.13 done — A2 closed** (uncommitted on 2026-09-30 on
  top of `beaf182`; to ship with A2.12b as 0.10.15). Handoff:
  [`A2-extraction.md`](../handoff/A2-extraction.md).
  - **The action catalog** (`apps/web/src/actions/catalog.ts`, plan §9.1
    guard 2, the part that was still missing). Every action a person
    reaches through a keyboard shortcut, a context or dropdown menu item or
    a toolbar button is listed once, as one of:
    - `commands`: the commands that carry its effect, which is what an
      agent uses;
    - `editorOnly`: with a reason (viewport, selection, the local
      clipboard, the editor's own undo, navigation);
    - `planned`: shown but not built (object Hide, disabled in the menu).

    82 actions: 53 `commands`, 28 `editorOnly`, 1 `planned`.

  - **Enforcement.** `ShortcutBinding.action` is required
    (`state/useShortcuts.ts`). The menu item wrappers in
    `components/ui/{context-menu,dropdown-menu}.tsx` (`Item`,
    `CheckboxItem`, `RadioItem`) require an `action` prop and render it as
    `data-action`. `actions/catalog.test.ts` checks four things:
    - every command an action names exists in the registry;
    - every `editorOnly` / `planned` reason is at least 20 characters;
    - no catalog action is unused in `src/`;
    - every `<Button>` / `<button>` in `ui/Toolbar.tsx` carries a
      catalog `data-action`, a literal id or the typed `toolAction(…)`
      helper (TypeScript AST scan).
  - **The guard found an untracked action at once**: renaming the deck by
    clicking its title in the toolbar (now `deck.rename`).
  - **Why in `apps/web`, not in `parity.test.ts`** (plan §9.1 put it
    there): the binding sites live in the web app, and `packages/commands`
    does not depend on it. The types force an action on every shortcut and
    menu item, and the test checks what the types cannot.
  - **Hand-rolled menus** (`<button role="menuitem">` in `SlideItemMenu`,
    the Inspector's text-style menu, `FoldersHome`, `FolderDecks`; found
    by the docs sweep) are covered as well: the test requires a catalog
    `data-action` on every element with a `menuitem` role in the web app.
    Their 17 items were tagged, adding `slide.transition`, `textStyle.*`,
    `deck.duplicate` / `moveToFolder` / `delete` and `folder.*` actions.
  - **What the guard does not see** (not triaged):
    - key handlers outside `useShortcuts` (48 `onKeyDown` /
      `addEventListener('keydown')` sites in `apps/web/src`, most of them
      text fields and Escape handling);
    - Inspector controls and canvas gestures.

    Writes from those still hit the one-door lint rule, and their routes
    hit the route guard. What nothing checks there is an `editorOnly`
    reason, or a new route-backed action without a catalog entry.

  - **`ONE_DOOR_PENDING` is empty.** `state/testApi.ts`, the dev-only e2e
    hook, writes through the command registry: `runCommandSync` /
    `runGroup` on a browser-host context with `LOCAL_ORIGIN`, as
    `useCommand()` builds it. It runs as a fixed owner actor
    (`e2e-test-api`).
    - `object.create` gained an optional `id` (letters, digits, `_`, `-`,
      at most 64 characters), refused with `conflict` when the slide
      already has that id. The test hook needs it, and it is useful to
      agents: the same id on two slides pairs objects for a magic
      transition.
    - Slide-model `createObjectOfType(…, id?)` and `buildTable` /
      `addTable` (`AddTableOpts.id`) take the id. `insertTable` in
      commands passes it through.
    - One state no command creates any more is an animation step with the
      retired `onEnter` trigger (decks from before A2.9, and PowerPoint
      effects whose node type the importer does not know). It is seeded by
      `state/testApiLegacyFixtures.ts`, which throws outside dev builds.
      That file is the only non-test entry added to `ONE_DOOR_IGNORES`,
      with a rationale in `eslint.one-door.js`.
    - `addImage` now takes a real `assetId`. The specs upload one first
      with `e2e/fixtures/media.ts` (`uploadTestPicture`: `media.upload` of
      a 1×1 PNG through `POST /commands`).
  - **`FINISHED_PHASES = ['A0', 'A1', 'A2']`**
    (`packages/commands/src/parity/knownMissing.ts`), since A2 has no
    known-missing entry left. The list holds 7 entries (A3 5, A4 2).
  - **E2E specs that seeded from one database now seed themselves:**
    - `htmltext-texture-isolation.spec.ts` creates its own deck (and
      deletes it afterwards) unless `E2E_DECK_ID` is set. It used to open
      the hard-coded deck `nO5v10urLTBI`.
    - `agent-activity.spec.ts` (component-master test) adapted to the
      master slide the server now writes (A2.12b). The setup run adds a
      text label instead of a slide, and the test checks that the label
      survives the revert of the second run.
    - `inspector-flows` and `keyboard-shortcuts` upload the picture their
      image tests place.
  - Verified by the docs sweep on 2026-09-30: `actions/catalog.test.ts` +
    `oneDoor.test.ts` (7 tests) and `objectEdit.test.ts` + `parity/`
    (42 tests) pass. A full e2e run was in progress against the dev stack
    during the sweep; its result is not recorded here.
  - tools/list: 188,697 bytes in url mode (187,617 form, 188,589 link), 129
    tools, measured 2026-09-30 by the docs sweep. The budget stays 189,000,
    leaving 303 bytes of headroom. `object.create`'s `id` added ≈ 290 bytes
    (was 188,407).

## Where we stand (2026-09-30, after A2.13 — A2 closed)

Released: A2.1–A2.11, A2.7a and A2.12a (0.10.2–0.10.14; A2.12a in 0.10.14,
2026-09-30, which is what production runs: `/version.json` answered
`v0.10.14+61260f2` on 2026-09-30). A2.12b and A2.13 are done in the working
tree and uncommitted on 2026-09-30. They are to ship together as 0.10.15.
The release has a pre-deploy check ([`deploy.md`](../deploy.md),
"Releasing A2.12b"); A2.13 adds no migration and no env var.

State after A2.13:

- `ONE_DOOR_PENDING` is empty. The editor writes documents only through
  commands. (Was 1 file after A2.12b, `state/testApi.ts`; 26 at A2.1.)
- `knownMissing` has 7 entries (A3 5, A4 2), and
  `FINISHED_PHASES = ['A0', 'A1', 'A2']`. (Was 32 A2 entries at the start
  of A2.)
- 129 commands (74 that run in the browser and on the server, 55
  server-only, counted from the manifest's `hosts`); 94 at the start of A2.
  The A2.12a line's "76 document, 52 server-only" was counted differently;
  the manifest said 74 / 54 at 0.10.14.
- 20 allowlist entries (18 at A1 close).
- 82 catalogued user actions (53 `commands`, 28 `editorOnly`, 1 `planned`).
- tools/list was 188,697 bytes (url mode) against the 189,000 budget.

Done since:

1. **0.10.15 released** (A2.12b + A2.13) on 2026-09-30; production
   reports `v0.10.15+f91b18e`, migrations 0027–0029 applied, the
   component-media data migration found nothing to copy.
2. **The holistic tools/list size review** (2026-09-30). Descriptions
   (69 KB) carry the rules an agent needs and barely repeat, so they
   stayed; the schemas (99 KB) repeated a few shapes on dozens of tools.
   `mcp/sharedShapes.ts` writes those compactly (the slide reference as
   `{ "type": ["string", "object"] }` on 72 tools, colours, the table
   cell, object id lists) and says them once in the instructions, the
   way `mcp/vocabulary.ts` does for field descriptions; whether a tool
   shows an example call is still decided on the full shapes. 188,697 →
   173,650 bytes (−8 %); budget 189,000 → 175,000. The full live eval
   was 44/44 before and after (332 → 326 turns, 287 → 281 tool calls,
   $5.65 → $5.43).

3. **Folder sharing, step 1 (access core)** done and committed on
   2026-09-30, not released: migration 0030 `folder_permissions`, folder roles through
   every service, route, sync document and the agent host
   ([ADR 0013](../adr/0013-folder-sharing-roles.md)). The plan, its status
   and the next steps: [`folder-sharing.md`](folder-sharing.md).

Next: **the test-loop speed-up** ([`dev-speed.md`](dev-speed.md) —
finish parallel Playwright), then **folder sharing** steps 2–5
([`folder-sharing.md`](folder-sharing.md)).

(Was, after the tools/list review: "Next: the MCP work.")

(Was, after A2.12b: "Next, 1. A2.13 Close — the parity guard over
shortcuts and menu ids; `testApi.ts` through commands; `FINISHED_PHASES +=
'A2'`; ADR 0010 status and a handoff note; then the tools/list review. 2.
Then MCP work.")

Open, outside the steps:

- **Folder sharing and linked component media — decided 2026-09-30, now
  in progress ([`folder-sharing.md`](folder-sharing.md)).** Petr's access model: sharing a folder shows everything in
  it (decks, components, pictures, videos, fonts, tokens), with no levels
  inside; sharing a deck shows that deck only. Narrative has no folder
  sharing today (a folder has one owner, sharing is per deck), which is why
  A2.12b copies media on every stamp. The follow-up step: folder members and
  folder invitations (roles proposed as for decks: viewer / editor / owner),
  access derived from membership everywhere (sync server, media, fonts,
  tokens, agent host); stamps and pastes inside a folder LINK to the
  component's media instead of copying it (copy only across folders);
  component media readable by folder members and by anyone with access to a
  deck of that folder; a deleted component's media stays with the folder.
  This supersedes the open A2.12b questions (a storage quota and a
  confirmation for stamping into a shared deck) and parts of
  [ADR 0012](../adr/0012-component-owned-media.md).

- folder token writes made by an agent carry `SERVER_EDIT_ORIGIN` (the
  origin of a person's server-side edit) and the propagation
  `TOKEN_PROPAGATION_ORIGIN`, so an agent run's revert does not undo them;
  the before-values are in the op's result (`previous`, the deleted
  `token`) — a run-level undo for folder documents is not designed yet
  (security review A2.12a, LOW-5);
- a running Claude Code session only sees new MCP tools after `/mcp` →
  Reconnect (documented in the plugin README);
- present mode ignores `videoTrigger` / `videoDelay` (see the A2.9 entry);
- the timeline draws an `onClick` step at its predecessor's end, while the
  compiler anchors the click pause at the end of everything before it
  (`tl.duration()`); the two differ after an overlapping `withPrevious`, so
  such a bar is drawn earlier than it plays. Pre-existing, not changed in
  A2.9; `packages/animation/src/__tests__/timelineLayout.test.ts` leaves
  onClick out of its contract for that reason.
