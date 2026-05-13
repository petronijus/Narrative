# Changelog

All notable changes to Narrative follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

---

## 0.7.0 — Sharing rework: invite by email + pending invites (2026-05-13)

Closes the usability gap from M10: invite collaborators by email instead
of by opaque Google `sub`, list pending invites, and show real
names/initials throughout the sharing UI.

### Added

- **`apps/server/drizzle/0013_users_and_invites.sql`** + Drizzle schema entries:
  - `users` table — directory keyed by Google `sub`, with email/name/picture_url. Populated on every `/auth/callback`. Backfilled from existing `sessions` rows on migration so the dialog renders correctly immediately after deploy.
  - `deck_invites` table — pending email invites with 30-day expiry, partial-unique on `(deck_id, LOWER(email))` for non-accepted rows.
- **`apps/server/src/auth/users.ts`** — `upsertUser`, `getUserBySub`, `getUserByEmail`, `listUsersBySubs`.
- **`apps/server/src/auth/invites.ts`** — `createInvite`, `listPendingInvitesForDeck`, `revokeInvite`, `consumePendingInvitesForEmail` (called from `/auth/callback`, converts pending invites to permission rows on first login).
- **`/auth/callback`** now upserts the user directory and consumes pending invites for that email before issuing the session cookie.
- **`POST /decks/:id/permissions`** rewritten to accept `{ email, role }`. Returns `200 { kind: 'granted', user }` when the email matches an existing user, or `201 { kind: 'pending', invite }` when the invitee hasn't signed in yet.
- **`GET /decks/:id/permissions`** enriched with `email` + `name` per row via a single IN-list join.
- **`GET /decks/:id/invites`** + **`DELETE /decks/:id/invites/:inviteId`** for listing and cancelling pending invites.
- **`GET /folders/:id/active-editors`** response shape changed from `{deckId, userIds:[sub]}` to `{deckId, users:[{userId,email,name}]}` so presence bubbles can render real initials.
- **`apps/web/src/ui/ShareDialog.tsx`** rewritten: invite by email with client-side validation, displays name + email per collaborator (with email subtitle when a display name is set), pending-invites section with cancel button, role-change uses the upsert-by-email path.
- **`apps/web/src/pages/FolderDecks.tsx`** `ActiveEditorsBubbles` rewritten to take enriched user objects; tooltip shows `Name (email) is editing`.
- **Tests**: 4 new server route tests covering enriched listPermissions + the granted/pending invite split + invite list/revoke. ShareDialog test rewritten for the email-input + name display + pending-invites flow (11/11).
- **`docs/handoff/0.7.0-sharing-rework.md`** — deploy + verification runbook.

### Changed

- `BUILD_PLAN.md` — M10 split: M10.1 is the server-session cutover (0.6.x), M10.2 is the sharing rework (0.7.0). Original M10 deliverable wording trimmed to match what actually shipped first.

### Why

The 0.6.x server-session migration exposed a UX cliff: every sharing surface displayed the Google `sub` (a 21-digit number) because nothing in the schema tied that sub to a human-readable identifier. Inviting a collaborator required them to send you their `sub`, which they can't even find. 0.7.0 makes the feature actually usable.

---

## 0.6.0 — Server-driven session cookies (2026-05-13)

Replaces the browser-PKCE flow that put the Google `id_token` into
`localStorage` (and only kept users signed in for ~1 h until the
hidden-iframe silent renew failed on Safari / privacy-strict Firefox)
with a proper server-driven OAuth + opaque session cookie flow. The
browser now only holds an opaque session id; the actual tokens never
leave the server.

User-visible: sessions last 30 days with sliding expiry, work in every
browser identically, and survive reboots without re-prompting.

### Added

- **`apps/server/drizzle/0012_sessions.sql`** + **`sessions` table in the Drizzle schema** — `id_hash` (SHA-256 of the cookie value), `user_sub`, `user_email`, `user_name`, `created_at`, `last_used_at`, `expires_at`, `revoked_at`, `user_agent`, `ip`. Indexed on `user_sub` and `expires_at`. A read-only DB compromise can't be used to impersonate active users because the raw cookie value never lands in the DB.
- **`apps/server/src/auth/session.ts`** — `createSession`, `lookupSession`, `revokeSession`, `revokeAllSessionsForUser`, `sweepExpiredSessions`. Every `lookupSession` touches `last_used_at` and slides `expires_at` forward by 30 d in one round-trip via Drizzle's `update().returning()`.
- **`apps/server/src/routes/auth.ts`** — server-driven OAuth: `GET /auth/start` (mints PKCE state + 302 to Google), `GET /auth/callback` (exchanges code → id_token → verifies via existing `JwtVerifier` → INSERTs session + Set-Cookie + 302 to returnTo), `GET /auth/me` (returns session user or 401), `POST /auth/logout` (revokes + clears cookie). State cookie is HMAC-signed via `@fastify/cookie`'s built-in signing.
- **`@fastify/cookie`** plugin registered in `apps/server/src/index.ts` with `SESSION_COOKIE_SECRET` env. CORS gets `credentials: true` so dev cross-origin (5173 → 3001) carries the cookie.
- **`SESSION_COOKIE_SECRET`** required env var (server throws on boot in prod without it). Documented in `.env.example` and `infra/.env.prod.example`.

### Changed

- **`apps/server/src/auth/fastifyAuth.ts`** — `authPreHandler` now reads the `narrative_session` cookie and looks up the session row instead of decoding a Bearer JWT. `AuthPluginOpts` drops the `verifier` field. Same `request.user` shape on the way out so route handlers don't change.
- **`apps/server/src/hocuspocus/index.ts`** — `onAuthenticate` parses the `Cookie:` header from the WS upgrade request instead of consuming a `token` arg from the client. Same-origin (prod) and same-site (dev) automatically carry the cookie on WS upgrade — no client-side token plumbing required.
- **`apps/web/src/state/AuthContext.tsx`** — rewritten. `login()` is a top-level navigation to `${API_URL}/auth/start`. `logout()` POSTs `/auth/logout` then bounces to `/auth/login`. On mount fetches `/auth/me`. `token` is gone from the context value — all API calls use `credentials: 'include'`.
- **`apps/web/src/api/client.ts`** — drops the Authorization header path; all requests now go out with `credentials: 'include'`. `createApiClient()` is a no-arg factory.
- **`apps/web/src/state/{Slide,Folder}DocProvider.tsx`, `state/componentDocCache.ts`, `state/writeComponentMasterTree.ts`** — drop the `token` arg passed to `HocuspocusProvider`. Cookie-based same-origin/same-site auth replaces it.
- **`apps/web/src/renderer/{imageUrl,videoInfo}.ts`** — fetch with `credentials: 'include'`; token-getter args removed.
- **`apps/web/src/state/useMediaUpload.tsx`** — `tus.Upload` now runs with `withCredentials: true`; no more Bearer header on PATCH.
- **CORS** in `apps/server/src/index.ts` gets `credentials: true` so dev cross-origin fetches carry the cookie.

### Removed

- **`oidc-client-ts`** dependency.
- **`apps/server/src/routes/authProxy.ts`** — replaced by the new `/auth/start` + `/auth/callback` routes.
- **`apps/web/src/pages/AuthCallback.tsx`** — the server handles the callback now and 302's straight back to the SPA's `returnTo`. The React Router route for `/auth/callback` is also removed.
- **`VITE_OIDC_*` build-time env vars** (`VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID`, `VITE_OIDC_REDIRECT_URI`) — no longer needed; the SPA does not configure any OIDC client. Removed from `.env.example`, `infra/.env.prod.example`, `apps/web/Dockerfile`, and `infra/scripts/deploy.sh`.
- **`registerComponentDocTokenGetter` / `setComponentDocTokenGetter`** and the cache's `tokenGetters` registry — the WS upgrade carries the cookie automatically.
- **`useAuth().token`** — gone from the public context shape; tests that referenced it have been updated.

### Operational notes

- **Google Cloud Console redirect URIs** must be updated before deploying:
  - Add: `https://narrative.example.com/api/auth/callback` (prod) and `http://localhost:3001/auth/callback` (dev).
  - Remove: the old `https://narrative.example.com/auth/callback` once prod redeploys.
- **`OIDC_CLIENT_SECRET`** must be set on the prod VM (`/home/user/narrative/infra/.env.prod`). Already there from 0.5.x; no change needed.
- **`SESSION_COOKIE_SECRET`** must be added to `.env.prod`: `openssl rand -hex 32`.
- Migration `0012_sessions.sql` runs automatically on next prod deploy via `migrate.js`.
- All existing sessions invalidate at cutover: users will need to log in once more. Subsequent logins last 30 days sliding.

### Why

The browser-PKCE flow needed third-party cookies + a hidden iframe to refresh the id_token, which is increasingly broken (Safari since 2020, Firefox ETP-strict, eventually Chrome). Sessions effectively maxed out at 1 h. The id_token also sat in localStorage which is XSS-readable. The server-driven session cookie addresses all of that and is the pattern every grown-up SaaS uses (Linear, Notion, GitHub, Vercel…).

---

## Google OIDC end-to-end + first production deploy (2026-05-12)

First public deployment of Narrative. Live at
`https://narrative.example.com` via a Cloudflare Tunnel on the
home-lab. Auth is real Google OIDC with PKCE; the `client_secret`
required by Google's "Web application" client type lives only on the
server, so the SPA bundle stays clean.

### Added

- **`apps/server/src/routes/authProxy.ts`** — `POST /api/auth/google/exchange`. Browser sends `code` + `code_verifier`; server adds `OIDC_CLIENT_SECRET` (env-only) and forwards to Google's token endpoint. The SPA points `oidc-client-ts`'s `token_endpoint` here via `metadataSeed`, declaring `token_endpoint_auth_methods_supported: ['none']` so the library treats the client as public and skips its "client_secret is missing" guard.
- **`infra/docker-compose.prod.shared-tunnel.yml`** — new prod topology for hosts that share an upstream Cloudflare Tunnel (e.g. the one already routing nextcloud + others on the home-lab docker VM). Caddy publishes on host:80 (so the external tunnel can reach it via LAN IP); the bundled `cloudflared` service is profile-gated out via `profiles: [internal-tunnel]`; internal services drop their `127.0.0.1:` host-port publishes via `ports: !reset []` (sidesteps a Docker 29.4 port-bind race on rapid container recreate); OIDC + media env vars are explicitly piped from `.env.prod` into the server container; `narrative-server` healthcheck overridden to use `127.0.0.1` (BusyBox `wget` resolves `localhost` to IPv6 first, which Fastify doesn't bind).
- **`apps/web/e2e/prod-oauth-smoke.spec.ts`** — non-destructive smoke test that hits the prod URL, confirms the login redirect, parses the Google OAuth URL, and asserts client_id / redirect_uri / PKCE params without actually completing Google's consent screen.
- **`docs/handoff/google-auth-handover.md`** — operating notes for the deploy target (VM 103 `narrative` on Proxmox, SSH jump path, architecture diagram).
- **Server-side `apps/server/src/db/migrate.ts`** rewritten as a custom per-file-transaction migrator (~50 lines). Each migration runs as its own implicit transaction via node-postgres simple query protocol, so `ALTER TYPE ... ADD VALUE 'font'` commits before subsequent migrations reference the new enum value. Drizzle's built-in migrator wraps all pending migrations in one outer transaction, which Postgres rejects with `unsafe use of new value … of enum type` (error 55P04) — this hit `0009_m16_consolidate_fonts` on every fresh deploy. Tracking table layout (`drizzle.__drizzle_migrations`) matches drizzle's so the built-in could resume if needed.

### Fixed

- **`packages/shared`** missing `yjs` declaration — `src/slide.ts` did `import type * as Y from 'yjs'` but `yjs` wasn't in the package's deps. Worked in dev via pnpm hoisting, broke in Docker's isolated `--frozen-lockfile` install. Added as devDependency.
- **`apps/web`** missing `y-protocols` — same class of bug. Added.
- **`apps/server/Dockerfile`** runtime `CMD` pointed at `apps/server/dist/index.js`, but tsc emits with workspace-root rootDir (cross-package imports include files outside `apps/server/src/`) so the actual entry is `apps/server/dist/apps/server/src/index.js`. Same path mismatch for `db/migrate.js` (used by deploy.sh). Both paths corrected.
- **`apps/server/Dockerfile`** workspace package resolution — `pnpm install` symlinks `node_modules/@narrative/*` to `packages/<pkg>/`, where `package.json` says `"main": "./src/index.ts"`. Node can't load `.ts` at runtime. Mirrored the video-worker Dockerfile pattern: copy compiled JS from the builder stage on top of the symlinked source dir, then `sed` `package.json` to point at `./src/index.js`. Applied to `@narrative/shared` and `@narrative/slide-model`.
- **Drizzle migrations path** — compiled `migrate.js` lives 4 dirs deeper than expected, so `path.resolve(__dirname, '../../drizzle')` resolved wrong. Dockerfile now copies `drizzle/` to BOTH the original `apps/server/drizzle/` and the deeper `apps/server/dist/apps/server/drizzle/` location.
- **pnpm 10 `[ERR_PNPM_IGNORED_BUILDS]`** in Docker — pnpm 10 fails the install if any package's postinstall script isn't explicitly whitelisted. Web Dockerfile uses `--ignore-scripts` (esbuild's postinstall just verifies a platform binary that's already in `@esbuild/linux-x64`; skipping is safe). Root `package.json` declares `pnpm.onlyBuiltDependencies: [esbuild, @swc/core, msgpackr-extract]` as a longer-term fix.
- **`apps/web/Dockerfile`** missing `VITE_OIDC_*` build args — Vite bakes `import.meta.env.VITE_*` at build time. Added `VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID`, `VITE_OIDC_REDIRECT_URI`, `VITE_IMGPROXY_URL` as ARG + ENV. `deploy.sh` passes them via `--build-arg` derived from `${DOMAIN}` and `.env.prod`.
- **Auth callback race** — `apps/web/src/pages/AuthCallback.tsx` previously created its own `UserManager` and listened for events that the `AuthProvider`'s separate `UserManager` instance never received. Plus, even when the right instance got the event, `navigate('/')` raced the React state commit so `<ProtectedRoute>` rendered with `user=null` and bounced back to `/auth/login` — requiring a second login attempt. Fixed by routing the callback through `AuthProvider.completeSignin()` (single shared `UserManager`) and using `flushSync` to commit the user state before navigating.
- **AuthError page** — was hardcoded "session expired" text. Now reads `location.state.error` and renders the actual `signinRedirectCallback` error message in a red pre block, so unknown failures are debuggable without DevTools.
- **`oidc-client-ts` `loadUserInfo: true`** — was triggering an extra round-trip to Google's userinfo endpoint after the token exchange. The id_token JWT already carries `sub` / `email` / `name`, so the call is redundant — and any failure (CORS, rate limit) was fatal to the whole sign-in. Disabled.

### Changed

- **`infra/scripts/deploy.sh`** — new `USE_SHARED_TUNNEL=1` flag toggles the override compose file, skips the bundled-cloudflared healthcheck, and probes server health via `docker exec` (no host port published in shared-tunnel mode).
- **Top toolbar** — `apps/web/src/components/EditorLayout.tsx` — the toolbar now spans the full width above the side panels (was previously squeezed between them). Slides + Inspector panels start at `top: topBarH`; toolbar at `z-20` over the panels.

### Infrastructure

- **VM 103 `narrative`** on Proxmox `pve` — Ubuntu 24.04 cloud image provisioned via `qm create` + cloud-init from this machine over SSH (Proxmox MCP can inspect but not create). 4 vCPU / 4 GB RAM / 40 GB disk on the `data` lvmthin pool. `petr` user, ed25519 key auth, NOPASSWD sudo, Docker 29.4.3 + Compose v5.1.3, qemu-guest-agent reporting IP to Proxmox.
- **OPNsense dnsmasq static reservation** — `BC:24:11:18:A0:ED → 192.0.2.147` so the LAN IP stays put and the Cloudflare Tunnel public-hostname mapping (`narrative.example.com → 192.0.2.147:80`) doesn't break on lease renewal.

### Removed

- Stale Playwright artifact directories at `apps/test-results/` and `test-results/` (also added to `.gitignore`).

---

## Audit + test debt cleanup (2026-05-09)

Multi-stage codebase audit and test-suite consolidation. Eight commits
on `main`: `1e53cf5` (Tier 1 security/leaks/bundle), `7081697`
(Tier 2 render storms / animation lifecycle / observer race), `229658d`
(centralised Pixi mock), `778bab1` (web suite cleanup + e2e migration),
`d8ed687` (testing strategy doc), `d026e68` (Tier A), `7edebd9`
(Tier B), `d504f83` (Tier C).

### Added

- **`/CLAUDE.md`** — project guide telling Claude sessions which test commands to auto-run for which kinds of changes (renderer, mutations, auth, etc.) and the architecture invariants not to violate.
- **`docs/testing-strategy.md`** — strategy + roadmap doc, all three tiers (A/B/C) marked complete.
- **`packages/slide-model/src/convergence.property.test.ts`** — fast-check property-based CRDT convergence (3 properties, 400 random op sequences per run): disjoint+sync, three-client star topology, offline-then-reconnect.
- **`apps/server/src/hocuspocus/lifecycle.test.ts`** — server doc-cache leak guard (cache returns to 0 after debounce, 50× open/close stays bounded, reopen reuses cached entry).
- **`apps/web/e2e/keyboard-shortcuts.spec.ts`** — replaces 14 jsdom-misplaced unit tests; covers Toolbar (R/O/T/V), input-focus suppression, present-mode entry, slide nav, present-layout exit.
- **`apps/web/e2e/renderer-visual.spec.ts`** — sampled-thumbnail visual regression (always-on) + opt-in pixel-perfect baselines (`RUN_VISUAL_BASELINES=1`).
- **`apps/web/e2e/destructive-flows.spec.ts`** — deck delete + cascade, share-link revoke happy + IDOR guard, folder cascade, Drafts protection.
- **`apps/web/e2e/multi-client-collab.spec.ts`** — three browser contexts converging through real Hocuspocus + offline/online catch-up via `setOffline`.
- **`apps/web/e2e/inspector-flows.spec.ts`** — full Inspector e2e replacing deleted DOM-presence component tests.
- **`apps/web/src/test/pixiMock.ts`** + **`apps/web/src/test/renderWithProviders.tsx`** — single-source-of-truth mock factory and provider wrapper (replaces ~20 inline copies).
- **`tests/load/runAll.mjs`** — load-test harness with absolute thresholds + 20% drift warnings vs `tests/load/baselines.example.json`.
- **`.lighthouserc.json`** + `pnpm lighthouse` script — Core Web Vitals on the editor route (warn-level FCP/LCP/TBT/CLS/TTI).
- **`packages/slide-model/stryker.config.json`** + `pnpm --filter @narrative/slide-model mutate` — Stryker mutation-testing pilot targeting `mutations.ts` + `slides.ts`.
- **`pnpm size`** — size-limit budgets per chunk + total first-paint ≤ 800 KB gz (currently 747).
- Vite `manualChunks` split — main app chunk down from 836 KB gz to 189 KB gz.

### Fixed

- **Tier 1**: security blockers (auth bypass paths, IDOR on share-link revoke, missing rate-limits on auth endpoints), server resource leaks (Hocuspocus doc-cache eviction with `unloadImmediately:false` + `debounce:2000`), bundle hygiene.
- **Tier 2-A**: render storms — memoised `SelectionContext`, `SlideDocProvider`, `EditorLayout` array refs.
- **Tier 2-B**: server-side leaks — Hocuspocus lifecycle settings, doc cache returns to 0 after disconnects.
- **Tier 2-C**: animation lifecycle — Magic Move `onComplete` chained via `eventCallback('onComplete')` instead of overwriting; `playTransition` snap-final-state guard restored.
- **Tier 2-E**: `subscribeToSlides` race — `slideObserve` no longer fires partial state during transactions.
- **`InputBridge`** listener leak — single-overwrite replaced with `Set<cb>` broadcast.
- **`videoRenderer`** shared `containerRegistry` race — registry keyed by node id, cleared on unmount.
- **`useMediaUpload` tests** — switched mock from `getHeader` to `getBody` (server moved metadata to JSON body because browser CORS strips custom headers).

### Changed

- **Web test suite**: 102 failures → 0; 61 skipped → 23 (all remaining skips have rationale comments in-file). Total across all packages: 1,219 unit + integration tests pass, 0 fail.
- **`pnpm dev`** — now starts web + server + video-worker (was only web + server). Added `pnpm dev:no-worker` for the old behaviour.
- **`hls.js`** — moved back to static import after lazy-import broke video rendering on first play; vendor-hls chunk split kept.
- **`bullmq` + `ioredis`** — Node 25 ESM compat fix: default-import + destructure named exports.

### Removed

- ~80 DOM-presence component tests (`getByText('Fill')`, `expect(button).toBeInTheDocument()`) — replaced by e2e or deleted as no-signal.
- 6 `objectRenderers/*.test.ts` files asserting Pixi mock-call shapes — replaced by sampled-thumbnail e2e.
- 14 jsdom keyboard-shortcut tests — moved to `apps/web/e2e/keyboard-shortcuts.spec.ts` (real focus model required).
- 6 `FillTokenTab.test.tsx` skips for retired UX (Token tab folded into colour-picker popover during M16-P8).
- Empty `describe` blocks left over after deletions.

### Technical decisions

- `Y.encodeStateAsUpdate` is **not** canonical (clock entries serialise in insertion order). Property-based convergence asserts structural deep-equality of `listSlides()` output (with `JSON.parse(JSON.stringify(slide))` to strip live `Y.Text` / `Y.XmlFragment` refs).
- Visual regression is two-tier: sampled-thumbnail tests run always (cross-platform robust); pixel-perfect baselines opt-in via env var (avoid baseline-churn from font-rendering differences).
- Lighthouse + Stryker are NOT on every PR — `pnpm size` and `pnpm load:all` are. Slow gates run nightly / pre-release.
- Sub-agents in this repo MUST run on Opus (memory-noted): Sonnet output needed reviewer rework on M16 P5/P6.

---

## M1 — Scene graph + resource manager (2026-04-19)

### Added

- **`pixi.js` v8** — PixiJS v8 přidán jako production dependency do `apps/web` (WebGL/WebGPU renderer, hoistován přes pnpm workspace)
- **`vitest` + `jsdom`** — Test runner a browser environment pro unit testy renderer vrstvy
- **`apps/web/src/renderer/Canvas.tsx`** — React komponenta pro mount/unmount Pixi Application; StrictMode safe (ref guard), ResizeObserver, HiDPI (resolution=DPR, autoDensity=true), Pixi v8 API (`app.canvas`, `app.init()`)
- **`apps/web/src/renderer/SceneGraph.ts`** — Scene graph wrapper; ID-based diff reconciler (add/update/remove); žádné přímé Pixi mutace mimo renderer modulů
- **`apps/web/src/renderer/ResourceManager.ts`** — Centrální správce GPU zdrojů; ref counting pro textury; `acquireTexture` / `releaseTexture` / `destroyAll`
- **`apps/web/src/renderer/types.ts`** — `SlideObjectData` discriminated union; `RectangleObject`; `BaseSlideObject`; připraveno na rozšíření v M2
- **`apps/web/src/renderer/coords.ts`** — DPR-aware coordinate transforms; `worldToScreen` / `screenToWorld`; dokumentuje povinnou DPR compensation (Spike C nález)
- **`apps/web/src/renderer/objectRenderers/rectangleRenderer.ts`** — První object renderer; Pixi Graphics fill; pivot na středu objektu pro správnou rotaci
- **`apps/web/src/renderer/objectRenderers/index.ts`** — Renderer registry (Map<type, renderer>); připravena na rozšíření v M2
- **`apps/web/src/data/demoSlide.ts`** — Hardcoded demo data: dva obdélníky (modrý + červený, různá opacity a rotace)
- **`apps/web/src/renderer/ResourceManager.test.ts`** — 10 unit testů: ref counting, acquire/release, destroyAll, textureCount
- **`apps/web/src/renderer/SceneGraph.test.ts`** — 9 unit testů: ID diff add/update/remove, destroy, edge cases
- **`docs/adr/0002-renderer-architecture.md`** — ADR pro renderer architekturu (PixiJS v8, SceneGraph, ResourceManager, DPR transforms, StrictMode safety)

### Changed

- **`apps/web/src/components/EditorLayout.tsx`** — Canvas placeholder nahrazen `<Canvas slideData={demoSlide} />` — center pane nyní mountuje živý Pixi canvas
- **`apps/web/vite.config.ts`** — Přidán `build.target: 'esnext'` (top-level await pro Pixi v8 `app.init()`); přidána `test` sekce pro vitest s jsdom environment

### Technical decisions

- Vitest spouštěn přes `node ../../node_modules/vitest/vitest.mjs run` (Windows pnpm hoisting nenechá `.bin/vitest` fungovat bez full path)
- `rectangleRenderer` ukládá Graphics referenci přes Symbol property na Container — `any` cast s komentářem; vylepšeno v M2
- `objectRenderers/index.ts` registry Map používá `any` pro generické varianty ObjectRenderer — nutné pro heterogenní registry; vylepšeno v M2
- ResourceManager testován s Pixi Assets mock — testy nepotřebují GPU ani browser

---

## M0 — Foundation (2026-04-19)

### Added

- **Monorepo** — pnpm workspaces with `apps/web`, `apps/server`, and four `packages/*` shells (`shared`, `slide-model`, `animation`, `ui`)
- **`apps/web`** — React 18 + Vite 6 + TypeScript strict + Tailwind CSS v3; 3-pane editor layout shell (Slides sidebar, Canvas center, Inspector sidebar)
- **`apps/server`** — Fastify 5 + TypeScript ESM skeleton; `GET /health` endpoint with pino structured logging on port 3001
- **`tsconfig.base.json`** — Shared strict TypeScript config (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`)
- **`eslint.config.js`** — Flat ESLint 9 config with `@typescript-eslint/recommended`, `react-hooks/recommended` for web, `@typescript-eslint/no-explicit-any: error`
- **`.prettierrc`** — `singleQuote: true`, `semi: false`, `printWidth: 100`
- **`.github/workflows/ci.yml`** — CI pipeline: lint → typecheck → build → test on every push/PR to `main`; Node 22 + pnpm 10; dependency caching
- **`infra/docker-compose.yml`** — Postgres 16 Alpine with named volume, health check, `POSTGRES_PASSWORD` required from env
- **`.env.example`** — Env var template with comments for all current and future variables
- **Husky v9 + lint-staged** — Pre-commit hooks: ESLint + Prettier on staged `.ts`/`.tsx` files
- **`docs/adr/0001-monorepo-layout.md`** — ADR for monorepo structure, why pnpm workspaces (not Turborepo yet), why single `apps/server` app

### Technical decisions

- `shamefully-hoist=true` in `.npmrc` to resolve Windows pnpm symlink issues (documented in spike-A handoff)
- `concurrently` for parallel dev startup (`pnpm dev` starts both web and server)
- Server uses `--experimental-strip-types` for dev (no separate tsc compile step in dev mode); production build is separate
- No PixiJS in M0 — canvas placeholder only; PixiJS mounts in M1
