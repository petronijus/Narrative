# M10 Phase 1a — Authentik Infrastructure Handoff

**Date:** 2026-04-20
**Owner:** infra
**Status:** Complete — ready for phase 2 (server JWT middleware) and phase 3 (web OIDC client)

---

## What was done

Stood up Authentik as the self-hosted OIDC identity provider for Narrative. Phase 1a is infrastructure only — no JWT validation in the server yet, no login flow in the web app yet.

---

## Files changed

### Added

- `infra/authentik/blueprints/custom/narrative-oidc.yaml` — Authentik declarative blueprint (OIDC provider + application + group + policy)
- `infra/authentik/media/.gitkeep` — directory placeholder (runtime state gitignored)
- `infra/authentik/certs/.gitkeep` — directory placeholder (runtime state gitignored)
- `infra/scripts/verify-authentik.sh` — OIDC endpoint sanity check script

### Modified

- `infra/docker-compose.yml` — added `authentik-postgres`, `authentik-redis`, `authentik-server`, `authentik-worker` services + `authentik_pg_data`, `authentik_media`, `authentik_certs` volumes
- `infra/docker-compose.prod.yml` — prod overrides for Authentik (127.0.0.1 port binding, ZFS volume paths, `AUTHENTIK_DATA_PATH`)
- `infra/caddy/Caddyfile` — added `auth.{$DOMAIN}` virtual host proxying to `authentik-server:9000`
- `.env.example` — added all `AUTHENTIK_*` and `VITE_AUTHENTIK_*` vars
- `infra/.env.prod.example` — added all `AUTHENTIK_*` and `VITE_AUTHENTIK_*` vars with production URL patterns
- `.gitignore` — added `infra/authentik/media/*` and `infra/authentik/certs/*` with `.gitkeep` exceptions
- `README.md` — added `## Authentication (M10)` section with first-run setup, architecture, blueprint explanation, DNS requirements, phase 2 consumer expectations

---

## New services

| Service              | Image                                 | Purpose                                           |
| -------------------- | ------------------------------------- | ------------------------------------------------- |
| `authentik-postgres` | `postgres:16-alpine`                  | Authentik-private DB (separate from Narrative DB) |
| `authentik-redis`    | `redis:7-alpine`                      | Authentik session store + task queue              |
| `authentik-server`   | `ghcr.io/goauthentik/server:2024.8.3` | OIDC HTTP server, admin UI, blueprint runner      |
| `authentik-worker`   | `ghcr.io/goauthentik/server:2024.8.3` | Background jobs (email, events, outposts)         |

---

## New env vars

### Dev (`.env.example`)

```
AUTHENTIK_POSTGRES_PASSWORD      DB password for authentik-postgres
AUTHENTIK_SECRET_KEY             Django secret key — generate: openssl rand -hex 32
AUTHENTIK_BOOTSTRAP_EMAIL        Initial akadmin email
AUTHENTIK_BOOTSTRAP_PASSWORD     Initial akadmin password
AUTHENTIK_HTTP_PORT              Port Authentik listens on (default 9000)

AUTHENTIK_ISSUER                 OIDC issuer URL (used by server to validate tokens)
AUTHENTIK_JWKS_URL               JWKS endpoint (used by server to fetch signing keys)
AUTHENTIK_CLIENT_ID              OAuth client ID (narrative-web)

VITE_AUTHENTIK_ISSUER            Issuer URL for web OIDC client
VITE_AUTHENTIK_CLIENT_ID         Client ID for web OIDC client
VITE_AUTHENTIK_REDIRECT_URI      Post-login redirect URI
```

### Prod (`.env.prod.example`) — additional

```
AUTHENTIK_DATA_PATH   ZFS dataset path for Authentik volumes (postgres, media, certs)
```

---

## Blueprint behavior

`infra/authentik/blueprints/custom/narrative-oidc.yaml` runs on every Authentik server start. It is idempotent — safe to restart repeatedly.

Creates:

1. Group `narrative-users` — Narrative access is restricted to members
2. OIDC provider `Narrative OIDC Provider` — public client, PKCE, client ID `narrative-web`, access tokens 30 min, refresh 30 days
3. Application `Narrative` (slug `narrative`) linked to the provider
4. Expression policy enforcing group membership
5. Policy binding attaching the policy to the application

The blueprint pre-registers `http://localhost:5173/auth/callback` as redirect URI. Production URI (`https://narrative.example.com/auth/callback`) must be added via admin UI or by editing the blueprint before first run.

---

## Gotchas

1. **DNS for `auth.DOMAIN`**: production subdomain `auth.narrative.example.com` must resolve to the server. Caddy handles TLS, but DNS is manual. Wildcard A record (`*.narrative.example.com`) is the easiest approach.

2. **Bootstrap password**: if `AUTHENTIK_BOOTSTRAP_PASSWORD` is unset or empty, Authentik shows a first-run setup flow at `/if/flow/initial-setup/` instead of auto-creating akadmin. Set it in env for automated/CI runs.

3. **Blueprint `redirect_uris` contains a hardcoded domain** (`narrative.example.com`). This is illustrative — ops must update it for real production domains. The blueprint is applied idempotently so re-running after editing is safe.

4. **Internal JWKS URL in prod**: `AUTHENTIK_JWKS_URL` in `.env.prod.example` is set to `http://authentik-server:9000/...` (internal Docker network) rather than the public `https://auth.DOMAIN/...`. This avoids TLS round-trips inside the Docker network and works because both server and Authentik are on the same compose network. The public-facing issuer URL (`AUTHENTIK_ISSUER`) must still match what Authentik reports in its discovery document.

5. **Separate Postgres instance**: Authentik gets its own `authentik-postgres` service rather than reusing the Narrative `postgres` service. This makes Authentik independently restartable and avoids schema collisions.

6. **Media and certs volumes**: in dev these are named Docker volumes (`authentik_media`, `authentik_certs`). In prod the `docker-compose.prod.yml` overrides them to bind-mount paths under `AUTHENTIK_DATA_PATH`. The override syntax uses `${AUTHENTIK_DATA_PATH:-authentik_media}/media` — if `AUTHENTIK_DATA_PATH` is unset it falls back to the named volume. This is a minor inconsistency (volume name vs path prefix); ops should always set `AUTHENTIK_DATA_PATH` in prod.

---

## Phase 2 consumer expectations (server — `state-sync` / apps/server owner)

The server implementation should:

- Read `AUTHENTIK_JWKS_URL` to fetch Authentik's public signing keys (HTTP, internal network)
- Read `AUTHENTIK_ISSUER` to validate the `iss` claim in incoming JWTs
- Read `AUTHENTIK_CLIENT_ID` (`narrative-web`) to validate the `aud` claim
- Reject requests with missing, expired, or invalid tokens (401)
- Extract `sub` (stable user ID), `email`, and optionally `name` from token claims
- Wire the middleware before the `/decks` REST routes and Hocuspocus connection hook

## Phase 3 consumer expectations (web — editor-ui owner)

The web implementation should:

- Use `VITE_AUTHENTIK_ISSUER` + `VITE_AUTHENTIK_CLIENT_ID` for PKCE authorization code flow
- Redirect to `{issuer}../authorize` with `response_type=code`, `code_challenge_method=S256`
- After redirect back, exchange code at `{issuer}../token` (no client secret for public clients)
- Store access token (memory or `sessionStorage` — not `localStorage` per security best practice)
- Set `Authorization: Bearer {token}` on all API requests
- Handle 401 responses by triggering re-auth flow
- Use `VITE_AUTHENTIK_REDIRECT_URI` as the registered callback URL

---

## Restore drill checklist (next infra milestone)

When testing backup restore, include:

- [ ] `authentik_pg_data` volume or `AUTHENTIK_DATA_PATH/postgres` directory
- [ ] `authentik_media` / `AUTHENTIK_DATA_PATH/media` (uploaded avatars, etc.)
- [ ] Re-running blueprints after restore (automatic on server start)
- [ ] Verifying group membership is preserved (stored in Authentik DB)
