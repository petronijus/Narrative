-- Agentic layer A1 (ADR 0011 point 7): irreversible commands (`confirm: 'always'`
-- — share, invite, delete) run only with the user's explicit confirmation, which
-- the server host enforces for every transport. agent_ops.confirmation records
-- how it was given, next to the op it allowed:
--   { "via": "elicitation" | "explicit", "by": <user sub>, "surface": "mcp" | "api", "at": <ISO time> }
-- `elicitation`: the MCP client showed Narrative's question and the user accepted.
-- `explicit`: the MCP fallback for clients that cannot elicit (the model retried
-- with confirmed: true after asking the user), or the command API's `confirm` list.

ALTER TABLE "agent_ops" ADD COLUMN IF NOT EXISTS "confirmation" jsonb;
