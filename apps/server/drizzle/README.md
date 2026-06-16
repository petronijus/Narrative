# Database migrations

**Migrations here are HAND-WRITTEN. Do _not_ run `drizzle-kit generate`.**

## Why hand-written (and why `db:generate` is disabled)

The runtime migrator is a custom script — [`../src/db/migrate.ts`](../src/db/migrate.ts) —
not drizzle-kit's built-in `migrate()`. The built-in migrator wraps **all**
pending migrations in a single outer transaction, and Postgres rejects
`ALTER TYPE … ADD VALUE 'x'` followed by a statement that _uses_ `'x'` inside
the same transaction (error `55P04`, "unsafe use of new value of enum type" —
see migration `0004` vs `0009`). Our migrator runs **each migration file in its
own implicit transaction** (node-postgres simple protocol), so an `ADD VALUE`
commits before later migrations reference it.

Because we never adopted `drizzle-kit generate`, the snapshot chain under
`meta/` was never maintained (only `meta/_journal.json` is kept, by hand).
Running `drizzle-kit generate` therefore diffs the live schema against an empty
snapshot and emits a **destructive full-schema migration** (CREATE TABLE for
everything). The `db:generate` npm script is guarded to fail loudly for this
reason. `drizzle.config.ts` / the `drizzle-kit` dep remain only for `studio`
and ad-hoc inspection — never for `generate`.

## What the runtime needs

`migrate.ts` reads only:

- **`meta/_journal.json`** — the ordered list of migrations (`idx` + `tag`).
- **`<tag>.sql`** — the SQL for each entry.

It hashes each file's SQL (sha256, `--> statement-breakpoint` markers stripped)
and records applied migrations in `drizzle.__drizzle_migrations`, skipping any
whose hash is already present. The `meta/*_snapshot.json` files are **not read
at runtime** — they exist only for drizzle-kit codegen, which we don't use.

## How to add a migration

1. Create `NNNN_short_name.sql` (next sequential number, zero-padded to 4).
2. Write plain SQL. Prefer idempotent forms (`CREATE INDEX IF NOT EXISTS`,
   `ADD COLUMN IF NOT EXISTS`, …) so a partially-applied migration is safe to
   re-run. Separate statements with `--> statement-breakpoint` if you want
   drizzle-style breakpoints (the migrator strips them; they're advisory).
3. Append an entry to `meta/_journal.json`:
   ```json
   { "idx": <N>, "version": "7", "when": <epoch-ms>, "tag": "NNNN_short_name", "breakpoints": true }
   ```
   `idx` must be the next integer; `when` is cosmetic (the migrator sorts by
   `idx`). Keep `tag` exactly equal to the filename without `.sql`.
4. (Optional but recommended) mirror the change in
   [`../src/db/schema.ts`](../src/db/schema.ts) so the ORM model stays accurate.
   The schema file is the source of truth for drizzle's _types_; the SQL +
   journal are the source of truth for the _database_.
5. Apply: `pnpm --filter @narrative/server db:migrate` (also runs automatically
   on dev server start, and as a step in `infra/scripts/deploy.sh`).

## Do NOT

- Run `drizzle-kit generate` / `db:generate` (guarded — produces garbage here).
- Edit an already-applied migration's SQL — its hash changes, so the migrator
  treats it as a new migration and tries to re-apply it. Add a new migration
  instead.
