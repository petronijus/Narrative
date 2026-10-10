# A3 — render worker: the server can see a slide

Execution plan for phase A3 of [`agentic-layer.md`](./agentic-layer.md) §4.6
and §10. Written 2026-10-10, at v0.10.19.

## Goal

Today only a browser with the deck open can turn a slide into a picture.
A3 gives the server that ability, through the real renderer:

- **the agent sees what it built** — `query.render` returns slides as MCP
  image content (one slide, a contact sheet, a crop, before/after), so the
  playbooks can make it look after every visible change (decision 8,
  2026-09-26);
- **PNG export** of a slide or a deck (`deck.exportPng`);
- **thumbnails for decks nobody has open** — an agent's or an import's
  changes no longer leave a stale or missing card on the folder page
  (`deck.refreshThumbnail`, `component.refreshThumbnail`);
- **text-fit measurement** — each text box's laid-out height against its
  box, measured with the real fonts (the input A4's brand checker needs).

Done when the A3 part of `knownMissing.ts` is empty (except what Petr moved
out, below) and `A3` is in `FINISHED_PHASES`.

## Decided (Petr, 2026-10-10)

- **No more RAM for VM 103.** Measured that day: 927 MB of 2.9 GB in use,
  1.98 GB available (the rest is page cache); every container together
  ≈ 450 MB. The renderer must fit beside them (see "Memory" below).
- **No PDF export in A3.** `deck.exportPdf` moves to a later phase
  (`knownMissing.ts`, phase `A5`, with the reason).
- **Release per step**, as in A2 and folder sharing.

## Why the real renderer, in a real browser

Text fidelity depends on the browser's text shaping and on the folder
fonts, and 9 of the 10 0.9.x defects appeared only under the production CSP
(plan §4.6). So the worker drives headless Chromium on the real web bundle,
served by the real Caddy with the real CSP — never a second renderer.

## Architecture

```
MCP / route ──▶ server ──BullMQ "render" (media-redis)──▶ render-worker
                  ▲  mints a render token                   │ Chromium, on demand
                  │  result: MinIO key                      ▼
                  └──── MinIO ◀── PNG ── https://<domain>/deck/:id/render?slide=…&share_token=nrr_…
                                         (page origin: the public domain; every request,
                                          the /ws socket included, routed to http://caddy)
```

- **Render page** (`/deck/:id/render?slide=<id|index>`, web app): the deck's
  providers (fonts, folder doc, tokens, the live slide document) and the
  main canvas at 1920×1080, no editor chrome. It reports on
  `window.__narrativeRender` once the slide is settled — every object
  mounted, every tracked load (media URLs, textures, folder and bundled
  fonts) done, every HTMLText raster drawn — with the count of loads that
  failed; or an error with its reason (access refused, empty deck, slide not
  found, font list unreadable, inputs never came, not settled). The worker
  screenshots the canvas. Contact sheets and crops are composed in the page
  (a 2D canvas), so the worker needs no image library.
- **Live document**: the page connects to Hocuspocus like any client, so a
  render right after a command already shows it.
- **Render token** `nrr_…` (`apps/server/src/auth/renderTokens.ts`): 256
  bits, minted per job by the server, held in its memory as a SHA-256 for 5
  minutes (the page's connections close at expiry), viewer of one deck for
  as long as the requester can still read it. It is a share link:
  `findShareLink` resolves it, so it reaches exactly what a share-link
  visitor reaches — the deck and folder documents, `GET /decks/:id`, and the
  media and font reads (`shareReadPreHandler`) — read-only. The API and the
  sync server run in one process, which is the only one that mints and
  checks them; more processes would need a shared store.
- **Where the page runs** (decided 2026-10-10, after the A3.1 review): on
  the public origin, `https://<domain>`, not on `http://caddy`. The signed
  media and font URLs the server hands out are absolute
  (`MINIO_PUBLIC_URL`, `IMGPROXY_ENDPOINT`, the host part of a SigV4
  signature), so a page on another origin would have them blocked by the
  CSP. The worker keeps the real origin, CSP and cookies and only changes
  the transport: Playwright's request and WebSocket routing send every
  request to Caddy inside the compose network with the original `Host`, so
  nothing travels out through Cloudflare and back.
- **Same-origin bundle**: the production build no longer bakes
  `https://<domain>/api` and `wss://<domain>/ws`; the app resolves `/api`
  and `/ws` against the page (`apps/web/src/lib/endpoints.ts`). The web
  image names no domain.
- **render-worker** (`apps/render-worker`): BullMQ consumer of queue
  `render` on media-redis, like the video worker; Playwright with
  `chromium-headless-shell`; uploads results to MinIO under
  `decks/<id>/renders/<nanoid>/…` (swept like PPTX exports) and returns the
  keys.

## Memory

1.98 GB available on VM 103; the renderer must never starve the server or
Postgres:

- Chromium **starts with the first job and quits after 60 s idle** — zero
  cost between agent sessions, warm during one;
- `chromium-headless-shell` (no full browser UI), one page at a time
  (worker concurrency 1), Chromium's renderer-process limit 1;
- a compose **memory limit** on the container (≈ 700 MB; measured in
  A3.2 and set from the measurement), so the worst case is a failed
  render, not an OOM-killed server;
- measured with `docker stats` during a render of the largest production
  deck before the step ships.

## Steps

Each step: code + tests, review, `just check`, the e2e rows it needs,
release and deploy.

1. **A3.1 Render page and access.** `/deck/:id/render?slide=` route (no
   `GlobalChrome`), the readiness signal, the `nrr_` token on WS + the REST
   reads, same-origin `/api` and `/ws` in the production build. e2e: the
   render page paints a seeded slide and reports ready; a token for deck A
   cannot read deck B (writes: unit tests — the e2e stack's BYPASS_AUTH
   makes every request a signed-in user).
2. **A3.2 render-worker.** The app, its Dockerfile (Playwright base, headless
   shell), compose service with the memory limit, dev (`pnpm dev` runs it
   with the system Chrome where Playwright has no Chromium), the queue
   contract in `packages/shared`, the server's enqueue + wait, MinIO
   upload + sweep. Measured memory.
3. **A3.3 PNG export.** `deck.exportPng` (one slide or all, `delivery` url
   or base64 like `deck.exportPptx`), the route, an editor menu item.
4. **A3.4 `query.render`.** MCP image content (a new branch in
   `mcp/results.ts`), single slide downscaled to ≈ 1568 px, contact sheet,
   region crop; tools/list budget.
5. **A3.5 Server thumbnails.** `deck.refreshThumbnail`,
   `component.refreshThumbnail`; after a server-side or agent write to a
   deck with no editor connected, a debounced thumbnail job (the editor's
   upload stays for open decks).
6. **A3.6 Before/after and text-fit.** The run records
   `encodeStateAsUpdate` at its first write (beside its `UndoManager`, same
   lifetime); the render page can render a fixed state; `compare: 'before'`.
   The page reports each text box's measured height; `query.render`
   returns overflowing boxes.
7. **A3.7 Close.** Playbooks: look after every visible change; eval
   scenarios; `FINISHED_PHASES += 'A3'`; handoff note.

## Where we stand

2026-10-10: plan written. **A3.1 built** (unreleased), then reworked after
the code and security reviews of the same day:

- The production bundle uses relative `/api` and `/ws`
  (`apps/web/src/lib/endpoints.ts`); `build-push.sh` bakes no domain; the
  unused `VITE_IMGPROXY_URL` is gone from the build and the env examples.
- **Share links now reach the media and font reads.** `authPreHandler`
  answered 401 before any route read `share_token`, and the client never
  sent it, so an anonymous share-link visitor saw no pictures and no folder
  fonts in production (the e2e stack's BYPASS_AUTH hid it). New
  `shareReadPreHandler` (no credential → anonymous, a bad one → 401, a PAT → 403) on `GET /api/media/:id/url`, `/video-info`, `/font-url`,
  `/api/folders/:id/fonts`, `/api/decks/:id/fonts`; the folder font reads
  take a share token (`requireFolderContentReader`); the client appends the
  page's `share_token` (`lib/shareToken.ts`).
- Render tokens (`auth/renderTokens.ts`) as described above; also: a share
  link id is never drawn in a credential's shape; a share connection is
  named `share:<hash prefix>`, never by characters of its token.
- URLs with credentials are masked everywhere they were logged: Fastify's
  request log and 404, Sentry (`share_token=` values and keys), and Caddy's
  access log (URI and Referer, a `format filter`); `Referrer-Policy:
strict-origin` keeps a share-link page's URL out of same-origin Referers.
- The render page (`pages/DeckRender.tsx`) reads the target slide from the
  document itself (no transient "slide not found"), does not seed an empty
  deck, reports `access-refused`, `empty-deck`, `fonts-unavailable`,
  `not-ready` (inputs never came within 60 s, listed) and `not-settled`, and
  counts failed loads in `ready`. It hides from awareness only when opened
  with a render token. `SlideDocProvider`: `hydrate`, `presence`, `synced`
  (only on a real sync), `refused`.
- `renderer/renderWork.ts` (the bundled Inter is tracked too, failures
  counted) and `renderer/settleScene.ts` (deadline on every wait, abortable,
  reads the expected ids live).
- Dev only: `POST /dev/render-token` (BYPASS_AUTH) lets the e2e suite open
  the page with a real render token.
- Tests: e2e `render-page.spec.ts` — picture, text and folder font painted
  at `ready`; `?slide=` by id / index / unknown; the worker's way in (render
  token: paints, never a collaborator); another deck's token refused —
  20/20 in four repeats. Unit tests for `shareReadPreHandler` (real identity
  resolution, no bypass), the share-token font path, render tokens
  (requester re-check, expiry closes connections), the log serializer and
  404, Sentry masking, `settleScene` (fake scene and rAF), render work,
  endpoints, the slide choice. Caddy's filter checked against a running
  Caddy 2.11.
- `deck.exportPdf` moved to phase A5 in `knownMissing.ts`.

Next: full e2e, release (the Caddy config changes with it), check on
production that a share link shows its pictures and fonts; then A3.2 (the
worker).
