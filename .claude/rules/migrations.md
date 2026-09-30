---
paths:
  - 'apps/server/drizzle/**'
  - 'apps/server/src/db/schema.ts'
---

# Database migrations (apps/server/drizzle/README.md)

- Hand-written SQL, never `drizzle-kit generate`. A new file
  `NNNN_name.sql` plus a `meta/_journal.json` entry with the next `idx` and
  `when` = the current time (`date +%s%3N`): the dev server's drizzle
  migrator skips an entry older than the newest applied one.
- An applied migration never changes — production tracks migrations by the
  hash of their SQL. Mirror the change in `src/db/schema.ts`.
- Changes to documents are not SQL migrations: they go in
  `src/services/dataMigrations.ts` (through the sync server).
- Run `just integration` for stores and migrations.
