# Narrative desktop — Tauri prototype

A prototype that answers one question: can Narrative's desktop shell be a
[Tauri](https://tauri.app) app instead of Electron (`apps/desktop`, ADR 0015)?

Tauri draws with the **system webview** — WebKit (WKWebView) on macOS,
WebKitGTK on Linux, WebView2 (Chromium) on Windows — instead of bundling a
Chromium. That makes the app far smaller, but the editor then runs in WebKit
on two of the three platforms. The WebKit e2e run (`just e2e-webkit`,
2026-10-16) measured that part: once the specs' timing races were fixed, no
editor bug remains that only WebKit shows
(`docs/plans/desktop-tauri-evaluation.md`).

## What it does

The same shape as the Electron shell, so the two compare like for like:

- one window that loads the editor from a Narrative server (`--server=dev`,
  `prod` or an https origin; dev by default);
- `window.narrativeDesktop`, bridge version 1 (`packages/shared/src/desktop.ts`):
  `info()` and `signIn()` work, the rest is inert (no native menu, no opened
  files, the page places its own presentation window);
- the system-browser sign-in of the Electron shell (`routes/desktopAuth.ts`):
  PKCE verifier and state, the ticket back through `narrative-dev://` /
  `narrative://auth/complete`, the redeem posted by the shell itself (no
  `Origin`, `X-Narrative-Desktop: 1`) and its session cookie put into the
  webview's cookie store (Tauri 2's `set_cookie`, here 2.12);
- navigation kept on the server; other web links open in the browser.

Not here: the native menu, opened `.pptx` files, presentation placement on
Hyprland, signed self-updates and the update feed, the macOS and Windows
packages. Those are what a port would add.

## Run it

A **debug** build loads the local dev stack, a **release** build production;
`--server=dev|prod|<https origin>` (or `NARRATIVE_SERVER`) overrides either.

### Linux

Prerequisites: Rust (stable), `webkit2gtk-4.1`, `libsoup3`, `gtk3`, `librsvg`,
`openssl` — on Arch `pacman -S webkit2gtk-4.1 libsoup3`, on Ubuntu
`apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev librsvg2-dev`.

```bash
just dev                      # the dev stack
just desktop-tauri            # the app against it (a debug build)
just desktop-tauri-dist       # deb, rpm, AppImage in src-tauri/target/release/bundle/
cd apps/desktop-tauri/src-tauri && cargo test
```

On NVIDIA under Wayland the app sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` for
itself: WebKitGTK's DMA-BUF renderer takes the window down there.

### macOS (the MacBook)

Prerequisites: Xcode Command Line Tools and Rust (`rustup`, from rustup.rs).
macOS draws with the system WKWebView — the engine this prototype is mostly
about.

```bash
git switch feat/desktop && pnpm install
just desktop-tauri-dist       # src-tauri/target/release/bundle/macos/Narrative.app (+ dmg/)
open apps/desktop-tauri/src-tauri/target/release/bundle/macos/Narrative.app
```

The bundle loads production and registers `narrative://` for the sign-in
(an unbundled `cargo run` cannot receive it on macOS: schemes come from the
bundle's Info.plist). It is unsigned; built on this Mac it opens without a
Gatekeeper prompt. To try it against the dev stack instead:
`open …/Narrative.app --args --server=dev` (that sign-in uses BYPASS_AUTH).

What to try: sign in (Google opens in the browser, the app comes forward
signed in), open a deck, edit text, draw a path, use a table's handles,
present, cut and paste. Compare the feel with the browser.

The sign-in's deep link is registered at start on Linux; the second launch
the browser makes hands the link to the running app (single-instance plugin)
and exits.

## Measuring it (the perf harness)

`just perf <ids…> --shell tauri` runs the perf benches (`apps/web/e2e/perf`,
`packages/perf/README.md`) in this window instead of a Playwright browser:
it builds a **debug** shell with the `perf-driver` feature
(`cargo build --features perf-driver`), serves the side's web build as
`just perf` does, and starts the app on it (`--server=http://localhost:<port>`
— a debug build takes a loopback http origin, a release build only https).
Playwright still seeds the scene through the command API; the page is driven
through `src/perf_driver.rs`:

- scripts in the page: an initialization script connects each page to a
  WebSocket of the driver on 127.0.0.1 and evaluates what it is sent
  (`apps/web/e2e/perf/lib/tauriPage.ts`, Playwright's `evaluate`);
- native input: keys, mouse and wheel arrive on the app's stdin and become
  NSEvents sent through the window, so they cross WebKit's UI process as a
  person's input does (trusted events, system timestamps);
- the window's size and position, navigation, and — a diagnostic —
  WebKit's device scale (`--device-scale 1` for a like-for-like comparison
  with a 1× Playwright page; the window's own scale is the screen's).

The feature is off by default, refuses to compile into a release build, and
does nothing unless `NARRATIVE_PERF_DRIVER_PORT` is set; a driven instance
skips the single-instance hand-over. macOS only so far (the input is
AppKit's). The window must stay unoccluded while it runs: WebKit stops
drawing a covered window, so the run measures nothing.

## Electron vs Tauri

The measured comparison is in `docs/plans/desktop-tauri-evaluation.md`.
