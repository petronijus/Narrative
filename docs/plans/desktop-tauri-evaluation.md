# Desktop: Tauri instead of Electron? — evaluation

**Status**: measured 2026-10-16 on the Omarchy desktop (Linux, Hyprland on
Wayland, NVIDIA RTX 5090), branch `feat/desktop` at main 0.14.0. Decision open
(Petr).

The desktop app (ADR 0015, `apps/desktop`) is an Electron shell that loads the
editor from a Narrative server. Tauri would draw the same editor with the
**system webview** — WKWebView on macOS, WebKitGTK on Linux, WebView2
(Chromium) on Windows — instead of a bundled Chromium. Two questions: does the
editor work in WebKit, and what does Tauri buy?

## 1. The editor in WebKit

`just e2e-webkit` runs the e2e suite in Playwright's WebKit (Linux, in
Playwright's image) against the dev stack.

| Result             | Count | What                                                                                                                                                                                                                                         |
| ------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| passed             | 204   | renderer (Pixi/WebGL), sync (Yjs over WebSockets), present, sharing, tokens, fonts, components, export, PPTX, agents                                                                                                                         |
| skipped            | 15    | as in Chromium                                                                                                                                                                                                                               |
| test-only failures | 9     | 6: WebKit logs `WebSocket is closed before the connection is established` when a socket closes before it opened, which the specs' clean-console gate rejects (the features worked); 3: a downloaded file's spaces become `_` (export worked) |
| **real failures**  | 6     | below                                                                                                                                                                                                                                        |

The six "real" failures of the first run, traced (2026-10-16):

1. Rectangle → path on double-click, 2. rotated line end handles: the specs
   clicked before the editor had the API-created object in its scene; WebKit
   mounts it a frame or two later. Fixed in the specs (wait for the scene
   graph), not the editor.
2. The add-column handle: the spec read the handle's position before it had
   moved to the wider table (0.3 s in WebKit, 0.15 s in Chromium). Fixed in
   the spec.
3. Inline text live update, 5. edit overlay alignment: fixed waits too short
   under load; the text and the overlay are right (−0.1 px). Fixed in the specs
   (poll for the rendered state).
4. Mod+X: the cut shortcut exists only on this branch (the desktop menu), and
   the run went against main's dev stack, which has no Mod+X at all — it failed
   in Chromium the same way.

One difference stays open: after a layer reorder (`[`), Playwright's WebKit
applies the change to the canvas ~0.8 s after the keypress where Chromium
takes one frame — the main thread is busy in between (requestAnimationFrame
itself runs at 60 Hz there). It may be the container (no GPU) or real; feel
it on the Mac. A full WebKit run in its container is also less stable under
six workers than Chromium's (different specs time out each run, all pass
alone).

After those and the noise below were fixed, **no editor bug remains that only
WebKit shows** in the e2e suite. Noise handled in the specs: WebKit's console
error for a socket closed while connecting (`e2e/fixtures/consoleNoise.ts`),
and the underscores Playwright's WebKit reports in a download's name.

Caveat: Playwright's WebKit on Linux is close to, not the same as, macOS's
WKWebView (usually newer) or a distribution's WebKitGTK (often older).

## 2. The prototype

`apps/desktop-tauri` (Tauri 2.12): one window loading the server, bridge
version 1 with `info()` and `signIn()`, the system-browser sign-in with the
server's PKCE ticket and deep link unchanged (the shell posts the redeem and
puts the session cookie into the webview with `set_cookie`), navigation kept
on the server. No native menu, opened files, presentation placement, updates.
Its own README says how to run it.

## 3. Measurements

Release builds, Linux x86_64, both loading the dev stack's editor home page
(signed in through BYPASS_AUTH), measured 25–30 s after start, PSS summed over
the app's processes.

|                      | Tauri prototype                      | Electron shell         |
| -------------------- | ------------------------------------ | ---------------------- |
| `.deb`               | **6.7 MB**                           | 102 MB                 |
| AppImage             | 102 MB (carries WebKitGTK)           | 126 MB                 |
| Unpacked app         | 22 MB binary + system WebKitGTK      | 286 MB                 |
| Memory, idle on home | **354 MB** in 3 processes            | 422 MB in 10 processes |
| Release build        | 1 min 48 s (Rust, cold cache ~5 min) | 14 s                   |

Not measured: startup to first paint, memory and frame rate while editing a
large deck, macOS and Windows (the MacBook and the Windows VM).

## 4. What surfaced

- **NVIDIA on Wayland**: WebKitGTK's DMA-BUF renderer crashes the window at
  start (`Error 71 (Protocol error) dispatching to Wayland display`). With
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` it runs. A shipped Linux app would set it
  for NVIDIA itself; it may cost GPU compositing. Electron has no such issue.
- **A dependency break**: `tauri-plugin-deep-link` 2.6.2 does not compile
  against `rust-ini` 0.21.2+; the prototype pins 0.21.1 in `Cargo.lock`. The
  Rust side brings its own supply chain to watch.
- **macOS to check**: production sends `connect-src 'self'`; Tauri 2's IPC
  uses an `ipc://` custom scheme first and falls back to `postMessage` when
  that is refused, so the bridge should still work (with a console warning).
  Not verifiable on Linux, where the dev stack sends no CSP.
- **The sign-in needs no server change**: the shell's redeem (no `Origin`,
  `X-Narrative-Desktop: 1`) passes `isDesktopRedeemSource` as the Electron
  shell's navigation does. Not yet run end to end against Google (needs a
  person at the browser).

## 5. What a port would take

The Electron shell's main process (≈ 40 files in `apps/desktop/src/main`) in
Rust: the native menu and its routing to the editor's actions, opened `.pptx`
files and the file association, presentation placement on Hyprland, the
settings and server choice, signed self-updates against the existing feed (or
Tauri's updater), macOS signing and notarisation, the Windows installer, and
the e2e fixtures (Playwright drives Electron natively; Tauri needs WebDriver).
Weeks, not days.

## 6. Recommendation

Tauri is viable: the e2e suite shows no editor bug particular to WebKit,
and the app is 15× smaller to download with ~15% less memory.
The cost is a rewrite of the shell in Rust, WebKit's per-platform differences
to test on every release, and the NVIDIA/Wayland quirk on Linux.

Next: try the prototype on the MacBook (WKWebView is the engine that matters
most; README.md → macOS), then decide.
