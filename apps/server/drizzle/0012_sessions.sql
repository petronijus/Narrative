-- 0012_sessions.sql
--
-- Server-side opaque sessions. Replaces the previous browser-PKCE flow where
-- the SPA held the Google id_token in localStorage and sent it as Bearer.
--
-- A session row is created by GET /api/auth/callback after a successful Google
-- OAuth exchange, and is referenced from the browser via a `narrative_session`
-- HttpOnly cookie that holds only the session id. The actual user identity
-- comes from the row.
--
-- Cleanup: sessions older than 30 days (or with `revoked_at` set) are deleted
-- by a periodic sweep. Active sessions get `last_used_at` bumped on every
-- request so an active user effectively never logs out.
--
-- We store the SHA-256 of the cookie value (not the raw value) so that a
-- read-only DB compromise can't be used to impersonate active users.

CREATE TABLE IF NOT EXISTS sessions (
  -- SHA-256(cookie_value) — hex string (64 chars)
  id_hash      TEXT PRIMARY KEY,

  -- Google `sub` claim — stable, unique, opaque
  user_sub     TEXT NOT NULL,
  user_email   TEXT NOT NULL,
  user_name    TEXT,

  -- Issuance + sliding expiry
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,

  -- For "view active sessions" UI in the future. Truncated to keep PII small.
  user_agent   TEXT,
  ip           TEXT
);

CREATE INDEX IF NOT EXISTS sessions_user_sub_idx   ON sessions(user_sub);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
