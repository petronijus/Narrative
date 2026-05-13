# ADR 0005 — Server-driven session cookies for HTTP and WebSocket auth

**Status**: Accepted (2026-05-13, shipped in `0.6.0`–`0.6.3`).
**Replaces**: the browser-PKCE flow originally documented in
`docs/handoff/google-auth-handover.md`.

## Context

The 0.5.x deployment used the browser-PKCE pattern documented in the
`oidc-client-ts` README:

- The SPA ran the full Google OAuth dance in the browser.
- The resulting Google `id_token` lived in `localStorage` and was sent
  to the API as `Authorization: Bearer <jwt>`.
- The Hocuspocus client passed the same `id_token` as `token` to
  `HocuspocusProvider`; the server verified it in `onAuthenticate`.
- Tokens expired after 1 h. A hidden iframe + `prompt=none` silent
  renew was used to refresh them in the background.

This worked in Chrome but degraded in three increasingly common
environments:

1. **Safari (since 2020)** and **Firefox with strict ETP** block
   third-party cookies, which breaks the iframe-based silent renew
   because the iframe is cross-site with `accounts.google.com`.
2. **Chrome's third-party cookie deprecation roadmap** would have
   broken the same path on Chrome in the near future.
3. **localStorage is XSS-readable**, so any successful injection
   would exfiltrate a usable bearer token for the full 1-h window.

Users effectively had ~1-hour sessions, with the practical experience
of "log in again after every browser close" on Safari.

## Decision

Move all OAuth handling to the server. The browser only ever holds an
opaque session id in an HttpOnly cookie. Concretely:

### HTTP API

- New routes on the Fastify server:
  - `GET /auth/start?returnTo=…` — generates PKCE state + 302's to Google.
  - `GET /auth/callback?code=…` — exchanges the code, verifies the
    `id_token` via the existing `JwtVerifier` (which still enforces
    `OIDC_ALLOWED_EMAILS` / `OIDC_ALLOWED_DOMAIN`), inserts a row into
    `sessions`, sets the `narrative_session` cookie, then 302's back
    to `returnTo`.
  - `GET /auth/me` — returns `{ sub, email, name }` resolved from the
    session cookie, or `401`.
  - `POST /auth/logout` — revokes the session row and clears the cookie.
- A new `sessions` table (migration `0012_sessions.sql`) keyed by
  `SHA-256(cookie_value)` so the raw id never lands in the database.
  Sliding 30-day expiry; revocation supported.
- `authPreHandler` reads the cookie and looks up the session row.
- CORS gets `credentials: true` so dev's cross-origin SPA (5173 → 3001)
  carries the cookie.

### WebSocket auth (Hocuspocus)

This is the part that needed the most care — explaining why is the
real motivation for this ADR.

`@hocuspocus/server`'s `onAuthenticate` hook only fires when the
**client** sends an explicit auth-frame in the Hocuspocus protocol,
and `HocuspocusProvider` only sends one when it's configured with a
non-falsy `token`. If you skip `token`, the server's
`requiresAuthentication: true` flag holds the connection in limbo
until its idle timeout fires.

We considered three approaches:

1. **Move auth to `onConnect`.** Earliest hook, no token required.
   Rejected because `onConnect` doesn't have a clean reject mechanism
   that produces the right close code on the client (the `onClose`
   path expects 4401/4403 from `onAuthenticate`).
2. **Use a dedicated `onUpgrade` hook + manual WebSocket close.**
   Works but pulls auth out of Hocuspocus's lifecycle and complicates
   share-token handling.
3. **Send a sentinel `token` so `onAuthenticate` runs; read the real
   auth from the WS upgrade's `Cookie` header.** Chosen.

So every `new HocuspocusProvider({ … })` call site in `apps/web/`
passes `token: 'cookie'` as a literal sentinel. The server's
`onAuthenticate` ignores the value entirely and pulls the session
from the cookie carried on the WS upgrade (which the browser sends
automatically because the WS host is same-origin with the SPA).

This works because:

- WebSocket upgrades are HTTP requests under the hood; browsers
  attach same-origin cookies normally.
- Hocuspocus exposes `requestHeaders` on the `onAuthenticate` payload.
- Our share-link path (anonymous viewer with `?share_token=…`) is
  unchanged — it sends `parameters: { share_token }` and no token,
  and the server detects `share_token` _before_ the cookie check.

## Consequences

- Sessions last 30 days sliding; users effectively never log in again
  until they explicitly log out or stay away >30 days.
- The Google `id_token` never enters the SPA, so XSS can't steal it.
  The most XSS could exfiltrate is the cookie's `narrative_csrf`
  value (currently not deployed; will be added if/when we have
  third-party integrations) or the `/auth/me` response — neither is
  usable cross-site.
- Safari / Firefox strict ETP / Chrome 3PC-deprecated all work
  identically to Chrome because there's no iframe + no third-party
  cookies anywhere in the auth path.
- The sentinel-`token` convention is non-obvious to new readers. Every
  HocuspocusProvider call site has an inline comment pointing at this
  ADR. The string `'cookie'` is arbitrary; the server doesn't look at it.
- `@hocuspocus/provider`'s `onClose` handler prints a single
  cosmetic warning if its idle-timeout-triggered 4401 close races
  the initial shared-WS attach. We suppress this in
  `apps/web/src/state/installHocuspocusWarningFilter.ts` — the
  warning's premise ("you didn't send a token") is wrong for our
  case, but the library can't tell.

## Operational notes

- `SESSION_COOKIE_SECRET` is required in `.env.prod` (the OAuth state
  cookie is signed with it). `openssl rand -hex 32`.
- Google Cloud Console must list `https://<DOMAIN>/api/auth/callback`
  as an Authorized redirect URI. Note the `/api/` prefix: Caddy
  strips it before forwarding to the server, but the browser hits
  the URL with the prefix and Google validates against the URL the
  browser sees.

## Related work

- Migration: `apps/server/drizzle/0012_sessions.sql`
- Server module: `apps/server/src/auth/session.ts`
- Server routes: `apps/server/src/routes/auth.ts`
- Server middleware: `apps/server/src/auth/fastifyAuth.ts`
- Hocuspocus integration: `apps/server/src/hocuspocus/index.ts`
- Client context: `apps/web/src/state/AuthContext.tsx`
- Deploy runbook: `docs/handoff/0.6.0-server-sessions.md`
- Pull requests: `#48` (0.6.0), `#49` (0.6.1), `#50` (0.6.2), `#51` (0.6.3)
