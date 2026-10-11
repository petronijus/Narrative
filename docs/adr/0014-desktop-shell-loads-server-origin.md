# ADR 0014 — The desktop app is a shell that loads the server's origin; offline is a web-app feature

**Status**: Accepted (2026-10-11). Petr asked for an Electron desktop app
that also works offline (2026-10-10) and decided the open points on
2026-10-11: macOS builds are signed with an Apple Developer ID and update
themselves, choosing the presentation display is a web-app feature, and
updates are signed by a dedicated key held in 1Password. Built in phases
D0–D4 on branch `feat/desktop` ([`plans/desktop-app.md`](../plans/desktop-app.md));
D0, the shell, is specified in [`plans/desktop-d0-spec.md`](../plans/desktop-d0-spec.md).
**Scope**: `apps/desktop` (new), the desktop sign-in routes in `apps/server`,
the bridge contract in `packages/shared`, the thin desktop call sites in
`apps/web`, the update feed under `/desktop/` (Caddy) and its publishing
script.
**Related**: ADR 0005 (server-side session cookies), ADR 0007 (the CSP),
ADR 0008 (release and image tag discipline), ADR 0010 (commands are the
only writer).

## Context

- The desktop app must work offline: open, present and edit decks without a
  connection and sync once it is back (D1–D3).
- The editor already runs from one versioned bundle served by the server;
  since A3.1 (0.10.20) it reaches the API and the sync server through
  relative `/api` and `/ws` (`apps/web/src/lib/endpoints.ts`), so it works
  unchanged from whichever origin serves it.
- Yjs makes offline editing possible at all: edits made offline are CRDT
  updates that merge with everyone else's.
- Google refuses OAuth inside embedded user agents (`disallowed_useragent`),
  and an Electron window is one. Sign-in has to happen in the system
  browser.
- Sessions are an opaque HttpOnly cookie set by the server (ADR 0005); the
  shell must end up with that same cookie in its own storage.

## Decision

1. **The shell loads the configured server's origin** (production by
   default; a dev server or a custom URL for testing) in a persistent
   session partition per server. It does not bundle `apps/web/dist`.
2. **Offline work is built into the web app** (service worker for the app
   shell, Yjs persisted in IndexedDB, media cached by asset id), so the
   browser gets it too; the shell adds a persistent profile and native
   integration.
3. **One versioned bridge** (`window.narrativeDesktop`) with two roles, the
   main window and the presentation audience window. Its contract lives in
   `packages/shared`; the web app reaches it only through
   `apps/web/src/desktop/`. Every payload is validated in the main process
   and every sender is checked against its role.
4. **Sign-in runs in the system browser** and comes back as a one-time
   ticket: `/api/auth/start?client=desktop` carries an S256 challenge made
   by the shell, the callback issues an `ndt_` ticket valid for 60 s and
   bound to that challenge, and redirects to a custom-scheme URL that is a
   server constant (never taken from the request). The shell checks its own
   `state` nonce and redeems the ticket with a POST navigation in a hidden
   window of the same partition, so the server's `Set-Cookie` lands where
   the editor reads it. Tickets live in the API process's memory, like
   render tokens.
5. **Security baseline**: the OS sandbox is required (packaged builds
   refuse `--no-sandbox` and remote debugging), context isolation, no Node
   in any page, navigation pinned to the server origin, everything else
   opened in the system browser, permissions limited to what the editor
   uses, Electron fuses flipped (no `RunAsNode`, no Node CLI inspect
   arguments, cookie encryption on, app loaded only from the asar).
6. **Packaging and updates**: electron-builder; a generic update feed under
   `/desktop/` on the server, written only by the publishing script from a
   tagged, clean build. Every artefact carries an SSH signature (SSHSIG,
   Ed25519) made through the 1Password SSH agent with a dedicated key that
   never leaves 1Password; the shell verifies it before installing. macOS
   builds are Developer ID signed and notarized and update through
   Squirrel.Mac, whose code-signature check is a second gate there. Windows
   builds are unsigned, per-user NSIS installers built on Linux. Linux
   ships a deb and an AppImage.
7. **Native menus come from a model the web app owns**, whose items name
   actions of `apps/web/src/actions/catalog.ts`. An item that has a
   shortcut dispatches that chord through the editor's shortcut chain, so a
   menu item does exactly what its key does.
8. **Choosing the presentation display is a web-app feature** (the Window
   Management API: `getScreenDetails()`, `requestFullscreen({ screen })`),
   used by Chrome, Edge and the shell alike. The shell only places the
   audience window where the page cannot: on Hyprland through `hyprctl`.
9. **Device-local capabilities** (server choice, display choice, opened
   files, offline pinning later) are editor-only and sit in the parity
   allowlist with that reason; anything that changes a document still goes
   through a command.

## Consequences

- One bundle, one CSP, one auth model: a server release updates the editor
  in every shell, and no installed client has to stay compatible with old
  server versions beyond what a stale browser tab already needs.
- The app cannot start the editor offline until D1 adds the service worker;
  D0 is online only.
- Restarting the API process loses tickets in flight; the user signs in
  again.
- Losing the update signing key means existing installs can be updated
  only by a manual reinstall that carries the new public key. Approving each
  signature in 1Password is part of every release.
- macOS releases need Petr's Apple Developer Program membership, the
  Developer ID certificate on the MacBook and a notarization key; without
  them no macOS build ships, and Linux and Windows are unaffected.
- On Wayland compositors other than Hyprland the compositor may choose the
  audience display unless Chromium's screen-targeted fullscreen reaches the
  output (checked in D0 step 12); the editor then says so.
- Deb updates ask for the password (pkexec); the AppImage is not the Ubuntu
  target, because Ubuntu 26.04 blocks its user namespaces.
- Cookie encryption, once on, cannot be turned off for an existing profile.
- Asar integrity protects the signed macOS bundle; in the unsigned Windows
  build it only catches accidental corruption, and Linux has none.

## Alternatives considered

- **Bundling `apps/web/dist` into the app (`app://`)**: works offline from
  the first start, but needs a second auth model (cookies do not cross
  from `app://`), a second CSP and a compatibility contract between every
  server release and every installed client. Rejected.
- **Signing in inside the app window**: blocked by Google.
- **Redeeming the ticket with a JSON fetch from the main process, or
  setting the cookie with `session.cookies.set`**: the first does not put
  the server's cookie into the window's partition with its real attributes;
  the second copies a credential the main process should never hold.
- **A database table for tickets**: needed only once the API runs as more
  than one process.
- **Electron Forge**: no self-hosted Linux updates.
- **Trusting HTTPS and the feed's sha512**: the hash comes from the same
  host as the file, so a compromised VM or Cloudflare account would mean
  code execution on every client.
- **Reusing an existing key** (the desktop's SSH key, the nexusQ OTA key):
  couples unrelated systems — a leak of one signs updates of the other, and
  rotating one breaks the other.
- **Per-scope menu actions instead of chord dispatch**: menu and key could
  drift apart.

## Revisit when

- an Authenticode certificate is bought for Windows;
- the API runs as more than one process;
- Electron or Chromium can target a display for fullscreen on every Wayland
  compositor;
- electron-builder ships signed feed manifests as a stable feature.
