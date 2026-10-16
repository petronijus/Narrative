# A1 — MCP server, server host and agent identity — handoff (2026-09-27)

**Status:** committed (`4acf6c1`, plugin `083312a`, on top of A0 `c4f8a5f`)
and released together with A0 as **v0.10.0** (CHANGELOG "0.10.0 — Agents
over MCP"). Verified on the Linux desktop on 2026-09-27 before the release —
see "Desktop verification" under Findings. The deploy itself is recorded in
`docs/deploy.md` and the release commit.

Plan: [`docs/plans/agentic-layer.md`](../plans/agentic-layer.md) §10, row
**A1 Server host, identity, MCP**. Decisions:
[ADR 0010](../adr/0010-command-layer-is-the-only-writer.md),
[ADR 0011](../adr/0011-agent-execution-over-mcp.md) (amended in A1:
decisions 7–8, the WebSocket, token-lifetime, audit-log and OAuth
consequences). Reference: [`docs/mcp.md`](../mcp.md). Previous handoff:
[`A0-agentic-foundations.md`](./A0-agentic-foundations.md).

After A1, Claude Code (personal access token or OAuth) and claude.ai (custom
connector, OAuth) can drive Narrative through `/api/mcp` with every command
the registry has. The editor itself still writes through slide-model
directly — that is A2.

## Before you release this — read first

1. **`AGENT_PRINCIPAL_KEY_SECRET` is required in production** and missing
   from the prod env today. Compose will not even parse
   `docker-compose.prod.yml` without it
   (`required variable AGENT_PRINCIPAL_KEY_SECRET is missing a value`,
   reproduced 2026-09-27), so **`build-push.sh` fails first**, on the build
   machine. Add it to `env.prod.sops`, decrypt, `scp` to the VM.
2. **`CLOUDFLARED_TRUSTED_PROXIES` must be set to the real cloudflared host
   address.** The shared-tunnel overlay defaults to `192.0.2.101/32`, a
   documentation-range placeholder (every `192.0.2.x` in this repo is one;
   the narrative VM's real LAN address is in `private/release.env`). Left at the
   default, Caddy overwrites `CF-Connecting-IP` on every tunnelled request
   and all visitors share one rate-limit bucket and one WebSocket
   failed-auth throttle. Found by the docs sweep; not verified on the VM.
3. Migrations `0016`–`0023` run in `deploy.sh`; the Caddyfile changed.

Full checklist: [`docs/deploy.md`](../deploy.md) "Releasing the agentic
layer (A1) — one-time steps".

## What was completed

### Identity and access (`apps/server/src/auth/`, `routes/accessTokens.ts`)

- **Personal access tokens** (`auth/personalAccessTokens.ts`): `nrt_` + 43
  base64url characters; only the SHA-256 and a display prefix are stored;
  scopes `mcp` / `api`; expiry 30, 90 or 365 days (no "never" — migration
  `0020` capped older rows); at most 20 active per user
  (`MAX_ACTIVE_PATS_PER_USER`). Accepted by `authPreHandler`, tus (media
  only) and `/mcp`; **refused on the Hocuspocus WebSocket**.
- **Tied to the sign-in policy** (`auth/signInPolicy.ts`): every
  verification re-applies `OIDC_ALLOWED_EMAILS` / `OIDC_ALLOWED_DOMAIN` to
  the token's owner (`users.email_verified`, migration `0020`).
- **Kill switch** (`auth/agentCredentials.ts`): `revokeAllSessionsForUser`
  revokes sessions, PATs and every MCP OAuth grant, expires pending
  authorisations and closes the user's MCP sessions; the ops script
  `scripts/revokeUserAccess.ts` (`pnpm --filter @narrative/server
db:revoke-user <email|sub> [--dry-run]`, in the image as
  `revokeUserAccess.js`) does the same out of process and exits `2` if the
  user could still sign in.
- **Web**: Access tokens page (`/settings/access-tokens`, account menu)
  with **Connected apps**; the confirmation page `/confirm/:id`.

### The server host (`apps/server/src/agent/`)

- `serverHost.ts`: authorises the target **before** opening any document
  (the direct connection skips `onAuthenticate`), runs each command or
  batch in **one** `doc.transact(fn, agentOrigin(runId))`, enforces
  confirmation, attributes to a run, logs the op.
- Runs (`services/runs.ts`, `runStore.ts`; `agent_runs` / `agent_ops`,
  migrations `0016`, `0017`, `0019`, `0023`): opened implicitly on a
  session's first write to a target or with `agent.startRun`, closed after
  10 minutes idle. **Per-run revert** via a `Y.UndoManager` per run
  tracking only its origin, component masters included; only while the
  document is loaded. Ops stored **redacted** (`opRedaction.ts`); runs and
  ops deleted **90 days** after last activity (`runtime.ts`).
- **Presence** (`presence.ts`): an MCP run is the peer "Claude (MCP)"; an
  API run is "<name>'s agent (<client>)". Whom it works for is an HMAC key
  (`AGENT_PRINCIPAL_KEY_SECRET`) the server sends each signed-in editor in a
  `narrative.agentPrincipal` stateless message.
- **Editor commands**: `editor.context` (the caller's `activeSlideId` and
  selection from awareness, only from client ids bound to the caller's own
  connections), `editor.show` (stateless message: jump + highlight),
  `editor.present.link` (`/deck/:id/present?slide=N`).
- **Agent activity popover** in the editor and the component master editor.
- `POST /api/commands` (`routes/agent.ts`): one command or a batch, `api`
  scope or the browser session, same-origin check, explicit `confirm` list.

### Server-backed commands and shared services

- **44 server-only commands** (94 in total): agent (3), component (5), deck
  (11 — incl. `deck.importPptx`, `deck.insertFrom`, `deck.exportPptx`,
  `deck.moveToFolder`, `deck.activeEditors`), editor (3), folder (7), media
  (5), share (9), `token.usages`. Their logic lives in
  `apps/server/src/services/`, called by both the REST route and the
  command (one implementation, two callers); the command side is typed by
  `packages/commands/src/services/` and tested against fakes.
- **URL downloads** (`services/binarySource.ts`, `net/ssrfGuard.ts`,
  `net/fetchAudit.ts`): public addresses only, redirects re-checked, caps
  below browser uploads (.pptx / video 200 MB + 120 s, image 25 MB, fonts
  8–10 MB), streamed to a temp file, at most two per user
  (`downloadSlots.ts`). Every contacted host is logged (`fetched_hosts`).
- **Token rebinding** (`services/tokenRebind.ts`): a deck moved to another
  folder (and slides inserted from another folder) keeps its look — token
  references rebound by name, else literalised / detached.
- **Live-document PPTX export** (`pptx/exportDeck.ts`): exports the live
  document, embeds only the deck's own media and its folder's fonts, hands
  back a presigned URL; exports swept after a day.
- **Deck → deck insert** (`services/deckInsert.ts`).
- Paged `deck.list` / `folder.list` (`listPaging.ts`, cursor, max 200).

### The MCP server (`apps/server/src/mcp/`)

- Streamable HTTP with sessions at `/mcp` (public `/api/mcp`), one user and
  one credential per session, 30-minute idle timeout, ≤ 16 per user, swept
  every minute against revocation.
- **Tools generated from the registry** (`tools.ts`): name = id with `.` →
  `_`; schemas compacted (`schemaCompact.ts`); annotations from explicit
  `readOnly` / `idempotent` metadata; descriptions rewritten to tool names,
  one example each; confirmation wording per client capability. Budget test:
  `toolListBudget.test.ts` (160,000 bytes). (Follow-up 2026-09-28, not in
  v0.10.0: examples only where the input needs one, shared field
  descriptions said once in the instructions, budget 132,000 — see Known
  TODO.)
- **Confirmation** (`confirm.ts`, `agent/confirmations.ts`,
  `agent/confirmationSummary.ts`): form elicitation → URL-mode elicitation →
  out-of-band page with a server-issued `confirmationId` (5 minutes, single
  use, bound to session, user, command, input hash, target). URL downloads
  are confirmed naming the host unless on `AGENT_URL_FETCH_ALLOWED_HOSTS`.
- **Prompts and resources** from the playbooks (`guidance.ts`):
  `basics`, `edit`, `find-replace`, `restyle-lite`, `shorten`, `translate`;
  `narrative://playbooks/<name>`, `narrative://capabilities`; initialize
  `instructions`.
- **OAuth 2.1 authorization server** (`mcp/oauth/`, migrations `0018`,
  `0021`, `0022`): issuer `PUBLIC_API_URL`; Client ID Metadata Documents by
  default (hosts `MCP_OAUTH_CIMD_HOSTS`, default `claude.ai`; fetched
  through the SSRF guard; never stored); DCR only with
  `MCP_OAUTH_DCR_ENABLED`; PKCE S256; `resource`-bound tokens (`nmo_`
  access 1 h, `nmr_` refresh 30 days, rotating, replay detection with a
  fingerprint and a flag); redirect allowlist = the claude.ai callback +
  Claude Code's loopback on any port (+ `MCP_OAUTH_REDIRECT_URIS`);
  CSRF-safe consent bound to one user. Discovery at the host root through a
  new Caddy route.

### Security hardening (two review passes, 2026-09-27)

From code comments and the ADR; the review reports themselves were not
handed to the docs sweep:

- tokens refused on the WebSocket; PAT expiry cap and sign-in-policy tie
  (H3); tus accepts a token for media only, never a .pptx (M2); storage-key
  extensions sanitised (M5); PPTX export scoped to the deck's own assets
  (M6); awareness client ids bound to their connection (M9); SSRF guard
  rejects IPv4 embedded in IPv6 (L1); API runs keyed per browser session,
  not per user (L3); same-origin check on cookie-authenticated command
  routes (L6); Sentry scrubbing of auth headers, `nrt_` and session cookies
  (L7);
- **awareness privacy**: editors publish a random per-tab id and their
  display name, never the Google sub or email; read-only and share-link
  connections get `user.id` replaced and email-looking values removed; the
  principal key is an HMAC, not a bare hash;
- the model-settable `confirmed: true` flag removed in favour of the
  out-of-band confirmation; URL-fetch confirmation + `fetched_hosts`;
- OAuth hardening (`0022`): registered scopes and grant types enforced,
  `redirect_uri` repeat check, replay fingerprinting;
- rate limits (`http/rateLimit.ts`, `http/bearerCache.ts`): per session or
  token, per IP for the anonymous; agent bearers pre-limited **per token
  hash** so claude.ai users behind Anthropic's shared egress
  (`160.79.104.0/21`) do not share a budget; failed bearers cached 60 s;
- **CF-Connecting-IP trust rule in Caddy**: the header is overwritten
  unless the peer is `CLOUDFLARED_TRUSTED_PROXIES`.

### Pre-existing bug fixed: Hocuspocus auth context

Live WebSocket connections often had **no `userId` or role**. Hocuspocus
2.15 replaces `hookPayload.context` with a merged copy after each hook, and
in production `onConnect` could finish while `onAuthenticate` was still
awaiting the database, so writes made only to `data.context` were lost. This
affected production before A1: session revocation did not close sockets
(CONN-1), active-editor bubbles could miss people. Fixed in
`hocuspocus/authenticate.ts` (the context is also the hook's return value);
regression test `hocuspocus/authenticate.context.test.ts` over a real
WebSocket with a slow database.

### Agent eval suite (`tests/agent-eval/`, `pnpm agent:eval`)

14 scenarios through headless Claude Code, isolated from the developer's
setup, graded deterministically from the document. Latest full run
(`results/2026-09-27T12-12-39-753Z.json`, Claude Code 2.1.283, model opus,
tree `c4f8a5f+dirty`): **14/14 pass, 80 turns, 65 tool calls, 194 s,
2.07 USD** list-price equivalent (the earlier full run at 10:38 UTC: 14/14,
2.13 USD). 11 scenarios have recordings and replay free in
`packages/commands/src/agentEvalReplay.test.ts`.

### The `narrative` Claude Code skill

`packages/commands/scripts/skill.ts` generates it from the playbooks
(`pnpm --filter @narrative/commands skill`). **It lives in this repo**, as
the Claude Code plugin `claude-plugin/narrative/` with a root
`.claude-plugin/marketplace.json` (install:
`/plugin marketplace add petronijus/Narrative`), and
`packages/commands/scripts/skill.test.ts` fails when it is stale. (Was: it
had been generated into the Wingtip an internal plugin repo repo. Petr, 2026-09-27:
nothing about Narrative belongs there — the unpushed commit was removed and
the skill moved here.)

### Registry and guard numbers (end of A1)

94 commands (50 browser + server, 44 server-only); `knownMissing.ts` 39 (A2
32, A3 5, A4 2), `FINISHED_PHASES = ['A0', 'A1']`; allowlist 18; route guard
69 routes (figure from the plan; the guard does not print it). New registry
rules: `acceptsComponent` / `commandTargetProblems`, `undoneBy`,
`confirmWhen`, explicit `readOnly` / `idempotent`. Manifest current
(`capabilities --check` exit 0).

## Key decisions

Petr's (plan §12, 2026-09-26), which A1 implements:

- **MCP only.** MCP is the only agent surface; no in-app agent, no
  Anthropic dependency, no model cost for Narrative (§12.3, 12.5, 12.7).
- **Direct apply.** Agent writes apply live and are revertible per run;
  only irreversible commands (and, since the review, URL downloads) ask
  (§12.2). Propose mode is not built.
- **Locks are editor-only.** Commands and agents ignore `locked` (§12.9,
  decided in A0).
- **Tokens + a few components; layouts stay data.** Style packs (A4) compile
  to folder tokens, fonts and only the recurring components; A1's component
  commands (`list`, `get`, `stamp` with slot content, master editing) are the
  groundwork (§12.10).

Made during A1:

- **Tokens never open a WebSocket.** Agents write only through the server
  host (validation, confirmation, attribution, audit); a raw Yjs socket
  would bypass all four (ADR 0011).
- **No model-settable confirmation.** Out-of-band confirmation bound to the
  exact call replaced `confirmed: true` (ADR 0011 decision 7).
- **Narrative is its own OAuth AS; CIMD by default, DCR opt-in** (ADR 0011
  consequences; `docs/mcp.md`).
- **The browser no longer computes the principal key** — the server sends
  it; a bare hash of the sub could be recomputed by anyone who knows it.
- **Routes and commands share one service implementation**, so the web app
  and agents cannot drift (`apps/server/src/services/`).
- **Tool schemas are compacted, not trimmed of meaning**: the server still
  validates against the real zod schema and names the offending field.

## How to verify

```bash
pnpm install                                        # A1 adds @modelcontextprotocol/sdk, @fastify/rate-limit, yaml, …
pnpm typecheck && pnpm lint                         # exit 0 (lint: 0 errors, 218 warnings in apps/web)
pnpm -r test                                        # 3,192 passed, 32 skipped, 223 files (2026-09-27)
pnpm --filter @narrative/commands capabilities --check   # exit 0
pnpm --filter @narrative/server test:integration    # 3 files vs the local Postgres — NOT run by the docs sweep
pnpm agent:eval                                     # needs `pnpm dev` (BYPASS_AUTH); 14/14 on 2026-09-27
PLAYWRIGHT_USE_SYSTEM_CHROME=1 PLAYWRIGHT_NO_VIDEO=1 pnpm --filter web test:e2e \
  -g "access-tokens|agent-activity|agent-confirm"    # new specs — NOT run by the docs sweep
```

Measured by the docs sweep on 2026-09-27 (`pnpm -r test`):

| Package                | Files   | Passed    | Skipped |
| ---------------------- | ------- | --------- | ------- |
| `apps/server`          | 79      | 1,126     | 1       |
| `apps/web`             | 75      | 686       | 30      |
| `packages/commands`    | 20      | 639       | 0       |
| `packages/slide-model` | 27      | 392       | 0       |
| `packages/shared`      | 8       | 193       | 0       |
| `packages/animation`   | 13      | 144       | 0       |
| `apps/video-worker`    | 1       | 12        | 1       |
| **Total**              | **223** | **3,192** | **32**  |

(A0 close: 167 files, 2,188 passed.) e2e: 53 spec files (A0: 50).

End to end by hand, against `pnpm dev`: SETUP.md §9 (a PAT, `claude mcp
add … http://localhost:3001/mcp --header …`, `claude -p "…"`).

## Findings

- **Resolved before release — the eval replay harness no longer honours
  `confirmed: true`.** Checked on the desktop 2026-09-27: `lib/mcpNames.ts`
  splits out only `confirmationId`, and `lib/memoryWorld.ts` refuses a
  `confirm: 'always'` command unless the harness itself passes
  `explicitConfirm` (the equivalent of a script's `confirm: [id]`), so the
  memory world models the server's out-of-band confirmation. The finding
  was written against an earlier state of the A1 working tree.
- **Migration `0019`'s header comment describes the removed flag**
  (`explicit` = "the model retried with confirmed: true"). Do not edit an
  applied migration (its hash changes); the current meaning is in
  `agent/runStore.ts` (`OpConfirmation`).
- **Resolved before release — the Sentry scrubber covers every Narrative
  credential.** `observability/sentry.ts` masks `nrt_`, `nmo_`, `nmr_`,
  `nmc_` and `nms_` inside any string (`CREDENTIAL_RE`), and
  `sentry.test.ts` checks all four OAuth prefixes in an `/oauth/token` form
  body. Written against an earlier state of the working tree, like the eval
  finding above.
- **`tools/list` is ≈ 148 KB against a 120 KB target** — see TODO.
  (Decided and done 2026-09-28: static compaction to ≈ 129 KB; the 120 KB
  target is deliberately not reached.)
- **`pnpm size` still exits 1, on the Tiptap chunk only** (132.64 kB gz vs
  120, +12.64 — unchanged since A0). Measured 2026-09-27: main app chunk
  40.67 kB (A0: 38.67), Pixi 160.24, React 121.07, Yjs 8.95, GSAP 26.89,
  **total first paint 633.9 kB of 800 (A0: 605.45, +28.45 kB)** — A1's pages
  are lazy routes, so where the +28 kB of first-paint payload comes from was
  not investigated.
- **Real-deck PPTX round trip: A0 + A1 add no difference.** Run on
  2026-09-27 on two client decks from the desktop's backup (Tailspin brand
  examples, 12 slides; Contoso deck, 36 slides): HEAD reports 22 and
  41 differences, and a clean `v0.9.29` worktree reports the **identical**
  22 and 41 (byte-identical reports apart from timings). So A1's changes to
  `pptx/writer.ts` / `appendDeck.ts` / `exportDeck.ts` are neutral, but the
  "5 differences" recorded for 0.9.26–0.9.29 is deck-specific: other real
  decks are much further from 0 (`fontSize` 27.99 → 28, `text.length`,
  geometry and `strokeWidth` on the Contoso deck, run `attrs` lost on 4 slides).
  The reference deck the "5" came from is not on the desktop.
- Carried over from A0, not re-checked: Stryker broken on vitest 4,
  `m16-component-flows.spec.ts` hardcoded Drafts id.
- **Desktop verification (petronijus-PC, Ubuntu 26.04, 2026-09-27).**
  `pnpm typecheck` green; `pnpm lint` 0 errors (218 warnings);
  `pnpm -r test` 3,199 passed / 32 skipped; `test:integration` 21/21 against
  the dev Postgres after migrations 0016–0023 applied on `pnpm dev`; e2e
  `access-tokens|agent-activity|agent-confirm|destructive-flows` with
  `PLAYWRIGHT_USE_SYSTEM_CHROME=1 PLAYWRIGHT_NO_VIDEO=1`: 14 passed, 1
  skipped (the share-link revoke assertion, skipped by design under
  `BYPASS_AUTH`).

## Traps worth knowing

- **Caddy strips one `/api`.** Fastify registers `/mcp`, `/oauth/*`,
  `/.well-known/*`; the public URLs are `/api/…`. `PUBLIC_API_URL` must
  therefore include `/api` in prod (compose passes `https://${DOMAIN}/api`),
  every OAuth token is audience-bound to `<PUBLIC_API_URL>/mcp` (changing it
  disconnects every app), and RFC 8414 discovery for the issuer
  `https://<domain>/api` is at the **host root**
  (`/.well-known/oauth-authorization-server/api`) — outside `/api`, so it
  needs its own Caddy route with `handle`, not `handle_path`. In dev there
  is no Caddy and no `/api`: `http://localhost:3001/mcp`.
- **A `:?` required variable in a prod compose file breaks `build-push.sh`**,
  not just the deploy (it runs `docker compose build`).
- **Hocuspocus context writes in `onAuthenticate` can be lost** (above).
- **`claude -p` dismisses every elicitation** → headless calls always take
  the out-of-band path, and an approval is bound to the MCP session that
  asked (a new `claude -p` is a new session).
- **A bare `claude -p` loads the developer's whole setup** — 208 tools and
  ~208k context tokens before the first word, plus SessionStart hooks
  (measured 2026-09-27); the eval isolates it (`tests/agent-eval/README.md`).
- **Sub-agent stream stalls.** The implementing session reported delegated
  sub-agents whose output stream stalled mid-task during A1 (details not
  handed to the docs sweep: which agents, how long, whether work was lost).
  Keep delegated tasks small enough to re-run, and check the working tree
  after a stalled agent rather than trusting its last message.
- **The repo's IP addresses are placeholders** (`192.0.2.x`); where one is
  used as a live default (`CLOUDFLARED_TRUSTED_PROXIES`), it is wrong in
  prod.

## Next step

1. **Release A0 + A1** as one version (A0 is committed but untagged): add
   the two env values above, bump all eight `package.json`, turn
   `Unreleased` into the version section, tag, `build-push.sh`, deploy, run
   the post-deploy checks incl. the client-IP check, smoke-test an agent
   against prod.
2. **A2 — extraction** (plan §10): move every web-only item in Appendix B
   into commands and switch the UI to `useCommand()`, turning on the
   `no-restricted-imports` rule per directory; move token seeding and
   text-style propagation to the server; the notes API, `deck.duplicate`,
   `slide.copyTo` / `object.copyTo`, `text.set` with formatting,
   `table.cell.setText`; empty the A2 part of `knownMissing.ts` (32).
   Shortcut and menu-action enumeration for the parity guard. Every new
   command adds an eval scenario.

## Known TODO

- **Tool list 148 KB vs a 120 KB target — decided and done 2026-09-28**
  (resolution at the end of this item). The target is not recorded in
  code (the test budget is 160,000 bytes). Measured by the docs sweep on
  2026-09-27, form mode, 94 tools = 148,207 bytes (descriptions 52,211,
  schemas 81,366, annotations 5,286); url mode 150,975, link mode 151,119.
  Deferral options, bytes saved from the form-mode total:
  - defer the 14 `table_*` tools until a table is involved: −31,411 →
    **116,796**;
  - defer the 12 `object_*` tools: −30,069 → 118,138 (not realistic: core);
  - defer the account/admin tools (share 9, folder 7, component 5, media 5,
    token 1 = 27 tools): −28,705 → **119,502**;
  - `object_create` alone is 13,251 bytes (the 11-kind union) — the biggest
    single target for further compaction; the ~9 KB of example tails are
    another.
    Mechanism options: domain toolsets announced with
    `notifications/tools/list_changed`, or a small `tools_enable`-style meta
    tool.

  **Measured 2026-09-28** (Claude Code 2.1.283, haiku,
  `pnpm agent:probe:list-changed`, the full matrix once plus `--repeat 4` of
  the same-/next-turn cases, both routes pooled — an in-process server with Narrative's
  transport shape; `tests/agent-eval/probes/listChanged.ts`):

  | Claude Code setup                                         | re-reads `tools/list` on `list_changed` | new tool usable, same turn                 | next turn | 86 filler tools ≈ 148 KB cost per request |
  | --------------------------------------------------------- | --------------------------------------- | ------------------------------------------ | --------- | ----------------------------------------- |
  | default tools (ToolSearch on — a user's session)          | yes, ~25 ms after, on both routes       | **10/10**                                  | 10/10     | **+2.6k tokens** (71.3k → 73.9k)          |
  | `--tools ""` (no ToolSearch — how `pnpm agent:eval` runs) | yes                                     | **4/10, flaky** ("No such tool available") | 10/10     | **+99.8k tokens** (14.7k → 114.5k)        |

  Both notification routes (the session's standalone GET stream, and the
  tools/call response stream) behave the same; Claude Code opens the GET
  stream right after `initialized`. With ToolSearch on, Claude Code defers
  MCP tools: the model sees names only and loads a schema with
  `ToolSearch select:<name>`, so the tool list's size barely matters there.

  **claude.ai: not testable locally** (a connector needs a public HTTPS
  URL). Its connector docs do not mention `list_changed`, and an open
  issue (anthropics/claude-ai-mcp#1044, 2026-09-16) reports claude.ai
  keeping a connector's old tool list per URL even across Disconnect /
  Connect and remove + re-add, although the server served the new list. A
  tool list that changes mid-session is therefore likely to strand the
  deferred tools there.

  **Consequence for the decision before A2:** deferring toolsets behind
  `list_changed` buys nothing in Claude Code as users run it (already
  deferred), is flaky within a turn without ToolSearch, and is probably
  broken in claude.ai. If the list must shrink, static compaction
  (`object_create`'s union, the example tails) helps every client without
  dynamic behaviour. Where the size really costs is the eval harness, which
  runs without ToolSearch.

  **Resolution (2026-09-28, working tree on top of `db7ef91`, uncommitted
  at the time of writing; CHANGELOG "Unreleased"):**
  - **No dynamic toolsets.** Every tool stays in `tools/list` from the
    start; nothing is deferred behind `list_changed`.
  - **Static compaction, MCP projection only** (`apps/server/src/mcp/`; the
    zod schemas, command descriptions and capability manifest are
    untouched):
    - `mcp/vocabulary.ts`: 27 field descriptions repeated across tools
      (slide reference on 45 tools, object / table ids, cells, text bodies
      and targets, font fields, fill kinds, file `{ url }` | `{ base64 }`
      and the download policy, share role, `componentId`, `assetId`) are
      stripped from every schema by exact match and said once in the
      instructions. `mcp/vocabulary.test.ts` guards both directions (an
      entry must still match some command; any description on ≥ 3 tools
      costing ≥ 100 bytes to repeat must be listed).
    - Example calls only where the input has several forms, a nested
      object / array or more than two own properties (`needsExample`);
      39 of 94 tools lost theirs, and the title is gone (`Example: {…}`).
    - The per-tool confirmation line says only that / how this client
      asks; declined, dismissed and the `confirmationId` retry are said
      once in the instructions; `confirmationId` is bare `{ type: 'string' }`.
    - `schemaCompact.ts` pass 4: identical union alternatives said once
      (mostly `object_create`, −267 bytes).
  - **Measured** (bytes of `JSON.stringify({ tools })`, 94 tools):

    | Mode | 2026-09-27 | 2026-09-28 |
    | ---- | ---------- | ---------- |
    | form | 148,207    | 128,349    |
    | url  | 150,975    | 129,309    |
    | link | 151,119    | 129,213    |

    Form mode now: descriptions 44,178 (was 52,211), schemas 68,286 (was
    81,366), annotations 5,286; the 14 `table_*` tools 27,884,
    `object_create` 11,727 (was 13,251). The instructions grew from
    ≈ 1.6 KB to 3,945 bytes (the shared-field paragraph is 2,173), so the
    net saving per session is ≈ 17.5 KB (form) to ≈ 19.5 KB (link).
    `TOOL_LIST_BUDGET_BYTES` 160,000 → 132,000 (per tool 16,000 unchanged).

  - **The 120 KB target is not reached, on purpose.** What remains is
    mostly command descriptions carrying real guidance (radians, crop /
    flip gotchas, run formatting, animation trigger semantics); cutting
    further loses guidance and is Petr's call. The one dedupable candidate
    left: `animation.add` / `animation.update` share ≈ 700 characters (the
    presets list duplicates the enum; triggers and rotation units
    repeated).
  - **The eval runs with ToolSearch** (`tests/agent-eval/lib/claude.ts`:
    `--tools ListMcpResourcesTool,ReadMcpResourceTool,ToolSearch`, also in
    `--allowedTools`), so it sees Narrative the way users' Claude Code
    does. ToolSearch calls land in transcripts as non-Narrative calls
    (`command: null`), which grading and replay skip. Result on 2026-09-28
    (opus, Claude Code 2.1.283, `results/2026-09-27T22-38-11-223Z.json`,
    UTC stamp, git `db7ef91+dirty`): 13 pass + 1 error in the full run,
    $1.62 list-price equivalent (was ≈ 2 USD), 90 tool calls of which 17
    ToolSearch. The error was `selected-slide-context`: Playwright's bundled
    browser is missing on Ubuntu 26.04; it passed on a rerun with
    `PLAYWRIGHT_USE_SYSTEM_CHROME=1` ($0.07). So 14/14.
  - **Verified with the change:** `pnpm typecheck` green, `pnpm lint`
    0 errors, `pnpm -r test` green (3,205 passed / 32 skipped in the docs
    sweep's run). One earlier full run hit a timing flake in
    `services/editor.test.ts` (recorded in `docs/testing-strategy.md`,
    "Known flaky unit tests").
  - **Not verified:** claude.ai with the new list (needs a public
    deployment); the change is not released or deployed.

- The `narrative` skill regenerates with `pnpm --filter @narrative/commands skill`;
  its freshness test makes a playbook change without regeneration fail.
- CLAUDE.md is stale (test counts, e2e count, no A1 prod secret, placeholder
  IPs) — Petr's edit.
- From A0, still open: Drafts id in `m16-component-flows.spec.ts`, the 5
  real-deck round-trip differences, Tiptap budget, Stryker runner, explicit
  drag gesture boundary.

## Links

- Plan: [`docs/plans/agentic-layer.md`](../plans/agentic-layer.md)
- ADRs: [0010](../adr/0010-command-layer-is-the-only-writer.md),
  [0011](../adr/0011-agent-execution-over-mcp.md)
- MCP reference: [`docs/mcp.md`](../mcp.md); eval:
  [`tests/agent-eval/README.md`](../../tests/agent-eval/README.md); playbooks:
  [`packages/commands/playbooks/README.md`](../../packages/commands/playbooks/README.md)
- Deploy: [`docs/deploy.md`](../deploy.md) (A1 checklist, MCP / OAuth
  discovery, Client IP, kill switch, retention); ops:
  [`docs/ops.md`](../ops.md) "Agents (MCP)"
- Manifest: [`docs/capabilities.md`](../capabilities.md)
- Ownership: [`docs/agents.md`](../agents.md),
  [`.claude/agents/ai-integration.md`](../../.claude/agents/ai-integration.md),
  [`.claude/agents/state-sync.md`](../../.claude/agents/state-sync.md),
  [`.claude/agents/agent-parity.md`](../../.claude/agents/agent-parity.md)
- Previous handoff: [`A0-agentic-foundations.md`](./A0-agentic-foundations.md)
