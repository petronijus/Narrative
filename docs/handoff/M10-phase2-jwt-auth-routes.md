# M10 Phase 2 — JWT Validation + Route Enforcement + Sharing Endpoints

**Date**: 2026-04-20
**Agent**: state-sync
**Branch**: main
**Status**: Complete — 115/115 tests pass, 0 typecheck errors

---

## What was done

### New files

- `apps/server/src/auth/jwt.ts` — `createJwtVerifier(opts)` using `jose` library. Fetches JWKS from Authentik, verifies RS256 tokens, checks issuer + audience + expiry. Returns `{ sub, email?, name?, groups? }`. Error messages are intentionally generic (no token detail leakage).

- `apps/server/src/auth/fastifyAuth.ts` — Fastify auth plugin + two pre-handlers:
  - `registerAuthPlugin(app, { verifier, bypass, db })` — decorates request with `user` and `deckAccess` fields, stores opts on app instance for route access
  - `authPreHandler` — extracts Bearer token, verifies, attaches `request.user`. Returns 401 on failure. In bypass mode synthesizes `{ sub: 'dev-user' }`.
  - `requireDeckRole(role)` — factory returning a pre-handler that calls `resolveDeckAccess`, checks `roleAtLeast`, attaches `request.deckAccess`. Returns 403 on insufficient access.

- `apps/server/src/routes/sharing.ts` — Sharing management routes (all require owner role):
  - `GET /decks/:id/permissions` → `listPermissions`
  - `POST /decks/:id/permissions` → `grantPermission` (validated body: `{ userId, role }`)
  - `DELETE /decks/:id/permissions/:userId` → `revokePermission` with last-owner guard (409)
  - `GET /decks/:id/share-links` → `listShareLinks` (filters revoked)
  - `POST /decks/:id/share-links` → `createShareLink` → returns `{ id, url }` where url = `${PUBLIC_URL}/deck/:id?share_token=:id`
  - `DELETE /decks/:id/share-links/:linkId` → `revokeShareLink`

- Test files:
  - `apps/server/src/auth/jwt.test.ts` — 9 tests (valid payload, missing fields, wrong issuer, wrong audience, expired, malformed)
  - `apps/server/src/auth/fastifyAuth.test.ts` — 10 tests (authPreHandler + requireDeckRole)
  - `apps/server/src/hocuspocus/auth.test.ts` — 11 tests (onAuthenticate logic + persistence viewer blocking)
  - `apps/server/src/routes/sharing.test.ts` — 13 tests (full CRUD matrix + last-owner guard + access control)

### Modified files

- `apps/server/src/routes/decks.ts` — All routes use `authPreHandler`. `POST /decks` sets `ownerUserId = request.user!.sub`. `GET /decks` queries by accessible decks (via `deck_permissions` join; bypass mode also includes `demo-user` owned decks). `DELETE /decks/:id` requires owner role. `GET /decks/:id` added as a new endpoint — the ONE route accepting unauthenticated share token access via `?share_token=`.

- `apps/server/src/routes/decks.test.ts` — Rewritten to use bypass auth + mocked `resolveDeckAccess`. Tests cover: GET filters, POST sets dev-user as owner, DELETE requires owner (403 for editor/viewer), GET /:id with share token.

- `apps/server/src/index.ts` — Auth plugin registered before routes. `BYPASS_AUTH` env read, loud warning logged. `createJwtVerifier` called when not bypassed. Hocuspocus receives `verifier` + `bypass`. `registerSharingRoutes` registered.

- `apps/server/src/hocuspocus/index.ts` — `onAuthenticate` hook implemented. Validates JWT or share token, calls `resolveDeckAccess`, sets `data.context.{userId,deckId,role}` and `connection.readOnly = true` for viewer role. `onConnect` no longer hardcodes `demo-user`.

- `apps/server/src/hocuspocus/persistence.ts` — `onStoreDocument` checks `context.role === 'viewer'` and skips persistence if true (defense-in-depth; primary enforcement is `connection.readOnly`).

- `apps/server/src/auth/index.ts` — Barrel export updated to include `jwt.ts` and `fastifyAuth.ts`.

- `.env.example` — Added `BYPASS_AUTH=false` and `PUBLIC_URL=` entries with documentation.

- `apps/server/package.json` — Added `jose: ^6.2.2` dependency.

---

## New dependencies

- **`jose` v6.2.2** — Standard JOSE/JWT/JWKS library for Node.js. Used for `createRemoteJWKSet` (auto-caching JWKS) + `jwtVerify` (RS256 verification). Widely maintained, no binary dependencies.

---

## New routes

```
GET    /decks/:id/permissions         → owner only
POST   /decks/:id/permissions         → owner only, body: { userId, role }
DELETE /decks/:id/permissions/:userId → owner only, 409 if last owner
GET    /decks/:id/share-links         → owner only, returns active links only
POST   /decks/:id/share-links         → owner only, body: { role, expiresAt? } → { id, url }
DELETE /decks/:id/share-links/:linkId → owner only

GET    /decks/:id  → NEW (added in phase 2), accepts ?share_token for unauthenticated view access
```

---

## BYPASS_AUTH behavior

- `BYPASS_AUTH=false` (default) — JWT validation active. `AUTHENTIK_ISSUER`, `AUTHENTIK_JWKS_URL`, `AUTHENTIK_CLIENT_ID` must be set.
- `BYPASS_AUTH=true` — All requests synthesize `dev-user` as subject. No JWT verification. Loud warning logged on boot. `GET /decks` also returns legacy `demo-user`-owned decks (Option A compatibility).

---

## Consumer expectations for Phase 3 (editor-ui)

1. **REST auth**: send `Authorization: Bearer <jwt>` on all API requests. Handle 401 → re-authenticate, 403 → show error.
2. **WebSocket auth**: pass `token: <jwt>` into `HocuspocusProvider({ token })`. Hocuspocus sends it in the auth message.
3. **Share links**: if viewing via `?share_token=...`, pass the token as a WS query param too: `HocuspocusProvider({ url: 'ws://...?share_token=<id>' })` — Hocuspocus forwards query params from the URL.
4. **Share dialog**: use `GET /decks/:id/permissions` and `GET /decks/:id/share-links` to populate. Use `POST /decks/:id/share-links` to create; the response `url` is the shareable link to display.
5. **Share link URL format**: `/deck/<deckId>?share_token=<id>` — frontend must route this to the viewer, extract `share_token`, and pass it in the WS URL.

---

## Known limitations / TODOs

- `GET /decks` in production mode uses `sql\`IN (subquery)\`` — verify Drizzle escapes it correctly in integration tests before going to production.
- `demo-user` bypass fallback in `GET /decks` is a temporary shim. Remove when the migration script runs in production and `BYPASS_AUTH` is permanently disabled.
- `PUBLIC_URL` env var must be set in production for correct share link URLs.
- Phase 3 (client login flow) is out of scope for this phase — handled by `editor-ui` agent.
