-- Agentic layer A1 (security review of the MCP surface, 2026-09-27): the hosts
-- an agent command actually downloaded from, per op.
--
-- Commands that take a file source (`{ url }` — media.upload, folder.fonts.upload,
-- deck.importPptx, deck.insertFrom) make the server fetch a URL the model chose,
-- which is an exfiltration channel (the URL itself can carry data). Such a call
-- is confirmed by the user naming the host (unless the host is on
-- AGENT_URL_FETCH_ALLOWED_HOSTS), and every host the fetch contacted — the
-- requested one and each redirect hop — is recorded here, next to the op, so the
-- audit trail shows where data could have gone even when the input was redacted.
--
-- NULL: the op fetched nothing (every op before this migration, and every op
-- without a URL file source).

ALTER TABLE "agent_ops" ADD COLUMN IF NOT EXISTS "fetched_hosts" text[];
