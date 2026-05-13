-- 0013_users_and_invites.sql
--
-- Closes the gap left after the 0.6.0 server-session migration: deck
-- collaboration was identified by the opaque Google `sub` claim, which is
-- impossible for a human to type into the invite field. Adds:
--
--   1. `users` — directory of every Google account that has ever logged in,
--      keyed by `sub` (which is also the value used in `deck_permissions.user_id`,
--      `decks.owner_user_id`, etc). Allows joins so the UI can resolve a sub
--      to an email + display name without depending on the `sessions` row
--      (which gets sweep-deleted).
--
--   2. `deck_invites` — pending invites by email for users who haven't yet
--      signed in. On their first /auth/callback, any matching invite is
--      converted into a real `deck_permissions` row and the invite is
--      marked accepted.

-- ─── users ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  sub           TEXT PRIMARY KEY,           -- Google OIDC `sub` claim
  email         TEXT NOT NULL,
  name          TEXT,
  picture_url   TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness on email so two Google accounts can't collide.
-- (Google `sub` is the source of truth — email is best-effort display.)
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uniq ON users (LOWER(email));

-- Backfill from existing sessions so users created before this migration
-- get a row immediately (otherwise the ShareDialog couldn't resolve their
-- name until they next log in).
INSERT INTO users (sub, email, name, first_seen_at, last_seen_at)
SELECT DISTINCT ON (user_sub) user_sub, user_email, user_name, MIN(created_at) OVER (PARTITION BY user_sub), MAX(last_used_at) OVER (PARTITION BY user_sub)
FROM sessions
WHERE revoked_at IS NULL
ORDER BY user_sub, last_used_at DESC
ON CONFLICT (sub) DO NOTHING;

-- ─── deck_invites ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deck_invites (
  id              TEXT PRIMARY KEY,         -- nanoid(12) — also forms the invite URL token
  deck_id         TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,            -- lower-cased on insert
  role            deck_role NOT NULL,
  invited_by_sub  TEXT NOT NULL,            -- the inviter's Google sub
  invited_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,     -- default 30 days from invite time
  accepted_at     TIMESTAMPTZ,              -- set when the invitee first logs in
  accepted_by_sub TEXT                      -- the invitee's actual sub
);

-- One pending invite per (deck, email). Re-inviting overwrites role.
-- `accepted_at IS NULL` ensures we don't conflict with historical accepted rows.
CREATE UNIQUE INDEX IF NOT EXISTS deck_invites_deck_email_pending_uniq
  ON deck_invites (deck_id, LOWER(email))
  WHERE accepted_at IS NULL;

CREATE INDEX IF NOT EXISTS deck_invites_email_pending_idx
  ON deck_invites (LOWER(email))
  WHERE accepted_at IS NULL;

CREATE INDEX IF NOT EXISTS deck_invites_deck_id_idx
  ON deck_invites (deck_id);
