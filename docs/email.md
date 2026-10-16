# Email

Narrative sends transactional email through Resend (`apps/server/src/email/client.ts`;
without `RESEND_API_KEY` it only logs). Every email has one look and one tagline —
"Pro tool for keynote masters" — from `email/layout.ts`.

## The kinds

Every kind is listed once in `apps/server/src/email/catalog.ts`, with who gets it and a
preview built from sample data:

| Group    | Kind                   | Sent when                                                     | To                            |
| -------- | ---------------------- | ------------------------------------------------------------- | ----------------------------- |
| Sharing  | `deck-shared`          | a deck is shared (invite for a new address, notice otherwise) | the person shared with        |
| Sharing  | `folder-shared`        | a folder is shared, with its three latest decks               | the person shared with        |
| Sharing  | `invite-accepted`      | an invited person signs in for the first time                 | who invited them              |
| Sharing  | `access-removed`       | an owner removes someone from a deck or folder                | the person removed            |
| Sharing  | `deleted`              | a shared deck or folder is deleted                            | everyone else it reached      |
| People   | `sign-in-allowed`      | an admin allows a new address to sign in                      | that address                  |
| People   | `admin-granted`        | someone is made an admin                                      | the new admin                 |
| People   | `admin-revoked`        | someone's admin role is taken away                            | the former admin              |
| Security | `access-token-created` | a personal access token is created                            | the account owner             |
| Security | `app-connected`        | an app (claude.ai connector) is connected over OAuth          | the account owner             |
| Agents   | `agent-confirmation`   | an agent's confirmation waits 2 minutes unanswered            | the person the agent acts for |

A share sends nothing for the same role again; a new role sends again.

## Switching kinds off

Admins switch each kind on or off for the whole instance in Administration → Emails, and
preview it there. The switches live in `email_settings` (migration 0037; no row = on).
`email/notify.ts` asks before every send, so a kind that is off is not even rendered.

## Sending one

Services never call `sendEmail` directly: they call `notify({ db, log, kind, to, render })`
(or a helper in `email/events.ts`). It is fire-and-forget — the database change it
announces already happened, so a failed email is logged, never thrown. Who to tell is read
before a delete cascades the rows away; those reads select a `notifyAudience` column,
which `test-support/scriptedDb.ts` answers with nobody, so service tests need not script
the recipients.

## Adding a kind

1. A template in `email/templates/` built with `renderEmail` (layout.ts).
2. An entry in `EMAIL_KINDS` and `EMAIL_CATALOG` (label, description, recipient, preview).
3. The send through `notify` at the place it happens; an integration test in
   `email/events.integration.test.ts`.

`catalog.test.ts` renders every kind and checks the shared look; Administration shows the
new kind at once.
