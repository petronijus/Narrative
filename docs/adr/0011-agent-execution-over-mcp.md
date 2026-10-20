# ADR 0011 — Agents reach Narrative only through MCP and execute on the server

**Status**: Accepted (2026-09-26). The origin helper landed in phase A0
(`packages/slide-model/src/origins.ts`); the ServerHost, runs and the MCP
server were built in A1 (2026-09-27, unreleased — see
[`docs/handoff/A1-mcp-and-server-host.md`](../handoff/A1-mcp-and-server-host.md);
was: "ship in A1").
**Scope**: `apps/server/src/mcp/` (the MCP server at `/api/mcp`), the
ServerHost that runs commands for agents, `packages/slide-model/src/origins.ts`,
the `agent_runs` / `agent_ops` tables, the Agent activity popover, and the
awareness fields agents read and write.
**Related**: [`docs/plans/agentic-layer.md`](../plans/agentic-layer.md) §4.3,
§4.5, §6, §12, §13; ADR 0010 (commands are the only writer); ADR 0003
(`LOCAL_ORIGIN` and the editor UndoManager); ADR 0006 (persistence).

## Context

With the command registry of ADR 0010 in place, the remaining questions are
where the model runs, where an agent's commands execute, and how an agent's
changes are attributed, reviewed, undone and made visible. The survey of
2026-09-26 found:

- The server already writes live decks through
  `hocuspocus.openDirectConnection(deckId)` (`pptx/appendDeck.ts`). A direct
  connection **skips `onAuthenticate`**, and Hocuspocus runs the callback
  **without wrapping it in one transaction**, so one server write reaches
  clients as many small updates.
- Every writer uses the single `LOCAL_ORIGIN` symbol. Server writes reach an
  open editor as remote updates, which the editor's UndoManager (tracking
  only `LOCAL_ORIGIN`) does not undo.
- There is no machine identity: no API tokens, no rate limit, no audit log.

Petr decided on 2026-09-26 (plan §12): MCP now and as the only agent surface;
the agent applies changes directly for every kind of run; irreversible
commands still ask; Narrative carries no model cost; an in-app agent is not
needed now.

## Decision

1. **MCP is the only agent surface.** `apps/server/src/mcp/` exposes the
   registry over streamable HTTP at `/api/mcp` with the official MCP
   TypeScript SDK. Tools are generated from commands, carrying their zod
   schema as JSON Schema and annotations from their metadata (`readOnlyHint`,
   `destructiveHint`, `idempotentHint`). The model runs in the user's own
   Claude client (Claude Code, claude.ai), so Narrative has **no Anthropic
   dependency, no API key and no bill**. Authentication is a personal access
   token first, then the MCP OAuth flow for claude.ai connectors. An MCP
   session is bound to one user and runs every command with that user's deck
   role, never more. The same registry backs `POST /api/commands` for
   scripts.

2. **Every agent command executes in the ServerHost**, never in a browser:
   - It opens `openDirectConnection(deckId)` and **checks access first**,
     because the direct connection bypasses `onAuthenticate`.
   - It wraps each invocation, or each batch, in **one**
     `doc.transact(fn, agentOrigin(runId))`. Clients receive one update per
     agent action instead of many, and the action is one unit for revert.
   - Attribution holds even though slide-model mutations pass `LOCAL_ORIGIN`
     themselves: Yjs keeps the **outermost** transaction's origin for
     everything nested inside it.
   - `agentOrigin(runId)` returns the **same object for the same run** until
     `releaseAgentOrigin(runId)`. `Y.UndoManager.trackedOrigins` is a Set
     compared by identity, so a fresh object per call would make the run's
     revert manager track nothing.

3. **Direct by default, reverted per run.** A run is one MCP session's work
   on one deck, split when the agent calls `agent.startRun` (the playbooks
   do, per user request) or after 10 minutes of inactivity. Commands apply
   live. `agent.revert` undoes a whole run or its last N ops through a
   **server-side `Y.UndoManager` scoped to `agentOrigin(runId)`**, so a
   revert removes only that run's changes and keeps what people edited in
   the meantime. The editor's **Agent activity** popover lists recent runs
   with a Revert button, so a person can undo an agent without going back
   to Claude.

4. **Runs are recorded as changesets.** `agent_runs` holds run id, user,
   surface (MCP or API), the client name the session reported, the request
   as stated in `agent.startRun`, status and style pack. `agent_ops` holds
   run id, sequence number, command id, input, result or error, and time.
   Because commands take explicit ids (ADR 0010), re-running the recorded
   ops on a fork is deterministic. The tables are the audit trail and the
   replay record, not the undo mechanism.

5. **Propose mode is opt-in**, on `ops.apply` and the style commands. The
   host forks the live document (a new Y.Doc seeded with
   `encodeStateAsUpdate(live)`), runs the commands on the fork, and returns
   before/after renders. `agent.applyProposal` then applies
   `encodeStateAsUpdate(fork, stateVectorAtFork)` to the live document under
   the agent origin. It is a CRDT delta, so human edits made while the
   proposal was under review survive.

6. **Batches are atomic.** `ops.apply({ ops, atomic: true })` runs many
   commands as one change and one revert step. It is the main tool the
   agent calls: fewer round trips, and one user request stays one step.
   Every input is validated first; the ops then run on a **fork** of the
   deck document (seeded with `encodeStateAsUpdate(live)`, reusing the live
   document's clientID so its clock simply continues), and only when all of
   them succeed is `encodeStateAsUpdate(fork, stateVectorAtFork)` applied to
   the live document in one transaction with the run's origin. A failure
   anywhere discards the fork and leaves the live document untouched. The
   whole batch is synchronous, so nothing can interleave between fork and
   apply. Single commands do not fork (that would copy the document on every
   edit); instead every handler must check all preconditions before its
   first write, which the command contract suite enforces for every command
   by running it against missing ids and asserting the document is
   byte-for-byte unchanged. Implemented in `packages/commands/src/run.ts`
   (A0).

7. **Irreversible commands and URL downloads always confirm.** `share.*`,
   `deck.delete`, `folder.delete`, invite emails and the other deletes carry
   `confirm: 'always'`; a call whose input makes the server download a URL
   (`confirmWhen`, registry metadata — the URL can carry data to its host) is
   confirmed naming the host, unless every host is on
   `AGENT_URL_FETCH_ALLOWED_HOSTS`. The question is built on the server from
   the exact call (titles, recipient, role, host — one fact per line). A client
   with form elicitation is asked in the client. For a client without it —
   and when a form question is dismissed or fails — confirmation is **out of
   band**: the server stores the exact call (session, user, command, input
   hash, target; 5 minutes, single use) and returns `confirmation_required`
   with a Narrative page where the signed-in user approves or declines (URL-mode
   elicitation sends that page itself when the client supports it); the model
   retries with the server-issued `confirmationId`. There is no model-settable
   `confirmed` flag (security review, 2026-09-27): a prompt injection could set
   it. The command API keeps its explicit `confirm` list — scripts the user runs
   deliberately.

8. **The agent is present in the deck.** It joins awareness as a peer named
   "Claude (MCP)" with its own colour and selection, so people watch it work
   the way they watch a colleague (an agent on the command API appears as
   "<user's display name>'s agent (<client>)", the client name sanitised and
   truncated; never the Google sub). Whom the agent works for travels in
   the peer's `agent` field as `principalName` (the user's sanitised
   display name, or null — never the email) and `principalKey`, an opaque
   key scoped to the document: 22 base64url characters of HMAC-SHA256, keyed
   with the server secret `AGENT_PRINCIPAL_KEY_SECRET`, over
   `agentPrincipalKeyInput(documentName, sub)` (v2, `packages/shared`). A bare
   hash could be recomputed by anyone who knows a sub, so the browser no
   longer computes the key: the server tells each signed-in editor its own
   key in a `narrative.agentPrincipal` stateless message when it connects
   (never share-link connections), and the editor labels a peer carrying it
   "working for you"; one person's agents on two decks carry unrelated keys.
   Human editors publish only a random per-tab peer id as `user.id` and their
   profile name (never the sub or email); as defence in depth, read-only and
   share-link connections receive awareness with `user.id` replaced and
   email-looking values removed (`hocuspocus/awarenessRedaction.ts`). (Until
   the release after this change the server also sends the key as the
   deprecated `onBehalfOf`, which pre-change editors require to recognise an
   agent peer at all; it used to hold the sub.) `editor.context` reads the calling
   user's `activeSlideId` (a new awareness field) and selection from the
   awareness states of that user's connections, which is how "this" becomes
   ids before a command runs. Awareness is client-asserted, so each client id
   is bound to the connection (and user) that first announced it
   (`hocuspocus/awarenessOwnership.ts`); a state another user's connection
   sends under that id is ignored, and only ids bound to the caller's own
   connections count. `editor.show` sends a Hocuspocus stateless message to the
   user's open editors to jump to a slide and highlight objects.

## Alternatives considered

- **An in-app agent**: a chat panel, with the model running on Narrative's
  server. Deferred, not rejected (plan §13). It would reach people without a
  Claude client and would make agent steps Mod+Z-undoable, but it needs an
  Anthropic key on the server and a per-use bill, an agent runtime and a
  chat UI. It reuses the registry, playbooks, render worker and style packs
  unchanged, so nothing in A0–A5 has to be built differently to add it
  later.
- **Propose by default** (the old `ai-integration` principle "never mutate
  the Y.Doc without user confirmation"). Rejected by the 2026-09-26
  decision: review-first puts a round trip in front of every small edit,
  and per-run revert makes direct application safe to undo. Propose mode
  stays for anyone who wants it.
- **Keep Hocuspocus's default, one update per mutation.** Rejected: a single
  agent action would reach clients as a burst of partial states, and would
  have no natural boundary for revert or for batch atomicity.

## Consequences

- **Mod+Z in the editor does not undo agent writes.** An agent write is made
  in the server's copy of the document and reaches the editor as a remote
  update. The editor's UndoManager tracks only `LOCAL_ORIGIN`, and it has
  to: tracking remote origins would let one person's Mod+Z undo a
  collaborator's work. Agent changes are undone per run instead
  (`agent.revert`, the Agent activity popover). Making them Mod+Z-undoable
  would need the agent to execute inside the browser, which is the deferred
  in-app agent.
- **Revert works only while the document is loaded.** The per-run
  UndoManager lives in server memory: `unloadImmediately: false` keeps the
  document loaded while anyone is connected, and a server restart or an
  unload loses it. Persistence keeps a single compacted snapshot (ADR 0006),
  so there is no older state to fall back to. Durable revert needs version
  history (M18) and is a known limit, not a bug.
- **Every ServerHost entry point owns an access check.** Skipping it is an
  IDOR, because nothing downstream of `openDirectConnection` checks again.
  Personal access tokens become a second identity accepted by
  `authPreHandler` and the tus upload handler (media only — images, videos,
  fonts; a .pptx goes through `deck.importPptx` / `deck.insertFrom`), behind
  `@fastify/rate-limit`. A1 goes through `security-reviewer`.
- **Personal access tokens are NOT accepted on the Hocuspocus WebSocket**
  (security review of A1, 2026-09-27). Agents write only through the server
  host, which validates every command, enforces confirmation, attributes the
  change to a run and records it in the audit log; a raw Yjs connection
  authenticated by a token would bypass all four. `onAuthenticate` refuses a
  connection that presents a token (auth frame or `Authorization` header)
  instead of falling back to a cookie or a share link. The WebSocket takes
  the session cookie and share links only, so revoking a token has no live
  socket to close.
- **Tokens do not outlive the account.** Every token expires (30, 90 or 365
  days; no "never"). Each verification re-applies the sign-in allowlist to
  the token's owner (`auth/signInPolicy.ts`), and revoking a user's sessions
  revokes their agent credentials with them
  (`auth/agentCredentials.ts`, the `revokeUserAccess` ops script).
- **The audit log is redacted and bounded.** `agent_ops` stores inputs and
  results with inline file bytes and `data:` URLs replaced by
  `{ bytes, sha256 }` and URL query strings and fragments stripped, so
  replaying an op that carried a file needs the stored asset rather than the
  log (decision 4's determinism holds for everything else). Runs and their
  ops are deleted 90 days after their last activity.
- **Narrative is its own OAuth authorization server, and does not store
  Claude's clients.** claude.ai connectors need OAuth. The issuer is
  `PUBLIC_API_URL`; the existing Google sign-in is only the login step in
  front of Narrative's own consent page (plan §4.5).
  Clients identify themselves with a Client ID Metadata Document (the MCP
  spec of 2025-11-25; Claude Code and claude.ai both do), fetched through
  the SSRF guard from an allowlisted host (`MCP_OAUTH_CIMD_HOSTS`, default
  `claude.ai`) and never persisted; RFC 7591 dynamic registration is off by
  default (`MCP_OAUTH_DCR_ENABLED`): a DCR client such as claude.ai
  registers a new client on every fresh connection, so stored registrations
  only accumulate (they are swept after 7 idle days when DCR is on). Every MCP OAuth token
  is bound to `<PUBLIC_API_URL>/mcp`, so changing that URL disconnects every
  app. Because the issuer has a path (`/api`), RFC 8414 discovery lives at
  the host root and needs its own Caddy route. Details: `docs/mcp.md`.
- **Atomicity costs a document copy per batch.** A Yjs transaction cannot be
  aborted, so `atomic: true` is delivered by running the batch on a fork
  (decision 6). Encoding the deck once per batch is cheap for agent batches
  and would be wasteful for every UI edit, which is why single commands rely
  on validate-before-write instead. Undoing a partial write with a temporary
  UndoManager was rejected: the editor's own UndoManager would already hold a
  stack item for the failed write, and undoing that item later would
  resurrect content the rollback had restored as new items.
- **Agent-heavy use amplifies a known model risk.** Reordering layers,
  slides and animations deletes and re-inserts a clone, which loses a
  collaborator's concurrent edit to the moved item. A fractional-index order
  field fixes it; it is tracked in plan §11 as a later ADR, to revisit if
  lost edits show up.
- **Evals need no API key.** `pnpm agent:eval` drives scenarios through
  headless Claude Code with the Narrative MCP server configured, on the
  developer's own subscription.
- **The Hocuspocus lifecycle settings become load-bearing for revert** as
  well as for persistence; the lifecycle test that enforces
  `unloadImmediately: false` now protects both.

## Amendment (2026-10-18): agent writes store on the debounce, batches on a kept fork

Measured with `just perf-commands` (`apps/server/perf/commands.ts`, a
100-slide deck, `docs/plans/performance.md` → Log, "S3/B4/S2"): every agent
command waited for a full snapshot store of the deck (about 11 ms of a
16 ms command; 200 commands wrote 46 MB), and every atomic batch copied
the whole deck to fork it.

- **Durability.** The agent host's lease no longer stores after each write
  (`agent/documents.ts`, `hocuspocus/directWrite.ts` `writeDirect`): the
  write is applied to the live document and broadcast, and the sync
  server's debounce stores it, as it stores people's edits (2 s after the
  last change, at most 10 s after the first unstored one). When a command
  returns, its change is live and its op is in `agent_ops`. The document is
  stored at once, awaited, when the run closes or is replaced and after a
  revert (`services/runs.ts`), when the agent host disconnects, and on
  graceful shutdown. A crash loses at most the debounce window of agent
  writes — the window people's edits already had; their ops stay in
  `agent_ops`, and the revert history was in memory anyway.
- **Atomic batches** (decision 6, "Atomicity costs a document copy per
  batch") run on a fork the server host keeps per live document
  (`packages/commands/src/batchForks.ts`): made on the first batch, kept in
  step by replaying the live document's updates, dropped when a batch fails
  (all-or-nothing is unchanged), after a minute idle, and past its memory
  caps. A batch's change is the fork's own update. The fork writes under
  a client id of its own: the old fork borrowed the live document's id, and
  Yjs gave the fork a new random id on every copy, so every batch had added
  a client to the deck. The editor (no kept fork) still copies per batch.
