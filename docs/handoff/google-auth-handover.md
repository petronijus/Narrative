# Google OIDC end-to-end — pickup notes

> Branch: `chore/auth-google-cleanup` (1 commit ahead of `main`).
> Status as of 2026-05-11: code complete + deploy VM provisioned;
> blocked on user-provided Google OAuth client_id + Cloudflare Tunnel
> public-hostname mapping. Goal: `https://narrative.example.com` end-to-end
> with real Google login, allowlist `petr@example.com`.

## Deploy target — VM 103 `narrative` on Proxmox

- **SSH**: `ssh petr@192.0.2.147` (LAN, vlan20 SERVERS subnet)
- **From outside home LAN**: jump through pve →
  `ssh -J root@192.0.2.100 petr@192.0.2.147`
  (pve password in 1Password "proxmox"; petr's auth is ed25519 key)
- **OS**: Ubuntu 24.04.4 LTS Server, 4 vCPU, 4 GB RAM, 40 GB disk
- **Docker**: 29.4.3 + Compose v5.1.3, `petr` in `docker` group
- **Cloudflare Tunnel**: NOT running on this VM — existing tunnel on
  docker VM (105) at 192.0.2.101 handles all public hostnames.
  Public hostname mapping for `narrative.example.com` must be added in
  Cloudflare dashboard: service URL `http://192.0.2.147:80`.

## Architecture

```
narrative.example.com  →  Cloudflare edge (TLS termination)
                      →  cloudflared tunnel (already running on docker VM .101)
                      →  caddy:80 on narrative VM (.147)
                      →  internal Docker network: server, postgres, minio, etc.
```

Because the existing cloudflared elsewhere handles ingress, the prod
compose on this VM **does not** run its own cloudflared. The
`infra/docker-compose.prod.yml` template has cloudflared baked in — we
need to either disable it or use a slimmer override compose file.

## What's already in place (no work needed)

- **Server** — `apps/server/src/auth/jwt.ts` validates Google ID tokens
  via remote JWKS; accepts both `https://accounts.google.com` and
  `accounts.google.com` issuers; enforces `OIDC_ALLOWED_EMAILS`
  (exact) + `OIDC_ALLOWED_DOMAIN` (requires `email_verified=true` on
  the token to defeat unverified-email impersonation).
- **Server wiring** — `apps/server/src/index.ts:53-69` reads
  `BYPASS_AUTH`, `OIDC_ISSUER`, `OIDC_JWKS_URL`, `OIDC_CLIENT_ID`,
  `OIDC_ALLOWED_EMAILS`, `OIDC_ALLOWED_DOMAIN`. Hocuspocus uses the
  same verifier (`apps/server/src/hocuspocus/index.ts` `onAuthenticate`).
- **Web** — `apps/web/src/state/AuthContext.tsx` uses
  `oidc-client-ts` `UserManager`, browser PKCE (`response_type=code`),
  scope `openid profile email`, sends `id_token` (not access_token —
  Google access tokens are opaque) as `Authorization: Bearer`.
  `automaticSilentRenew=true` via the iframe `prompt=none` flow.
- **UI** — `apps/web/src/pages/AuthLogin.tsx`,
  `apps/web/src/pages/AuthCallback.tsx`, `apps/web/src/pages/AuthError.tsx`
  exist and are routed.
- **`.env.example`** — already on the new `OIDC_*` schema with
  comments explaining the Google Cloud Console setup steps.

## What's blocked

**Local `.env`** still contains the old `AUTHENTIK_*` variable names.
Server silently runs in `BYPASS_AUTH=true` because the new vars aren't
set. Local `.env` redacted snapshot:

```
AUTHENTIK_POSTGRES_PASSWORD=…    (still used by Postgres init? verify)
AUTHENTIK_SECRET_KEY=…           (drop — Authentik container removed)
AUTHENTIK_BOOTSTRAP_EMAIL=…      (drop)
AUTHENTIK_BOOTSTRAP_PASSWORD=…   (drop)
AUTHENTIK_HTTP_PORT=…            (drop)
AUTHENTIK_ISSUER=…               (rename → ignore; replaced by OIDC_ISSUER)
AUTHENTIK_JWKS_URL=…             (rename → ignore)
AUTHENTIK_CLIENT_ID=…            (rename → ignore)
BYPASS_AUTH=true                 (flip → false)
VITE_BYPASS_AUTH=true            (flip → false)
VITE_AUTHENTIK_ISSUER=…          (drop — replaced by VITE_OIDC_ISSUER)
VITE_AUTHENTIK_CLIENT_ID=…       (drop)
VITE_AUTHENTIK_REDIRECT_URI=…    (drop)
```

**Before migrating**, check if `infra/docker-compose.yml` still
references any `AUTHENTIK_POSTGRES_*` for a Postgres init env block —
if so, those keys may still be needed for the DB container even
though the auth provider is gone. The audit cleanup commit (92e004a)
touched the comment but may have left the env-var consumers.

## Next session — exact steps

### Pre-requisite from the user

User must provide a Google OAuth client_id. Walkthrough was already
delivered and lives in conversation context; summary:

1. console.cloud.google.com → APIs & Services → OAuth consent screen
   → User Type **Internal** (example.com Workspace) → fill app name +
   support email.
2. Credentials → Create Credentials → OAuth client ID → Web application.
3. Authorized JavaScript origins: `http://localhost:5173`
4. Authorized redirect URIs: `http://localhost:5173/auth/callback`
   (exact match — no trailing slash, http not https for localhost).
5. Copy the client_id ending in `.apps.googleusercontent.com`.

No client_secret needed (browser PKCE).

### Once user provides the client_id

1. **Migrate `.env`**:
   - Add:

     ```
     OIDC_ISSUER=https://accounts.google.com
     OIDC_JWKS_URL=https://www.googleapis.com/oauth2/v3/certs
     OIDC_CLIENT_ID=<paste-here>.apps.googleusercontent.com
     OIDC_ALLOWED_EMAILS=petr@example.com

     VITE_OIDC_ISSUER=https://accounts.google.com
     VITE_OIDC_CLIENT_ID=<paste-here>.apps.googleusercontent.com
     VITE_OIDC_REDIRECT_URI=http://localhost:5173/auth/callback
     ```

   - Flip `BYPASS_AUTH=false` and `VITE_BYPASS_AUTH=false`.
   - Decide what to do with the old `AUTHENTIK_*` lines (most can be
     deleted; verify Postgres container env first).

2. **Restart `pnpm dev`** — server should start WITHOUT the
   `BYPASS_AUTH=true` warning. Look for:
   - No `OIDC_ALLOWED_EMAILS and OIDC_ALLOWED_DOMAIN are both empty`
     warning (confirms allowlist is set).

3. **Manual test the happy path**:
   - Open `http://localhost:5173`.
   - Should redirect to `/auth/login?returnTo=/`.
   - Click "Sign in with Google" → Google's consent screen.
   - Sign in with `petr@example.com`.
   - Lands back at `/auth/callback` then redirects to `/`.
   - Network tab: every API call carries `Authorization: Bearer eyJ...`
     (the id_token JWT, not access_token).

4. **Test the unhappy paths**:
   - Sign in with a non-allowlisted Google account → server returns
     401 on the first authenticated request → web app should bounce
     back to `/auth/login`.
   - Manually delete sessionStorage `oidc.user:...` key → page reload
     should hit login redirect.

5. **e2e**: `pnpm --filter web test:e2e -g "destructive-flows"` —
   covers share-link IDOR + cascade-delete; doesn't directly test
   Google flow but verifies the auth pre-handler still gates routes.

### Hocuspocus considerations

The WebSocket is gated by the same JWT verifier
(`apps/server/src/hocuspocus/index.ts` `onAuthenticate`). The web client
passes the bearer token in the WS connection's `token` payload via
oidc-client-ts → Hocuspocus extension. Verify in DevTools:

- WS connect to `ws://localhost:3002` succeeds (1xx upgrade).
- Server logs `[hocuspocus] authenticate → doc=… user=<sub> role=…`.
- Edits sync between two browser tabs.

If the WS rejects, common cause is the iframe silent-renew flow
hasn't refreshed the token yet — manual `pnpm dev` reload is the
cheap workaround. ID tokens expire after 1 hour.

## Uncommitted state to be aware of

- **`apps/web/src/components/EditorLayout.tsx`** — modified in this
  session. Top toolbar now spans full width above the side panels
  (was previously squeezed between them). 14 insertions / 7 deletions.
  Changes:
  - Slides panel: `inset-y-0` → `bottom-0` + `top: topBarH`
  - Toolbar: removed `paddingLeft/Right` insets, bumped to `z-20`
  - Inspector: `inset-y-0` → `bottom-0` + `top: topBarH`

  Web typecheck passes; visually verified via Playwright
  (`/tmp/editor-topbar-after.png`). NOT committed — user did not say
  "push" / "commit" / "hotovo". Decide whether to fold this into the
  auth-cleanup branch or split into its own commit before continuing.

- **Pre-existing typecheck failure** unrelated to this session:
  `packages/slide-model/src/convergence.property.test.ts` cannot find
  `fast-check`. This was introduced by the audit Tier-A commit
  (`d026e68`) on `main` and was already broken when the branch was
  created. `pnpm add -D fast-check` in `packages/slide-model` fixes it
  but is out of scope for the auth task.

## References

- `apps/server/src/auth/jwt.ts` — verifier impl + allowlist
- `apps/server/src/auth/fastifyAuth.ts` — pre-handler + `requireDeckRole`
- `apps/web/src/state/AuthContext.tsx` — UserManager config + bypass
- `apps/web/src/pages/AuthLogin.tsx` — login button
- `.env.example` lines 41–80 — OIDC schema with inline docs
- CHANGELOG.md "Audit + test debt cleanup" — context for the audit commits
