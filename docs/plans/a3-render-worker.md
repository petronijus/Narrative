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
                  │  per job: a render token,                │ Chromium, on demand
                  │  one presigned PUT per slide              ▼
                  │                       https://<domain>/deck/:id/render?slide=…&share_token=nrr_…
                  │                       (page origin: the public domain; every request,
                  │                        the /ws socket included, routed to http://caddy)
                  └── reads the PNGs ── MinIO ◀── PUT /storage/… (through Caddy) ── worker
```

- **Render page** (`/deck/:id/render?slide=<id|index>`, web app): the deck's
  providers (fonts, folder doc, tokens, the live slide document) and the
  main canvas at 1920×1080, no editor chrome. It reports on
  `window.__narrativeRender` once the slide is settled — every object
  mounted, every tracked load (media URLs, textures, folder and bundled
  fonts) done, every HTMLText raster drawn — with the count of this slide's
  loads that failed and the font families that failed for the page; or an
  error with its reason (access refused, empty deck, slide not
  found, font list unreadable, inputs never came, not settled). The worker
  screenshots the canvas. Contact sheets and crops are composed in the page
  (a 2D canvas), so the worker needs no image library.
- **Live document**: the page connects to Hocuspocus like any client, so a
  render right after a command already shows it.
- **Render token** `nrr_…` (`apps/server/src/auth/renderTokens.ts`): 256
  bits, minted per job by the server, held in its memory as a SHA-256 until
  the job's deadline plus a minute and revoked when the job ends (the page's
  connections close then), viewer of one deck for as long as the requester
  can still read it. It is a share link:
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
  `chromium-headless-shell`; uploads each PNG through the presigned PUT the
  job carries for it (through Caddy's `/storage`; the server chose the key,
  `decks/<id>/exports/<job>/slide-N.png`, which the export sweep removes
  after a day) and returns the slides' sizes and failures, no keys.

## Memory

1.98 GB available on VM 103; the renderer must never starve the server or
Postgres:

- Chromium **starts with the first job and quits after 60 s idle** — zero
  cost between agent sessions, warm during one;
- `chromium-headless-shell` (no full browser UI), one page at a time
  (worker concurrency 1), Chromium's renderer-process limit 1;
- a compose **memory limit** (`mem_limit: 900m`, `memswap_limit: 900m`),
  so the worst case is a failed render, not an OOM-killed server.

Measured 2026-10-10 on the production image (headless shell 148,
SwiftShader), with the compose hardening on, against a 50-slide deck of
incompressible 800×600 photos shown at 1200×900: 107 MiB idle, 544 MiB peak
for 20 slides at 1920×1080 (flat from the third slide on — no growth across
slides), 1.8 s per slide with imgproxy resizing every picture for the first
time. At 2× (3840×2160) the renderer was OOM-killed at 773 MiB within five
slides — SwiftShader's 4K framebuffers — and a 50-slide 2× job took the
whole container down: **renders are 1920×1080 only** (decided the same
day; the slide's own size, more than the 1568 px a model reads), and a
request renders **at most 20 slides** (a job's work budget is 20 s + 2.5 s
per slide, so a one-slide request waiting behind the largest job still
answers within its 95 s, under Cloudflare's 100 s).

## Isolation

The page renders other people's content (their text, fonts and pictures),
so a Chromium renderer bug must not become code running with the worker's
reach (security review, 2026-10-10):

- **Chromium's sandbox is on** (`chromiumSandbox: true`; Playwright's
  default is off, `--no-sandbox`): renderers run in their own user and PID
  namespaces under Chromium's seccomp-bpf filter. Docker's default seccomp
  profile forbids creating user namespaces, so the container runs
  `seccomp=unconfined` — Chromium filters the processes that handle the
  content itself, more tightly than Docker's profile; the other choice, a
  copy of Docker's default profile with user namespaces allowed, would be a
  frozen copy of upstream configuration (not done without Petr's approval
  and an update path). Verified in the container: renderers in another user
  and PID namespace, no `--no-sandbox`. Verified on VM 103 (Ubuntu 24.04,
  kernel 6.8, Docker 29.4, `kernel.apparmor_restrict_unprivileged_userns=1`):
  a non-root process in a container with these settings creates a user
  namespace (`unshare -U -r`), with Docker's default seccomp it cannot.
- **Required**: `RENDER_REQUIRE_SANDBOX=1` makes the worker check after every
  launch that renderers are sandboxed (`renderersSandboxed`, /proc) and
  refuse to render otherwise.
- **No credentials**: the worker uploads each PNG through a presigned PUT
  the server signs for exactly that object (through Caddy's `/storage`) —
  its type and `Cache-Control: private, no-store` signed too, so the upload
  cannot store anything else and a private slide stays out of shared caches
  (Cloudflare caches `.png`) — and Chromium's environment holds none of the
  worker's variables. The image carries no storage client.
- **Its own internal network** (`narrative_render`, `internal: true`):
  Caddy and the media Redis only, and no route out — not to the internet,
  not to the LAN behind the VM (checked: a container on such a network
  reaches its peers, nothing else). Inside the browser, every request off
  the app origin is aborted and every other WebSocket closed (`routing.ts`);
  the network catches what that routing cannot see (WebRTC, a compromised
  renderer). The page cannot set the client-IP headers the rate limits key
  on.
- **Container**: non-root, `cap_drop: ALL`, `no-new-privileges`, read-only
  root with a 512 MB tmpfs `/tmp`, `pids_limit: 512`, `cpus: 2`.
- **Fair share** (the worker runs one job at a time, for everyone): two
  renders in flight per person (eight for BYPASS_AUTH's dev identity, which
  the e2e suite shares), twenty jobs waiting at most; a job's BullMQ
  priority is the number of slides its caller has in flight with it, so
  one slide asked for goes ahead of twenty someone else has queued; two
  clocks per job, both enforced by the worker (it closes the page and
  aborts the upload): the caller's wait (95 s from the request, queueing
  included) and the job's work budget from its start (20 s + 2.5 s per
  slide), so no job holds the worker longer than its size warrants; a job
  that comes up after its caller stopped waiting is dropped before it
  starts (or wakes) Chromium; the render token lives until the deadline
  plus a minute; a render token's
  WebSocket refusals do not count against the failed-login limit, and its
  requests have their own rate-limit buckets (per requester, not the
  worker's one address). Jobs a previous server process left waiting are
  dropped at start (their tokens died with it; only jobs older than the
  process, so a request already being served keeps its own). With the media
  Redis down, a request hears "unavailable" within seconds (every Redis call
  is bounded: BullMQ waits for a first connection forever), and shutdown
  does not hang on it either.
- **The PNG route** refuses a request the web app did not make
  (`isFromWebApp`): a sibling subdomain's `<img>` carries the `SameSite=Lax`
  cookie, but no allowed `Origin`.
- Not done, as defence in depth beyond the above: a Redis ACL user for the
  worker limited to the render queue (the media Redis has no auth; it needs
  a new secret in the private overlay).

## Steps

Each step: code + tests, review, `just check`, the e2e rows it needs,
release and deploy.

1. **A3.1 Render page and access.** `/deck/:id/render?slide=` route (no
   `GlobalChrome`), the readiness signal, the `nrr_` token on WS + the REST
   reads, same-origin `/api` and `/ws` in the production build. e2e: the
   render page paints a seeded slide and reports ready; a token for deck A
   cannot read deck B (writes: unit tests — the e2e stack's BYPASS_AUTH
   makes every request a signed-in user).
2. **A3.2 render-worker** and **A3.3 PNG export**, shipped together (the
   worker alone had nothing to test it by): the app, its Dockerfile
   (headless shell), the compose service with the memory limit, dev
   (`pnpm dev` runs it with the system Chrome where Playwright has no
   Chromium), the queue contract in `packages/shared`, the server's
   enqueue and wait, the presigned uploads and the sweep, measured memory;
   `deck.exportPng` (one slide, several or a deck of up to 20; `delivery`
   url or base64 like `deck.exportPptx`), `GET /decks/:id/export.png`,
   "Export as PNG" in a slide's menu.
3. **A3.4 `query.render`.** MCP image content (a new branch in
   `mcp/results.ts`), single slide downscaled to ≈ 1568 px, contact sheet,
   region crop; tools/list budget.
4. **A3.5 Server thumbnails.** `deck.refreshThumbnail`,
   `component.refreshThumbnail`; after a server-side or agent write to a
   deck with no editor connected, a debounced thumbnail job (the editor's
   upload stays for open decks).
5. **A3.6 Before/after and text-fit.** The run records
   `encodeStateAsUpdate` at its first write (beside its `UndoManager`, same
   lifetime); the render page can render a fixed state; `compare: 'before'`.
   The page reports each text box's measured height; `query.render`
   returns overflowing boxes.
6. **A3.7 Close.** Playbooks: look after every visible change; eval
   scenarios; `FINISHED_PHASES += 'A3'`; handoff note.

## Where we stand

2026-10-10: plan written. **A3.1 released in 0.10.20** (deployed the same
day; built, then reworked after the code and security reviews):

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

Deploy of 0.10.20 checked on production: `/version.json` serves
`v0.10.20+c01cccf`, `deploy.sh` reloaded the Caddyfile (`Referrer-Policy:
strict-origin` served), Caddy's access log writes `share_token=REDACTED`,
the `/ws` upgrade answers 101, and an anonymous media read reaches the
service (404 for an unknown asset, no longer 401). Left for Petr: open the
editor (it now talks to `/api` and `/ws` relatively) and a share link
without signing in — pictures and folder fonts must show.

Full e2e at release: 189 passed; one known flake (the
`component-promote-stamp` cleanup `DELETE /folders/:id` timeout,
dev-speed.md), green alone. `just size`: only the Tiptap chunk over, the
same 132.82 kB as on 0.10.19 (measured on a worktree of HEAD).

**A3.2 + A3.3 done** (2026-10-10, released in 0.10.21), reworked after the
code, security and parity reviews of the same day (the isolation and the
fair share above, 1920×1080 only, 20 slides a request):

- `apps/render-worker`: BullMQ consumer of `render` (concurrency 1,
  `maxStalledCount: 0`); `BrowserHolder` starts Chromium for the first job
  (the start bounded by the job's deadline) and quits it after
  `RENDER_IDLE_MS` (60 s), and after any browser-side failure;
  `RENDER_CHROME_EXECUTABLE` when set, else Playwright's headless shell, else
  a system Chrome / Chromium; WebGL always through SwiftShader. One fresh
  browser context per job, closed when its time is up; the slides of a job
  are shown in turn in one page (`window.__narrativeRenderShow`, no reload)
  and screenshotted at `ready`; `failedLoads` per slide (pictures; fonts
  load once for the page and come back as the job's `failedFonts`).
- Routing (`routing.ts`): with `RENDER_UPSTREAM`, the app origin and its
  `/ws` go to Caddy with the original `Host` (through `node:http`: Node's
  `fetch` drops a `Host` header), no `accept-encoding`, no client-IP headers,
  no `set-cookie` back, 64 MB per response; everything else is blocked.
  Tested with a real Chromium against a local stand-in for Caddy
  (`routing.browser.test.ts`).
- Server: `services/render.ts` (reader check, slides from the live
  document, a render token and presigned uploads per job, the fair share,
  worker failures mapped: slide gone → 404, refused while still a reader →
  503, gone → 403, renderer → 503, deadline → 504), `render/queue.ts` (no
  offline queue on the producer — Redis down is a fast 503; typed timeout;
  error listeners; stale jobs dropped at start; closed at shutdown),
  `routes/pngExport.ts` (streams the stored PNG; its own rate limit, 20 a
  minute; only the web app's requests). `deck.exportPng` (viewer; ≤ 20
  slides; ≤ 8 MB inline; `failedLoads` per slide, `failedFonts` per call) —
  tools/list budget 181,000 → 182,500.
- Editor: "Export as PNG" in a slide's context menu and its "⋯" menu
  (`slide.exportPng` in the action catalog); CORS exposes
  `Content-Disposition`.
- Measured, dev (Vite, unbundled): a one-slide job 1.6–2.4 s, ≈ 0.15 s per
  further simple slide; with fresh photos 1.8 s per slide; memory above.
- For A3.4: `query.render` wants well under a second per look; keep a warm
  page per deck between jobs (a render session, so the token outlives one
  job), and measure.
- Tests: worker unit (routing, headers, forwarding with `Host`, signed
  uploads and their abort, late jobs, the sandbox check against a fake
  /proc, page URL, token masking) and the real-Chromium routing test; server
  unit (`services/render.test.ts`: slide choice, access, the job's token /
  uploads / deadline / work budget, the in-flight cap and the priority,
  failure mapping, deliveries, limits; `render/queue.test.ts`: Redis down →
  "unavailable" in seconds and a shutdown that does not hang; the PUT
  presign's signed headers; `isFromWebApp`; render-token rate-limit buckets;
  the WebSocket throttle sparing render tokens); web unit (font faces
  failing apart from loads, cleared by a retry); e2e `render-export.spec.ts`
  (links and inline with pixels, the in-place-switched slide's pixels, an
  edit visible in the next render, an unknown slide refused, the editor's
  menu download); eval scenario `export-png-slide` (live-only).

Verified before the release: `just check`; the full e2e (195 passed, 15
opt-in skipped); the eval scenario `export-png-slide` live (pass, $0.08)
and the full eval (52/52, $6.75); the production image with the compose hardening against
the dev stack (sandbox required and active, the stored PNG `private,
no-store`); an internal Docker network reaching its peers and nothing else;
on VM 103, a user namespace created under these container settings.

**After 0.10.21** (2026-10-11, Petr's first export on production): the
slide came out in the wrong fonts, and took 11.6 s.

- Fonts: not the worker's — the editor's. HTMLText draws through an SVG that
  sees only the faces Pixi embeds from its cache at raster time. Text drawn
  before its folder font loaded was never redrawn (FolderFontLoader sits
  above the canvas, so its canvas context was always null), and run-level
  families with a space were never embedded (Pixi's scan of the run markup
  stops at the space). A machine with the fonts installed hid both. Fixed
  with font-change announcements every SceneGraph listens to
  (`renderer/fontChanges.ts`) and the box's and runs' families passed to
  Pixi by name (`htmlTextFontFamilies`); e2e with a font whose letters are
  solid blocks, so no fallback face can pass. The review of the fix (same
  night) added: faces embedded from the bytes the loader downloaded, not
  re-fetched by Pixi from presigned URLs that die after an hour;
  announcements delivered once per family as tracked render work; table
  cells and component leaves redrawn (every HTMLText whose families include
  the one that changed); and family names kept out of Pixi's unescaped SVG
  `<style>` unless they are plain (`isEmbeddableFamilyName`) — a name like
  `X</style><img …>` could otherwise inject markup, pre-existing.
- Speed: the editor no longer asks the worker. "Export as PNG" renders in
  the browser, in a hidden same-origin frame running this render page
  (`state/browserSlideExport.ts`, `__narrativeRenderCapture`): exact, the
  user's caches and session, edits of a moment ago included (the page waits
  until its copy of the deck covers the editor's state vector). Measured in
  dev: 1.6 s cold, 0.36 s warm. The worker stays the agents' way, and the
  fallback when the browser cannot render.
- The worker's 11.6 s per job is the app loading in a fresh page each time:
  A3.4 keeps a warm page per deck.

Next: A3.4 `query.render` (the agent sees a slide), with a warm page per
deck in the worker.
