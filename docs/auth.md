# Authentication and access

Who can sign in to Narrative, how a browser stays signed in, and how agents
and scripts authenticate. Sharing (deck and folder roles, links, invites) is
in [ADR 0013](./adr/0013-folder-sharing-roles.md); the MCP side in
[`mcp.md`](./mcp.md).

## Sign-in: Google OIDC, run by the server

Identity is **Google OIDC directly** — no self-hosted identity provider.
Since 0.6.0 the server runs the whole OAuth exchange
([ADR 0005](./adr/0005-server-side-session-cookies.md)); the browser never
sees a Google token and holds only an opaque, HttpOnly session cookie.

```
Browser → GET /auth/start?returnTo=…        (server: PKCE state, 302 to Google)
        → accounts.google.com               (the user signs in)
        → GET /auth/callback?code=…         (server: code → id_token, verified
                                              against Google's JWKS, sign-in policy)
        ← Set-Cookie: narrative_session=…   (a row in `sessions`, keyed by the
                                              cookie's SHA-256; sliding 30-day expiry)
        → every API request and the Hocuspocus WebSocket carry the cookie
```

- `GET /auth/me` resolves the cookie to `{ sub, email, name }` (or `401`);
  `POST /auth/logout` revokes the row and clears the cookie.
- In production the routes sit under `/api` (Caddy strips the prefix), so the
  Google redirect URI is `https://<domain>/api/auth/callback`.

## Who may sign in

Google authenticates anyone with a Google account, so the server decides who
gets in (`apps/server/src/auth/signInPolicy.ts`). An account is admitted when

1. the **env allowlist** admits it — `OIDC_ALLOWED_EMAILS` (exact,
   comma-separated) and/or `OIDC_ALLOWED_DOMAIN` (a workspace domain, verified
   email only); **or**
2. the **database** admits it, for a verified email only: an open invite to
   a deck or folder, or a role on a deck or folder _somebody else_ created.

Set at least one allowlist variable in production — the server warns loudly
at boot when both are empty. Adding and revoking people on production:
[`deploy.md` → Adding a new allowed user](./deploy.md#adding-a-new-allowed-user)
and [Revoking a user](./deploy.md#revoking-a-user-kill-switch).

## Setting up the Google OAuth client

1. <https://console.cloud.google.com> → APIs & Services → Credentials →
   **Create OAuth 2.0 Client ID** → Web application.
2. Authorized redirect URIs:
   - `http://localhost:3001/auth/callback` (dev)
   - `https://YOUR_DOMAIN/api/auth/callback` (prod)
3. Copy the client id and secret into `OIDC_CLIENT_ID` and
   `OIDC_CLIENT_SECRET` (`.env` / `infra/.env.prod`; the secret stays
   server-side).
4. Set the allowlist, and `SESSION_COOKIE_SECRET` (`openssl rand -hex 32`,
   signs the short-lived OAuth state cookie; required in production).

`OIDC_REDIRECT_URI` overrides the callback the server sends to Google;
`SPA_ORIGIN` is where it sends the browser afterwards. Both have working
defaults in dev and prod (`.env.example`).

## Dev: `BYPASS_AUTH`

With `BYPASS_AUTH=true` and `VITE_BYPASS_AUTH=true` the server synthesises a
`dev-user` for every request and the editor skips `/auth/me` — the normal dev
setup, no Google client needed ([SETUP.md](../SETUP.md) §8 for the real flow).
Both must have the same value, or the editor logs
`Hocuspocus: authentication token required`. Never set it in production; when
it is on, keep the dev ports bound to `127.0.0.1`.

## Agents and scripts

- **Personal access tokens** (account menu → Access tokens) carry scopes:
  `mcp` for the MCP server, `api` for the command API
  (`POST /api/commands`). A token stops working the moment its owner no
  longer passes the sign-in policy above.
- **OAuth for MCP clients** (claude.ai connectors, Claude Code without a
  token): Narrative is its own authorization server, with a consent page and
  a Connected apps list under Access tokens — [`mcp.md`](./mcp.md).
- Irreversible agent actions are approved by a signed-in person on the
  confirmation page (`/confirm/<id>`), which accepts only the browser session,
  never a token.

## Ingress (production)

Public traffic arrives through a **Cloudflare Tunnel**, not a port forward:
Cloudflare terminates TLS at the edge and an outbound-only `cloudflared`
reaches Caddy on plain HTTP. One-time setup:

1. <https://one.dash.cloudflare.com> → Networks → Tunnels → Create a tunnel.
2. Name it (e.g. `narrative`) and put its install token into
   `CLOUDFLARE_TUNNEL_TOKEN` in `infra/.env.prod`.
3. In the tunnel's **Public Hostname** tab add a route: your subdomain and
   zone → service `http://caddy:80`.

Cloudflare creates the DNS records; the VM needs only outbound 443. The live
setup uses a shared tunnel on another VM (`USE_SHARED_TUNNEL=1`) —
[`deploy.md` → Production topology](./deploy.md#production-topology).
