# The Narrative MCP server

Narrative's agent surface (ADR 0010, ADR 0011, `docs/plans/agentic-layer.md` §4.4–4.5).
Claude Code and claude.ai drive Narrative through it; the model runs in the user's
own Claude client, so Narrative has no model, no API key and no bill.

Code: `apps/server/src/mcp/`. Endpoint: **`https://<domain>/api/mcp`** (dev:
`http://localhost:3001/mcp`) — Fastify registers `/mcp`; Caddy strips one `/api`.

## Connecting

### Claude Code (personal access token)

1. Narrative → account menu → **Access tokens** → create a token with the `mcp`
   scope (30, 90 or 365 days).
2. Register the server:

   ```bash
   claude mcp add --transport http --scope user narrative https://<domain>/api/mcp \
     --header "Authorization: Bearer <token>"
   ```

   (The Access tokens page shows this command with the right URL.) Use
   `--scope local` to register it for one project only.

   Without `--header`, Claude Code signs in with OAuth instead: it names its
   Client ID Metadata Document (`https://claude.ai/oauth/claude-code-client-metadata`)
   as its client, listens on a loopback port, and sends you to Narrative's
   consent page — the same flow as claude.ai below, with a warning that the
   approval returns to a program on your computer.

3. `claude mcp list` shows it connected. Optionally install the `narrative`
   skill, which teaches Claude Code the playbooks: it ships from this repo as
   the plugin `claude-plugin/narrative/` —
   `/plugin marketplace add petronijus/Narrative`, then
   `/plugin install narrative@narrative`. It is generated from the same files
   the server serves (see "Prompts" below) with
   `pnpm --filter @narrative/commands skill`, and a test fails when the
   committed copy is stale. Without it, the server's prompts and
   `narrative://playbooks/*` resources carry the same text.

### claude.ai (custom connector, OAuth)

Settings → Connectors → Add custom connector → URL `https://<domain>/api/mcp`. claude.ai
discovers Narrative's OAuth server and sends you to Narrative: sign in with Google
(the normal login), then approve the connection on the consent page, which names the
application, who publishes it, and — in a box of its own — the host the approval is
sent to (`claude.ai`). Disconnect it again under **Access tokens → Connected apps**
(API: `GET/DELETE /api/oauth/connections`).

**Discovery at the domain root.** OAuth clients look for the authorization-server
metadata outside `/api`: `https://<domain>/.well-known/oauth-authorization-server/api`
(RFC 8414 path insertion for the issuer `https://<domain>/api`). The Caddyfile routes
`/.well-known/oauth-authorization-server[/*]` and `/.well-known/oauth-protected-resource[/*]`
to the API without stripping the path (its "OAuth discovery" block; docs/deploy.md
has the post-deploy `curl` checks). The protected-resource metadata is also reachable
under `/api` — that is the URL the server sends in `WWW-Authenticate`.

## Configuration

| Env var                         | Default                                                                                             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PUBLIC_API_URL`                | dev `http://localhost:<API_PORT>`, prod `<SPA origin>/api` (compose passes `https://${DOMAIN}/api`) | Public base of the API. The MCP resource is `<base>/mcp` — exactly the URL users enter — and every OAuth token is bound to it (audience).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `MCP_OAUTH_REDIRECT_URIS`       | empty                                                                                               | Extra OAuth callbacks, comma-separated: https URLs (matched exactly) or http URLs on `localhost` / `127.0.0.1` (any port). The claude.ai and Claude Code callbacks are built in. Checked at start.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `CORS_ORIGIN`                   | `http://localhost:5173`                                                                             | Browser origins allowed to call `/mcp` (besides the API's and the SPA's own).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `CLIENT_IP_HEADER`              | unset (prod: `cf-connecting-ip`)                                                                    | Real client IP header, for the per-IP limits of the OAuth endpoints and of `/mcp` callers without a verified credential.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `MCP_OAUTH_CIMD_HOSTS`          | `claude.ai`                                                                                         | Hosts whose Client ID Metadata Documents are accepted, comma-separated (`host[:port]`). A metadata `client_id` on any other host is refused before anything is fetched. `none` accepts none (and stops advertising `client_id_metadata_document_supported`). Checked at start.                                                                                                                                                                                                                                                                                                                                                                               |
| `MCP_OAUTH_DCR_ENABLED`         | `false`                                                                                             | `true` turns on RFC 7591 dynamic client registration. Off, `registration_endpoint` is not advertised and `POST /oauth/register` answers 404. Claude Code and claude.ai use metadata documents, so DCR is only for other clients. Checked at start.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `AGENT_URL_FETCH_ALLOWED_HOSTS` | empty                                                                                               | Hostnames (exact, no port, comma-separated) an agent's `{ url }` file download may reach WITHOUT the user confirming the host. Empty = every URL download is confirmed. An allowlisted download may only be redirected to other allowlisted hosts. Checked at start.                                                                                                                                                                                                                                                                                                                                                                                         |
| `AGENT_PRINCIPAL_KEY_SECRET`    | dev default (prod: required, ≥ 32 chars)                                                            | HMAC key of the opaque "working for" key agent peers carry in awareness (see "Awareness privacy"). The server refuses to start in production without it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SERVER_TIMING_KEY`             | unset                                                                                               | A secret (≥ 16 characters) a request sends as `x-narrative-timing` to get its phases back (the perf probe `just perf-agent`, which sends it from `.env`); compared in constant time. Unset: outside production `x-narrative-timing: 1` does it, in production nothing does. `SERVER_TIMING=false` turns timing off anywhere. Phases go only to an authenticated caller whose call was authorised on its target, never on a 401, 403 or 429; the time before the route handler (rate limit, body, credential check) is one opaque `http.pre`. The command API answers them in `Server-Timing`, a tool call in the result's `_meta["narrative/serverTiming"]`. |

## Authentication

`/mcp` accepts only `Authorization: Bearer …`, never the session cookie:

- a **personal access token** with the `mcp` scope (`nrt_…`), or
- an **MCP OAuth access token** (`nmo_…`). These are audience-bound to the MCP
  resource and accepted on `/mcp` only — not on REST routes, tus or the WebSocket.

Both re-apply the sign-in allowlist (`isAllowedToSignIn`, auth/signInPolicy.ts) to
their user on every request — the same policy function for both. A missing or bad
credential gets `401` with
`WWW-Authenticate: Bearer realm="narrative", resource_metadata="<base>/.well-known/oauth-protected-resource/mcp", scope="mcp"`;
a PAT without `mcp` gets `403 insufficient_scope`. Requests with an `Origin` header
from anywhere but Narrative's own origins get `403` (DNS rebinding).

**Rate limits**: 240 requests/minute per token or OAuth grant on `/mcp`. Before any
credential lookup every request is counted in memory (http/rateLimit.ts,
http/bearerCache.ts). A request carrying a well-formed agent bearer (`nmo_…` OAuth access
token or `nrt_…` PAT) is counted against a bucket of its own token (SHA-256, 3000/minute),
not its IP: claude.ai calls from Anthropic's shared egress range (160.79.104.0/21), so a
per-IP budget would be shared by every claude.ai user. A bearer that failed verification
in the last minute is refused without a database lookup and counted against its IP again.
A bearer not seen in the last 10 minutes first counts against a per-IP limit of 300 new
bearers/minute, which bounds sprays of random tokens. Everything else is counted per
client IP (`CLIENT_IP_HEADER`).

**Revocation reaches open sessions**: disconnecting an app (or its client revoking its
token) closes that grant's MCP sessions at once; revoking one access token in the web app
closes that token's sessions; the in-process account kill switch
(`revokeAllSessionsForUser`, auth/agentCredentials.ts) revokes every PAT and OAuth grant
of the user, expires their not-yet-exchanged authorizations (an approved code can no
longer be exchanged) and closes their MCP sessions. The `revokeUserAccess` ops script runs
in its OWN process and cannot close sessions of the running server: they end at the next
sweep — every minute the server re-verifies each open session's credential (PAT or grant
still live) and its user's sign-in policy and closes the dead ones, SSE streams included —
or at once if you restart the server. The same sweep ends the sessions of a user removed
from the allowlist.

### The OAuth authorization server

Narrative itself is the authorization server (issuer = `PUBLIC_API_URL`), OAuth 2.1
with the MCP authorization spec (2025-11-25):

| Route (server path; public adds `/api`)           | What                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /.well-known/oauth-protected-resource[/*]`   | RFC 9728 metadata of `/mcp` (`resource` = the MCP URL, one authorization server)      |
| `GET /.well-known/oauth-authorization-server[/*]` | RFC 8414 metadata (built in memory: no database or network work)                      |
| `POST /oauth/register`                            | RFC 7591 dynamic client registration (JSON only; 404 unless `MCP_OAUTH_DCR_ENABLED`)  |
| `GET /oauth/authorize`                            | validates the request, stores it, redirects to the consent page                       |
| `GET /oauth/authorize/consent`                    | sign-in if needed, then the consent page (client name, callback host, scope)          |
| `POST /oauth/authorize/decision`                  | Allow / Deny                                                                          |
| `POST /oauth/token`                               | `authorization_code` (PKCE) and `refresh_token` (`application/x-www-form-urlencoded`) |
| `POST /oauth/revoke`                              | RFC 7009 revocation (revokes the whole grant)                                         |
| `GET`, `DELETE /oauth/connections[/:id]`          | the signed-in user's connections (session only)                                       |

Rules:

- **PKCE** `S256` only (`code_challenge_methods_supported: ["S256"]`).
- **Redirect URIs** (mcp/oauth/redirects.ts): exactly `https://claude.ai/api/mcp/auth_callback`
  (every hosted Claude app), Claude Code's loopback callbacks `http://localhost/callback`
  and `http://127.0.0.1/callback` on **any port** (RFC 8252), and `MCP_OAUTH_REDIRECT_URIS`.
  A client may only declare URIs on that list, and at `/authorize` the requested URI
  must match one it declared **and** the list (so a registration made under an older,
  wider list cannot use a callback the list no longer holds). No other host, path,
  scheme, `[::1]`, fragment or userinfo. When `/authorize` named `redirect_uri`, `/token`
  must repeat it exactly.
- **`resource`** must be the MCP URI.
- **Scopes**: `mcp` (required) and `offline_access` (listed in the metadata, so Claude
  requests it). A refresh token is issued only when `offline_access` was approved;
  without it the connection lasts one access token. The consent page says which.
  Registered scopes and grant types are enforced: `/authorize` grants only scopes the
  client registered (or its document declares), and drops `offline_access` unless the
  client's grant types include `refresh_token` (RFC 7591: no `grant_types` means
  `authorization_code` only). The grant types are snapshotted on the grant; a refresh by a
  client without `refresh_token` gets `unauthorized_client`.
- **Tokens**: access tokens live 1 hour, refresh tokens 30 days and rotate on every
  use; a reused authorization code revokes the grant. Each rotation records a
  fingerprint (SHA-256 of client IP and User-Agent). A replayed refresh token is logged as
  a security event (`event: "mcp_oauth_refresh_replay"`) and flags the connection (shown
  under Connected apps); inside 30 s from the same fingerprint (the client racing itself)
  the grant is kept, from another fingerprint or later it is revoked. **Every refresh failure is `invalid_grant`** —
  also a refresh by a registered client that no longer exists — so Claude starts a
  fresh sign-in instead of giving up. Only SHA-256 hashes of codes, tokens and client
  secrets are stored (migrations `0018_mcp_oauth`, `0021_mcp_oauth_cimd`).
- **Consent** is CSRF-safe: a per-render random token (hash stored with the request),
  the request is bound to the first user who opens it, the POST must come from
  Narrative's origin with that user's session, and the page cannot be framed. It
  names the application and who vouches for it (the host that publishes its metadata
  document; nobody, for a self-registered client), shows the redirect URI's host in a
  box of its own, warns when the approval returns to a program on this computer, and
  warns harder when **every** redirect URI the client declared is a loopback one. Every
  consent page says "Only approve if you just started connecting…" with the request
  time (UTC). `client_name` is sanitised like a peer label (`sanitizePeerLabel`).

### Client registration: metadata documents; DCR only when enabled

Narrative advertises `client_id_metadata_document_supported: true` and the `none`
token endpoint auth method — the two things Claude checks before it uses a **Client
ID Metadata Document** (CIMD, MCP spec 2025-11-25) instead of registering. Claude Code
does (`https://claude.ai/oauth/claude-code-client-metadata`).

- A `client_id` that is an https URL is resolved from its document at `/authorize`
  (mcp/oauth/clientMetadata.ts): canonical URL with a path, no query, fragment, dot
  segments or credentials; fetched through the SSRF guard (public addresses only,
  port 443, no redirects, 5 KiB, 5 s, `Accept: application/json`); the document's
  `client_id` must equal the URL, `client_name` is required, every `redirect_uris`
  entry must be on the allowlist, and the client must be public (`none`, no secret).
- Documents are cached in memory for their `Cache-Control` lifetime (`no-store` /
  `no-cache` not cached, `max-age` up to 24 h, 5 min without a header), failures for
  15 s, at most 500 documents; concurrent resolutions share one fetch.
- A metadata-document client is **never stored as a registered client**: the
  authorization and the grant keep its URL (`client_metadata_url`) and a display
  snapshot. The token and revocation endpoints do not fetch the document again — a
  public client is identified by its `client_id`, which must equal the one the code
  or grant was issued to.
- Documents are accepted only from hosts on `MCP_OAUTH_CIMD_HOSTS` (default
  `claude.ai`, which serves Claude Code's document); any other host gets an error page
  before anything is fetched.
- **Dynamic client registration** (RFC 7591) is **off by default**
  (`MCP_OAUTH_DCR_ENABLED`): with it off, `registration_endpoint` is not advertised, so
  Claude Code and claude.ai use their metadata documents. Turn it on only for clients
  without a document. Registrations made while it was on keep working. DCR clients
  (one per fresh connection) that have had no live grant and no use for 7 days are
  deleted hourly (and once a minute after start), with their revoked grants and tokens.
- **Retention**: authorizations decided or exchanged, and grants revoked, more than 30
  days ago are deleted hourly (metadata-document grants included).

## Sessions

Streamable HTTP with sessions: `initialize` (POST without `Mcp-Session-Id`) creates one
and binds it to **one user and one credential** (the PAT, or the OAuth grant, which
survives refresh). A later request with another user or credential gets `404 Session
not found` — the same answer as an unknown id, so clients re-initialize. POST carries
JSON-RPC (JSON or SSE answers), GET opens the server→client stream, DELETE ends the
session. Sessions end on DELETE, after 30 minutes without requests, when their OAuth
grant or their access token is revoked, when the user's access is revoked as a whole,
beyond 16 per user (least recently used first) and at shutdown; ending a session
closes its open runs. Sessions live in process memory — a restart
ends them and clients re-initialize.

The client's `clientInfo` (`name version`) from `initialize` is recorded on every run
the session opens (`agent_runs.client_name`).

## Tools

One tool per registry command, generated at start (`mcp/tools.ts`) — never
hand-written:

- **Name**: the command id with `.` → `_` (`object.path.setAnchors` →
  `object_path_setAnchors`); Claude only accepts `[a-zA-Z0-9_-]{1,64}`, and ids never
  contain `_`, so the mapping is reversible.
- **Input schema**: the command's zod input as JSON Schema, compacted
  (`mcp/schemaCompact.ts`: bounds that tell a model nothing dropped —
  `minLength: 1`, zod's safe-integer limits, storage caps of 64+ characters;
  discriminated unions such as `object_create`'s 11 object kinds collapsed into one
  object with a line saying which kind takes which property; `$defs` inlined where
  that is smaller; `additionalProperties: false` only at the root). The schema may be
  looser than the command; the server still validates every call against the real
  zod schema and names the offending field. Plus the transport arguments, bare
  (`{ "type": "string" }`): `deckId` for deck commands — and `componentId` to act on a
  component master instead, only on commands that accept one (`acceptsComponent` in
  the registry: document commands, document queries and the `agent_*` run tools; the
  host refuses a `componentId` for every other command with `no_target`), and
  `folderId` to act on a folder's own media, only on commands that accept a folder
  (`acceptsFolder`: `media_delete`, since 2026-10-03; such a command may need a
  different role per target, `roleOn`) —, `folderId` for folder commands, nothing
  for account commands, and an optional
  `runId`. What they mean is said once in the server `instructions`, not per tool.
  Union inputs (`object.update`) are flattened into one object and their forms named
  in the description. Identical alternatives of a union are said once
  (`schemaCompact.ts` pass 4, since 2026-09-28; mostly `object_create`, −267 bytes).
- **Shared fields** (`mcp/vocabulary.ts`, since 2026-09-28): 28 field descriptions that
  mean the same on every tool (27 until A2.9 added the animation step id, 2026-09-29) —
  the slide reference (on 45 tools as of 2026-09-28), object / table ids,
  table cells, text bodies and text targets, `fontFamily` / `fontWeight` / `bold` /
  `fontSize` / `color`, fill kinds, file inputs (`{ url }` | `{ base64 }`, the URL
  download policy, filename / MIME type hints), share role, `componentId`, `assetId`,
  animation step ids —
  are stripped from every tool schema where the description matches exactly, and
  said once at the end of the server `instructions` ("Fields that mean the same
  everywhere…"). Only the MCP projection drops them: the zod schemas, the capability
  manifest and the contract suite keep the full text. `mcp/vocabulary.test.ts` fails
  when an entry no longer matches any command (a reworded `.describe()` would
  silently put the sentence back on every tool) and when a description repeated on
  ≥ 3 tools, costing ≥ 100 bytes to repeat, is missing from the vocabulary.
- **Description**: the command's description with every command mention rewritten to
  its tool name, a line saying only THAT and HOW this client asks the user (only on
  tools that may need a confirmation: "Narrative asks the user in your client
  first." for form elicitation, "…opens a confirmation page and the call waits for
  the answer." for URL elicitation, "…the call returns confirmation_required with a
  link for the user." otherwise), and an example call `Example: {…}` — only when the
  input has several forms, a nested object or array, or more than two own properties
  (`needsExample` in `tools.ts`; 77 of 117 tools have one after A2.10 on 2026-09-29 —
  76 of 116 after A2.9, 55 of 94 on 2026-09-28; not recounted for the 121 tools
  after A2.11). What a declined or
  dismissed question means, and the retry with `confirmationId`, are said once in the
  `instructions`; the `confirmationId` argument is bare `{ "type": "string" }` like the
  other transport arguments. (Until 2026-09-28 every tool had an example with a title,
  `Example (<title>): {…}`, and each confirming tool repeated the whole procedure.)
- **Size**: the whole `tools/list` is loaded into the model's context when a client
  connects. Claude Code with its default tools defers MCP tools behind ToolSearch
  (names only, a schema loaded on demand), so there the size costs little; a client
  that loads the whole list (possibly claude.ai) pays all of it on every request. It
  was 234,633 bytes (form-eliciting clients) before the first compaction, ≈ 148 KB
  after it (2026-09-27), 128,349 (form) / 129,309 (url) / 129,213 bytes (link) after
  the second (2026-09-28, 94 tools), and grows with every A2 command: ≈ 175,569 (form) /
  176,529 (url) / 176,433 bytes (link) for 121 tools measured 2026-09-30 during A2.11,
  before the step's last example tweak (not re-measured after it) — A2.11 added
  ≈ 7.7 KB: `text_setBoxTypography` 2,638, `text_edit` 2,416, `text_style_apply`
  1,343, `text_replace` 1,334; 167,916 / 168,876 / 168,780 for 117 tools after A2.10
  on 2026-09-29 (166,020 / 166,980 / 166,884 for 116 tools after A2.9, same day), with
  the `instructions` at 4,030 bytes after A2.10 (of which 2,258 are the shared fields;
  was 3,945 / 2,173; not re-measured after A2.11, whose playbook edits may have moved
  it). `mcp/toolListBudget.test.ts` fails past 175,000 bytes since the post-A2 review
  (2026-09-30): the shapes that recur on many tools — the slide reference on 72, colours,
  the table cell, object id lists — are written compactly in each schema and explained
  once in the instructions (`mcp/sharedShapes.ts`, like `mcp/vocabulary.ts` for field
  descriptions), 188,697 → 173,650 bytes in url mode for 129 tools; descriptions and
  example calls unchanged, the full live eval 44/44 before and after (332 → 326 turns).
  Before that it failed past 189,000 bytes (since A2.12b, 2026-09-30:
  187,617 (form) / 188,697 (url) / 188,589 bytes (link) for 129 tools measured
  2026-09-30 after A2.13, whose `object_create` `id` field added ≈ 290 bytes
  (`object_create` 12,003 bytes); 188,407 in url mode after A2.12b; 187,000 after A2.12a with 186,157 for 128
  tools; 177,000 after A2.11, 169,000 after A2.10, 167,000 after A2.9; 16,000 for one
  tool),
  so it cannot grow unnoticed; the budget was 160,000 until 2026-09-28, then 132,000,
  and Petr's call for A2 is to raise it step by step (each raise is itemised in the
  test's comment) and review the sizes as a whole when A2 closes. A2 closed on
  2026-09-30 (A2.13), and that review is the next step before the MCP work. Headroom on
  2026-09-30 after A2.13 is 303 bytes in url mode (593 after A2.12b, 843 after A2.12a, ≈ 470 during A2.11, 124
  after A2.10, 20 after A2.9). Today the budget is 200,000 bytes and link mode is the
  largest: 199,999 after L3 (2026-10-20); F6 (2026-10-23) trimmed the descriptions
  instead of raising it — 189,572 (link) / 189,506 (url) / 188,582 bytes (form) for 146
  tools, 10,428 bytes (5.2 %) left — by taking out what a description repeated from its
  own field descriptions or the instructions, never guidance; the `instructions` grew
  4,931 → 5,026 bytes (the slide's size and axes, said once instead of on several
  tools). The test's comment itemises it.
- **Annotations** come from the registry's explicit metadata (`readOnly` / `idempotent` on each command; the registry refuses inconsistent combinations); a hint equal to the MCP default (`readOnlyHint` / `idempotentHint` false) is left out, `destructiveHint` and `openWorldHint` (default true) are always stated: `readOnlyHint` for commands that change nothing — document queries and server reads such as `deck_list`, `share_links_list`, `media_url`; `destructiveHint` for writes with `undo: 'irreversible'` (false on other writes); `idempotentHint` on read-only tools and on set-to-value writes marked `idempotent` (renames, `text_set`, `slide_setBackground`, `object_update`, … — the contract suite runs each of their examples twice), false on every other write; `openWorldHint` for commands that can fetch a URL (file inputs).
- **Paged lists**: `deck_list` (most recently changed first — content, title or folder) and `folder_list` (by name) return at most `limit` items (default 50, max 200) as lean records plus `nextCursor`; pass it back as `cursor` with the same filters for the next page. `query` filters by title or name (case-insensitive, literal), and `deck_list` also takes `folderId`. The web app's `GET /decks` and `GET /folders` are unchanged.
- **Results**: `structuredContent` = the command's output, plus the same as JSON text;
  writes add a line naming the run. Failures are `isError` results with the
  CommandError `code`, message and per-field issues. Internal failures carry only a
  reference id (the detail is in the server log).
- `ops_apply` batches document commands as one change; inside `ops`, `command` may be
  the id (`object.move`) or the tool name (`object_move`).

Every call runs through the ServerHost (`agent/serverHost.ts`) with the session's user,
`surface: 'mcp'` and the session's current run.

## Local files: upload sessions

MCP carries a file only as `{ url }` (a public address the server downloads) or
`{ base64 }` the model writes out itself — fine for an icon, hopeless for a photo. An
agent with a shell (Claude Code) measures the file (`wc -c < logo.png`) and calls
**`media_uploadSession`** with its name and size instead: it returns a one-time bearer
token (`nus_…`) and a ready `curl` line that sends the file in ONE
request to the tus upload the editor uses (`POST <PUBLIC_API_URL>/api/uploads`, tus
creation-with-upload; the answer is the asset JSON). The file gets the editor's checks
(media/finalizeUpload.ts). The curl line holds no shell expansion (Claude Code's
permission rules refuse `$(…)`), and it passes the token on stdin (`-H @-`), so the
token is not in the process list while the upload runs.

The token (media/uploadSessions.ts, table `upload_sessions`, migrations 0024–0025 and 0029):

- is stored only as its SHA-256; the raw value appears once, in the command result;
  the audit log keeps `nus_[redacted]` (agent/opRedaction.ts, also inside the curl line);
- authenticates tus requests only — it is not a personal access token, every other
  route ignores it;
- uploads media (image, video, font) into its own deck, as the user who asked, who must
  still be an editor there and still pass the sign-in policy — or, when the call targets
  a component master (`componentId`, since A2.12b, 2026-09-30, unreleased at the time),
  a picture or video into that component, whose folder the user must still own (no
  fonts; `upload_sessions_one_owner`: exactly one of `deck_id` / `component_id`);
- uploads exactly the file it was asked for: its declared size (`Upload-Length` must
  match, a deferred length is refused) and kind;
- must start its upload within 15 minutes, is bound to that upload (an atomic claim —
  a second upload with the token is refused) and may continue it for 2 hours more;
  only that upload's HEAD / PATCH work with it, never a GET;
- dies with the credential that asked for it (revoking the access token or MCP
  connection deletes its sessions) and with the account kill switch
  (`revokeUserAccess`); at most 10 unused ones per user.

Like every agent credential it is refused on the collaboration WebSocket
(hocuspocus/authenticate.ts), masked in Sentry, the audit log and the eval
recordings (auth/credentialPatterns.ts), and it only travels over https:
`PUBLIC_API_URL` must be https except on loopback, or the server does not start.

No confirmation, but the upload is the agent's to run on the user's machine (Claude
Code asks before running the curl line unless the user allowed it), and a file put into
a SHARED deck is readable by its collaborators — so deck content could try to talk an
agent into uploading something it should not (a key file as "an image"). Against that:
the command description tells the model to upload only files the user named themselves;
`filename` is a plain name, never a path; and an agent's upload must prove its type —
an image by its signature or readable dimensions, a video by its container signature,
a font by parsing (media/finalizeUpload.ts `strictContent`), so arbitrary bytes are
refused.

## Confirmation

Two kinds of call never run without the user:

- **Irreversible commands** (`confirm: 'always'`: sharing, invitations, deleting decks,
  folders, fonts, media or components, moving a deck).
- **URL downloads** (`confirmWhen`, registry metadata evaluated on the validated input):
  a `{ url }` file source (`media_upload`, `folder_fonts_upload`, `deck_importPptx`,
  `deck_insertFrom`) makes the server download from a host the model chose, and the URL
  itself can carry whatever the model read — an exfiltration channel. The user confirms
  the host. Inline `{ base64 }` needs nothing. Hosts on `AGENT_URL_FETCH_ALLOWED_HOSTS`
  are exempt; such a download may then only be redirected to other allowlisted hosts
  (net/fetchAudit.ts). The registry refuses a URL-taking command without `confirmWhen`.

What the user sees is built on the server from the exact call
(agent/confirmationSummary.ts), one fact per line: the action, the deck / folder title
looked up in the database, recipient and role, the collaborator, invite or link affected,
the download host. Ids are resolved only within the authorised target, so the summary
never reveals a stranger's email. The model's own words never reach the question.

How the MCP server asks (mcp/confirm.ts), in order:

1. **Form elicitation** (client declared `elicitation.form`, e.g. Claude Code):
   `elicitation/create` on the tool call's stream with a yes/no box. Only Accept with the
   box ticked runs it; Decline or an unticked box refuse and nothing runs.
2. **URL-mode elicitation** (client declared `elicitation.url`, MCP 2025-11-25): the
   client is sent Narrative's confirmation page; the tool call stays open until the user
   decides there, then `notifications/elicitation/complete` is sent and it runs.
3. **Out of band** (a client that can do neither, a form question that was dismissed —
   headless `claude -p` cancels every question — or one that failed): nothing runs; the
   call fails with `confirmation_required`, carrying the page URL
   (`<SPA>/confirm/<id>`) and a `confirmationId` in `structuredContent.error.confirmation`.
   The user opens the page in their signed-in browser and approves or declines. The model
   retries with the same arguments plus `confirmationId`.

There is **no model-settable flag** (the old `confirmed: true` argument is gone): a prompt
injection could set it. A pending confirmation (agent/confirmations.ts, process memory,
like MCP sessions) holds the exact call — MCP session, user, command, SHA-256 of the
canonical input, target — lives 5 minutes and is single use. The server host accepts a
`confirmationId` only if approved, unexpired, unused and bound to the same session, user,
command, input hash and target; a retry with other arguments or from another session is
refused. At most 10 undecided confirmations per user are kept (the oldest is dropped).
Because the binding includes the MCP session, the approval must be used by the session
that asked (a new `claude -p` run is a new session).

The confirmation page (`apps/web` `pages/ConfirmAgentAction.tsx`, lazy route
`/confirm/:id`) and its API (`GET /api/agent-confirmations/:id`,
`POST /api/agent-confirmations/:id/decision` with `{"decision":"approve"|"decline"}`,
routes/agentConfirmations.ts) accept only the browser session cookie — a PAT gets 403, an
MCP OAuth token is no identity there — only for the user the confirmation belongs to
(404 otherwise), and the decision only from Narrative's own origin with a JSON body
(CSRF). The page shows the "Only approve if you just asked the agent" warning and the
request time. Under BYPASS_AUTH (dev only) every cookie-less request is the dev-user.

The ServerHost enforces all of it for every transport: such a call runs only with a
confirmation that covers it — `elicitation` (the MCP question just accepted),
`out_of_band` (an approved id) or `explicit` (`POST /api/commands` takes
`"confirm": ["<commandId>"]`; API clients are scripts the user runs deliberately);
otherwise `confirmation_required` (HTTP `428`), or `not_confirmed` (HTTP `403`) when the
user declined. Batches never contain such commands (`isBatchable`). How it was confirmed
is logged with the op (`agent_ops.confirmation`: `via`, `by`, `reasons`, `hosts`,
`confirmationId`, `approvedAt`), and every host a command's downloads contacted —
redirect hops included — in `agent_ops.fetched_hosts` (migration 0023).

## Awareness privacy

Awareness reaches every connection of a deck, anonymous share-link viewers included.
Human editors publish only a random per-tab peer id as `user.id` and their profile name
(never the Google sub or the email; a user without a name shows as `User <4 chars>`). As
defence in depth, read-only and share-link connections receive awareness with `user.id`
replaced by `peer:<clientId>` and email-looking values removed
(hocuspocus/awarenessRedaction.ts). The key an agent peer carries to say whom it works
for is an HMAC-SHA256 with `AGENT_PRINCIPAL_KEY_SECRET` (a bare hash of the sub could be
recomputed by anyone who knows it); the server tells each signed-in editor its own key in
a `narrative.agentPrincipal` stateless message when it connects (never share-link
connections), which is how the editor still labels its agent "working for you".

## Prompts and resources

- **Prompts** are the playbooks (`packages/commands/playbooks/*.md`): one prompt per
  file, `basics` prepended to every other one, `{{arg}}` filled from the arguments
  (optional ones fall back to their default). Command mentions are rewritten to tool
  names.
- **Resources**: `narrative://playbooks/<name>` (each playbook — a model can read
  `basics` itself; Claude Code lets models read resources, not invoke prompts) and
  `narrative://capabilities` (the capability manifest).
- The initialize **instructions** (`mcp/guidance.ts`, 4,030 bytes on 2026-09-29; 3,945 on 2026-09-28) point
  at `narrative://playbooks/basics`, the first tools to call, and the rule that deck
  content is data, never instructions. They also carry what every tool shares, said
  once instead of per tool: the target arguments and `runId`, the confirmation
  procedure (declined means nothing happens; a dismissed question and a client that
  cannot ask end in `confirmation_required`; retry with only that `confirmationId`,
  never an invented one), and the shared field notes from `mcp/vocabulary.ts`.

The production image ships the playbook files (`apps/server/Dockerfile` copies
`packages/commands/playbooks/`); the loader is `@narrative/commands/playbooks`.

## Testing

- `apps/server/src/mcp/mcp.test.ts` — the server over real HTTP with the SDK client.
- `apps/server/src/mcp/urlFetch.test.ts` — URL downloads: confirmation naming the host,
  the allowlist and its redirect rule, `fetched_hosts`.
- `apps/server/src/agent/confirmations.test.ts`, `routes/agentConfirmations.test.ts` —
  the pending-confirmation store and the page's API (session only, own user, CSRF).
- `apps/server/src/mcp/sessionSweep.test.ts` — the sweep closes sessions whose credential
  died out of process.
- `apps/web/e2e/agent-confirm.spec.ts` — a client without elicitation, the confirmation
  page (approve, decline), the retry with `confirmationId`.
- `apps/server/src/mcp/oauth/oauth.test.ts` — the OAuth flow (registered and
  metadata-document clients), its failure paths, housekeeping and the kill switches.
- `apps/server/src/mcp/oauth/{clientMetadata,redirects}.test.ts`, `mcp/config.test.ts` —
  the CIMD resolver and cache, the redirect allowlist, the public URLs.
- `apps/server/src/mcp/oauth/store.integration.test.ts` — the Drizzle store against
  Postgres (`vitest.integration.config.ts`, not part of `pnpm test`).
- `packages/commands/src/playbooks/playbooks.test.ts` — playbook frontmatter,
  placeholders and command mentions.
- `apps/server/src/mcp/toolListBudget.test.ts` — `tools/list` ≤ 175,000 bytes in every
  confirmation mode (since the post-A2 review, 2026-09-30: 173,650 in url mode for 129
  tools; 189,000 before, with 188,697 measured after A2.13, 188,407 after A2.12b;
  187,000 after A2.12a, 177,000 after A2.11, 169,000 after A2.10, 132,000 on
  2026-09-28, raised per A2 step since; 160,000 before), ≤ 16,000 per tool, `$ref`s
  self-contained. Measured 2026-09-30 during A2.11, before its last example tweak:
  ≈ 175,569 (form), 176,529 (url), 176,433 bytes (link) for 121 tools; the four new
  text tools as above. Measured 2026-09-29 after A2.10: 167,916
  (form), 168,876 (url), 168,780 bytes (link) for 117 tools; the 15 table tools
  together are 29,181 bytes (`table_style_table` 4,279, the new `table_setSize`
  1,079), `object_fill_gradient` 2,872, `object_create` 11,727, `object_path_create`
  4,146, and the six `animation_*` tools 11,087. (After A2.9, same day: 166,020 /
  166,980 / 166,884 for 116 tools; the 14 table tools 27,896, `object_create` 11,731,
  `object_path_create` 4,148, `animation_*` 11,095 — `animation_update` 3,161,
  `animation_add` 3,131, `animation_retime` 1,788, `animation_retarget` 1,277.) (2026-09-28: 128,349 /
  129,309 / 129,213 for 94 tools, table tools 27,884; 2026-09-27: 148,207 / 150,975 /
  151,119, 31,397 and 13,251.)
- `apps/server/src/mcp/vocabulary.test.ts` — every shared field still matches some
  command's description, every description repeated on ≥ 3 tools at ≥ 100 bytes saved
  is in the vocabulary, the instructions carry every note, and no tool in any
  confirmation mode carries a shared description.
- `pnpm agent:eval` — real headless Claude Code against `pnpm dev`, 39 graded scenarios
  on 2026-09-30 after A2.11 (36 after A2.10, 34 after A2.9; 14 at A1: 14/14 on
  2026-09-27, and on 2026-09-28 with ToolSearch on and the compacted list; the
  39-scenario suite has not been run in full); 33 of them replay without a model in
  `packages/commands/src/agentEvalReplay.test.ts`. See `tests/agent-eval/README.md`.
- End to end with the real CLI against `pnpm dev` (BYPASS_AUTH off or on):
  create a PAT, `claude mcp add --transport http narrative-local http://localhost:3001/mcp
--header "Authorization: Bearer <token>" --scope local`, then
  `claude -p "…" --allowedTools "mcp__narrative-local__*"`.
