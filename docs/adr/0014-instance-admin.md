# ADR 0014 — An instance admin owns everything and decides who may sign in

**Status**: Accepted (2026-10-16). Petr asked for a role above the folder
roles: someone who sees every folder, has the same rights as an owner in all
of them, and can let other people into Narrative without anyone editing the
server's environment.
**Scope**: `users.is_admin` and `allowed_emails` (migration 0036),
`apps/server/src/auth/{admin,permissions,signInPolicy}.ts`,
`apps/server/src/services/{admin,decks,folders}.ts`, `routes/admin.ts`,
`apps/web/src/pages/Admin.tsx`.

## Context

ADR 0013 made folder roles: owner, editor and viewer _in one folder_. Nothing
sat above them, so a second person who should see what the first sees had to
be invited to every folder, and again to every new one. Letting a person
sign in at all meant editing `OIDC_ALLOWED_EMAILS` on the production VM.

## Decision

1. **An admin is a flag on the user**, `users.is_admin`, not a row per
   folder. The access resolvers read it in the query they already run
   (`resolveDeckAccess` joins `users`; `resolveFolderAccess` asks once more,
   only when the caller is not already an owner; the deck list joins it in
   SQL, the folder list asks first and only an admin's query reads every
   folder). An admin is **owner** of every folder and deck, so a new
   folder is theirs at once and removing the flag takes everything away at
   once; no rows exist to drift out of sync.
2. **Other people's Drafts stay private.** A Drafts folder is never shared
   (ADR 0013); an admin does not see it either, nor the decks in it. Their
   own Drafts is theirs as before.
3. **Who may sign in** gets a third source beside the env allowlist and the
   implicit invite/share grants: `allowed_emails`, edited by admins. The
   address must be a verified Google email, as for invites. Removing one
   signs the person out (sessions, agent credentials, live connections) when
   nothing else admits them any more; access an invite or a share still gives
   them stays. The kill switch (`revokeUserAccess`) also drops the admin flag
   and the entry. With the env allowlist, `ADMIN_EMAILS` all empty, any Google
   account could sign in and this list would gate nothing: production then
   refuses to boot unless `OIDC_ALLOW_ANY_ACCOUNT=true`.
4. **Bootstrap**: `ADMIN_EMAILS` (env, verified email) seeds the FIRST admin:
   it sets the flag at sign-in only while the instance has no admin, and it
   lets the listed addresses sign in. After that admins decide — a demoted env
   admin stays demoted after signing in again, and an address a workspace
   hands to a new person does not make them an admin. Only a person whose
   Google email is verified can be promoted.
5. **Nobody changes their own role.** A demotion therefore always leaves its
   caller an admin, so the instance cannot end up without one; promoting and
   demoting lock the admin rows (`FOR UPDATE`) so two admins demoting each
   other at once serialise and the second is refused. A demoted admin's open
   sockets and render pages are closed (CONN-1): they reconnect with their
   own role.
6. **Not an agent capability.** There are no `admin.*` commands; the routes
   are on `parity/allowlist.ts` with this reason. Text inside a deck is data
   written by other people (ADR 0011): an instruction hidden in one must not
   be able to let a stranger in or make one an owner of everything. The admin
   routes refuse access tokens and need the app's own origin.
7. **An admin's agent has the admin's reach** (accepted risk, Petr to
   confirm). Agents act as their user through the same resolvers, so an
   admin's agent can read every deck outside others' Drafts; an instruction
   planted in one deck it reads could make it copy content from decks the
   planter cannot see. Before this ADR the reach was the user's own shares.
   The alternative — the admin override only for browser sessions, never for
   access tokens or MCP — is a contained change in `agent/access.ts` and the
   list services if the risk is not accepted.

## Consequences

- An admin's folder list is every folder but others' Drafts, as owner; there
  is no "viewing as admin" mode. Folder member lists do not show admins; an
  admin manages a folder's members like its owners do.
- Admin actions are logged (`audit: 'admin'` log lines: allow, remove, make,
  remove admin).
- `resolveFolderAccess` costs one more indexed lookup for a non-owner caller.
  Tests that script the database answer it from `scriptedDb({ admin })`
  (the `adminProbe` select key) without consuming a scripted result.
- An admin can open any deck's live document (Hocuspocus authenticates with
  the same resolver) and delete any folder: this is a powerful role. Keep it
  to the few people who run the instance.
- Not built: a stored audit trail of what admins read, and a per-admin
  Drafts opt-in.
