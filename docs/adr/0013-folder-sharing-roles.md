# ADR 0013 — A folder is shared with roles; everything in it follows the folder role

**Status**: Accepted (2026-09-30). Petr decided the model on 2026-09-30:
sharing a folder shows everything in it with no hierarchy inside, sharing a
deck shows that deck only, the folder roles are the deck roles, the same
roles bind agents over MCP, and component media is linked rather than copied
inside a folder. Step 1 (the access core) shipped in 0.10.16; step 2
(linked component media) is built; steps 3–5 are planned in
[`plans/folder-sharing.md`](../plans/folder-sharing.md).
**Scope**: `folder_permissions` (migration 0030), `apps/server/src/auth/permissions.ts`,
`apps/server/src/services/shared.ts` (`requireFolderRole`,
`requireFolderContentReader`), every folder-scoped service and route, the
Hocuspocus `folder:<id>` and `component:<id>` documents, component media
access (`apps/server/src/media/mediaOwner.ts`), and the agent host
(`apps/server/src/agent/access.ts`).
**Supersedes**: decision 2 of ADR 0012 (component media is authorised by
owning the component's folder; share tokens never reach it). Decision 3 of
ADR 0012 (copy whenever media crosses an owner) is narrowed by step 2: inside
one folder a stamp links the component's media instead of copying it.
**Related**: ADR 0010 (commands are the only writer), ADR 0011 (agents act as
their user), ADR 0012 (component-owned media).

## Context

Until now a folder had exactly one person: `folders.owner_user_id`. Sharing
existed per deck only (`deck_permissions`, `deck_invites`, `share_links`).
Everything a folder holds besides decks — components, their pictures and
videos, fonts, design tokens — was reachable by the folder's owner alone. Two
consequences showed up in A2.12b:

- A deck shared with a colleague rendered without its folder's tokens and
  fonts: the `folder:<id>` document and the font routes refused anyone but
  the owner, so the deck fell back to default styles.
- Stamping a component into a deck had to copy the master's media into the
  deck (ADR 0012), because nobody but the folder's owner could load the
  master's own pictures.

Petr's model: a folder is a client or brand. Sharing it shares all of it;
there are no levels inside a folder. Sharing a single deck must not reveal
the rest of the folder.

## Decision

1. **`folder_permissions (folder_id, user_id, role)`** with the `deck_role`
   enum (viewer, editor, owner). The creator is the first owner (the
   migration backfills every existing folder; creating a folder or Drafts
   writes the row in the same transaction). `folders.owner_user_id` stays as
   the creator and the Drafts identity.
2. **One role per folder, applied to everything in it.** The deck role is the
   highest of the deck's own grant, the folder role and a share link.
   `decks.owner_user_id` only records who created a deck: the owner
   fallback it used to grant could not be revoked, so migration 0031 wrote
   every creator's owner row and the fallback went. The component role is the folder role. Viewer
   reads and presents, editor changes decks, components, tokens and fonts,
   owner also renames, shares and deletes the folder. Moving a deck between
   folders changes who sees it and needs the owner role on the deck plus
   editor in both folders.
3. **A deck guest reads the folder's shared content, and nothing else of the
   folder.** Anyone with access to a deck of the folder — a deck grant or a
   share link to it — reads the folder's tokens (`folder:<id>`, read-only),
   fonts and component media, so the deck renders as its owner sees it. They
   do not list the folder, its other decks or its components
   (`resolveFolderContentAccess`). The folder document is read-only for
   every browser connection, members included: tokens change only through
   the server, which validates them and carries a change into the decks.
4. **Component media: read by the folder's content readers, written by its
   editors** (`canReadComponentMedia`, `canWriteComponentMedia`). Share
   tokens now reach component media of the folder their deck is in.
   Copying a master's objects within its folder needs the viewer role;
   copying them into another folder is an export and needs editor, as
   copying out of a deck does.
5. **The same resolvers everywhere.** Routes and commands share the services
   (ADR 0010), which check roles through `requireFolderRole` /
   `requireFolderContentReader`; Hocuspocus and the agent host call the same
   resolvers, so an agent has exactly its user's role (ADR 0011).
6. **Drafts stays private**, and there is no share link for a whole folder:
   anonymous access stays per deck.

## Alternatives considered

- **Per-object ACLs inside a folder** (a component or font shared
  separately). Rejected by Petr: no hierarchy inside a folder.
- **Share a folder by granting every deck in it.** It would not cover
  components, fonts and tokens, would miss decks added later, and revoking
  would have to guess which grants came from the folder.
- **Keep folder content owner-only and copy it into shared decks** (what
  ADR 0012 did for component media). Tokens and fonts cannot be copied
  meaningfully — they are the folder's live styles — and copies multiply
  storage for every stamp.

## Consequences

- A member's role is resolved on every folder-scoped request; the deck role
  stays one query (the deck row with both grants joined).
- Revocation must close live connections wider than before: a revoked share
  link closes its connections on every document; revoking a deck grant also
  closes the user's `folder:<id>` connection when that deck was their only
  way in; moving or deleting a deck closes every connection on it and on
  its folder's token document, so everyone re-authenticates; revoking
  folder membership (step 3) must close the user's connections on the
  folder's decks, components and token document.
- Since step 2 a deck's guests, share-link holders included, can read every
  picture and video owned by the deck's folder or its components by id,
  not only those the deck shows, and a share-linked deck moved into
  another folder opens that folder's media to the link's holders.
  Accepted (Petr, 2026-10-03): ids are `nanoid(16)`, so the exposure is
  the ids a guest has already seen; the "Move to…" dialog warns when the
  deck has an active share link.
- Whoever may read a folder's pictures and videos may also take them into
  another folder (Petr, 2026-10-03): inside the folder they stay links,
  outside it they become copies the new owner keeps, also after losing
  access to the folder. A viewer or a deck guest can therefore keep copies
  of the component media they could see. Removing a picture or video from
  a master is a folder editor's, and hands it to the folder; deleting
  folder-owned media is the folder owner's.
- Until step 4 the folder-scoped commands still declare the owner role, so an
  agent of a folder editor is refused writes the web app allows.
- Removing someone from a folder (step 3) leaves their deck grants in
  place — including the owner row of a deck they created there — unless
  step 3 decides otherwise; those rows can now be revoked like any other.
