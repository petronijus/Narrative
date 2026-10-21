# ADR 0017 — The browser keeps a local copy of what the server confirmed; a document epoch guards it

**Status**: Proposed (2026-10-20; awaits Petr's approval), built on branch `perf/crowded-slide` for
the performance programme's L4 ([`plans/performance.md`](../plans/performance.md)
→ A); amended 2026-10-21 after its security review (restore generation,
foreign copies, cross-tab sessions, pruning, the render pages, byte caps,
at-rest exposure).
**Scope**: `apps/web/src/state/localDocStore.ts` (the IndexedDB store),
`state/localDocCopy.ts` (one document's copy and epoch next to its
provider), the three providers that use them (`SlideDocProvider`,
`FolderDocProvider`, `componentDocCache`), sign-in/sign-out in
`state/AuthContext.tsx` and `state/authBroadcast.ts`, pruning in
`state/localDocPrune.ts`; on the server the document epoch
(`hocuspocus/documentEpoch.ts`, migration `0041_document_epochs`) and the
restore generation (`hocuspocus/instanceGeneration.ts`, migration
`0042_instance_generation`, `infra/scripts/backup.sh`) checked in
`hocuspocus/authenticate.ts`; the shared wire format in
`packages/shared/src/documentEpoch.ts`.
**Related**: ADR 0003 (Yjs is the source of truth), ADR 0005 (session
cookies), ADR 0006 (snapshot-compacted persistence), ADR 0013 (folder
roles), ADR 0015 (the desktop shell; offline work is a web-app feature),
[`plans/desktop-app.md`](../plans/desktop-app.md) D1–D2.

## Context

Every open of a deck waited for a full sync: the page created an empty
Y.Doc, the server sent the whole document (sync step 2 against an empty
state vector) and the canvas mounted the first slide's objects only once it
had arrived. On the MacBook against the local dev stack that wait is
~100 ms after the canvas is ready (`open.wsSynced` ≈ 490 ms, `open.mounted`
≈ 540 ms on a 100-slide deck); over a real network a 100–300-slide
document adds its transfer and the server's encode on top.

Keeping the document in the browser changes where document state lives, so
the conditions had to be settled first:

- Access changes. A deck can be unshared, a folder member removed, a share
  link revoked; the server checks access on every connection
  (`onAuthenticate`) and closes live connections on revocation (CONN-1).
- Several people use one browser (one session cookie at a time, one after
  another).
- Read-only connections (viewers, every folder document) have their writes
  dropped by the sync server (`connection.readOnly`): Hocuspocus answers
  them with a "not applied" sync status.
- Documents are changed on the server — data migrations
  (`services/dataMigrations.ts`), token propagation, agent runs, reverts.
  Today all of them are CRDT edits through the sync server
  (`services/liveDocs.ts`), so an older copy merging into the server's
  document cannot bring back what they removed: the server's state carries
  the deletions, Yjs keeps the identities of deleted items, and the merge
  deletes the copy's content too. Two things make the server's state go
  **back** instead, and an old copy would then add items back in sync
  step 2 — resurrected slides, objects and texts:
  - a document **replaced** (an operator rebuilding a damaged document, a
    future "restore version" that writes old bytes): new identities for
    everything, items the replaced document never knew;
  - the database **restored** from a backup (a daily `pg_dump`): every
    document goes back to the dump, and a copy confirmed after the dump
    holds items the restored server does not. The restore brings every
    per-document epoch back with the rows, so a per-document epoch alone
    cannot tell such a copy (security review M1).
- Browsers differ: IndexedDB can be missing or throw (old private modes,
  locked profiles, embedded views), quota can run out, and the browser may
  evict an origin's storage at will.
- `y-indexeddb` (the Yjs project's own provider) was the plan of the
  desktop app (D1). It records **every** update of the document, the
  user's unconfirmed ones included, and replays them on the next open. On a
  read-only connection those updates are never applied by the server, so a
  viewer's local writes (an autofit height, a seeded slide) would come back
  on every open, visible to that viewer only, for ever; a writer demoted
  while offline would see the same. It opens one database per document
  (nothing to enumerate on sign-out), does not handle a failing open (an
  unhandled rejection, `whenSynced` never resolves), and applying its
  replay after the provider exists uploads the whole document to the
  server on every open.

## Decision

1. **The local copy is a cache of server-confirmed state, never a journal
   of edits.** A copy is written only at a moment when the provider is
   synced and the server has acknowledged every local update
   (`provider.synced && !provider.hasUnsyncedChanges` — the same test as
   `whenProviderSaved`). At such a moment everything the Y.Doc holds is
   held by the server too, so a copy is always a subset of the server's
   document. Consequences: rejected writes of a read-only connection are
   never stored; an edit the server has not acknowledged yet is lost on a
   reload exactly as before (offline editing is D2's, and needs its own
   journal of pending edits with lost-write detection); nothing a copy
   holds can be news to the server, unless the server's state went back
   (point 4). A stored copy is confirmed as it is (its age reset) by the
   same test, once `unsyncedChanges` is back at 0 after the sync — not on
   `synced` alone, which comes before the server has acknowledged the
   client's answer.

   A copy that is **not** a subset of the server's document (planted,
   damaged) is treated as foreign: when the server's first sync step (its
   state vector, read from the provider's `message` event before the
   provider answers it) lacks items of the copy, the provider is detached
   at once — its answer, the copy's surplus, is never sent, on a writable
   or a read-only connection — the copy deleted and the document rebuilt
   empty. A "not applied" sync status to a session that made no edits of
   its own means the same. What the state vector cannot show — deletions
   a planted copy carries — still reaches a writable connection; planting
   needs script on the origin or the profile's files, either of which can
   write to the deck directly anyway. The cost: edits the server
   acknowledged and then lost (a crash inside the store debounce) are no
   longer put back from a copy.

2. **Storage**: one IndexedDB database per origin, `narrative-local-docs`,
   three stores — `meta` (key → user, document name, format, epoch,
   sizes, when confirmed and opened), `bases` (a full
   `Y.encodeStateAsUpdate`) and `tails` (increments, each
   `encodeStateAsUpdate(doc, lastWrittenStateVector)`) — keyed by
   `<user sub> NUL <document name>`. A document opened without a copy
   writes a base at its first confirmed moment; every later write, and
   every write after opening a copy, appends a tail (cost proportional to
   the change, not the deck); past 64 tails, or when the stored base is of
   another epoch or gone (another tab, an eviction, a new generation), or a
   tail would take the copy past the byte cap, the next write is a base. A
   sync that brought nothing new only refreshes the copy's confirmation
   time.
   Writes are debounced (1 s after the last change, at most 10 s) and run
   in an idle callback; the last confirmed state is written when the
   document closes and on `pagehide`. A synchronous index in `localStorage`
   (`narrative:local-docs:v2:<sub>`) names the documents that have a copy,
   so an open without one starts its connection exactly as before — a cold
   open pays nothing.

3. **Opening**: when the index names a copy, the WebSocket opens at once
   (`HocuspocusProviderWebsocket`) while the copy is read (at most 1.5 s,
   then the open proceeds without it); the provider is created and joins
   the socket once the copy is applied — as one update (one transaction)
   with the named origin `LOCAL_COPY_ORIGIN` (not in undo history, a remote
   transaction). Its auth frame and first sync step go out only then, so
   they carry the copy's epoch and state vector: the server sends only what
   changed since, and the copy is never uploaded. The canvas mounts in
   parallel as before and paints the copy as soon as it is applied. A copy
   that fails to decode is deleted and the document rebuilt empty.

4. **An epoch, issued by the server, guards a server that went back.**
   What the server hands out is stamped `<generation>.<docEpoch>`:
   - `docEpoch` — `decks`, `folders` and `components` carry `doc_epoch`
     (integer, 1 for every document today), advanced by whatever replaces
     that one document's state (`bumpDocumentEpoch`, in the transaction
     that replaces the rows, after closing its live connections);
   - `generation` — the instance's restore generation (`instance_generation`,
     one row with `generation` and `floor`, unix seconds). A `pg_dump`
     restore carries the row back with everything else, so it is checked
     against a marker the restore cannot carry: `backup.sh` advances the
     generation right after each dump and writes the new value to
     `backups/marker/generation` on the VM (outside Postgres; deploys never
     touch `backups/`), mounted read-only into the server. A dump therefore
     always holds a generation below the marker written after it. At boot,
     before the sync server listens, a database whose generation is below
     the marker was restored: generation and floor jump to
     max(marker + 1, now). Daily backups move only the generation, never
     the floor, so they invalidate nothing.

   Every connection is told the epoch right after it connects (stateless
   message `narrative.documentEpoch`), and every connection **claims** the
   epoch of the content its Y.Doc already holds in the auth frame's token
   (`cookie;epoch=<generation>.<docEpoch>`; plain `cookie` for an empty
   document) — a copy's, or the one the server told this document earlier,
   so a tab that stayed open across a replacement or a restore is covered
   too. `onAuthenticate` refuses a claim whose `docEpoch` is not the
   document's or whose generation lies outside [floor, generation] with the
   reason `stale-document`, after the access check and before the sync
   server has processed any of the connection's messages (they are queued
   until authentication succeeds and discarded on a refusal), so nothing
   of the stale state reaches the server. The client then deletes its copy,
   rebuilds the document empty and connects again. A copy is written only
   once the epoch of the connection is known.

   The marker cannot help when it is gone or the database is restored onto
   another host; the restore runbook (`docs/deploy.md` → Restoring the
   database) therefore makes advancing generation and floor to "now" a
   mandatory step before the server starts — "now" is above every
   generation ever issued, since generations are unix seconds.

5. **Access**: copies are kept only for signed-in users and only where the
   page shows the live document — the editor, present mode, folder tokens
   and component masters opened from them. A share-link visit (a
   `share_token` in the page URL) keeps none, and neither does any page of
   a render route (`/deck/:id/render`, the component render page, frozen
   renders) — for the deck, its folder's tokens and the masters alike: the
   check is on the page's path, not on each provider's options. A copy is shown
   before the server has answered — that is the point — and only to the
   user who received it from the server on this browser profile:
   - any refusal of a connection deletes that document's copy; a refusal
     before the document's first sync of the session, while it shows a
     copy, also rebuilds the document empty, so a revoked deck shows
     nothing once the server has said no (as it showed nothing before
     this ADR);
   - signing out clears every copy; a page that learns it has no session
     (`/auth/me` 401) clears every copy; a page signed in as X deletes the
     copies of every other user (one session per browser at a time, so the
     previous user's copies can only be orphans) — their index entries at
     once, the stored copies when the page is idle; a page that cannot tell
     (`/auth/me` failed: offline, a server error) uses no copies and deletes
     none;
   - a change of user stops every open session's writes for good: the
     store refuses a write for anyone but the signed-in user, and any write
     begun before the change (a generation counter, checked as the
     IndexedDB transaction starts), so nothing of a session open before a
     sign-out lands after its clear; a sign-out stops this tab's sessions;
     every tab announces the user it runs for on the `narrative-auth`
     BroadcastChannel, and a tab that hears another user — or a sign-out —
     stops its writes and reloads (only tabs that already know their own
     user react, so tabs loading together do not reload each other);
   - when the home or a folder page has the user's folders, copies of
     folders not among them, of component masters not in those folders'
     lists, and of decks the server answers 403 or 404 for are deleted
     (once per page load, at idle; other errors keep them);
   - a copy the server has not confirmed for 30 days is deleted, so a
     device that stays offline does not keep a revoked deck readable
     indefinitely.

   **At rest** the copies are as exposed as the browser profile, and no
   more protected: IndexedDB is stored unencrypted in the profile
   directory (Chromium's LevelDB files, WebKit's SQLite), readable by anyone
   with the profile's files or the device's account; deleting a copy is
   not a secure erase (the bytes stay on disk until overwritten); closing
   the browser without signing out keeps every copy until the next visit
   (the 30-day limit is the only bound then); and the localStorage index's
   key carries the user's Google sub (`narrative:local-docs:v2:<sub>`). A
   person who does not want document copies on a device can turn them off
   for it (`setLocalDocsDisabledOnDevice` in `state/localDocStore.ts`:
   deletes every copy here and keeps none from then on); the control in
   the account menu is not built yet (an editor-only action of its own).

6. **Quota, eviction, failures**: per user at most 64 documents and
   256 MB of copies, checked after every write (bases and tails), least
   recently opened evicted first; a tail that would take one copy past
   256 MB makes the writer compact into a base, and a base larger than
   that is not kept; on
   `QuotaExceededError` the oldest half of the other copies is evicted and
   the write tried once more, then writes stop for the session. Storage is
   best-effort (`navigator.storage.persist()` is not asked for): an evicted
   copy is a cold open. IndexedDB or `localStorage` missing or throwing — a
   private window, a locked profile — turns copies off for the session and
   the editor works as before.

7. **The desktop shell** (ADR 0015) gets the same copies in its persistent
   profile. Offline opening (D1) needs a decision this ADR does not take:
   showing a copy without any server contact. Offline editing (D2) adds a
   journal of pending edits next to the confirmed copy, with the lost-write
   detection the desktop plan describes (read-only on reconnect, refused);
   the copy itself stays confirmed-only.

## Consequences

- A repeat open paints from the local copy and syncs a delta; the numbers
  are in the performance Log (L4).
- Deleting a copy never loses work: everything in it is on the server.
- One more query per connection (the document's epoch joined with the
  instance generation, after the access check) and one small stateless
  message.
- A restore of the database refuses every copy once (each browser reopens
  its documents from the server); a daily backup refuses none, but makes
  every copy write a new base the next time it syncs (its epoch string
  changed).
- A stale-epoch refusal costs one extra connection the first time a
  replaced document is opened; refusals are not counted by the failed
  authentication throttle.
- e2e specs that open the same deck twice in one browser context may see
  the copy for a moment before the sync; they must assert the server's
  state with retrying assertions (Playwright's `expect` polls already).
- The copy's format is versioned (`format: 2`, the index key's `v2`, since
  the epoch became `<generation>.<docEpoch>`); a new format deletes old
  copies instead of migrating them.

## Alternatives considered

- **`y-indexeddb` next to every provider** (the D1 plan): rejected for the
  reasons in the context — it persists unconfirmed and rejected updates,
  which a read-only connection turns into ghost edits, and it has no
  enumeration, no failure handling and no epoch.
- **`y-indexeddb` on a shadow document fed only confirmed states**: keeps
  the upstream storage but holds a second copy of every open document in
  memory and still needs our own index, epoch and clearing; the storage it
  would save is three object stores.
- **Show the copy only after the server confirmed access** (the role
  request or the WebSocket's authentication): the confirmation arrives
  within a few milliseconds of the full sync on the dev stack, so the open
  would gain next to nothing; offline it would show nothing at all.
- **A global epoch constant bumped by hand**: invalidates every copy of
  every user for one replaced document.
- **Only a runbook step for restores** (advance every `doc_epoch`): sound
  when followed, silent when forgotten; it stays as the fallback for a lost
  marker.
- **Advancing the generation at every boot**: does not detect a restore of
  the latest dump when no boot happened between the dump and the restore.
- **Postgres' system identifier or timeline**: a `pg_dump` restore into the
  same cluster changes neither.
- **The epoch inside the Y.Doc**: a stale copy carries the old value in the
  same key and the check would need the document loaded before
  authentication.
