-- Agentic A2.12 (2026-09-30): one-time DATA migrations the server runs on
-- start (services/dataMigrations.ts) — changes to documents rather than to
-- the schema, which must go through the sync server (a row written under a
-- loaded document would be lost). One row per migration id: how often it
-- was tried, when it completed (NULL until then), its report and the last
-- error. A failed one is tried again on the next start, up to a cap.

CREATE TABLE IF NOT EXISTS "app_data_migrations" (
  "id" text PRIMARY KEY,
  "attempts" integer DEFAULT 0 NOT NULL,
  "completed_at" timestamp,
  "report" jsonb,
  "last_error" text
);
