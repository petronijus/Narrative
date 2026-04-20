# M10 Phase 3 — Auth UI Handoff

## What was built

Client-side OIDC PKCE auth flow, Share dialog, and role-based UI gating.

## Files added

- `apps/web/src/state/AuthContext.tsx` — OIDC auth context (useAuth, AuthProvider, createUserManager)
- `apps/web/src/state/DeckRoleContext.tsx` — Per-deck role context (useDeckRole, DeckRoleProvider)
- `apps/web/src/api/client.ts` — Centralized API client with Bearer token injection (useApi, createApiClient)
- `apps/web/src/pages/AuthCallback.tsx` — /auth/callback OIDC code exchange
- `apps/web/src/pages/AuthLogin.tsx` — /auth/login page
- `apps/web/src/pages/AuthError.tsx` — /auth/error page
- `apps/web/src/components/ProtectedRoute.tsx` — Route guard (share_token bypass)
- `apps/web/src/ui/ShareDialog.tsx` — Share dialog (permissions + share links)
- `apps/web/src/state/AuthContext.test.tsx` — 7 tests
- `apps/web/src/components/ProtectedRoute.test.tsx` — 5 tests
- `apps/web/src/ui/ShareDialog.test.tsx` — 9 tests

## Files changed

- `apps/web/src/App.tsx` — AuthProvider + new auth routes + ProtectedRoute
- `apps/web/src/components/DeckShell.tsx` — Added DeckRoleProvider
- `apps/web/src/components/EditorLayout.tsx` — Viewer role gating (no TransformHandles, no create-object)
- `apps/web/src/state/SlideDocProvider.tsx` — Passes JWT token + share_token to HocuspocusProvider
- `apps/web/src/pages/Landing.tsx` — Refactored to useApi, added sign-out UI
- `apps/web/src/ui/Toolbar.tsx` — Auth-aware: tool buttons hidden for viewer, Share button (owner), sign-out
- `apps/web/src/ui/Inspector.tsx` — patch() is no-op for viewer, "View only" notice
- `apps/web/src/ui/SlidesPanel.tsx` — Add/delete/duplicate controls hidden for viewer
- `apps/web/src/ui/Toolbar.test.tsx` — Added AuthContext + DeckRoleContext mocks
- `apps/web/src/ui/SlidesPanel.test.tsx` — Added DeckRoleContext mock (owner role)
- `apps/web/package.json` — Added oidc-client-ts@^3.1.0

## New routes

- `/auth/login` — Public, shows "Sign in with Authentik" button
- `/auth/callback` — Public, handles OIDC redirect
- `/auth/error` — Public, error fallback with retry link
- `/`, `/deck/:id`, `/deck/:id/present` — Protected (require session or share_token)

## New deps

- `oidc-client-ts@3.5.0` — OIDC PKCE client (successor to oidc-client, supports silent renewal, standard PKCE, well-maintained)

## Share dialog features shipped

- [x] List people with access (userId, role, grantedAt)
- [x] Change role per user (revoke + re-grant)
- [x] Remove user from deck
- [x] Invite by userId (Authentik sub claim)
- [x] List existing share links (role, expiry, URL)
- [x] Create share link with role + optional expiry date
- [x] Copy link to clipboard
- [x] Revoke share link
- [x] Focus trap (Tab/Shift+Tab cycling), Esc closes, backdrop click closes
- [ ] Email lookup for invite — deferred to M21

## Role gating applied to

- Toolbar: tool buttons (rectangle/ellipse/text/select) hidden for viewer
- Toolbar: Share button shown only for owner
- Toolbar: sign-out always visible for authenticated users
- Inspector: patch() no-op for viewer, "View only" banner shown
- SlidesPanel: "+" add button hidden for viewer
- SlidesPanel: SlideItemMenu (duplicate/delete/transition) hidden for viewer
- SlidesPanel: drag-to-reorder disabled for viewer (onPointerDown is no-op)
- EditorLayout: TransformHandles not rendered for viewer
- EditorLayout: create-object tool action no-op for viewer

## Share token flow

- `/deck/:id?share_token=<id>` — anonymous viewer path
- ProtectedRoute allows unauthenticated access if share_token is present in URL
- DeckRoleContext returns 'viewer' role when share_token is present
- SlideDocProvider passes share_token as WS URL query param (Hocuspocus parameters option)

## Token storage

- oidc-client-ts default: sessionStorage (per-tab, clears on tab close)
- Tokens are NEVER logged to console or Sentry

## Dev / bypass mode

- Server runs with `BYPASS_AUTH=true` → missing JWT is fine
- Client: if no token, HocuspocusProvider gets `token: null` (passes undefined to Hocuspocus)
- API client: if no token, no Authorization header is sent → works with BYPASS_AUTH server

## Tests added

- AuthContext: 7 tests (session restore, login/logout, error handling)
- ProtectedRoute: 5 tests (redirect, auth pass-through, share_token bypass, loading state)
- ShareDialog: 9 tests (render, list display, grant/revoke/create/copy, Esc/backdrop close)
- Total new: 21 tests. All 381 tests pass.

## Known limitations

- Role resolution uses `/decks` list endpoint; server currently returns `viewerRole` only when phase 2 lands. Fallback: authenticated users who can see a deck get 'editor' role until server provides the field.
- Invite by userId (Authentik sub) only — email lookup deferred to M21.
- Silent renewal requires Authentik to have `silent_redirect_uri` configured; without it, users re-auth every token TTL (default Authentik 5 min).
- Share link QR code / custom slug — M21.
- HocuspocusProvider `parameters` option: verified present in v2.15 API for passing WS URL query params.

## Blockers for next agent

- State-sync (phase 2) needs to:
  1. Validate JWT on all `/decks*` routes
  2. Include `viewerRole` in GET /decks and GET /decks/:id responses
  3. Implement permissions and share-links endpoints
  4. Validate Hocuspocus `token` auth message
  5. Accept `share_token` WS query param for anonymous viewer path
