---
paths:
  - 'apps/web/e2e/**'
  - 'apps/web/playwright.config.ts'
---

# Playwright specs

- Run through `just e2e [-g name]` (the dev stack must be up; the recipe
  picks the browser). `/playwright-e2e` has the patterns.
- Seed decks and objects through the API / command API, never the dashboard
  UI; assert canvas output by sampling pixels or through
  `window.__narrative_test_api`.
- Do not edit `apps/` or `packages/` source during a run — an HMR reload
  shows up as a blank page or an `.artboard` timeout.
- Specs run in parallel (`fullyParallel`, `PW_WORKERS` workers, default 6)
  as the same `dev-user` against one server and database: seed your own
  folders, decks, components and tokens, find them by the ids you got back —
  never by position in, or the count of, a user-wide list (folders, decks,
  Drafts, access tokens, connected apps) — and name them uniquely. No test may
  rely on another test in its file having run. A spec that cannot share the
  machine (it measures CPU or frame timing, or changes user-wide state other
  specs read) is tagged `@serial`: it runs in the `serial` project, alone,
  after the parallel one (run it by itself with `--no-deps`).
