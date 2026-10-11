# Handoff A3 — the render worker: the server can see a slide

**Status:** done. A3.5b–A3.7 shipped as **0.10.30** on 2026-10-11 (the
verification is in the plan's "Where we stand"); A3.1–A3.5a in
0.10.20–0.10.29.
**Date:** 2026-10-11

Plan: [`docs/plans/a3-render-worker.md`](../plans/a3-render-worker.md)
(design, memory, isolation, the step log in "Where we stand") and
[`agentic-layer.md`](../plans/agentic-layer.md) §4.6 / §10 row **A3**.
Previous handoff: [`A2-extraction.md`](./A2-extraction.md).

After A3 the server draws slides through the real web renderer in headless
Chromium (`apps/render-worker`), on the live document, with the folder's
fonts and pictures: the agent sees what it built, people export PNGs, and
cards of decks and masters nobody has open stay current.

## What was completed

| Step   | Subject                                                                                                 | Commands                                 | Released        |
| ------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------- |
| A3.1   | render page `/deck/:id/render`, render tokens `nrr_…`, same-origin `/api` and `/ws`                     | —                                        | 0.10.20         |
| A3.2–3 | the worker, PNG export (server and in-browser), folder fonts on HTMLText                                | `deck.exportPng`                         | 0.10.21–0.10.23 |
| A3.4   | looks for the agent: slide, region, numbered sheet; render sessions and warm pages                      | `query.render`                           | 0.10.24         |
| —      | blank photo-heavy sheets (OOM at 900 MB → 1200 MB), then speed: `?paint=off` (7.4 s → 1.1 s a slide)    | —                                        | 0.10.25–0.10.28 |
| A3.5a  | deck cards drawn by the worker for decks nobody has open; a background render lane                      | `deck.refreshThumbnail`                  | 0.10.29         |
| A3.5b  | component master cards (render page and render token for a master)                                      | `deck.refreshThumbnail` on `componentId` | 0.10.30         |
| A3.6   | compare before/after (a frozen page of the run's first-write state); text overflow measured on the page | `query.render` `compare`, `overflow`     | 0.10.30         |
| A3.7   | playbooks (look after every visible change, fix overflow), eval scenarios, `FINISHED_PHASES += 'A3'`    | —                                        | 0.10.30         |

`deck.exportPdf` moved to A5 (Petr, 2026-10-10); `knownMissing.ts` holds no
A3 entry.

## How it fits together

- **Server** (`apps/server/src/services/render.ts`): picks slides from the
  live document, mints the render session's token (per person and
  document, `render/sessions.ts`; a background lane of its own for cards),
  queues one job (BullMQ `render` on media-redis) with presigned uploads,
  checks what comes back is a PNG. Cards: `services/deckThumbnails.ts`
  (scheduler on `onDeckStored` / `onComponentStored`),
  `services/deckThumbnailStore.ts` (a key per picture, swapped under a
  lock), `render/cardState.ts` (hash of the first slide's Yjs structure).
- **Worker** (`apps/render-worker/src/render.ts`): one job at a time, a warm
  page per render session, `?paint=off`; a compare opens a frozen page
  first (`?frozen=1`, the run's before-state handed in), closes it, then
  composes on the live page.
- **Page** (`apps/web/src/pages/DeckRender.tsx`; `ComponentRender.tsx` for
  masters): readiness signal, the job hooks, `renderLook.ts` composition,
  `textFit.ts` overflow measurement.
- **Access**: a deck render token is a share link of that deck
  (`findShareLink`); a master's token is admitted only by
  `resolveComponentAccess` and `resolveFolderContentAccess` for that master
  and its folder, while its requester can still read it.

## Numbers worth keeping

- Production VM 103: the worker container `cpus: 2`, `mem_limit: 1200m`.
  One heavy slide peaked at ~900 MiB before the fixes; captures cost
  ~0.4–1.3 s a slide on production after `?paint=off`.
- tools/list: 184,396 bytes of 184,500 after A3.5a; A3.5b–A3.6 grew it
  (see `toolListBudget.test.ts` for the dated note).

## Open, deliberately

- Folder token or font changes do not redraw cards of decks nobody has
  open (they store no deck snapshot); the editor's upload covers decks
  people open.
- The e2e suite on the Omarchy desktop must run on Playwright's own
  Chromium (SETUP.md → "Target crashed"); `canvas-sharpness-final` crashes
  only in parallel.
- No Redis ACL for the worker (needs a secret in the private overlay).

Next: A4 (style packs compiled into Narrative components, plan §7) — its
brand checker's fit rule takes `query.render`'s overflow measurement.
