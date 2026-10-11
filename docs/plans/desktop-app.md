# Desktop app (Electron) with offline work

Status: **planned** 2026-10-10, on branch `feat/desktop` (worktree
`../Narrative-desktop`). Nothing built yet. The branch takes `main` in
often (`git merge main`) while A3 continues there, and goes back into `main`
phase by phase (see "How the branch lives"). Since A3.1 (0.10.20) the
production bundle reaches the server through relative `/api` and `/ws`
(`apps/web/src/lib/endpoints.ts`), which is exactly what a shell that loads
the server's origin needs.

## What Petr asked for

- A desktop app of Narrative, built on **Electron**.
- It also **works offline**: decks can be opened, presented and edited
  without a connection, and the edits reach the server once it is back.

## The shape in one paragraph

The desktop app is a thin Electron shell around the **same web editor the
browser loads from the server** — not a second, bundled copy of it. Offline
work is built into the web app itself (a service worker for the app shell,
Yjs documents persisted in IndexedDB, media cached by asset id), so it works
in the browser too, and the shell adds what only a native app can do: a
persistent profile that the OS does not evict, sign-in through the system
browser, native menus, `.pptx` file associations, presenting on a chosen
display and auto-update. Yjs is what makes offline editing feasible at all:
edits made offline are CRDT updates that merge with everyone else's on
reconnect, with no conflict dialog.

## Why the shell loads the server's origin (decision to confirm in ADR 0014)

Two ways to put the editor into Electron:

|                        | **A. Load `https://narrative.bastla.com`** (chosen)             | B. Bundle `apps/web/dist` into the app (`app://`)                                     |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Editor version         | always the server's; `versionGuard` keeps it current            | whatever the installed app shipped; drifts from the server until auto-update          |
| Protocol skew          | none beyond today's (stale tab)                                 | every server release must stay compatible with every installed client                 |
| Auth                   | the existing `narrative_session` cookie, same origin (ADR 0005) | cross-origin cookies from `app://` do not work; needs a second, token-based auth path |
| CSP (ADR 0007)         | unchanged                                                       | a second policy for the bundled origin                                                |
| Offline start          | needs a service worker that caches the app shell                | works out of the box                                                                  |
| Benefit to the browser | offline presenting/editing everywhere                           | none                                                                                  |

A costs one service worker; B costs a second auth model, a second CSP and a
compatibility contract between every server and every installed client. A
also keeps one bundle under the size budgets and one set of e2e specs.

## Constraints found in the code (2026-10-10)

- **Sign-in cannot happen inside the Electron window.** Google refuses OAuth
  in embedded browsers (`disallowed_useragent`). Login must open the system
  browser and hand the session back to the app (see D0).
- **Media URLs are resolved online.** `renderer/imageUrl.ts` fetches
  `/media/:id/url` per asset; fonts and video playback use short-lived
  presigned MinIO URLs. `state/mediaCache.ts` caches by URL with a 24 h TTL
  and its MEDIA-1 invariant already says: anything offline must be keyed by
  a stable id (assetId / storageKey), never by a rotating URL.
- **Deck ids are made on the server** (`services/decks.ts`, `nanoid(12)`),
  so creating a deck offline needs a client-proposed id (D3).
- **Hocuspocus drops writes from read-only connections.** A user whose role
  dropped to viewer while they were offline would lose their offline edits
  silently on reconnect; so would a user whose deck was deleted (the
  connection is refused). D2 must detect both and offer a copy.
- **Folder tokens and component masters are Yjs documents too**
  (`FolderDocProvider`, `componentDocCache`), so the same persistence covers
  them — a deck renders offline only with its folder doc and the masters it
  stamps.
- **`versionGuard` reloads on a new build.** With offline edits pending this
  is still right (the edits live in IndexedDB, not in memory), but the new
  bundle must load before it syncs, so that a server-side document migration
  (`dataMigrations.ts`) never meets a stale client.

## Phases

Each phase ships on its own and is useful without the next.

### D0 — the shell (online only)

- `apps/desktop`: a pnpm workspace package, Electron main + preload, built
  with `electron-builder` (Linux AppImage + deb, macOS dmg, Windows nsis).
  Version = the repo version (`just bump` covers it, ADR 0008).
- Window loads the configured server (production by default; dev and a
  custom URL selectable for testing) in a persistent session partition.
- Security baseline: `contextIsolation`, `sandbox`, no `nodeIntegration`;
  the preload exposes one small typed bridge (`window.narrativeDesktop`);
  navigation is pinned to the server's origin; `setWindowOpenHandler` sends
  every other URL to the system browser; permission requests are denied
  except clipboard and fullscreen.
- **Sign-in via the system browser**: the shell opens
  `/auth/start?client=desktop`; after the Google callback the server
  redirects to `narrative://auth/complete?ticket=…` with a one-time,
  short-lived ticket bound to a PKCE verifier the shell generated; the shell
  redeems it with `POST /auth/desktop/redeem` from inside its own session,
  which sets the ordinary `narrative_session` cookie. Server work: the two
  routes, the ticket table/cache, an allowed-scheme check on `returnTo`.
  Security review required.
- Native menu whose items name actions in `apps/web/src/actions/catalog.ts`
  (the existing rule for menus and shortcuts).
- Opening a `.pptx` (file association, drag onto the dock icon) imports it
  through the existing tus import (`state/importPptxViaTus.ts`).
- Presenting on a chosen display: the shell lists displays through the
  bridge; the present window opens fullscreen on that display.
- Auto-update via `electron-updater`, feed hosted by the server
  (`/desktop/…`, served by Caddy from the release artefacts).
- Tests: Playwright's Electron driver (`_electron.launch`) for the shell —
  boots, loads the editor, deep-link sign-in ticket path with a stubbed
  server, external links leave the app.

### D1 — offline reading and presenting

- **Service worker** (web app, same origin, registered for every client):
  precaches the versioned build (`dist/assets/*`, `index.html`), serves the
  app shell for navigations when offline, never caches API responses
  itself. Caddy serves `sw.js` with `Cache-Control: no-cache`; CSP gets
  `worker-src 'self'`. `versionGuard` and the SW agree on one version
  (`/version.json`).
- **Yjs persistence**: `y-indexeddb` next to every `HocuspocusProvider`,
  database name scoped by user id and document name (a shared machine never
  mixes two people's decks). Load from IndexedDB first, then sync.
- **"Available offline"** per deck (and per folder): downloads the deck doc,
  its folder doc, the component masters it stamps, every image variant the
  renderer uses, the fonts, and video posters; full videos optional (open
  decision). Media cache v2 keyed by `assetId:variant` / font id with no
  TTL for pinned decks; eviction only when unpinned.
- REST metadata the editor needs offline (deck list, deck summary with role,
  folder list, font list) cached as last-known values, shown read-only and
  marked as offline.
- An offline indicator in the editor chrome; actions that need the server
  (share, import, export, agent runs, upload) are disabled with a reason.
- In the browser, pinning asks `navigator.storage.persist()`; the Electron
  profile is persistent anyway.
- Tests: e2e with `context.setOffline(true)`: open a pinned deck offline,
  present it, images and fonts render (sampled pixels, like
  `renderer-visual.spec.ts`).

### D2 — offline editing of existing decks

- Edits offline go into the Y.Doc and IndexedDB as today's edits go into the
  provider; the slides panel shows "N changes not synced yet".
- On reconnect: check `/version.json` first (reload into the new bundle if
  needed), then connect; after sync verify the server holds the local state
  vector.
- **Lost-write detection**: the connection came back read-only, or was
  refused (deck deleted, access revoked) → keep the local document and offer
  "Save as a copy" (a new deck from the local state, through a command).
- Undo stays per session; offline edits are ordinary transactions for the
  UndoManager.
- Tests: two clients, one offline edits, the other online edits, reconnect →
  `listSlides()` converge (structural, not byte equality); demoted-while-
  offline → copy offered, nothing silently dropped.

### D3 — new decks and uploads offline

- Client-proposed deck ids: `POST /api/decks` accepts an id (nanoid(12)
  format, unique, checked against the caller); a deck created offline lives
  locally until its first sync creates the row and the document.
- Uploads made offline queue in IndexedDB as tus uploads and start on
  reconnect; the image object shows the local blob until the asset exists.
- Agent parity: creating with a given id is a property of `deck.create`, so
  the command gets the optional input too.

### D4 — PPTX offline (optional)

- Import/export run in the Electron main process using the server's PPTX
  code (`apps/server/src/pptx`), which is Node already. Needs the PPTX module
  importable without the server's database and storage; that is a refactor
  of its own and is decided after D3.

## Rules this plan keeps

- State = Yjs only: offline persistence is a Yjs provider, not a parallel
  store. Metadata caches hold only what REST already returns.
- Every user capability is a command: "available offline" and display
  choice are device-local and editor-only (an agent has no device) → listed
  in `packages/commands/src/parity/allowlist.ts` with that reason; a deck
  created with a client id goes through `deck.create`.
- Documents are written on the server only through the sync server — the
  desktop app is just another Hocuspocus client.
- All UI strings, menus and installer texts in English.

## Open decisions for Petr

1. **Code signing.** macOS without a Developer ID (99 USD/year) means a
   Gatekeeper warning and no notarisation; Windows without a certificate
   means a SmartScreen warning. Personal use only → unsigned is acceptable
   at first.
2. **Offline in the browser too**, or only in the desktop app? The plan
   builds it into the web app (it costs nothing extra); the question is
   whether the browser shows the "Available offline" control.
3. **Videos in pinned decks**: download whole (size) or posters only.
4. **Servers the app may connect to**: production only, or also dev/local
   (useful for testing the shell against `just dev`).

## How the branch lives

A3 (and whatever follows it) keeps committing and releasing on `main` in
the main worktree; the desktop work runs beside it in `../Narrative-desktop`.

- **`main` comes in often**: `git merge main` before touching a file that
  `main` also changes, and at least at the start of every session. Merge,
  never rebase (the merge commits record which `main` each step was tested
  against; rebasing would rewrite tested history).
- **Shared files are touched thinly.** New behaviour lives in new files
  (`apps/desktop/**`, `apps/server/src/auth/desktop*.ts`,
  `apps/web/src/offline/**`); an existing file gets a one-line call site, not
  a rewrite. That keeps the merges from `main` small.
- **Back into `main` per phase**: when a phase is done (`just check`, its
  e2e specs, the reviews), the branch is merged into `main` while the main
  worktree is clean — never over another session's uncommitted files.
  Releases and deploys happen only from `main`, as today.
- Each worktree runs its own `just dev` only one at a time: both use the
  same ports and the same docker services.

## Work order

The D0 implementation spec (versions, layout, sign-in flow, tests, steps)
is `docs/plans/desktop-d0-spec.md`, revision 2 after security, invariants
and platform reviews (2026-10-11).

1. ADR 0014 (desktop shell loads the server origin; offline is a web-app
   feature) and Petr's answers to the open decisions.
2. D0; security review of the sign-in ticket flow.
3. D1, then D2 — each with its e2e specs and `e2e-affected.py` areas
   (`apps/desktop/**` gets its own area).
