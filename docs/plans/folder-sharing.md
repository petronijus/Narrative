# Folder sharing and linked component media

Status: planned and decided by Petr on 2026-09-30. Step 1 released in
0.10.16 (2026-10-02). **Step 2 built and committed on 2026-10-02, not yet
reviewed or released** — what is left is in `HANDOVER.md` → "Spillover". The
e2e suite was green (175 passed) on the committed tree; the test-loop
speed-up to do first is in [`dev-speed.md`](dev-speed.md).

## What Petr decided

- **Sharing a folder shows everything in it** — every deck, component,
  picture, video, font and token — with no levels or hierarchy inside the
  folder.
- **Sharing a deck** (an invitation or a share link) shows that deck only,
  never the rest of the folder.
- **Folder roles are the deck roles**: viewer (looks and presents the whole
  folder), editor (changes decks, components, tokens and fonts), owner
  (also shares the folder and deletes it).
- **The same roles bind agents over MCP**: an agent acts as its user, so
  the agent host resolves folder roles exactly as the editor does, and
  folder sharing is a command set an agent can use within its user's role.
- **Component media is linked, not copied**: stamping a component or
  pasting out of a master inside the folder points the slide at the
  component's own picture; a copy is made only when media crosses into
  another folder.

## Where it stood before step 1 (access map, 2026-09-30)

- A folder has one owner (`folders.owner_user_id`); there is no folder ACL.
  `resolveFolderAccess` returns owner or nothing; components, component
  media, folder fonts, folder tokens (`folder:<id>`) and component
  documents are owner-only.
- Decks are shared per deck: `deck_permissions`, `deck_invites`,
  `share_links`; `resolveDeckAccess` never looks at the folder. Deck lists
  come from `deck_permissions` rows only.
- A deck collaborator who does not own the folder gets no folder tokens and
  no folder fonts in the editor today (403 / WebSocket refused): the deck
  renders with fallback styles. This plan fixes that on the way.
- `decks.owner_user_id` still decides `moveDecks` and where deleted-font
  clones go.
- A2.12b copies a component's media into the deck on every stamp (ADR
  0012); that copy is what this plan replaces with a link.

## Model

### Data

- `folder_permissions (folder_id, user_id, role, granted_at, granted_by)`,
  primary key (folder_id, user_id), `role` the existing `deck_role` enum,
  cascade from folders. Every existing folder gets its owner's row in the
  migration (backfill); `folders.owner_user_id` stays as the creator and
  the Drafts identity.
- `folder_invites` — pending invitations by e-mail, as `deck_invites`.
- Media owned by a folder may now be pictures and videos too (the media of
  a deleted component), not only fonts.

### Access — one resolver per kind, in `auth/permissions.ts`

- **Folder role** = the user's `folder_permissions` row (BYPASS dev user as
  today).
- **Deck role** = the highest of: the deck's own permission row, the folder
  role of the deck's folder, the owner fallback, a share link. Folder
  membership therefore gives the same role on every deck in the folder.
- **Component** (list, read, stamp, edit the master) = the folder role:
  viewer reads, editor writes. A deck-only guest does not see the folder's
  components.
- **Component and folder media (pictures, videos)** are readable by folder
  members and by anyone with access to a deck of that folder (share links
  included) — so a stamped logo shows for a one-deck guest. Written or
  deleted by folder editors.
- **Folder tokens and fonts** are readable (read-only document, font list)
  by folder members and by anyone with access to a deck of that folder, so
  a shared deck renders with its styles; written by folder editors.
- **Documents over the sync server**: `folder:<id>` and `component:<id>`
  are read-only for viewers (and for deck-only guests on `folder:<id>`),
  like a deck for its viewers.
- **Agents**: `agent/access.ts` returns the real roles; the folder-scoped
  commands state the role they need (reads viewer, writes editor, sharing
  and deleting owner) instead of owner everywhere.

### Linked component media

- A stamp and a paste out of a master in the same folder keep the
  component's asset ids; nothing is copied.
- Pasting deck objects INTO a master still copies the deck's media into
  the component: a master must not depend on a deck's lifetime.
- Across folders (deck.moveToFolder, deck.duplicate into another folder,
  deck.insertFrom and object.insertFromDeck from another folder's deck) the
  linked media of the old folder is copied into the target, as deck media
  is today; the copy rules learn that a deck may show its folder's
  component and folder media.
- Deleting a component hands its media to the folder (the rows become
  folder-owned; the files stay) so every slide that shows it keeps showing
  it. The folder's deletion removes it all.
- PowerPoint export takes the linked media of the deck's folder into the
  file.

### Step 2 design (2026-10-02)

One notion carries it: **the media a document may show** — its own rows,
plus the component- and folder-owned pictures and videos of its folder
(`media/visibleMedia.ts`; only `image` and `video` rows link — the
folder's fonts are not slide media). Everything else follows from it:

- **Copy rule** (`deckInsert.ts` `copyMedia`): a referenced asset is copied
  into the target when the target may not show it; within one folder a
  linked asset is kept as it is. So a stamp and a paste out of a master in
  the same folder copy nothing; a paste of deck objects into a master
  still copies the deck's own media (a master must not depend on a deck);
  a copy into another folder (paste, `deck.insertFrom`, `deck.duplicate`)
  copies the linked media too — for **whoever may read it** in its folder:
  members of any role, guests of its decks (Petr, 2026-10-03, replacing the
  editor-only rule of the first review). Only what the source document may
  show is a candidate, and every candidate passes a read check for the
  caller; an id they cannot read, or one of another folder, is never copied
  and is reported (`skippedImages` / `skipped.images`). A paste may name
  ids its source no longer shows (a cut, then a paste elsewhere): the read
  check decides, not what the source references now. The PowerPoint export
  reads what the deck shows — its editors are content readers of its
  folder — and skips anything merely named in the document.
- **Moving a deck to another folder** copies its linked media into the
  deck and points the deck at the copies through the sync server, before
  the deck changes folders — so no reader ever meets a reference it cannot
  load — and records each asset with its copy, the folder it came from and
  who moved the deck (`deck_moved_media`, migration 0032; the mover goes to
  NULL with their account). A copy that fails (503) or that the mover may
  not make (403) stops the move before any deck changes folders. Decks
  handled earlier in the same move may already show their own copies by
  then: a reader sees the same pictures, and a retry reuses the recorded
  copies — re-pointing is idempotent. References that were broken already
  do not stop it. What a collaborator links during the move is caught up
  afterwards and reported (`MoveDecksResult.media`, the `media` output of
  `deck.moveToFolder`). Unbudgeted, like the move itself (owner of the
  deck, editor of both folders).
- **Old references after a move** (security review N1, 2026-10-03): an
  undo in an editor or an agent run's revert can bring back a reference to
  the old folder's media. After a revert (`RunManager` `afterDeckRevert`)
  and after the sync server stores the deck (`PostgresPersistence`
  `onDeckStored`, off the store's path, one pass per deck at a time) the
  server **only re-points** such a reference at its recorded copy
  (`localiseMedia.ts` `repointMovedMedia`), however often it comes back —
  undo/redo cycles copy nothing. An id the move did not record is never
  copied, so a planted id pulls nothing in. A fresh copy is made only when
  the recorded copy is gone (its row deleted, or its file): at most once
  per recorded id, at most ten per pass, on the mover's authority (they
  must still read the folder) and media copy budget, and a video only with
  its finished outputs — this path never queues a transcode. An undo that
  restores a slide the deck no longer referenced when it moved brings back
  a reference nobody of the new folder can load: accepted, the price of
  never copying an unrecorded id.
- **A write racing a move**: a stamp is staged for the deck's folder read
  at that moment (409 when the deck already left the master's folder);
  `object.insertFromDeck` and `deck.insertFrom` stage the target's linked
  media the same way. Each is settled after the write (the command
  framework's `settle` phase, and the editor's routes after their own
  write): a deck that moved meanwhile gets what the write linked carried
  into it — on the writer's authority and copy budget, recorded like a
  move's copies (`localiseMedia.ts` `carryLinkedMedia`). Checking only
  before the write would leave a window; after it, a move that commits
  later still runs its own catch-up pass over a document that holds the
  write.
- **Deleting a component** re-parents its rows to the folder in the same
  transaction as the delete (`component_id = NULL, folder_id = folder`);
  its `components/<id>/` prefix is swept of whatever no row names (the
  thumbnail, leftovers). The folder's deletion removes the rows with
  everything else, and sweeps the prefixes of components deleted earlier
  (named only by the rows' keys now).
- **Reading and removing**: a folder-owned picture or video is read by the
  folder's content readers (members, guests of its decks, share links to
  them), like component media. `media.url` / `.status` on a deck or master
  target accept what that document may show. Removing a master's picture
  or video hands it to the folder as deleting the component does — stamps
  keep showing it — for a **folder editor**, on every surface
  (`DELETE /api/media/:id`, `media.delete` on a master target, whose role
  is `editor` there; Petr, 2026-10-03). Deleting folder-owned media is the
  folder owner's alone (or the folder's deletion), and agents reach it
  through `media.delete` with a folder target (`acceptsFolder`, owner).
  `media.delete` reports what happened (`outcome`: `deleted` or
  `handedToFolder`). A folder font is refused there with a pointer to
  `DELETE /api/folders/:id/fonts/:assetId` (review M2/M3).
- **Storage keys are never deleted while a row still names them** (a deck
  delete used to remove a font file its folder's other decks still used —
  `deleteFont` clones share one key, and a pre-0009 folder font lives
  under the deck it was uploaded in). Prefix sweeps and explicit purges
  alike keep any key a remaining row names; `media.delete` and
  `folder.fonts.delete` remove the deleted row's files under the same
  rule. A prefix sweep also keeps what no row names _yet_ — a video's
  outputs under `videos/<id>/` of an existing row (the worker writes them
  before it records them; review N5) and anything younger than the
  15-minute grace window — and runs once more after the window when the
  owner is gone (`docs/storage.md`, "Cleanup").
- No data migration: the copies 0.10.15 made are deck- or component-owned
  and stay valid.

### Drafts

Drafts stays private: it cannot be shared (refused), and it is never
listed for anyone but its owner.

## Steps

1. **Access core** (no visible change while every folder has one member):
   migration with `folder_permissions` + backfill; the resolvers above;
   read-only folder/component documents for viewers; deck lists include
   decks visible through a folder; folder lists include shared folders with
   the user's role; deck-only guests read the folder's tokens and fonts
   (fixes the fallback styles). `moveDecks` and the font-clone rule move
   from `decks.owner_user_id` to roles.
2. **Linked component media**: stamp/paste link inside the folder; the
   media read rule; component deletion hands media to the folder; copies
   across folders; PowerPoint export; a data migration only if needed (the
   copies 0.10.15 made stay valid as they are).
3. **Folder sharing**: `folder_invites`, members (list, invite by e-mail,
   change role, remove), sign-in policy and invitation pick-up for folders,
   revocation closing that user's connections to the folder's decks and
   documents; routes and `folder.members.*` / `folder.invites.*` commands
   (owner); the Share folder dialog in folder settings, shared folders on
   the home page ("shared by …"), role-gated folder pages and editor
   (viewers see no editing controls).
4. **Agent surface**: folder-scoped command roles, eval scenarios (share a
   folder; a viewer's write refused), agent-parity and security review.
5. **Release** with the pre-deploy checks of the migration.

## Progress

**Step 1 (access core) — done 2026-09-30, not released.**

- Migration 0030 (`folder_permissions` + owner backfill); folder creation
  and Drafts provisioning write the creator's owner row in the same
  transaction.
- `auth/permissions.ts`: `resolveFolderAccess` (member rows, `alsoAs` for
  BYPASS_AUTH), `resolveDeckAccess` = highest of deck grant / folder role /
  owner fallback / share link, `resolveComponentAccess` = folder role,
  `resolveFolderContentAccess` (members with their role; deck guests and
  share links to a deck in the folder as viewers).
- `services/shared.ts`: `requireFolderRole` (404 / 403, and a message
  naming the missing role) replaced `requireOwnedFolder` at every caller;
  `requireFolderContentReader` for the folder's tokens and fonts. Roles per
  operation: rename and delete owner; font and token writes, components'
  rename / delete / create / promote, PPTX import into the folder, deck
  create and duplicate into it editor; lists, token usages, component
  reads viewer; token list, font list and font URLs any content reader.
- Deck lists (`list`, `listPage`) show decks through a grant or through the
  folder, with the higher role; folder lists are membership joins with the
  role (`min()` of the enum is the highest role — the enum is declared
  owner, editor, viewer). `FolderSummary.role` reaches the commands, the
  web type and `folder.list`.
- `moveDecks`: editor in both folders and owner on every deck. Deleting a
  folder font clones it onto every deck of the folder.
- Component media: read by folder content readers (share links included),
  uploaded and deleted by folder editors (`canReadComponentMedia`,
  `canWriteComponentMedia`); copying out of a master needs viewer, into a
  master editor.
- Hocuspocus: `folder:<id>` admits members and, read-only, deck guests and
  share links to a deck of the folder (the web passes the page's
  `share_token`); `component:<id>` is read-only for viewers. Revoking a
  share link closes its connections on every document; revoking a deck
  grant also closes the user's `folder:<id>` connection when that deck was
  their only way in.
- Tests: `auth/permissions.integration.test.ts` (the resolvers and the
  helpers against Postgres), `services/listPage.integration.test.ts`
  (lists through a shared folder, the highest role over several rows).

Left for the later steps, on purpose:

- The 18 folder-scoped commands still declare `role: 'owner'` (step 4); the
  agent host already resolves the real roles, so an agent is refused more
  than the web allows (invisible while every folder has one member):
  - reads a viewer or editor may make: `component.list`, `component.get`,
    `token.list`, `token.usages`, `folder.fonts.list`, `media.fontUrl`,
    `deck.activeEditors`;
  - writes an editor may make: `component.rename`, `component.delete`,
    `deck.importPptx`, `folder.fonts.upload`, `folder.fonts.delete`,
    `token.create` / `update` / `delete` / `seedDefaults`, `media.delete`
    on a component master.

  `folder.rename` and `folder.delete` stay owner-only.

- `authenticate.ts` passes a `deck:<id>` document name to
  `resolveDeckAccess` with its prefix, so a prefixed name never gets
  access; the web uses bare ids, so nothing is affected (pre-existing).
- An anonymous share-link visitor gets no REST reads besides
  `GET /decks/:id`: the web client sends `share_token` nowhere else, and
  `authPreHandler` answers 401 without a session — so no folder fonts, and
  no pictures or videos (`/api/media/:id/url`, `/video-info`), although
  the media service accepts share tokens. Pre-existing for every REST read;
  a share-link task of its own (routes that admit a share token, the client
  passing it), for Petr to schedule.
- Revoking folder membership (step 3) must close the user's connections on
  the folder's decks, components and `folder:<id>`.

### Review of step 1 (code and security review, 2026-09-30)

Fixed within step 1:

- Moving a deck changes who may open it: the move closes the live
  connections on the moved decks and on the source folder's token document,
  so everyone re-authenticates (security H1). Deleting a deck does the same
  for the deck and its folder's token document (it closed nothing before).
- The `decks.owner_user_id` owner fallback goes: every deck gets its
  creator's `deck_permissions` owner row (migration 0031) and access is
  decided by `deck_permissions` and `folder_permissions` alone, so a deck
  creator's access can be revoked like anyone's (security H2).
- `folder:<id>` is read-only for every browser connection; tokens change
  only through the server, which validates them (security M1).
- Copying out of a master into another folder is an export and needs the
  editor role in the component's folder; inside the folder a viewer role
  is enough (security M2).
- `moveDecks` moves only decks still in the source folder, all or none in
  one transaction (409 otherwise), and checks the deck owner role in one
  query (security L5, review 8).
- One component-role helper, `services/shared.ts` `requireComponentRole`
  (404 or 403 for an outsider, chosen by the caller), replaced three
  (review 5); the deck role is resolved in one query (review 8); the list
  role mapping is shared by `list` and `listPage` (review 6);
  `bypassAliases` (review 7).
- Tests: `auth/permissions.integration.test.ts` also covers the creator
  column granting nothing and migration 0031 (run twice), an expired share
  link and a guest's `alsoAs`.

Found by the new share-link e2e (`e2e/share-link-folder-tokens.spec.ts`)
and fixed within step 1:

- An anonymous share-link visit never authenticated its sync connections
  (the provider sends the auth message only with a `token`), so the deck
  itself never loaded; `state/hocuspocusAuth.ts` builds the options for the
  deck and the folder document.
- The share-link page never learned the deck's folder; `DeckRoleProvider`
  reads it and the link's role from `GET /decks/:id?share_token`.
- Token colours that arrive after the first paint were never redrawn (the
  scene diff follows the object data, not the token snapshot): the scene
  graph now repaints the objects whose token colours resolve differently
  when the folder's tokens change (`renderer/colourResolver.ts`,
  `SceneGraph.ts`), live palette edits included; a deck or component
  preview is uploaded only once the folder's tokens are final
  (`useFolderTokensSettled`).

Left for later steps:

- Step 3: Drafts is recognised by its name; reserve the name or mark Drafts
  with a column before folders can be renamed by other owners (security L3).
  Folder deletion must close its members' connections.
- Step 4: the command descriptions that still say owner-only
  (`folder.fonts.list`, `media.fontUrl`, `token.*`, `text.style.*`,
  `deck.moveToFolder`, `deck.activeEditors`, `component.stamp`,
  `object.insertFromDeck` — viewer within the folder, editor across folders
  and into a master —, `media.delete` — a folder editor hands component
  media to the folder —, `deck.duplicate` — the source folder when the user is an editor
  there —, and `deck.create`, whose `folderId` must be a folder where the
  user is an editor), with `just eval`; re-record `deck-create-in-folder`
  (its recording predates `role` in `folder.list`).
- Step 5: before deploying 0030/0031, count decks whose creator is not their
  folder's owner (`SELECT count(*) FROM decks d JOIN folders f ON f.id =
d.folder_id WHERE d.owner_user_id <> f.owner_user_id`); expected 0.
- BYPASS_AUTH only: several checks do not count the legacy demo user as the
  dev user (security L2). Dev-only; goes with the demo-user removal.

## Decided details (Petr, 2026-09-30)

- Renaming a folder: owner only.
- Moving a deck between folders changes who sees it: it needs the owner
  role on the deck and editor on both folders.
- No share link for a whole folder (anonymous access stays per deck).

## Decided after the step 2 reviews (Petr, 2026-10-03)

The code review and the security review of step 2 (2026-10-03) raised four
questions; Petr's answers:

- ~~**Taking linked media out of a folder** needs the editor role on the
  folder that owns it.~~ Replaced on 2026-10-03 (below): whoever may read
  it may carry it out as a copy.
- **Deleting a picture or video of a master** detaches it and hands it to
  the folder, as deleting the component does, so the stamps keep showing
  it. Folder-owned media is deleted only by the folder's owner, or with
  the folder.
- ~~**Undo or a run revert after a move** is repaired by localising again
  from the folders the deck left.~~ Replaced by the recorded copies of
  the second round (below): a repair only re-points.
- **Deck guests read the folder's component and folder media by id**,
  share-link holders included, and a share-linked deck moved into another
  folder opens that folder's media to the link: accepted as designed
  (ids are unguessable), recorded in ADR 0013; the "Move to…" dialog warns
  when the deck has an active share link.

The second round of reviews (code and security, 2026-10-03) found the
repair after an undo unbounded — any deck editor, an editor share link
included, could re-insert an old id and get a fresh copy on every store —
and Petr decided two more questions the same day:

- **Copying linked media out of its folder** (D1): whoever may READ a
  piece of folder media — a content reader of its folder: members, guests
  of its decks, share links per the read rules — may carry it into
  another folder (paste, also after a cut; `deck.insertFrom`;
  `deck.duplicate`). Outside the folder's permission scope it becomes a
  copy; within the folder it stays a link. Every id the client names still
  passes a per-asset read check, and one the caller cannot read is never
  copied and is reported as unresolved. Pictures and videos only.
- **Removing a master's picture or video** (D2): a folder editor, on every
  surface; the agent command takes the role per target (`media.delete`:
  deck owner, master editor, folder owner) and gains a folder target for
  the folder's own media.
- **The repair after an undo** (N1, the fix): the move records each asset
  with its copy (`deck_moved_media`); a later store or revert only
  re-points at the recorded copy, never copies an unrecorded id, and makes
  a fresh copy only when the recorded one is gone — once per id, on the
  mover's budget, never transcoding (see "Old references after a move"
  above).
