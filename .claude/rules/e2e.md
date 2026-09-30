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
