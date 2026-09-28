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
| A2.10 | Tables                                 | table.\* existing; ✚ `table.cell.setText`                                                                                                                                                                                                                                                                                        | `TableChrome`, `TableInspector`, `TableCellEditor`                                                  |
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
