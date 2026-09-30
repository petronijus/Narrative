# ADR 0012 — A component owns its media; media is copied whenever it crosses an owner

**Status**: Accepted (2026-09-30, A2.12b; to ship in 0.10.15). Petr chose the model — master pictures belong to the component, a stamp arrives as a remote change (Delete removes it, Ctrl+Z does not) — on 2026-09-30; the storage quota and a confirmation for stamping into a shared deck are open (see Consequences).
**Scope**: `media_assets` and `upload_sessions` (migrations 0027–0029),
`apps/server/src/media/` (`mediaOwner.ts`, `tus.ts`, `routes.ts`,
`uploadSessions.ts`, `bucketCleanup.ts`),
`apps/server/src/services/{componentStaging,deckInsert,mediaCopyBudget,components,folders}.ts`,
the `component.promote` / `component.stamp` / `object.insertFromDeck` /
`media.*` commands, and the video worker's output prefix.
**Extends**: the A2.2 decision that cross-deck slide paste runs on the server
and copies media, because media is deck-scoped
([`plans/a2-extraction.md`](../plans/a2-extraction.md), A2.2).
**Related**: ADR 0010 (commands are the only writer), ADR 0011 (server
execution); [`docs/storage.md`](../storage.md) (bucket layout).

## Context

Until A2.12b a picture or video had one of two owners: a deck (`deck_id`,
keys under `decks/<deckId>/…`) or, for fonts, a folder. Component masters
had no media of their own:

- A promoted master pointed at the promoting deck's assets. If that deck was
  deleted, the master lost its pictures. Media URLs are authorised by deck
  role, so a person without access to that deck saw nothing, even in a deck
  of their own where the component was stamped.
- Uploading into the master editor sent tus the made-up deck id
  `component:<id>`, which the server refused. No upload into a master had
  ever worked (`e2e/component-master-upload.spec.ts` header).
- A master is the folder owner's: its Y.Doc (`component:<id>`) is opened
  only by the owner of the component's folder (`resolveComponentAccess`).
  A master that shows a deck's media therefore mixes two access rules in one
  document.

A2.12b moves promote, stamp and cross-document paste onto the server
(`component.promote`, `component.stamp`, `object.insertFromDeck`), so the
server, not the browser, now decides what happens to the media involved.

## Decision

1. **Every media row has one owner**: a deck (`deck_id`), a component
   (`component_id`, migration 0027, `ON DELETE CASCADE`) or, for fonts
   only, a folder (`folder_id`). Migration 0028 enforces this with
   `media_assets_one_owner` (`num_nonnulls(deck_id, component_id, folder_id) <= 1`,
   validated).
2. **Access follows the owner.** Deck media is authorised by the deck's role,
   share links included. Component media is authorised by owning the
   component's folder (`canUseComponentMedia` =
   `resolveComponentAccess`), the same rule as the master document, so
   whoever can edit a master can use its pictures and nobody else can.
   Share tokens never reach component media.
3. **Media is copied whenever an object crosses owners**, as a deck-to-deck
   paste already did:
   - promote (deck → new component): the master's pictures and videos are
     copied into the component and links to slides are removed. The slide
     is not changed;
   - stamp (component → deck): the master's media is copied into the deck
     and registered before the deck is touched (`component.stamp`'s `load`
     → `ComponentService.prepareStamp`, handler `stampMaster`);
   - paste (deck ↔ master, master ↔ master): `object.insertFromDeck`
     with `fromComponent` or a master target.
     No font is copied into or out of a component. A master has no fonts of
     its own, because its folder's fonts cover it.
4. **Storage layout**: everything a component stores lies under
   `components/<componentId>/` (copied originals, video transcodes, the
   thumbnail). A tus upload into a master carries `componentId` in its
   metadata. It accepts images and videos only, from the editor or through
   an upload session issued for that component (migration 0029,
   `upload_sessions_one_owner`). Its
   object key is the compound upload id
   `<assetId>:unknown:<base64url(components/<id>/uploads/<assetId>/original.<ext>)>`,
   which is how `@tus/s3-store` keys objects. The server checks that the
   decoded path lies in the namespace of the owner the upload was
   authorised for. The video worker derives its output prefix from the
   storage key (`videoOutputPrefix`), not from a deck id.
5. **Ids that name storage keys must be storage-safe**:
   `^[A-Za-z0-9_-]{1,64}$` (`isStorageSafeId`, `mediaOwnerPrefix` throws
   otherwise, and the cleanup refuses to sweep). The component create route
   used to accept client-chosen ids, so `components_id_storage_safe` is
   added `NOT VALID`: new rows are checked, and legacy rows are left to
   the storage code. The route now generates the id and writes the empty
   master on the server.
6. **Cleanup**: deleting a component or a folder purges
   `components/<id>/` plus the master's tus originals. Their keys lie
   outside the prefix, so they are read before the FK cascade removes the
   rows.
7. **Server-side copies are budgeted per person**: 60 copies with media per
   minute (`services/mediaCopyBudget.ts`, 429). This covers every
   server-side copy (promote, stamp, paste, slide insert and duplicate),
   whether the editor or an agent asked. Media staged in a command's `load`
   is released if the host never reaches the write (`CommandDef.release`,
   `PreparedInvocation.abandon()`).
8. **Legacy masters are adopted once** (data migration
   `2026-09-30-component-media`, `adoptMasterMedia`). Media that belongs to
   a deck in the component's own folder is copied into the component and
   the master is re-pointed through the sync server. Any other reference
   stays unresolved and is counted in the report. A master can contain any
   asset id someone typed into it, and copying such media would hand the
   folder owner a picture they could not see.

## Alternatives considered

Reconstructed from the code and the A2.12b brief on 2026-09-30; the
weighing was not written down at the time.

- **Keep references across owners** (a master points at deck media, a stamp
  points at master media). This avoids the copies. It was rejected because
  every media URL check would have to know every document that references
  the asset, deleting a deck would still break masters, and a reference can
  be forged by typing an asset id into a document.
- **Folder-owned component media** (like fonts). This matches the master's
  access rule, but a component's media could then not be reaped with the
  component, and a stamp into a shared deck would still need a copy,
  because deck viewers are not folder owners.
- **Copy in the browser** (the pre-A2.12b promote wrote the master tree
  there, `writeComponentMasterTree.ts`). The browser cannot copy stored
  objects, and it is not a door agents use (ADR 0010).

## Consequences

- A component survives the deletion of the deck it was promoted from, and a
  stamp shows only media its deck owns, so every viewer of that deck sees
  it.
- Storage grows with every promote, stamp and paste. The budget limits the
  rate but not the total, and **there is no per-owner storage quota yet**
  (open, Petr's decision).
- **Stamping discloses the master's media** to the target deck's
  collaborators and share-link holders. This is the same policy as
  `deck.insertFrom` (security review L2). Whether stamping a private
  component into a shared deck should need a confirmation is open (Petr's
  decision).
- A stamp and a cross-document paste arrive in the editor as remote changes:
  Delete removes them and Ctrl+Z does not undo them (as with cross-deck
  slide paste since A2.2).
- A legacy component whose id is not storage-safe cannot take media. Before
  0028 can be applied, production must hold no media row with more than one
  owner, or the validated CHECK fails
  ([`docs/deploy.md`](../deploy.md), "Releasing A2.12b").
