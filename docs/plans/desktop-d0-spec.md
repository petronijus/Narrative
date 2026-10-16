# Narrative desktop D0: the Electron shell, online only (implementation spec, revision 3)

Worktree `/home/petronijus/Documents/Dev/Narrative-desktop`, branch `feat/desktop`, HEAD `1058d348`. This spec builds on `docs/plans/desktop-app.md` and the four research reports. Every file:line cited here was checked against the worktree. Revision 2 resolves the security, invariants and platform reviews. Where a fact can only be confirmed on real hardware, the step that depends on it names the check and says what the code does for each possible result.

**Petr's decisions this spec assumes:**

- **macOS builds are signed with an Apple Developer ID and notarized** (revision 3, Petr 2026-10-11); macOS updates install themselves through Squirrel.Mac. Windows builds stay unsigned.
- Every platform installs updates itself (§3.11).
- The server is production by default. A dev server or a custom URL can be chosen for testing.

## 0. Corrections to the plan and the research

| Claim                                                                 | What the code says                                                                                                                                                                                                                                             | Effect on the spec                                                                                                                                                                                |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan: the shell opens `/auth/start…` and POSTs `/auth/desktop/redeem` | Caddy strips `/api` (`infra/caddy/Caddyfile:78-90`). The public URLs are `/api/auth/start` and `/api/auth/desktop/redeem`. Fastify registers them without `/api`. The dev web app's `API_URL` is `http://localhost:3001` (`apps/web/src/lib/endpoints.ts:35`). | The shell works out the API base from its own server target (§3.2) and takes no URL from the page.                                                                                                |
| Plan: "an allowed-scheme check on `returnTo`"                         | `isSafeReturnTo` (`apps/server/src/routes/auth.ts:104-114`) is the open-redirect guard.                                                                                                                                                                        | `returnTo` stays a relative path. The `narrative://` target is a server constant chosen from an exact two-entry table (§4.1).                                                                     |
| Plan: e2e covers "the deep-link ticket path with a stubbed server"    | Under `BYPASS_AUTH`, `/auth/start` and `/auth/callback` return 500 (`auth.ts:169-172`, `:214-217`).                                                                                                                                                            | Server unit tests cover the real routes. The Electron spec covers the shell side against a stub server (§8). The real flow is checked by hand against the dev stack with real OIDC (§10, step 8). |
| Tooling report: add `electron` to `pnpm.onlyBuiltDependencies`        | `electron@44.7.0` has no install script and ships `bin.install-electron` (checked).                                                                                                                                                                            | Do **not** add it. Fetch the binary with the `electron:install` script (§6).                                                                                                                      |
| Research: redeem with a JSON body to force a CORS preflight           | The redeem is a form-encoded POST navigation (§4.3).                                                                                                                                                                                                           | Fetch metadata and an Origin check handle CSRF (§4.4). Content type does not.                                                                                                                     |
| Plan: a ticket "table/cache"                                          | Render tokens live in process memory because there is one API process (`apps/server/src/auth/renderTokens.ts:26-29`).                                                                                                                                          | Tickets live in an in-memory map (§4.2). No migration.                                                                                                                                            |
| Research: "HTTPS + sha512 in the yml is enough feed integrity"        | The sha512 only proves that the yml and the file came from the same host, and that host is VM 103 behind Cloudflare.                                                                                                                                           | Every artefact carries an SSH signature (SSHSIG, Ed25519) made with a key that never leaves 1Password, and the shell checks it before it installs anything (§3.11).                               |
| Research: the AppImage "crashes" on Ubuntu 26.04                      | The electron-builder 26.17 AppRun adds `--no-sandbox` by itself when `unshare -Ur` fails (`app-builder-lib/out/targets/appimage/appImageUtil.js`).                                                                                                             | A packaged build refuses to run without the sandbox (§3.1). The deb is the Ubuntu target.                                                                                                         |

## 1. Pinned versions

| Package             | Pin                                     | Why                                                                                                                                                                                                                                                       |
| ------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `electron`          | `44.7.0` exact (devDependency)          | Latest stable as of 2026-10-07: Chromium 152.0.7977.130, Node 24.21.0, supported until 2027-03-02. Move to Electron 45 at its first patch release, during a `just bump`. Electron 44 needs macOS 13 or later. Since Electron 42 there is no postinstall.  |
| `electron-builder`  | `26.17.0` exact                         | The npm `latest` tag is stale at 26.15.3 (checked), so a plain `pnpm add` would install the wrong version. Stay off 27 (alpha). It is the only tool that auto-updates AppImage, deb and NSIS from a self-hosted generic feed. Forge has no Linux updates. |
| `electron-updater`  | `6.8.10` exact (devDependency, bundled) | Matches builder 26.17.0. The `latest` tag (6.8.9) is stale (checked).                                                                                                                                                                                     |
| Bundler             | `esbuild` `0.27.7` exact                | Already in the lockfile (`pnpm-lock.yaml:3928`), so no fourth copy of the native binaries. The root `onlyBuiltDependencies` already covers esbuild (`package.json:45`). electron-vite 5 does not support the repo's vite 8.                               |
| `@playwright/test`  | keep the repo's `1.60.0`                | `_electron` supports Electron 21 and later. 1.64.0 loses a packaged app's first window (#43247).                                                                                                                                                          |
| `zod`               | the root version (devDependency)        | Validates IPC payloads and `settings.json` in main.                                                                                                                                                                                                       |
| `@narrative/shared` | `workspace:*` (devDependency)           | Precedent: `apps/render-worker/package.json:15`. It puts the desktop app in `--filter ...@narrative/shared`.                                                                                                                                              |

**Packaging rule.** `dist/main.cjs` bundles `electron-updater`, zod and `servers.json` (imported, so inlined), with `electron` external. `apps/desktop/package.json` has **no runtime `dependencies`**. Builder `files` is `["dist/**", "package.json"]`, and `extraResources` adds `resources/icon.png` (§3.12). A unit test checks that `electronVersion` in the builder config equals the `electron` devDependency pin. <!-- docs-check: ignore -->

## 2. Layout of `apps/desktop`

```
apps/desktop/
  package.json                 @narrative/desktop, version = root (0.10.23), private, type: module,
                               main: dist/main.cjs, desktopName: narrative.desktop
  servers.json                 { production, development, developmentApi, updateFeed, updatePublicKey }
  electron-builder.config.cjs  packaging, protocols, file associations, fuses, publish (§3.12)
  tsconfig.json                extends ../../tsconfig.base.json; noEmit; allowJs + checkJs; paths for
                               @narrative/shared (precedent apps/render-worker/tsconfig.json:1-16); include src, scripts
  vitest.config.ts             node env, src/**/*.test.ts, TEST_TIMEOUTS (precedent apps/render-worker/vitest.config.ts)
  scripts/build.mjs            esbuild: main, preload, audience preload, server dialog (inline script + CSP hash);
                               preload import guard; writes dist/build-info.json {version, commit, dirty, serversJsonDefault}
  scripts/sign-release.mjs     writes each artefact's manifest and signs it with `ssh-keygen -Y sign`
                               through the 1Password SSH agent; no key material on disk (§3.11)
  resources/icon.png           1024×1024 icon (builder makes .icns/.ico)
  resources/nsis/protocol.nsh  HKCU narrative:// + .pptx "Open with" registration (customInstall / customUnInstall)
  src/main/index.ts            entry: switches, sandbox check, single-instance lock, open-url/open-file, boot
  src/main/settings.ts         settings.json load/validate/atomic save (§3.8)
  src/main/servers.ts          ServerTarget → origin, apiUrl, partition, display host; feed URL normalisation
  src/main/window.ts           createMainWindow(target), window-state persistence, title suffix
  src/main/guards.ts           applyWebContentsGuards(wc, policy): navigation, window.open, webview
  src/main/navigationPolicy.ts pure: classifyNavigation(url, serverOrigin) → 'allow'|'external'|'block'
  src/main/permissions.ts      pure policy + installPermissionHandlers(session, serverOrigin)
  src/main/ipc.ts              registerIpc(): channels, sender/role validation, zod schemas
  src/main/ipcSchemas.ts       zod schemas of every renderer→main payload, accelerator allowlist
  src/main/signIn.ts           PKCE + state, the pending sign-in, start URL, hidden redeem window
  src/main/deepLinks.ts        pure: parseLaunchArgs(argv, appPath, cwd), parseCompleteUrl(), payload cap
  src/main/protocol.ts         scheme per build; setAsDefaultProtocolClient; dev .desktop registration
  src/main/linuxIntegration.ts AppImage self-integration (.desktop + icon + xdg-mime)
  src/main/desktopEntry.ts     pure: Desktop Entry Exec quoting/escaping
  src/main/openFiles.ts        queue of OS-opened .pptx: validate, chunked read, consume
  src/main/menu.ts             buildApplicationMenu(webSections, ctx) → MenuItemConstructorOptions[]
  src/main/menuRouting.ts      menu click → main window → native fallback (seq + timeout)
  src/main/present.ts          audience window, display choice, placement strategies
  src/main/hyprland.ts         pure monitor matching + hyprctl command builders
  src/main/updates.ts          electron-updater wiring, signature verification, macOS notice
  src/main/updateSignature.ts  pure: manifest builder + SSHSIG parser and Ed25519 verify (node:crypto)
  src/main/serverDialog.ts     the "Custom server…" window
  src/main/log.ts              JSON-lines log in app.getPath('logs'), 5 MB rotation, credential masking
  src/preload/index.ts         contextBridge: window.narrativeDesktop, role 'main' (bundled CJS, requires only 'electron')
  src/preload/audience.ts      contextBridge: window.narrativeDesktop, role 'audience' (endPresentation only)
  src/serverDialog/index.html  + dialog.ts + preload.ts: the custom-URL form
  src/**/*.test.ts             unit tests (§8.1)
```

**The shared contract** is the new file `packages/shared/src/desktop.ts`, exported from `packages/shared/src/index.ts`. It holds types and constants only, with no zod. Precedent: `packages/shared/src/render-queue.ts`. <!-- docs-check: ignore -->

```ts
export const DESKTOP_BRIDGE_VERSION = 1 as const

export const DESKTOP_IPC = {
  info: 'narrative:info', // invoke → DesktopInfo
  signIn: 'narrative:sign-in', // invoke {returnTo} → 'opened' | 'refused'
  setMenu: 'narrative:set-menu', // send DesktopMenuSection[] (or [] = reset to roles)
  menuAction: 'narrative:menu-action', // main→page {seq, action, accelerator?}
  menuActionResult: 'narrative:menu-action-result', // send {seq, handled}
  openFileSubscribe: 'narrative:open-file-subscribe',
  openFile: 'narrative:open-file', // main→page DesktopOpenedFile
  openFileRead: 'narrative:open-file-read', // invoke {id, offset, length} → Uint8Array
  openFileConsumed: 'narrative:open-file-consumed', // send {id}
  present: 'narrative:present', // invoke {deckId, slide?} → boolean
  presentEnd: 'narrative:present-end', // send (main and audience)
  presentationEnded: 'narrative:presentation-ended', // main→page {deckId}
} as const

export type DesktopRole = 'main' | 'audience'
export type DesktopNativeEdit = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'
export interface DesktopInfo {
  appVersion: string
  platform: 'darwin' | 'win32' | 'linux'
  role: DesktopRole
}
export interface DesktopMenuItem {
  action: string // a catalog ActionId (typed on the web side)
  label: string // ≤ 64 chars
  accelerator?: string // Electron syntax; must match the allowlist in main (§3.3)
  nativeFallback?: DesktopNativeEdit
  shell?: 'openPptx'
}
export type DesktopMenuEntry = DesktopMenuItem | 'separator'
export interface DesktopMenuSection {
  id: 'file' | 'edit' | 'view' | 'arrange' | 'present'
  label: string
  items: readonly DesktopMenuEntry[]
}
export interface DesktopOpenedFile {
  id: string
  name: string
  size: number
}
export const DESKTOP_OPEN_FILE_CHUNK = 8 * 1024 * 1024

interface DesktopBridgeBase {
  readonly bridgeVersion: typeof DESKTOP_BRIDGE_VERSION
  readonly role: DesktopRole
  endPresentation(): void
}
export interface NarrativeDesktopAudienceBridge extends DesktopBridgeBase {
  readonly role: 'audience'
}
export interface NarrativeDesktopMainBridge extends DesktopBridgeBase {
  readonly role: 'main'
  info(): Promise<DesktopInfo>
  signIn(req: { returnTo: string }): Promise<'opened' | 'refused'>
  setMenu(sections: readonly DesktopMenuSection[]): void
  onMenuAction(handler: (action: string, accelerator: string | undefined) => boolean): () => void
  onOpenFile(handler: (file: DesktopOpenedFile) => void): () => void
  readOpenFile(id: string, offset: number, length: number): Promise<Uint8Array>
  consumeOpenFile(id: string): void
  present(req: { deckId: string; slide?: number }): Promise<boolean>
  onPresentationEnded(handler: (deckId: string) => void): () => void
}
export type NarrativeDesktopBridge = NarrativeDesktopMainBridge | NarrativeDesktopAudienceBridge
```

**As built (steps 5–6, revision 3):** the presenting part of this contract is gone — `present`, `presentEnd`, `presentationEnded`, the `audience` role and its preload. Choosing the display is a web-app feature (§3.10), so the audience window is a popup the page opens and the shell places; it needs no bridge. `DesktopRole` is `'main'` only, and the settings file has no `presentDisplay`. `window-management` joins the allowed permissions (§3.3).

- The server versions the editor and the install versions the shell, so the web app feature-detects with `bridgeVersion`. A later bridge only adds methods and raises the version.
- The global declaration lives in `apps/web/src/desktop/bridge.ts`: `declare global { interface Window { narrativeDesktop?: NarrativeDesktopBridge } }`. <!-- docs-check: ignore -->

**Preloads.**

- Each preload is one CJS file whose only `require` is `electron`. An `onResolve` plugin in `build.mjs` fails the build on any other import that is left after bundling.
- `src/preload/index.ts` (main window only) exposes the main bridge. Every method is a thin `ipcRenderer.invoke` or `send` wrapper. `onOpenFile` sends `openFileSubscribe` when its first handler is added. `onMenuAction` answers every `menuAction` with `menuActionResult`, and with no handler the answer is `handled: false`.
- `src/preload/audience.ts` (audience window) exposes `{ bridgeVersion, role: 'audience', endPresentation }` and nothing else.
- Neither preload exposes `ipcRenderer`, raw channel names or Node globals.
- The presenter popup, the hidden redeem window and the server dialog's page get no bridge preload.

## 3. Main process

### 3.1 Startup order (`src/main/index.ts`)

Steps 1–8 run synchronously at module top level:

1. `app.enableSandbox()`.
2. **Unpackaged identity and test path.** When `!app.isPackaged`:
   - call `app.setName('Narrative Dev')`, so a dev run never shares the installed app's name, app_id or WM_CLASS;
   - if `NARRATIVE_DESKTOP_USER_DATA` is set, call `app.setPath('userData', …)`.
3. **Packaged hardening.**
   - When `app.isPackaged` and `app.commandLine.hasSwitch('remote-debugging-port')` or `hasSwitch('remote-debugging-pipe')` is set, log it and call `app.exit(1)`.
   - When `app.isPackaged` and `app.commandLine.hasSwitch('no-sandbox')` is set (on Ubuntu the AppImage's AppRun adds it), show a blocking message box after ready: "Narrative cannot run without its sandbox here. Install the .deb package instead (docs/desktop.md)." Then quit. This is never a warning that can be clicked away.
4. **Linux password store.** If `XDG_CURRENT_DESKTOP` contains `Hyprland`, call `app.commandLine.appendSwitch('password-store', 'gnome-libsecret')`.
5. Register `app.on('open-url')` and `app.on('open-file')`. Both call `event.preventDefault()` and push into the launch queue.
6. Compute the payload: `parseLaunchArgs(process.argv, app.getAppPath(), process.cwd())`.
7. **Single-instance lock.** `capLaunchPayload(payload)` keeps the deep link first, then as many file paths as fit in 8 KiB of JSON (each path at most 4096 bytes, at most 20 paths). Then `if (!app.requestSingleInstanceLock(capped)) { … }`. If paths were dropped, the second instance waits for ready, shows "N files were not opened: too many at once" and quits. It never drops them silently. Electron drops an oversized `additionalData` message completely, which is why the payload is capped.
8. `app.on('second-instance', (_e, _argv, _cwd, data) => handleLaunch(validateLaunchPayload(data)))`. Electron warns that `argv` there is unreliable, so only the payload is used.
9. `app.on('web-contents-created', (_e, wc) => applyWebContentsGuards(wc, …))`.
10. `app.whenReady()`, then in order:
    - load settings;
    - install the permission handlers on `session.defaultSession` (deny everything) (§3.3);
    - `linuxIntegration.ensure()` (AppImage only), **before** protocol registration, so the `.desktop` file exists first;
    - `protocol.register()` (§3.5);
    - `registerIpc()`;
    - create the main window;
    - `handleLaunch(payload)`;
    - `updates.start()`;
    - log `safeStorage.getSelectedStorageBackend()`. If it returns `basic_text`, show a one-time warning ("Your sign-in is stored without the system keyring…"; remembered as `warnedPlaintextStorage` in settings). The fix is in `docs/desktop.md`. <!-- docs-check: ignore -->
11. `window-all-closed`: quit, except on macOS. `activate` recreates the main window. `handleLaunch`, `completeSignIn` and the opened-file queue call `ensureMainWindow()`, which recreates the window when needed. On macOS a link or a file can arrive after every window has closed.

### 3.2 Servers, window and partition (`servers.ts`, `window.ts`)

```ts
type ServerTarget =
  { kind: 'production' } | { kind: 'development' } | { kind: 'custom'; origin: string }

function serverOrigin(t: ServerTarget): string // servers.json production/development, or t.origin
function apiUrl(t: ServerTarget): string
// production → servers.production + '/api'; development → servers.developmentApi ('http://localhost:3001');
// custom → t.origin + '/api' (the Caddy layout; a custom server must serve the API there)
function partitionFor(t: ServerTarget): string
// persist:narrative-prod | persist:narrative-dev | persist:narrative-custom-<sha256(origin).slice(0,16)>
function feedBase(): string // servers.updateFeed, normalised to end with '/'
```

`servers.test.ts` asserts that `servers.json.updateFeed` already ends with `/`. `new URL('x.dmg', 'https://d/desktop')` would drop the `desktop` segment and land on the SPA fallback.

**Partitions.** Each server gets its own on-disk partition, so cookies and IndexedDB never mix (this matters for D1).

**The main `BrowserWindow`:**

- `show: false`; shown on `ready-to-show`. Size and maximised state come from settings. Position is not restored, because Wayland cannot set it.
- `webPreferences`:
  ```
  { partition, preload: dist/preload.cjs, sandbox: true, contextIsolation: true,
    nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true,
    webviewTag: false, spellcheck: true, devTools: !app.isPackaged }
  ```
  `backgroundThrottling` keeps its default (true) on the main window, so the editor stops rendering in the background (battery). Only the audience window turns it off (§3.10).
- `loadURL(serverOrigin + '/')`.
- **Title.** On `page-title-updated`, when the server is not production, call `preventDefault()` and `setTitle(title + ' — ' + host)`.
- **Downloads.** Electron's default `will-download` save dialog stays. The blob downloads in `apps/web/src/lib/download.ts:6-16` keep working.

### 3.3 Security guards (`guards.ts`, `navigationPolicy.ts`, `permissions.ts`, `ipc.ts`)

**Navigation** applies to every webContents through `web-contents-created`:

- `will-frame-navigate` (all frames) and `will-redirect` use `classifyNavigation(url, serverOrigin)`.
- **allow:** `new URL(url).origin === serverOrigin`. This also covers the export iframe `/deck/:id/render` (`apps/web/src/state/browserSlideExport.ts:54-73`).
- **external:** `http:`, `https:` or `mailto:` to another origin. The guard calls `preventDefault()` and, for the main frame only, `shell.openExternal(url)`. This covers slide hyperlinks with target `_self` (`apps/web/src/components/PresentLayout.tsx:439`).
- **block:** everything else (`file:`, `javascript:`, `data:`, custom schemes): `preventDefault()` and a log entry.
- `will-attach-webview`: always `preventDefault()`.
- The server dialog and the hidden redeem window have their own policies (§3.8, §3.4).

**`setWindowOpenHandler`** (every webContents) always returns `{ action: 'deny' }`. Then:

- **Presenter popup:** same origin, path `^/deck/[A-Za-z0-9_-]{1,64}/present$` and `presenter=1` (`PresentLayout.tsx:173-179`). The shell opens its own `BrowserWindow` on that URL with an explicit `partition` equal to the opener's, the main window's webPreferences **without any preload**, and `devTools: !app.isPackaged`. The popup is opened with `noopener` (`PresentLayout.tsx:178`), so no opener relationship is lost. Creating the window ourselves avoids relying on an inherited preload being dropped by `overrideBrowserWindowOptions`. The shared partition keeps `BroadcastChannel` working.
- **An `http:`, `https:` or `mailto:` URL** on another origin is passed to `shell.openExternal` after parsing with `URL`. No other scheme ever reaches `openExternal`.

**Permissions** are installed on every session the shell uses: `defaultSession`, every server partition, `narrative-local` and the redeem window's partition (which is the server partition).

- `setPermissionRequestHandler((wc, permission, cb, details) => cb(allowed(permission, details.requestingUrl)))`
- `setPermissionCheckHandler((wc, permission, requestingOrigin) => allowed(permission, requestingOrigin))`
- `allowed(permission, urlOrOrigin)` is true only when `safeOrigin(urlOrOrigin) === serverOrigin` (`new URL(x).origin`, false on a parse error) **and** the permission is `clipboard-sanitized-write` (`apps/web/src/pages/AccessTokens.tsx:148`, `apps/web/src/ui/ShareDialog.tsx:129`) or `fullscreen` (`PresentLayout.tsx:244-252`). On `defaultSession` and `narrative-local`, `allowed` is always false.
- Everything else is denied (`clipboard-read`, media, display-capture, notifications, geolocation, midi, `window-management`, `openExternal`, `persistent-storage`, which is D1's).
- `setDisplayMediaRequestHandler` rejects. `setDevicePermissionHandler(() => false)`.

**IPC.** Every handler in `ipc.ts` first checks:

- `event.senderFrame` is the sender's main frame;
- `new URL(event.senderFrame.url).origin === serverOrigin`;
- the sender is one of the shell's windows, and its **role** is allowed on that channel.

| Channel                                                                                                     | Allowed role                               |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `info`                                                                                                      | main, audience (returns the caller's role) |
| `signIn`, `setMenu`, `menuActionResult`, `openFileSubscribe`, `openFileRead`, `openFileConsumed`, `present` | main                                       |
| `presentEnd`                                                                                                | main, audience                             |

Every payload is parsed with its zod schema from `ipcSchemas.ts`. An invalid payload is refused and logged. In particular:

- `present`: `deckId` matches `^[A-Za-z0-9_-]{1,64}$` (deck ids are `nanoid(12)`); `slide` is an integer from 1 to 100000 (the 1-based N that `apps/web/src/components/presentStartSlide.ts:24-36` reads). Both are put into the URL with `encodeURIComponent`.
- `setMenu`:
  - section ids come from the five known ids, unique;
  - labels are at most 64 characters, with at most 40 items per section;
  - `action` matches `^[a-z][A-Za-z]*(\.[A-Za-z]+)+$`;
  - `accelerator` must equal the entry for that action in the fixed `MENU_ACCELERATORS` table in `ipcSchemas.ts` (the D0 table in §5.2). Any other chord is refused, including the shell's own (`CmdOrCtrl+Q/W/R`, `F11`);
  - `nativeFallback` must equal the table's entry for that action.
- `signIn`: `returnTo` passes the `isSafeReturnTo` rule.

**Fuses** (packaged builds, builder `electronFuses`):

| Fuse                                    | Setting                                |
| --------------------------------------- | -------------------------------------- |
| `runAsNode`                             | false                                  |
| `enableNodeOptionsEnvironmentVariable`  | false                                  |
| `enableNodeCliInspectArguments`         | false                                  |
| `enableEmbeddedAsarIntegrityValidation` | true (works on macOS and Windows only) |
| `onlyLoadAppFromAsar`                   | true                                   |
| `grantFileProtocolExtraPrivileges`      | false                                  |
| `enableCookieEncryption`                | true                                   |

- No fuse covers `--remote-debugging-port`, so §3.1 step 3 refuses it, and packaged windows have `devTools: false`.
- Asar integrity does not work on Linux. Anywhere else, in an unsigned build, it does not stop local tampering either, because the exe and the asar can be edited together. It only catches accidental corruption. The ADR says this.
- Cookie encryption is one-way.
- On macOS an ad-hoc signed app shows a Keychain "Narrative Safe Storage" prompt after each manual update, because the code hash changes. `docs/desktop.md` says to answer "Always Allow". <!-- docs-check: ignore -->

The server's CSP (`Caddyfile:204`) applies unchanged. The shell injects no headers.

### 3.4 Sign-in (`signIn.ts`; the server side is §4)

```ts
interface PendingSignIn {
  verifier: string
  challenge: string
  state: string
  apiUrl: string
  serverOrigin: string
  createdAt: number
  attempts: number
}
const PENDING_TTL_MS = 10 * 60_000 // = the server's state-cookie lifetime (auth.ts:58-60)
const START_COOLDOWN_MS = 5_000
const MAX_REDEEM_ATTEMPTS = 3

async function startSignIn(req: { returnTo: string }): Promise<'opened' | 'refused'>
function completeSignIn(url: URL): void
```

**`startSignIn`:**

- Refuse (return `'refused'` and log) when the last start was less than 5 s ago. One page cannot open unlimited browser tabs.
- On an unpackaged build on macOS, show "Sign-in from an unpackaged build works on Linux and Windows; on macOS use `just desktop-dist`" and refuse. <!-- docs-check: ignore -->
- Generate the values:
  - `verifier = randomBytes(32).toString('base64url')`;
  - `challenge = sha256(verifier).base64url`;
  - `state = randomBytes(32).toString('base64url')`.
- Store the pending sign-in with `apiUrl = apiUrl(currentTarget)`. A new start replaces the old one.
- Call `shell.openExternal(apiUrl + '/auth/start?' + new URLSearchParams({ client: 'desktop', scheme, code_challenge, code_challenge_method: 'S256', desktop_state: state, returnTo }))`.
- Return `'opened'`.

**`completeSignIn(url)`** runs only when all of these hold (`parseCompleteUrl`):

- the protocol is `${scheme}:`, the host is `auth`, the path is `/complete`;
- `ticket` matches `^ndt_[A-Za-z0-9_-]{43}$` and `state` matches `^[A-Za-z0-9_-]{43}$`;
- a pending sign-in exists, is younger than 10 minutes, belongs to the current server, and `timingSafeEqual(state, pending.state)` holds.

Any other link is ignored and logged without the ticket. This includes a cold start from a stale link and a link fired by some web page with a guessed ticket. The state check also stops a ticket from the attacker's own flow being pushed in when they know the challenge. RFC 8252 §8.9.

**The redeem** runs in a **hidden** `BrowserWindow`. The main window is never navigated by a deep link.

- `show: false`, the same partition as the main window, no preload, `devTools: false`. Its navigation policy allows only `pending.apiUrl + '/auth/desktop/redeem'` and the redirect to the server origin.
- ```ts
  redeemWin.loadURL(pending.apiUrl + '/auth/desktop/redeem', {
    postData: [
      { type: 'rawData', bytes: Buffer.from(new URLSearchParams({ ticket, verifier }).toString()) },
    ],
    extraHeaders: 'Content-Type: application/x-www-form-urlencoded\nX-Narrative-Desktop: 1',
  })
  ```
- **As built (step 8):** the verifier and state are spent by the first link that passes the state check, whatever the redeem's outcome (security review M2a); a failed redeem shows `/auth/error?reason=desktop_sign_in_failed` at once instead of keeping the entry for three attempts. The server burns the ticket on any redeem anyway, so a retry could never succeed.
- On `did-redirect-navigation` (the server's 303), call `stop()`, close the window and look at the target:
  - **Success** (same origin as the server and the path is not `/auth/error`): consume the pending entry, then `ensureMainWindow()`, show and focus it (`app.focus({ steal: true })` on macOS), and `mainWin.loadURL(target)`. The cookie from the 303 is already in the partition's jar.
  - **Failure** (`/auth/error…`, a network error, or no redirect within 15 s): `attempts += 1`, and the pending entry stays, so a later genuine link still works. At the third failure, consume the pending entry and load `serverOrigin + '/auth/error?reason=desktop_sign_in_failed'` in the main window.
- At most one redeem runs at a time. A link that arrives while one is running is ignored.

After sign-in, the web app shows its usual signed-in UI. The account email is visible in the editor chrome, so a wrong account is obvious.

### 3.5 Deep links per OS (`deepLinks.ts`, `protocol.ts`, `desktopEntry.ts`)

**Schemes.** A packaged build uses `narrative`. An unpackaged build (`just desktop`) uses `narrative-dev`.

**`parseLaunchArgs(argv, appPath, cwd)`:**

- Skip `argv[0]`, any argument that resolves to `appPath`, any argument that starts with `-`, and the value after `-r` or `--require`. Playwright puts `-r loader.js --no-sandbox --inspect=0 --remote-debugging-port=0` first, so the arguments cannot be skipped by position.
- The first argument that parses as a URL with the active scheme becomes `deepLink`.
- A `file:` URL, or a path ending in `.pptx` (case-insensitive), is resolved against `cwd` and added to `files` (at most 20).

| OS             | Packaged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Unpackaged (`just desktop`)                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS          | `CFBundleURLTypes` from builder `protocols`; delivered by `open-url`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | not supported (the scheme must be in Info.plist); see §3.4                                                                                                                                                                                                                                                                                                                                                                                                                |
| Windows        | `protocol.nsh` writes `HKCU\Software\Classes\narrative` (`URL Protocol`; `shell\open\command` = `"$INSTDIR\Narrative.exe" "%1"`). At runtime, `app.setAsDefaultProtocolClient('narrative')` self-heals and writes the identical string (`"<execPath>" "%1"`; `protocol.test.ts` pins the format). `customUnInstall` removes the key only inside `${ifNot} ${isUpdated}`, because the uninstaller also runs during updates. Delivered by argv or `second-instance`.                                                                                                                                            | `app.setAsDefaultProtocolClient('narrative-dev', process.execPath, [path.resolve(appPath)])`                                                                                                                                                                                                                                                                                                                                                                              |
| Linux deb      | the builder's `.desktop` has `MimeType=x-scheme-handler/narrative;…` and `Exec … %U`; `after-install` runs `update-desktop-database`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `protocol.ts` writes `~/.local/share/applications/narrative-dev-<sha256(appPath).slice(0,8)>.desktop` (`Exec=` quoted by `desktopEntry.ts`, `NoDisplay=true`, `MimeType=x-scheme-handler/narrative-dev;`), runs `xdg-mime default <that file> x-scheme-handler/narrative-dev`, and calls `app.setDesktopName(<that file>)`. **Skipped when `NARRATIVE_DESKTOP_USER_DATA` is set** (tests). The last checkout that ran owns `narrative-dev://`; `docs/desktop.md` says so. |
| Linux AppImage | `linuxIntegration.ts`, when `process.env.APPIMAGE` is set, on every start: write `~/.local/share/applications/narrative.desktop` (`Exec=` = quoted `$APPIMAGE` + ` %U`; `MimeType=x-scheme-handler/narrative;application/vnd.openxmlformats-officedocument.presentationml.presentation;`), copy `path.join(process.resourcesPath, 'icon.png')` to `~/.local/share/icons/hicolor/512x512/apps/narrative.png`, and run `update-desktop-database ~/.local/share/applications` and `xdg-mime default narrative.desktop x-scheme-handler/narrative` (ENOENT is logged, not fatal). It never sets the pptx default. | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**`desktopEntry.ts`** quotes an `Exec` argument as the Desktop Entry spec requires:

- wrap it in double quotes;
- escape `"`, `` ` ``, `$` and `\` with a backslash, then double the backslashes once more for the string-value level;
- write `%` as `%%`.

Tests cover paths that contain spaces, `$`, `"`, `\` and `%`.

**Identity on Linux.** `package.json` `"desktopName": "narrative.desktop"`; builder `linux.executableName: "narrative"`, `linux.syncDesktopName: true`, `deb.packageName: "narrative"`.

**Targets.**

- Ubuntu 26.04 uses the **deb**, which installs its own AppArmor profile. The AppImage refuses to run there (§3.1 step 3).
- Omarchy/Arch uses the **AppImage**. User namespaces are not restricted there, so the sandbox works, and updates need no root.

### 3.6 File associations and opened `.pptx` files (`openFiles.ts`)

**Builder config:** `fileAssociations` sits under **`mac`** and **`linux`** only:

```
{ ext: 'pptx', name: 'PowerPoint Presentation', role: 'Viewer', rank: 'Alternate',
  mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }
```

- `rank` and `role` are macOS-only (LSHandlerRank). On macOS, `Alternate` keeps Narrative from claiming to own PowerPoint files.
- On Linux the MimeType line puts Narrative in "Open with", and the shell never runs `xdg-mime default` for pptx.
- **Windows** gets no builder `fileAssociations`. NSIS's `APP_ASSOCIATE` would overwrite `.pptx`'s default ProgID and leave it broken after uninstall. Instead, `protocol.nsh` registers "Open with" only:
  - `HKCU\Software\Classes\Narrative.Pptx` (ProgID; `shell\open\command` = `"$INSTDIR\Narrative.exe" "%1"`);
  - `HKCU\Software\Classes\.pptx\OpenWithProgids` value `Narrative.Pptx`;
  - `HKCU\Software\Classes\Applications\Narrative.exe\SupportedTypes` value `.pptx`.

  All three are removed in `customUnInstall` inside `${ifNot} ${isUpdated}`.

**Sources of opened files:**

- macOS: `open-file` (also a drop on the Dock icon);
- Windows and Linux: argv and `second-instance`;
- the shell's "Import PowerPoint…" item: `dialog.showOpenDialog` with a `pptx` filter.

**Validation** in `enqueue(path)`: `lstat` shows a regular file (symlinks are refused), the extension is `.pptx`, `1 ≤ size ≤ 2 GiB` (mirrors `MAX_PPTX_BYTES`, `apps/server/src/routes/pptxImport.ts:60`; the server stays the authority), and the first 4 bytes are `PK\x03\x04`. A file that fails is refused with a message box that names it and the reason.

**The queue** lives in main, so it survives reloads.

- An entry is `{ id: randomUUID(), path, name, size, mtimeMs }`.
- `openFileSubscribe` replays unconsumed entries as `openFile` metadata to the **main** window.
- `openFileRead(id, offset, length ≤ DESKTOP_OPEN_FILE_CHUNK)` re-checks size and mtime (otherwise it rejects with `file_changed`), reads with `fs.promises.open` plus `read`, and returns a `Uint8Array`.
- `openFileConsumed(id)` drops the entry.
- The renderer never sees a path. Every `openFile*` channel is main-window-only (§3.3).

### 3.7 Native menu (`menu.ts`, `menuRouting.ts`)

**Ownership.** The web app owns the editor menu model (§5.2) and sends it with `setMenu`. The shell owns its own roles.

- **Before the first `setMenu`:** the Edit section uses Electron roles (undo, redo, cut, copy, paste, selectAll).
- **After every main-frame `did-navigate`:** main resets to that role-only menu. The next `setMenu` from the page restores the editor menu, so a logout or an older editor never leaves stale items.
- **`setMenu([])`:** also resets to roles.

**macOS template:**

- **App:** About, Check for Updates…, Server ▸, —, Hide, Hide Others, Quit.
- **File, Edit, View, Arrange, Present:** web items. View adds —, Reload (`CmdOrCtrl+R`), Toggle Developer Tools (unpackaged only), Enter Full Screen (role `togglefullscreen`). Present adds —, Present on ▸.
- **Window:** role `windowMenu`.
- **Help:** Open Logs Folder.

**Windows and Linux template:**

- **File:** web file items, —, Server ▸, Check for Updates…, —, Quit.
- Edit, View, Arrange and Present as on macOS, without the macOS roles. F11 reaches the page's `present.fullscreen`.
- **Help:** About, Open Logs Folder.

**Accelerators per platform.** Electron's `registerAccelerator` works only on Linux and Windows. On macOS every displayed accelerator is a key equivalent, which fires whenever the page did not `preventDefault()` the key.

- **Windows and Linux:** every web item has `registerAccelerator: false`. Keys reach only the page, and Chromium edits text fields natively. The accelerator is display-only.
- **macOS:** every web item's accelerator is a live key equivalent. To stop a key running twice (once in the page, once from the menu), **every page binding of an action that carries an accelerator in `DESKTOP_MENU` sets `preventDefault: true`**. `menu.test.ts` (web) enforces this (§8.1). That changes these bindings:
  - `object.delete` (`apps/web/src/components/EditorLayout.tsx:2006-2017`, Delete/Backspace; inputs are already excluded by the dispatcher, `useShortcuts.ts:279-280`);
  - `object.copy` (`:2032`);
  - and whichever zoom, shortcut-help, group, ungroup, undo, redo, paste, select-all and `present.start` bindings lack it.

  Where a key is left unhandled (a text field, or `canHandle()` false), the menu fires, the page reports `handled: false`, and the native fallback runs. That is the only path by which Cmd+Z/X/C/V/A edit text fields on macOS.

**Web items** become `{ id: item.action, label, accelerator, registerAccelerator, click }`. `click(menuItem, _focusedWin, event)`:

- `item.shell === 'openPptx'` → the dialog, then enqueue (§3.6);
- otherwise `menuRouting.dispatch(mainWin, item)`. The **main** window is always the target, never the focused window (which may be the audience or presenter popup).

**`menuRouting.dispatch(win, item)`:**

- Send `menuAction { seq, action, accelerator }` and wait up to 1 s for `menuActionResult`.
- On `handled: false` with a `nativeFallback`: call `win.webContents[fallback]()`.
- On a **timeout**: do nothing and log. A busy renderer that answers late has run the action itself, and a fallback as well would run it twice.

### 3.8 Server selection and where it is stored (`settings.ts`, `serverDialog.ts`)

`app.getPath('userData')/settings.json`, validated with zod:

```json
{ "version": 1,
  "server": { "kind": "production" } | { "kind": "development" } | { "kind": "custom", "origin": "https://…" },
  "presentDisplay": { "kind": "automatic" } | { "kind": "display", "id": 123, "label": "DELL U2720Q" },
  "window": { "width": 1600, "height": 1000, "maximized": false },
  "warnedPlaintextStorage": false }
```

**Load and save:**

- A missing file means defaults.
- An invalid file is renamed to `settings.invalid-<timestamp>.json`, never deleted, and defaults apply.
- Saving writes `settings.json.tmp` and renames it over the original.

**Custom origin rules:** a URL with no path, query or credentials. `https:` is allowed for any host. `http:` only for `localhost`, `127.0.0.1` and `[::1]`.

**The Custom server… window:**

- `loadFile(dist/serverDialog.html)` in the in-memory partition `narrative-local`, with every permission denied and every navigation blocked.
- CSP meta: `default-src 'none'; script-src 'sha256-<hash>'; style-src 'unsafe-inline'`.
- Its own preload exposes only `narrativeServerDialog.submit(origin)` and `cancel()`.

**Switching server:**

- Choosing a custom origin first shows a confirmation: "Narrative will load <origin>. That server can see your work in Narrative and the PowerPoint files you open with it. Only use servers you trust."
- Then the shell saves the setting, clears the pending sign-in, closes the audience window and recreates the main window with the new partition.
- Non-production servers keep the title suffix (§3.2), which is shown outside the page.

**Test override:** `--server=<production|prod|development|dev|origin>` is honoured **only when unpackaged** and is not persisted. `servers.test.ts` covers the aliases.

### 3.9 Bridge-level behaviour of `signIn`

The page passes only `returnTo`. The shell takes the API base from its own server target (§3.2), so a page cannot point the ticket and verifier at any other host or local port.

### 3.10 Presenting on a chosen display (`present.ts`, `hyprland.ts`)

**Revision 3 (Petr 2026-10-11): choosing the display is a web-app feature.**
Chromium's Window Management API (`window.getScreenDetails()`, permission
`window-management`; fullscreen on a given screen with
`element.requestFullscreen({ screen })`) lets the web app list the displays
and put the audience on one of them, in Chrome and Edge as well as in the
shell. The display list, the stored choice and the "Present on" control
therefore live in `apps/web/src/present/` (an editor-only, device-local <!-- docs-check: ignore -->
setting, allowlisted like the rest of §7), and the shell's part shrinks to:

- allowing `window-management` in the permission handler for the server
  origin (§3.3);
- letting the audience popup through `setWindowOpenHandler` with
  `overrideBrowserWindowOptions` built from the screen the page asked for
  (the page passes the screen's `left`/`top`/`width`/`height` in the
  `window.open` features, which Chromium already honours on Windows, macOS
  and X11);
- the `hyprland` strategy below, because no Wayland compositor lets a
  client place its own window and Hyprland is the one where the shell can
  do it for the page.

What the web app does where the API is missing (Firefox, Safari): today's
single-window presenting, unchanged. Step 12 verifies on real hardware
whether `requestFullscreen({ screen })` reaches the chosen output under
GNOME Wayland; if it does not, the `compositor` row below applies and the
control says so. The rest of this section describes the placement
mechanics the shell keeps; the "Present on ▸" native menu becomes a mirror
of the web control (it sends the chosen screen to the page) instead of a
second store.

**Present on ▸** is a radio list: "Automatic", plus every display from `screen.getAllDisplays()`, shown by label (or `Display <n>`), resolution and "(primary)". The choice is stored in `presentDisplay`. The list is rebuilt on `display-added`, `display-removed` and `display-metrics-changed`.

**`present({ deckId, slide })`:**

1. Pick the target: a stored display that still exists; otherwise, under Automatic, the first display that is not `screen.getDisplayMatching(mainWin.getBounds())`. With fewer than 2 displays, return `false`, and the web app presents in its own window.
2. Create the audience window:

   ```
   new BrowserWindow({ x, y, width, height (= d.bounds), show: false, autoHideMenuBar: true, backgroundColor: '#000',
     title: 'Narrative audience <nonce>',
     webPreferences: { …main, preload: dist/audiencePreload.cjs, backgroundThrottling: false } })
   ```

   - `page-title-updated` is always `preventDefault()`ed, so the title stays unique.
   - Load `/deck/<encodeURIComponent(deckId)>/present` (plus `?slide=<n>`).
   - Place it with the strategy below.

3. Return `true`. The web app moves its own window to `?presenter=1` (§5). Both windows share the partition, so `BroadcastChannel` (`PresentLayout.tsx:479-517`) keeps them in sync.

**Placement strategy:**

| Strategy     | When                                                                                                                                              | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bounds`     | win32; X11; darwin (`setSimpleFullScreen(true)`, which stays in the same Space); forced by `NARRATIVE_DESKTOP_PLACEMENT=bounds` (unpackaged only) | the window is created on the display's bounds; on `ready-to-show`, `show()` then `setFullScreen(true)` (darwin: `setSimpleFullScreen(true)`)                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `hyprland`   | Wayland (`XDG_SESSION_TYPE=wayland`, no `ozone-platform=x11`) and `HYPRLAND_INSTANCE_SIGNATURE` set                                               | 1. `show()`. An unmapped Wayland window is invisible to `hyprctl`. 2. Poll `hyprctl -j clients` (every 50 ms, up to 2 s) for the exact title, and take its `address`. 3. `hyprctl -j monitors`, then `matchMonitor(display, monitors)` by logical geometry: `x`, `y`, `width/scale` and `height/scale`, with width and height swapped for `transform` 1, 3, 5 and 7. 4. `hyprctl dispatch movetoworkspacesilent <monitor.activeWorkspace.id>,address:<addr>`, which leaves focus on the presenter. 5. `setFullScreen(true)`. If any step fails, fall back to `compositor` and log why. |
| `compositor` | other Wayland (GNOME/mutter: Chromium sends `xdg_toplevel_set_fullscreen(NULL)`, and Electron has no output API)                                  | `show()`, then `setFullScreen(true)` wherever the compositor puts it. Present on ▸ shows a disabled line: "On Wayland the compositor chooses the display — move the audience window with your desktop's move-to-monitor shortcut". See the decisions at the end.                                                                                                                                                                                                                                                                                                                       |

**Ending a presentation:**

- `presentEnd` (from the main or the audience window) closes the audience window.
- When the audience window closes for any reason (Escape there, closed by hand, `display-removed`), main sends `presentationEnded { deckId }` to the main window.
- Only one audience window exists at a time. A second `present` closes the first.

### 3.11 Auto-update (`updates.ts`, `updateSignature.ts`)

- Inactive when `!app.isPackaged`.
- Checks run 10 s after ready, then every 6 hours, and from "Check for Updates…" (a manual check also reports "You're up to date").
- `autoUpdater` settings: `allowPrerelease = false`, `allowDowngrade = false`, **`autoInstallOnAppQuit = false`**. Nothing installs except through the verified path below. Every event is logged.
- Builder `publish.useMultipleRangeRequest: false`. Cloudflare sits in front of Caddy and may not serve multi-range requests. Differential downloads then use single ranges, or fall back to a full download, which is correct either way.

**Signature (all platforms): SSHSIG made by the 1Password SSH agent.**

- The key is the 1Password SSH Key item "Narrative desktop update signing key" (Ed25519, generated inside 1Password, never exported). It is used for nothing else: not the SSH key of any machine, not the nexusQ OTA key.
- For every artefact `scripts/sign-release.mjs` writes a manifest`<basename>.manifest`: <!-- docs-check: ignore -->

  ```
  narrative-desktop-update v1
  file <basename>
  version <version>
  sha512 <hex of the file>
  ```

  and signs it with `ssh-keygen -Y sign -n narrative-desktop-update -f <public key file>` while `SSH_AUTH_SOCK` points at the 1Password agent (Linux `~/.1password/agent.sock`, macOS `~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock`). 1Password asks Petr to approve each signing; the private key never reaches the disk, `op-cache` or the process. The output is `<basename>.manifest.sig` (armored SSHSIG). <!-- docs-check: ignore -->

- The 1Password SSH agent must offer this key (its `agent.toml` lists the vault or item); `just doctor` checks that `ssh-add -L` through that socket shows the public key from `servers.json` on the machines that publish (the Linux desktop and the MacBook).
- The public key (OpenSSH one-line form) is `servers.json.updatePublicKey` (bundled).
- `verifyUpdate(filePath, info)` streams the downloaded file into sha512, rebuilds the manifest from the file name, `info.version` and that hash, fetches `feedBase() + basename + '.manifest.sig'` with `net.fetch` (same origin as the feed, `cache: 'no-store'`), and verifies it: armor and `SSHSIG` magic, version 1, the embedded public key equals the pinned one byte for byte, namespace `narrative-desktop-update`, hash `sha512`, signature type `ssh-ed25519`, then `crypto.verify(null, signedData, key, sig)` over the SSHSIG signed-data blob (`"SSHSIG" ‖ string(namespace) ‖ string("") ‖ string("sha512") ‖ string(sha512(manifest))`). Any mismatch, a missing signature or a fetch error means **no install**: the updater's cached download is removed, and the failure is logged and reported in the next manual check.
- Unit tests sign real manifests with `ssh-keygen` and a throwaway key generated in the test (no 1Password), and check tampering of each field, a foreign key, a wrong namespace and a truncated armor.

| Platform / package | Behaviour |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| Windows NSIS (per-user oneClick, unsigned) | `autoDownload = true`. `autoUpdater.verifyUpdateCodeSignature` is overridden with `(_publisher, path) => verifyUpdate(path, current).then(ok => ok ? null : 'signature mismatch')`. electron-updater calls it before running the installer, and Authenticode is not used. On `update-downloaded`: "Narrative X.Y.Z is ready — Restart now / Later". "Restart now" calls `quitAndInstall(true, true)` (silent, relaunch). |
| Linux AppImage | `autoDownload = true`. On `update-downloaded`, `verifyUpdate(event.downloadedFile)` runs first; only on success does the dialog appear, and "Restart now" calls `quitAndInstall(true, true)`. No root needed. |
| Linux deb | as AppImage; the dialog adds "Installing asks for your password (system package)" (pkexec) |
| macOS (Developer ID, notarized; Squirrel.Mac) | `autoDownload = true`. Squirrel.Mac installs only a bundle whose code signature satisfies the running app's designated requirement (same Team ID), which is the integrity gate here and does not depend on the feed host. electron-updater's `MacUpdater` hands the zip to Squirrel inside its download step, so the SSHSIG check runs on `update-downloaded` as a second gate: on failure the shell never calls `quitAndInstall`, and with `autoInstallOnAppQuit = false` the staged bundle is not installed on quit; it is replaced by the next check's download. On success: "Narrative X.Y.Z is ready — Restart now / Later". | |

The feed is code delivery. Only `just desktop-publish` writes to it (§6), and only tagged builds are signed. <!-- docs-check: ignore -->

**As built (step 15):** one gate for every platform, `updateVerify.ts` on `update-downloaded`, before the Restart Now / Later dialog. electron-updater's Windows hook (`verifyUpdateCodeSignature`) is not used: `NsisUpdater` calls it only when the build carries an Authenticode `publisherName`, so for the unsigned build it would never run. A download that fails the gate is deleted and never offered; with `autoInstallOnAppQuit` off nothing installs on quit. The feed lives in `/opt/narrative/desktop-feed` on the VM (created by `deploy.sh`, excluded from the release `rsync --delete`), served by Caddy at `/desktop/` with `no-cache` and a sandbox CSP. Verified locally on Omarchy with AppImages 0.10.25 and 0.10.26 against a local feed and a throwaway key: an unsigned feed and a tampered file with recomputed `latest-linux.yml` were refused, the signed one was offered and installed and relaunched on Restart Now. `extraMetadata.name` names the updater cache `narrative-updater`.

### 3.12 `electron-builder.config.cjs`

```js
const servers = require('./servers.json')
const pkg = require('./package.json')
module.exports = {
  appId: 'com.bastla.narrative',
  productName: 'Narrative',
  electronVersion: '44.7.0',
  directories: { output: 'release', buildResources: 'resources' }, // never 'build' (gitignored + hook-denied)
  files: ['dist/**', 'package.json'],
  asar: true,
  extraResources: [{ from: 'resources/icon.png', to: 'icon.png' }],
  artifactName: 'narrative-${version}-${os}-${arch}.${ext}',
  protocols: [{ name: 'Narrative', schemes: ['narrative'] }],
  electronFuses: {/* §3.3 */},
  publish: { provider: 'generic', url: servers.updateFeed, useMultipleRangeRequest: false },
  mac: {
    target: [
      { target: 'dmg', arch: 'universal' },
      { target: 'zip', arch: 'universal' },
    ],
    // Developer ID Application certificate from the login keychain (CSC_NAME), hardened runtime,
    // notarized with an App Store Connect API key (APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER,
    // provided by `desktop-dist mac` from 1Password, never written to the repo).
    hardenedRuntime: true,
    gatekeeperAssess: false,
    notarize: true,
    entitlements: 'resources/entitlements.mac.plist',
    entitlementsInherit: 'resources/entitlements.mac.plist',
    category: 'public.app-category.productivity',
    fileAssociations: [/* §3.6 */],
  },
  win: { target: [{ target: 'nsis', arch: 'x64' }] },
  nsis: { oneClick: true, perMachine: false, include: 'resources/nsis/protocol.nsh' },
  linux: {
    target: ['deb', 'AppImage'],
    executableName: 'narrative',
    syncDesktopName: true,
    category: 'Office',
    maintainer: 'Petr Parkan Janda <petronijus@bastla.com>',
    fileAssociations: [/* §3.6 */],
  },
  deb: { packageName: 'narrative' },
  appImage: { executableArgs: [] }, // no hard-coded --no-sandbox in the embedded .desktop
}
```

- The `zip` target is required, because without it there is no `latest-mac.yml` and Squirrel.Mac has nothing to install.
- `resources/entitlements.mac.plist` grants exactly what Electron's V8 needs under the hardened runtime (`com.apple.security.cs.allow-jit`); nothing else (no camera, microphone or unsigned-memory entitlement unless a later phase needs one).
- macOS builds and publishing need Petr's Apple Developer Program membership (99 USD/year), the Developer ID Application certificate in the MacBook's keychain and an App Store Connect API key in 1Password. Until they exist, `desktop-dist mac` stops with that message; Linux and Windows are unaffected.
- `oneClick: true, perMachine: false` gives one per-user install in `%LOCALAPPDATA%`. No elevation, no install-mode page, and the HKCU keys always belong to the user.
- `desktop-dist` always passes `--publish never`.
- **The NSIS installer is built on the Linux desktop**, with electron-builder's bundled wine toolset (`USE_SYSTEM_WINE` unset). The justfile is bash-only and no Windows machine runs `just`. Windows is used to install and test, not to build.

## 4. Sign-in ticket flow, end to end

### 4.1 `GET /api/auth/start` (Fastify `/auth/start`, `auth.ts:168-210`)

**New query parameters:** `client=desktop`, `scheme` ∈ `{narrative, narrative-dev}`, `code_challenge` (matches `PKCE_CHALLENGE`), `code_challenge_method=S256`, `desktop_state` (`^[A-Za-z0-9_-]{43}$`), and `returnTo` (the existing rule).

**`parseDesktopStart(query)`** in `apps/server/src/routes/desktopAuth.ts` returns one of: <!-- docs-check: ignore -->

- `{ kind: 'web' }` when there is no `client`;
- `{ kind: 'desktop', challenge, scheme, state }`;
- `{ kind: 'invalid' }` for missing, extra or malformed values. The route answers 400 `{ error: 'invalid_desktop_request' }`.

**Changes in `auth.ts`:**

- `OauthStatePayload` (`:98-102`) gains `desktop?: { challenge: string; scheme: DesktopScheme; state: string }`, carried in the signed, HttpOnly, 10-minute state cookie (`:187-194`).
- `returnTo` stays relative, validated by `isSafeReturnTo` (now exported).
- The custom-scheme target comes only from `DESKTOP_COMPLETE_URLS = { narrative: 'narrative://auth/complete', 'narrative-dev': 'narrative-dev://auth/complete' }`, by exact key.

### 4.2 `GET /api/auth/callback` (desktop branch) and the ticket store

The callback (`auth.ts:213-364`) is unchanged up to and including `isAllowedToSignIn`, `upsertUser` and `consumePendingInvitesForEmail` (`:315-346`). Then, before `createSession` (`:350`):

```ts
if (statePayload.desktop) {
  await sendDesktopHandoff(
    reply,
    { user: { sub, email, name }, returnTo: returnPath },
    statePayload.desktop,
  )
  return
}
```

The system browser gets no session cookie, and no `sessions` row is written.

**`sendDesktopHandoff`:**

- It mints a ticket and answers with 200 HTML through `htmlHeaders(reply, [])`. That helper moves from `apps/server/src/mcp/oauth/routes.ts:95-109`, together with `noStore` (`:75-77`), to `apps/server/src/http/htmlHeaders.ts`. The headers are `no-store`, `X-Frame-Options: DENY`, `referrer-policy: no-referrer`, and CSP `default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`. <!-- docs-check: ignore -->
- The body carries `<meta http-equiv="refresh" content="0;url=narrative://auth/complete?ticket=ndt_…&state=…">`, an "Open Narrative" link with the same href, and the line "You can close this tab once Narrative has opened."
- Using a page rather than a 302 keeps the ticket out of `Location` in Caddy's access log (`Caddyfile:232-242`).

Errors before the branch keep `redirectWithError` (`auth.ts:399-407`). The shell's pending entry expires after 10 minutes.

**`apps/server/src/auth/desktopTickets.ts`** (shaped after `renderTokens.ts`): <!-- docs-check: ignore -->

```ts
export const DESKTOP_TICKET_PREFIX = 'ndt_'
export const DESKTOP_TICKET_TTL_MS = 60_000
export type DesktopScheme = 'narrative' | 'narrative-dev'
export interface DesktopTicketGrant {
  user: { sub: string; email: string; name: string | null }
  returnTo: string
}
export function mintDesktopTicket(
  grant: DesktopTicketGrant,
  challenge: string,
  now?: number,
): string
export function redeemDesktopTicket(
  ticket: unknown,
  verifier: unknown,
  now?: number,
): DesktopTicketGrant | null
export function clearDesktopTicketsForTests(): void
```

- **Format:** `ndt_` + `randomBytes(32).toString('base64url')`.
- **Storage:** `Map<sha256hex(ticket), { grant, challenge, expiresAt, timer }>`, with an `unref()`ed TTL timer and a cap of 10,000 entries (the oldest is evicted). One API process (`renderTokens.ts:26-29`, `apps/server/src/http/rateLimit.ts:68-69`). A restart inside 60 s loses the ticket. No migration.
- **`redeemDesktopTicket`**, in order:
  1. shape-check the ticket and verifier (`PKCE_VERIFIER`);
  2. hash the ticket;
  3. **`map.delete` first**, so a ticket is single-use even with a wrong verifier;
  4. clear the timer;
  5. check `expiresAt > now`;
  6. check `s256Matches(verifier, challenge)`.
- **`apps/server/src/auth/pkce.ts`** exports `PKCE_VERIFIER` and `PKCE_CHALLENGE` (moved from `apps/server/src/mcp/oauth/service.ts:141-142`), `s256(verifier)` (the expression at `service.ts:1041`) and `s256Matches` (`timingSafeEqual` over equal-length buffers). `service.ts` imports them. <!-- docs-check: ignore -->
- **`packages/shared/src/credentialPatterns.ts:22`:** add `'ndt'` to `CREDENTIAL_PREFIXES`, plus a line in the header comment.

### 4.3 `POST /api/auth/desktop/redeem` (`routes/desktopAuth.ts`)

`async registerDesktopAuthRoutes(app, opts: AuthRoutesOpts)` is **awaited** from `apps/server/src/http/registerRoutes.ts` right after `registerAuthRoutes` (`:111`), because the scoped content-type parser needs `await app.register(...)`.

- **Scope:** an encapsulated `app.register` that replaces the form parser. This is the pattern at `mcp/oauth/routes.ts:239-252`: `removeContentTypeParser`, then `addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 1024 }, …)` with `parseOAuthForm` (`:50`), which refuses repeated parameters.
- **Rate limit:** `{ config: { rateLimit: { max: 30, timeWindow: 60_000 } } }`, per IP from `CLIENT_IP_HEADER` (precedent `mcp/oauth/routes.ts:67-73`, `:295`).
- **Order of checks:**
  1. OIDC not configured → 500 `{ error: 'auth_not_configured' }` (mirrors `auth.ts:169`).
  2. Cross-site guard (§4.4) → 403 `{ error: 'forbidden_origin' }`.
  3. `redeemDesktopTicket(body.ticket, body.verifier)`. On `null`: warn `{ reason: 'invalid_ticket' }` without the ticket, then 303 to `${spaOrigin}/auth/error?reason=desktop_sign_in_failed`. Every failure kind gets the same answer, so it is no oracle.
  4. **Revoke a prior session in this jar:** if the request carries a `narrative_session` cookie that resolves to a live session, revoke that row (the same call logout uses).
  5. `createSession(db, { user, userAgent: ua?.slice(0, 512), ip: clientIpFromHeaders(…) })` (`apps/server/src/auth/session.ts:102-121`, `apps/server/src/http/clientIp.ts:18`). The session is fresh, so there is no fixation.
  6. `setSessionCookie(reply, rawId, expiresAt, isProd)` (now exported from `auth.ts:124-143`), `Cache-Control: no-store`, and 303 to `${spaOrigin}${grant.returnTo}` after re-checking `isSafeReturnTo`.

### 4.4 CSRF and login-CSRF reasoning

- **Login CSRF into a browser.** An attacker who holds their own ticket and verifier could auto-submit a form — from another site, or from any page on the app's own origin (an inline upload, an XSS). The guard (`isDesktopRedeemSource`, revised after the security review of steps 2–4) takes only the shell's own navigation:
  - the request must carry `X-Narrative-Desktop: 1`, which the shell's `loadURL` sets in `extraHeaders` and no HTML form can send;
  - **and** `Sec-Fetch-Site` must be `none` (a navigation the browser itself started); `same-origin`, `same-site` and `cross-site` are refused;
  - **when fetch metadata is absent**, pass only with no `Origin` at all.

  Do **not** reuse `isFromWebApp` (`apps/server/src/http/sameOrigin.ts:93-99`), because it passes requests that carry no metadata.

- **Login CSRF into the desktop app** (the attacker knows the challenge from browser history and pushes in their own ticket): stopped by the shell's `state` nonce, which the server echoes from the signed state cookie and the shell compares in constant time (§3.4).
- **What the server design relies on in the shell** (security review of steps 2–4, M2): (a) a `narrative://auth/complete` link is taken only while a sign-in is pending, its `state` compared in constant time, and the verifier and state are discarded after one redeem whatever the outcome; (b) the redeem is `webContents.loadURL(redeemUrl, { postData, extraHeaders })` in a hidden window — a `<form>` posted from a `data:`, `file:` or `about:blank` page sends `cross-site` and `Origin: null` and is refused, which must never be "fixed" by loosening the guard; (c) the incoming URL and argv are never logged or put into a crash report; (d) the hidden window uses the editor window's partition, or the cookie lands in the wrong jar. Step 8's tests check each.
- **Production serves only the release build's scheme**: `scheme=narrative-dev` is refused when `isProd` (`allowedDesktopSchemes`).
- **A local app that claims `narrative://` and starts its own flow** (RFC 8252 §8.6) receives a ticket it can redeem, because it owns that verifier: PKCE cannot help there. Accepted residual risk (ADR 0015): Google's account chooser always asks (`prompt=select_account`), and the hand-off page names the account and "the Narrative desktop app" with "If you did not start this sign-in, close this tab".
- **The redeem ends a session the window held before**, with `keepConnectionsOf` the signing-in user, so the same person's editors on other devices stay connected (`revokeSession`).
- **A stolen ticket** cannot be redeemed without the verifier, which never leaves main (RFC 8252 §8.1). It is single-use and lives 60 s.
- **A junk deep link** neither consumes the pending sign-in nor navigates the main window. The redeem runs in a hidden window, and the pending entry survives up to 3 failed attempts.
- **The sign-in allowlist** applies once, at the callback. A grant is at most 60 s old.
- **Caches:** the handoff page and the redeem response are both `no-store`.
- **Logs:** the `ndt_` prefix covers the Fastify serializer (`requestLogSerializer.ts:19-27`) and Sentry (`sendDefaultPii: false`, `observability/sentry.ts:110`). There is no `Location` header with a ticket, and the redeem body is never logged.

### 4.5 Logout, expiry, failures

- **Logout** is unchanged (`apps/web/src/state/AuthContext.tsx:141-153`). The menu resets to roles on the navigation that follows (§3.7).
- **Session expiry:** the cookie lasts 30 days (`auth.ts:138`), and the row slides (`session.ts:132-149`). After expiry, `/auth/me` returns 401, `ProtectedRoute` goes to `/auth/login`, and the desktop sign-in runs again.
- **Ticket expired or used:** the hidden redeem lands on `/auth/error`, which counts as one attempt (§3.4). After 3 attempts the main window shows `/auth/error?reason=desktop_sign_in_failed`, and `AuthError.tsx` gets the case "The sign-in link expired or was already used. Sign in again."
- **The user never finishes in the browser:** the pending entry expires after 10 minutes.
- **Google:** authorization always runs in the system browser. The redirect URI in Google Cloud Console does not change.

## 5. Web app changes

### 5.1 Call sites

| # | File:line | Change |
| --- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 1 | `apps/web/src/state/AuthContext.tsx:133` | `if (desktopSignIn(target)) return` |
| 2 | `apps/web/src/pages/AuthLogin.tsx:27` | in the desktop app, after the click: "Continue in your browser — Narrative signs you in when Google is done." |
| 3 | `apps/web/src/pages/AuthError.tsx` (`:15-28`) | `case 'desktop_sign_in_failed'` |
| 4 | `apps/web/src/ui/Toolbar.tsx:336` | `handler: () => startPresentation()`, with `const startPresentation = useStartPresentation(id)` |
| 5 | `apps/web/src/ui/Toolbar.tsx:957` | `onClick={startPresentation}` (Preview at `:914` stays in-window) |
| 6 | `apps/web/src/components/PresentLayout.tsx:543` (`present.exit`) | `endDesktopPresentation()` before `navigate(…)` |
| 7 | `apps/web/src/ui/usePptxImport.tsx:102` | `useDesktopOpenedFiles(accept)` |
| 8 | `apps/web/src/App.tsx:122` | `<DesktopBridge />` (inside Router and AuthProvider) |
| 9 | `apps/web/src/state/useShortcuts.ts` | refactor `handleKeyDown` (`:260-310`) into `scopeChainFor(target)` + `dispatchShortcut(e): boolean`; new exports `runChord` and `runAction` (below) |
| 10 | `apps/web/src/state/versionGuard.ts:144`, `:147` | add a `focus` listener and its removal (an unfocused Electron window rarely becomes `document.hidden`) |
| 11 | `apps/web/src/components/EditorLayout.tsx:2006`, `:2032` and the other bindings named in §3.7 | `preventDefault: true` |
| 12 | new `apps/web/src/state/cutSelection.ts` | `cutSelection(ctx)`, extracted from `handleCut` (`apps/web/src/ui/EditorContextMenu.tsx:265-277`): copy every selected object with `{ cut: true }`, delete only the unlocked ones (locks are editor-only; locked objects stay), then `clear()`. `EditorContextMenu` uses it. | <!-- docs-check: ignore --> |
| 13 | `EditorLayout.tsx` shortcut list | `{ keys: 'Mod+x', scope: 'canvas', preventDefault: true, action: 'object.cut', handler: () => cutSelection(…) }` |
| 14 | `apps/web/src/actions/catalog.ts` | `'deck.importPptx': { label: 'Import PowerPoint', commands: ['deck.importPptx'] }` |

```ts
// useShortcuts.ts — the menu runs exactly what the key would.
/** The scope chain handleKeyDown uses for a target (explicit DOM scope, sticky pointer scope, canvas). */
function scopeChainFor(target: EventTarget | null): string[] {
  /* body moved from handleKeyDown */
}

/** Dispatch a synthetic, cancelable keydown for an accelerator at the focused element.
 *  Bubbles through the element's own listeners (ProseMirror keymaps, including the
 *  y-prosemirror undo in SlideNotesPanel), then the document listener. Handled = defaultPrevented. */
export function runChord(accelerator: string): boolean {
  const target = document.activeElement ?? document.body
  const e = new KeyboardEvent('keydown', {
    ...chordToInit(accelerator),
    bubbles: true,
    cancelable: true,
  })
  target.dispatchEvent(e)
  return e.defaultPrevented
}

/** For menu items without an accelerator: the first binding with this action in the target's scope chain. */
export function runAction(id: ActionId): boolean {
  const target = document.activeElement
  if (isInputElement(target)) return false
  for (const scope of [...scopeChainFor(target), 'global'])
    for (const { bindings, handlerRef, scope: s } of registry.values()) {
      if (bindings.action !== id || s !== scope) continue
      if (bindings.canHandle !== undefined && !bindings.canHandle()) continue
      handlerRef.current(new KeyboardEvent('keydown', { cancelable: true }))
      return true
    }
  return false
}
```

- **Edit ▸ Copy while the slide panel is the active scope** runs `slide.copy` (`apps/web/src/ui/SlidesPanel.tsx:1268`), exactly as Mod+C there does. Chord dispatch goes through the same matcher and scope chain.
- **Undo in the notes editor** reaches the y-prosemirror keymap, which handles it and calls `preventDefault`, so the answer is `handled: true` and there is no native fallback.
- **In a plain `input`, `textarea` or the text-edit overlay** (`apps/web/src/ui/TextEditOverlay.tsx`, which has no Mod+Z handler; checked), nothing prevents the event. The answer is `handled: false`, and the shell's native `undo()` does exactly what the real key does there today.

### 5.2 `apps/web/src/desktop/` <!-- docs-check: ignore -->

| File                       | Content                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bridge.ts`                | the global declaration; `mainBridge(): NarrativeDesktopMainBridge \| undefined` (`bridgeVersion >= 1 && role === 'main'`); `anyBridge()`; `isDesktop()`                                                                                                                                                                                                                                    |
| `signIn.ts`                | `desktopSignIn(returnTo): boolean`: with a main bridge, `void bridge.signIn({ returnTo })` and return true                                                                                                                                                                                                                                                                                 |
| `present.ts`               | `endDesktopPresentation()` through `anyBridge()` (works in the audience window too)                                                                                                                                                                                                                                                                                                        |
| `useStartPresentation.ts`  | without a main bridge, `navigate('/deck/:id/present')`; with one, `present({ deckId })`: `true` → `?presenter=1`, `false` → in-window                                                                                                                                                                                                                                                      |
| `menu.ts`                  | `DESKTOP_MENU`, built with `item(action: ActionId, extra?: { menuLabel?, accelerator?, nativeFallback?, shell? })`. The label defaults to `USER_ACTIONS[action].label`. `menuLabel` overrides it (for example "Delete" for "Delete selected object(s)"); the action id stays the source.                                                                                                   |
| `menuDispatch.ts`          | `dispatchMenuAction(action, accelerator): boolean` → `isActionId(action) && (accelerator ? runChord(accelerator) : runAction(action))`                                                                                                                                                                                                                                                     |
| `openedFiles.ts`           | page queue, `hasConsumer()`, `toFile(meta)` (chunked `readOpenFile` → `File` with `PPTX_MIME`, `apps/web/src/lib/pptxFiles.ts:18`), `consume(id)`                                                                                                                                                                                                                                          |
| `useDesktopOpenedFiles.ts` | registers as the consumer, drains (`toFile`, `accept`, `consumeOpenFile`), unregisters on unmount                                                                                                                                                                                                                                                                                          |
| `DesktopBridge.tsx`        | `null` without a **main** bridge. Otherwise: `setMenu(DESKTOP_MENU)` on mount and after every route change (main resets on navigation); `onMenuAction(dispatchMenuAction)`; `onOpenFile` → queue, and `navigate('/')` when no consumer is mounted; `onPresentationEnded(deckId)` → `navigate('/deck/<deckId>')` if the path starts with `/deck/<deckId>/present`; `setMenu([])` on unmount |
| `menu.test.ts`             | §8.1                                                                                                                                                                                                                                                                                                                                                                                       |

**As built (step 10):** one table, `DESKTOP_MENU_ACCELERATORS` in `packages/shared/src/desktop.ts`, gives every key and native fallback: the editor builds its menu from it and the shell's `setMenu` schema refuses anything else, so the two cannot drift. Every key carries `CmdOrCtrl`: View ▸ Zoom In/Out and Edit ▸ Delete have **no key in the menu** (they run by action), because on macOS a bare `=`, `-` or `Delete` as a menu key equivalent would compete with typing. `runChord` reports a key as handled when a binding fired or a listener prevented it. The File section (Import PowerPoint…) and the `deck.importPptx` catalog entry land with opened files (step 11).

**`DESKTOP_MENU` (D0, as planned).** Every accelerator here equals the entry in main's `MENU_ACCELERATORS` (§3.3). `menu.test.ts` (desktop) compares the two tables.

| Section     | Item                  | `menuLabel`        | Accelerator         | `nativeFallback` / `shell` |
| ----------- | --------------------- | ------------------ | ------------------- | -------------------------- |
| **File**    | `deck.importPptx`     | Import PowerPoint… | —                   | `shell: 'openPptx'`        |
| **Edit**    | `history.undo`        | Undo               | `CmdOrCtrl+Z`       | undo                       |
|             | `history.redo`        | Redo               | `Shift+CmdOrCtrl+Z` | redo                       |
|             | —                     |                    |                     |                            |
|             | `object.cut`          | Cut                | `CmdOrCtrl+X`       | cut                        |
|             | `object.copy`         | Copy               | `CmdOrCtrl+C`       | copy                       |
|             | `object.paste`        | Paste              | `CmdOrCtrl+V`       | paste                      |
|             | `object.duplicate`    | Duplicate          | `CmdOrCtrl+D`       | —                          |
|             | `object.delete`       | Delete             | `Delete`            | —                          |
|             | —                     |                    |                     |                            |
|             | `selection.all`       | Select All         | `CmdOrCtrl+A`       | selectAll                  |
| **View**    | `view.zoomIn`         | Zoom In            | `=`                 | —                          |
|             | `view.zoomOut`        | Zoom Out           | `-`                 | —                          |
|             | `view.resetZoom`      | Actual Size        | `CmdOrCtrl+0`       | —                          |
|             | —                     |                    |                     |                            |
|             | `view.shortcuts`      | Keyboard Shortcuts | `CmdOrCtrl+/`       | —                          |
| **Arrange** | `object.group`        | Group              | `CmdOrCtrl+G`       | —                          |
|             | `object.ungroup`      | Ungroup            | `Shift+CmdOrCtrl+G` | —                          |
|             | —                     |                    |                     |                            |
|             | `object.bringToFront` | Bring to Front     | —                   | —                          |
|             | `object.bringForward` | Bring Forward      | —                   | —                          |
|             | `object.sendBackward` | Send Backward      | —                   | —                          |
|             | `object.sendToBack`   | Send to Back       | —                   | —                          |
| **Present** | `present.start`       | Present            | `CmdOrCtrl+Enter`   | —                          |

`object.nudge`, `tool.shape` and the closure-only actions (`deck.share`, `deck.exportPptx`, …) stay out until a general action dispatcher exists.

**Lint constraints** (`eslint.config.js`): type imports (`:59`), no `any`, hooks and components in their own files (`:77`), and no slide-model writers or `.transact(` (`apps/web/eslint.one-door.js:49-71`). Every document effect goes through existing bindings and commands.

## 6. Repo wiring checklist

| Item | Change | Precedent |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------- |
| Workspace | none (`pnpm-workspace.yaml:1-3` globs `apps/*`) | render-worker (`3727f8a4`) |
| `apps/desktop/package.json` | devDependencies: `electron@44.7.0`, `electron-builder@26.17.0`, `electron-updater@6.8.10`, `esbuild@0.27.7`, zod, `@narrative/shared: workspace:*`, `@types/node`, typescript, vitest. **No** `dependencies`. `"desktopName": "narrative.desktop"`. | `apps/render-worker/package.json:1-27` | <!-- docs-check: ignore --> |
| Desktop scripts | `build: node scripts/build.mjs`; `typecheck: tsc --noEmit`; `lint: eslint src scripts`; `test: node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts`; `start: electron .`; `dist: electron-builder --config electron-builder.config.cjs --publish never`; **`electron:install: install-electron`**. Never name a script `setup`: `pnpm setup` is a built-in command that edits the shell profile. Always invoke scripts with `pnpm --filter @narrative/desktop run <name>`. | same |
| Root `package.json` | none (see §0; not added to `dev`) | — |
| Lockfile | regenerated by `pnpm install`, never edited (`.claude/hooks/guard-edits.sh:66-67`) | — |
| tsconfig | `apps/desktop/tsconfig.json` (§2) | `apps/render-worker/tsconfig.json:1-16` | <!-- docs-check: ignore --> |
| ESLint / Prettier | none (root flat config; `format.sh` skips `*/dist/*`); `release/` is gitignored before the first `dist` | `eslint.config.js:23`, `tools/dev/format.sh:44` |
| `.gitignore` | `apps/desktop/release/`, `desktop-feed/` | `.gitignore:5-7` | <!-- docs-check: ignore --> |
| `.dockerignore` | `apps/desktop/release` | `.dockerignore:5-9` |
| Claude hooks | `.claude/hooks/guard-edits.sh:70-72`: deny `apps/desktop/release/*` | dist/build entries |
| `.claude/settings.json:20` | `"Bash(just desktop-publish *)"` and `"Bash(just desktop-publish)"` in `ask` | `just deploy *` |
| justfile | `desktop target="dev"`: the recipe body runs `just _stack` when the target is `dev`/`development`, then `pnpm --filter @narrative/desktop run electron:install && … run build && pnpm --filter @narrative/desktop exec electron . --server={{target}}` (the aliases are accepted, §3.8). `desktop-dist`: build + `dist` for the current OS; with `win`, the NSIS through wine. `desktop-publish platform`: `infra/scripts/desktop-publish.sh {{platform}}`. `desktop-apparmor`: installs the dev Electron AppArmor profile (sudo; below). `just setup` runs `electron:install`. | `dev`/`dev-lite` (`justfile:145-150`), `deploy` (`:187-188`) |
| Ubuntu dev sandbox | `tools/dev/apparmor/narrative-electron-dev`: `abi <abi/4.0>, include <tunables/global>, profile narrative-electron-dev /home/*/**/node_modules/.pnpm/electron@*/node_modules/electron/dist/electron flags=(unconfined) { userns, include if exists <local/narrative-electron-dev> }`. `just desktop-apparmor` copies it to `/etc/apparmor.d/` and runs `apparmor_parser -r`. Without it, the unpackaged Electron aborts on Ubuntu 26.04 (`kernel.apparmor_restrict_unprivileged_userns=1`), both under `just desktop` and in the e2e. Never `--no-sandbox`. | — | <!-- docs-check: ignore --> |
| `just test desktop` | through the `--filter` mapping (`justfile:81-83`) | `just test server` |
| Version / bump | none (`just bump` rewrites `apps/*/package.json`, `justfile:178-180`); `apps/desktop/src/version.test.ts` checks it equals the root version | `packages/commands/scripts/skill.test.ts` | <!-- docs-check: ignore --> |
| docs-check | every cited path exists; `AGENTS.md` under 200 lines (168 now) | `tools/dev/docs-check.py` |
| AGENTS.md "When to run what" | new row: `apps/desktop/**`, `apps/web/src/desktop/**`, `packages/shared/src/desktop.ts` → `just e2e -g "desktop-"`; `just desktop-dist` plus the per-OS checklist in `docs/desktop.md` for packaging, protocol, update or fuse changes | the table | <!-- docs-check: ignore --> |
| e2e-affected | `DESKTOP = ["desktop-shell", "desktop-sign-in", "desktop-open-file", "desktop-present", "desktop-menu"]`. Rows: `("apps/desktop/*", DESKTOP)`, `("apps/web/src/desktop/*", DESKTOP)`, `("packages/shared/src/desktop.ts", DESKTOP)`, server auth files keep their existing areas (no `desktop-sign-in`: that spec runs against a stub). Add `desktop-menu` to the rows of `apps/web/src/state/useShortcuts.ts`, `apps/web/src/ui/Toolbar.tsx`, `apps/web/src/components/EditorLayout.tsx` and `apps/web/src/state/cutSelection.ts`, and `desktop-present` to `PresentLayout.tsx`. Editing `packages/shared/src/index.ts` and `App.tsx` runs the whole suite; accepted and stated. | `tools/dev/e2e-affected.py:310` | <!-- docs-check: ignore --> |
| Playwright | `apps/web/playwright.config.ts`: `chromium` and `serial` get `testIgnore: /desktop-.*\.spec\.ts/`; project `desktop-build` (`testMatch: /desktop\.setup\.ts/`, runs `pnpm --filter @narrative/desktop run build` and starts Xvfb, §8.2); project `electron` (`testMatch: /desktop-.*\.spec\.ts/`, `dependencies: ['desktop-build']`, `workers: 1`). `just e2e` always brings up `_stack`; that is accepted for the stack-less `desktop-sign-in` too. | render-worker specs in `apps/web/e2e` |
| `tools/dev/doctor.sh` | Electron binary present without side effects (check `node_modules/electron/path.txt` and `dist/`, never `require('electron')`, which downloads); `Xvfb` on PATH (`xvfb` on Ubuntu, `xorg-server-xvfb` on Arch); on Ubuntu, `apparmor_restrict_unprivileged_userns=1` without the dev profile → print `just desktop-apparmor`; wine is optional (builder downloads its own). No `dpkg-deb` check (fpm builds the deb). | render-worker browser check | <!-- docs-check: ignore --> |
| Infra: Caddy | `handle_path /desktop/* { root * /srv/desktop; @feed path /latest*.yml; header @feed Cache-Control "no-cache"; @artefact not path /latest*.yml; header @artefact Cache-Control "public, max-age=31536000, immutable"; file_server }` **before** the SPA `handle` (`Caddyfile:163`); no fallback (a missing file is 404) | `/storage/*` (`:130-142`) |
| Infra: compose | `infra/docker-compose.prod.yml:171-175` caddy volume `../desktop-feed:/srv/desktop:ro`. `remote-release.sh` creates `/opt/narrative/desktop-feed` owned by `petr` before `compose up`, so Docker never creates it as root. | `web_static` mount |
| Infra: rsync | `infra/scripts/remote-release.sh:81`: `--exclude /desktop-feed/` (anchored, like `/.env`) | `--exclude backups/` |
| Infra: publish | new `infra/scripts/desktop-publish.sh <linux\|mac\|win>`: (1) clean tree, HEAD exactly at `v$version` (`git describe --exact-match`), the tag on origin (the checks in `infra/scripts/ship.sh:21-48`); (2) `release/build-info.json` says that commit, `dirty: false` and `serversJsonDefault: true`; (3) sign that platform's artefacts (`node scripts/sign-release.mjs <files>`, through the 1Password SSH agent, one approval per artefact); (4) check free space on the VM (refuse under 5 GB); (5) rsync that platform's binaries, `.blockmap` and `.sig` to `$NARRATIVE_VM:/opt/narrative/desktop-feed/`, **then** its `latest*.yml`; (6) prune per platform: keep the version its live yml names plus 2 older, check the yml's `version` against the files that remain. The MacBook publishes `mac` (it needs SSH to the VM over LAN or Tailscale); the Linux desktop publishes `linux` and `win`. | `prune-images.sh` |
| Ownership | `.claude/agents/desktop.md` (`apps/desktop/`, `apps/web/src/desktop/`, `packages/shared/src/desktop.ts`); a row in `docs/agents.md:26-34`; the `CLAUDE.md` subagent table; `.claude/rules/desktop.md` (security baseline, bridge versioning, roles, no Node in preloads, update signing); `code-reviewer.md:34-36` (apps/desktop imports nothing from apps/web; the contract goes through `@narrative/shared`); `security-reviewer.md` scope gains the shell, the ticket and the update feed | `.claude/agents/media.md:14-19` | <!-- docs-check: ignore --> |
| Docs | `AGENTS.md` (Layout row, plan pointer, When-to-run row); `docs/desktop.md` (install per OS, including Gatekeeper's "System Settings › Privacy & Security › Open Anyway" on macOS 15+ and `xattr -dr com.apple.quarantine`; SmartScreen; the keyring and `basic_text`; switching servers; updates and SHA-512 checks on macOS; logs; the per-OS checklist; troubleshooting); `SETUP.md` (`just desktop`, `just desktop-apparmor`, Xvfb); `README.md`; `docs/deploy.md` "Releasing the desktop app" (the full chain: `bump` → commit → tag → push → `deploy` → `desktop-dist` per OS from the tag → `desktop-publish <platform>`); `docs/testing-strategy.md` desktop row; `CHANGELOG.md` Unreleased; `HANDOVER.md` per-OS steps, plus one AI-handover Todoist task per affected OS (macOS: build + publish mac; Windows: install test) per the global rule | render-worker docs in `3727f8a4` | <!-- docs-check: ignore --> |

## 7. Parity and catalog obligations (ADR 0010)

**Route parity.** The redeem route triggers the route guard (`apps/server/src/routes/agentParity.test.ts:85-97`). In `packages/commands/src/parity/allowlist.ts:62-72`:

- add `{ method: 'POST', path: '/auth/desktop/redeem' }` to the "Browser sign-in and session" entry;
- extend its capability text with "…, desktop-app sign-in ticket";
- extend its reason with "The desktop app's sign-in redeems a one-time ticket from the system browser into its own window session; agents authenticate with a PAT or MCP OAuth."

**New allowlist entry** (no routes):

- capability: "Desktop app shell: native menu, presenting on a chosen display, opening .pptx files from the OS, server choice, app updates";
- reason: "Device-local behaviour of one installed app with no document effect. An agent has no device. The import an opened file starts runs `deck.importPptx`, and the menu items run existing catalog actions."

**Both entries land in step 4**, together with `just capabilities`. `packages/commands/src/manifest.ts:19,77` embeds `AGENT_ALLOWLIST` in `capabilities.json` and `docs/capabilities.md`, so `capabilities-check` in `just check` fails until the manifest is regenerated. The `agent-parity` agent runs in the same step.

**Catalog:** `deck.importPptx` (§5.1, item 14) is used in `apps/web/src/desktop/menu.ts`, which satisfies the unused-action test (`apps/web/src/actions/catalog.test.ts:51-59`); step 10 adds that file. Until then, step 4 does not add the catalog entry. It lands in step 10 with its use, followed by `just capabilities` again if the manifest changes. Shell-only items are covered by the allowlist entry. <!-- docs-check: ignore -->

## 8. Tests

### 8.1 Unit tests (vitest; in `just check`)

**`apps/server/src/auth/pkce.test.ts`:** the RFC 7636 appendix B vector; a mismatch and a length mismatch both return false. <!-- docs-check: ignore -->

**`apps/server/src/auth/desktopTickets.test.ts`** (injected `now`): <!-- docs-check: ignore -->

- mint returns `ndt_` + 43 characters;
- the right verifier returns the grant;
- a second redeem returns null;
- a wrong verifier returns null **and burns the ticket**;
- `now + 60_001` returns null;
- a malformed ticket or verifier returns null;
- the cap evicts the oldest entry.

**`apps/server/src/routes/desktopAuth.test.ts`.** Harness: bare `Fastify()` + `@fastify/cookie`, `vi.stubEnv` for the OIDC id and secret, a fake `JwtVerifier`, a stubbed `fetch`, and `vi.mock` for `signInPolicy`, `users`, `invites` and `session` (as in `apps/server/src/routes/sharing.test.ts:57-70` and `apps/server/src/mcp/oauth/oauth.test.ts:19-29`). <!-- docs-check: ignore -->

- **start:**
  - a missing or malformed challenge → 400;
  - `method≠S256` → 400;
  - an unknown `scheme` → 400;
  - a missing or malformed `desktop_state` → 400;
  - `returnTo=https://evil` or `narrative://x` → the state `returnTo` is `/`;
  - valid → the signed state cookie holds `desktop` (challenge, scheme, state) and 302 to Google.
- **callback (desktop):**
  - no session cookie and no `createSession` call;
  - 200 HTML whose meta refresh and link carry `narrative://auth/complete?ticket=ndt_…&state=<state>`;
  - the CSP, `no-store` and `no-referrer` headers are present;
  - `scheme=narrative-dev` is refused in production and gives a `narrative-dev://` URL against a development server.
- **callback (web):** unchanged (regression check).
- **redeem:**
  - success → one `createSession`, a cookie with `HttpOnly`, `SameSite=Lax` and `Path=/`, 303 to `spaOrigin + returnTo`, and `no-store`;
  - a prior valid `narrative_session` cookie → that session is revoked;
  - a second use, a wrong verifier or an expired ticket → 303 to `/auth/error?reason=desktop_sign_in_failed`;
  - `Sec-Fetch-Site: cross-site` → 403;
  - `Sec-Fetch-Site: same-site` → 403;
  - no metadata with a foreign `Origin` → 403;
  - no metadata with `Origin: null` → 403;
  - JSON → 415;
  - a repeated parameter → 400;
  - `verifier: null` → 500.

**Other server tests:**

- `credentialPatterns.test.ts`: `ndt_` is masked.
- `requestLogSerializer.test.ts`: a URL with `ndt_…` is redacted.
- `agentParity.test.ts`, the MCP OAuth suites and `capabilities-check` stay green.

**`apps/web/src/desktop/menu.test.ts`** (TypeScript AST scan, like `catalog.test.ts`): <!-- docs-check: ignore -->

- every action is in `USER_ACTIONS`;
- every item with an `accelerator` has a binding with that action whose `keys` contain the same chord, with modifiers compared as a parsed set `{ mod, shift, alt, key }` (`CmdOrCtrl`→`Mod`; `Shift+CmdOrCtrl+Z` matches `Mod+Shift+z`);
- **every binding of every action that carries an accelerator sets `preventDefault: true`**;
- section ids are unique, and no section is empty.

**`apps/web/src/state/useShortcuts.test.ts`** (pure dispatch, no DOM-presence assertions): <!-- docs-check: ignore -->

- `runChord` with a focused scoped element follows that scope (slide panel → `slide.copy`);
- an input → false;
- `runAction` follows the same chain.

`catalog.test.ts` stays green.

**`apps/desktop/src/**/\*.test.ts`:\*\*

| Test file                  | Covers                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deepLinks.test.ts`        | Playwright-style argv (`-r loader.js --no-sandbox --inspect=0 …`); the app path matched by value; `file:` URLs; relative paths with cwd; the first deep link only; a link followed by `--some-switch`; the 20-file cap; payload capping to 8 KiB with the deep link kept; wrong scheme, host or path, a malformed ticket or state → rejected |
| `navigationPolicy.test.ts` | same origin → allow; another https origin → external; `file:`, `javascript:` and custom schemes → block; userinfo and port differences count as other origins                                                                                                                                                                                |
| `permissions.test.ts`      | only `clipboard-sanitized-write` and `fullscreen`, only for the server origin, from a full `requestingUrl` as well as an origin; the lookalike `https://narrative.bastla.com.evil.com` → denied; defaultSession policy → denied                                                                                                              |
| `settings.test.ts`         | defaults; an invalid file is renamed; custom origin rules; atomic save                                                                                                                                                                                                                                                                       |
| `servers.test.ts`          | partitions (stable custom hash); `apiUrl` per target; `--server` aliases; `updateFeed` ends with `/`; `new URL('x.dmg', feedBase())` stays under the feed path                                                                                                                                                                               |
| `menu.test.ts`             | template merge per platform; `registerAccelerator: false` for every web item on win32 and linux; live accelerators on darwin; the role menu before `setMenu` and after a navigation reset; `MENU_ACCELERATORS` equals the web `DESKTOP_MENU` accelerators                                                                                    |
| `menuRouting.test.ts`      | handled → no fallback; `handled: false` → `webContents[fallback]`; timeout → nothing; always the main window                                                                                                                                                                                                                                 |
| `ipcSchemas.test.ts`       | extra keys and bad types rejected; foreign accelerators, reserved chords and long labels rejected; `present` deckId and slide bounds                                                                                                                                                                                                         |
| `ipc.test.ts`              | the role table: audience → only `info`, `presentEnd`; wrong-origin or subframe senders refused                                                                                                                                                                                                                                               |
| `openFiles.test.ts`        | extension, size, zip magic, symlinks refused; chunk reads; `file_changed`; replay on subscribe                                                                                                                                                                                                                                               |
| `hyprland.test.ts`         | monitor matching by logical geometry (scale 1.25/1.5, transforms 1 and 3); the `clients` lookup; the `movetoworkspacesilent` command string                                                                                                                                                                                                  |
| `signIn.test.ts`           | the start URL (exact parameters, including `desktop_state`); the cooldown; pending TTL; replacement; a link without a pending entry, for another server or with a wrong state → ignored; a failed redeem keeps the pending entry until the third attempt                                                                                     |
| `updateSignature.test.ts`  | a valid signature → ok; a tampered file, a wrong version or name, a wrong key or a missing `.sig` → not ok                                                                                                                                                                                                                                   |
| `updates.test.ts`          | `autoInstallOnAppQuit === false`; a bad signature → no `quitAndInstall`; the NSIS hook returns an error string on mismatch; the macOS notice refuses a `file.url` on another origin or outside the feed path                                                                                                                                 |
| `desktopEntry.test.ts`     | `Exec` quoting of spaces, `$`, `"`, `\`, `%`                                                                                                                                                                                                                                                                                                 |
| `protocol.test.ts`         | the Windows command string equals the NSIS one; the dev registration is skipped when `NARRATIVE_DESKTOP_USER_DATA` is set; the hashed file name                                                                                                                                                                                              |
| `version.test.ts`          | version equals the root; builder `electronVersion` equals the electron pin; builder `publish.url === servers.updateFeed`                                                                                                                                                                                                                     |

### 8.2 Playwright Electron specs (`apps/web/e2e/desktop-*.spec.ts`; `electron` project; in `just e2e` and `just ci`)

**`apps/web/e2e/desktop.setup.ts`** builds the shell and starts `Xvfb -displayfd 3 -screen 0 3840x1080x24` for the run. If Xvfb is missing, it fails with the install hint; it never skips silently. The display number goes to the fixture. <!-- docs-check: ignore -->

**Fixture `apps/web/e2e/support/desktop.ts`:** <!-- docs-check: ignore -->

```ts
const repoRoot = path.resolve(__dirname, '../../../..')
const desktopDir = path.join(repoRoot, 'apps/desktop')
_electron.launch({
  executablePath: require(require.resolve('electron', { paths: [desktopDir] })),
  args: [desktopDir, '--server=' + server, ...args],
  cwd: repoRoot,
  chromiumSandbox: true, // otherwise Playwright adds --no-sandbox on Linux
  env: {
    ...withoutKeys(process.env, ['WAYLAND_DISPLAY', 'HYPRLAND_INSTANCE_SIGNATURE']),
    DISPLAY: xvfbDisplay,
    NARRATIVE_DESKTOP_USER_DATA: tmpDir,
    NARRATIVE_DESKTOP_PLACEMENT: 'bounds',
  },
})
```

- Playwright replaces the whole environment when `env` is given, so `process.env` is spread in.
- Xvfb keeps windows off Petr's real monitors, and with no Hyprland signature no real `hyprctl` runs. The dev `.desktop` registration is skipped because of the user-data variable.
- On Ubuntu the AppArmor profile is required (doctor).
- The fixture stubs `shell.openExternal` in main through `electronApp.evaluate` and records the URLs.

| Spec                | Needs                                                    | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop-shell`     | stack                                                    | Against `development`, the folders page loads. `getLastWebPreferences()` shows sandbox, contextIsolation and no nodeIntegration. `app.commandLine.hasSwitch('no-sandbox') === false`. `bridgeVersion === 1`, `role === 'main'`, `typeof require === 'undefined'`. `location.href = 'https://example.com'` stays on the origin and is recorded. `window.open('https://example.com')` is denied and recorded. The presenter popup (`?presenter=1`) opens as a second window in the same partition, and there `window.narrativeDesktop === undefined`. `Notification.requestPermission()` → `'denied'`. `navigator.clipboard.writeText` resolves after `win.focus()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `desktop-sign-in`   | no stack (runs under `just e2e`, which starts it anyway) | A node `http` stub on a random port is a **custom** server (`--server=http://127.0.0.1:<port>`). Its `/` calls `narrativeDesktop.signIn({ returnTo: '/after' })`. Assert the recorded URL: `origin/api/auth/start`, `client=desktop`, `scheme=narrative-dev`, a 43-character `code_challenge`, `S256`, a 43-character `desktop_state`, `returnTo=/after`. The stub's `/api/auth/desktop/redeem` records headers and body, checks the ticket and `sha256(verifier) == challenge`, sets `narrative_session=test; HttpOnly; Path=/; SameSite=Lax`, and sends 303 to `/after`. Deliver `narrative-dev://auth/complete?ticket=ndt_<43>&state=<recorded state>` via `app.emit('second-instance', …, { deepLink })`. Assert: the main window URL is `/after`; the partition has one `narrative_session`; the stub saw `sec-fetch-site: none` and the form content type; the main window never loaded the redeem URL. Negative cases: a wrong state, the same link again, no pending entry, a malformed ticket → no redeem request. A stub answering `/auth/error` twice and then success → signed in, with the pending entry kept across the failures. |
| `desktop-open-file` | stack                                                    | Launch with `apps/web/e2e/fixtures/import-test.pptx`. The import dialog appears on FoldersHome. Complete the import into a seeded folder, assert the deck exists through the API, then delete it. A `.txt` renamed `.pptx` → no `openFile` event.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `desktop-present`   | stack                                                    | Stub `screen.getAllDisplays` in main with two displays. Mod+Enter opens the audience window at `/deck/:id/present` with `role === 'audience'`, and the main window shows `?presenter=1`. The next slide in the presenter moves the audience (the active-slide assertion from `present-layout.spec.ts`). A menu click while the audience is focused acts on the main window. Escape in the audience closes it, and main returns to `/deck/:id`. With one display, the presentation is in-window.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `desktop-menu`      | stack                                                    | An edit through `testApi`, then a click on `getMenuItemById('history.undo')`, reverts it (structural `listSlides()`). Focus the deck-rename input, type, click Undo → the text reverts (native fallback). Focus the slide-notes editor, type, click Undo → the note reverts through y-prosemirror, and the slide's notes in `listSlides()` match. Slide panel focused + Edit ▸ Copy → a slide copy, not an object copy. Mod+X on an object removes it and paste restores it; a locked object survives the cut. Navigating to `/auth/login` resets the Edit menu to roles.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

`apps/web/e2e/keyboard-shortcuts.spec.ts` gains: Mod+X cuts (and a locked object survives), Mod+C still copies, and Delete still deletes with `preventDefault`.

### 8.3 What runs where

- **`just check`:** formatting, types, lint, docs-check, `e2e-affected --check`, every unit test above (the desktop vitest through `pnpm -r test`), and `capabilities-check`.
- **`just e2e-affected`:** the `desktop-*` specs for desktop files, `desktop-menu` for shortcut files, `desktop-present` for `PresentLayout`.
- **`just e2e` / `just ci`:** everything, including the `electron` project under Xvfb.
- **By hand, per OS** (the `docs/desktop.md` checklist): <!-- docs-check: ignore -->
  - the installer;
  - a deep link from the real browser;
  - focus after a deep link (on Wayland and Windows the window may only be flagged for attention; then the expected result is a highlighted taskbar/dock entry, and one click brings the signed-in window);
  - the macOS key equivalents in text fields and on the canvas, with no double run;
  - the update path;
  - Hyprland and GNOME placement;
  - on petronijus-PC, `chrome://gpu` in the shell shows hardware acceleration on the RTX 5090 and not a software fallback (the Quadro's nodes are EACCES by design).

## 9. ADR 0015

Written in step 1: [ADR 0015](../adr/0015-desktop-shell-loads-server-origin.md)
(the shell loads the server's origin; offline is a web-app feature), with
Petr's decisions of revision 3.

## 10. Implementation steps (each verifiable on its own)

Start every session with `git merge main` in the worktree.

1. **ADR 0015 and plan update.** `docs/adr/0015-desktop-shell-loads-server-origin.md` (§9). Record Petr's answers in `docs/plans/desktop-app.md`. Verify: `just lint-docs`. <!-- docs-check: ignore -->
2. **PKCE helpers and the HTML headers move.** `apps/server/src/auth/pkce.ts` + test; `service.ts` imports it; `htmlHeaders`/`noStore` move to `apps/server/src/http/htmlHeaders.ts`. Verify: `just test server` (the MCP OAuth suites stay green). <!-- docs-check: ignore -->
3. **The ticket store.** `desktopTickets.ts` + test; the `ndt` prefix + test. Verify: `just test server`.
4. **The desktop routes and parity.**
   - `routes/desktopAuth.ts` (with state validation), the awaited registration, and in `auth.ts`: the state payload, the start and callback branches, and the exports;
   - the session revoke on redeem;
   - `AuthError.tsx`;
   - **both allowlist entries (§7)**;
   - the §8.1 server tests.

   Then `just capabilities` (commit its output with the change) and the `agent-parity` agent. Verify: `just check`, `just test server commands web`, then `just e2e -g "destructive-flows"`. Then the `security-reviewer` agent on steps 2–4.

5. **The shared contract and package skeleton.**
   - `packages/shared/src/desktop.ts` and the `apps/desktop` package (`package.json` with the `electron:install` script, `servers.json` with a placeholder `updatePublicKey` that the step-15 key replaces, tsconfig, vitest, `scripts/build.mjs`); <!-- docs-check: ignore -->
   - the `.gitignore`, `.dockerignore` and guard-hook entries;
   - the AppArmor profile and `just desktop-apparmor`; <!-- docs-check: ignore -->
   - `pnpm install`.

   Verify: `just check`; `pnpm --filter @narrative/desktop run build` writes `dist/main.cjs`, `dist/preload.cjs`, `dist/audiencePreload.cjs` and `dist/build-info.json`.

6. **Main shell core.** `index.ts` (sandbox and debugging checks, identity, payload cap), `settings.ts`, `servers.ts`, `window.ts`, `guards.ts` (the presenter popup the shell creates itself), `navigationPolicy.ts`, `permissions.ts`, `log.ts`, `ipc.ts` (`info` + roles), both preloads, and `just desktop`. Verify: `just test desktop`; on Ubuntu, `just doctor` is clean after `just desktop-apparmor`; `just dev` + `just desktop` (the editor loads; the title shows `localhost:5173`; the app id is "Narrative Dev"); `just desktop prod`. <!-- docs-check: ignore -->
7. **Server selection UI.** Server ▸, the custom-URL dialog and the confirmation. Verify: `just test desktop`. By hand: switch to Custom (`http://127.0.0.1:5173`), confirm, and check that the partition directory changes under `userData/Partitions`.
8. **Sign-in in the shell and web.** `signIn.ts` (state, cooldown, hidden redeem window, attempts), `deepLinks.ts`, `protocol.ts` and `desktopEntry.ts` (dev registration), `apps/web/src/desktop/{bridge,signIn}.ts`, `AuthContext.tsx:133`, `AuthLogin.tsx`. Verify: `just test desktop web`. By hand on Linux, **against the local stack with real OIDC** (`BYPASS_AUTH=false`, `VITE_BYPASS_AUTH=false`, `OIDC_REDIRECT_URI=http://localhost:3001/auth/callback`, as `.env.example:59-80` documents): run `just desktop dev`, sign in through the browser, and check that the `narrative-dev://` link returns to the app signed in. Production sign-in waits for the release (step 19). <!-- docs-check: ignore -->
9. **E2E wiring.** The Playwright `desktop-build` (with Xvfb) and `electron` projects, the fixture, the `desktop-shell` and `desktop-sign-in` specs, and the e2e-affected rows. Verify: `just e2e -g "desktop-shell|desktop-sign-in"`; `just e2e-affected --list` names no desktop file as unclaimed.
10. **Menus.**
    - Web: the `useShortcuts.ts` refactor (`scopeChainFor`, `dispatchShortcut`, `runChord`, `runAction`) + test; `cutSelection.ts` (also used by `EditorContextMenu`); the `preventDefault` bindings (§3.7); the Mod+X binding; the `deck.importPptx` catalog entry; `desktop/{menu,menuDispatch}.ts`; `DesktopBridge.tsx` (menu part); the `App.tsx` mount.
    - Shell: `menu.ts`, `menuRouting.ts`, the `ipcSchemas` accelerator table, and the navigation reset.
    - Specs: `desktop-menu` and the keyboard-shortcuts cases.
    - `just capabilities` if the manifest changes.

    Verify: `just check`; `just e2e -g "desktop-menu|keyboard-shortcuts"`.

11. **Opened files.** `openFiles.ts`, Import PowerPoint…, `desktop/{openedFiles,useDesktopOpenedFiles}.ts`, `usePptxImport.tsx:102`, and the `DesktopBridge` file part. Verify: `just e2e -g "desktop-open-file|pptx-import"`.
12. **Presenting.** `present.ts` (audience preload, title lock, `backgroundThrottling: false` on the audience only), `hyprland.ts`, `desktop/{present,useStartPresentation}.ts`, `Toolbar.tsx:336` and `:957`, `PresentLayout.tsx:543`, and the `desktop-present` spec. Verify: `just e2e -g "desktop-present|present-layout"`. By hand: Omarchy with two monitors (`hyprland`: the audience lands on the chosen monitor and the presenter keeps focus), Ubuntu GNOME (`compositor` plus the hint), macOS (`simpleFullscreen`), Windows (`bounds`).
13. **The `versionGuard` focus listener.** Verify: `just test web`; `just e2e-smoke`.
14. **Packaging.** `electron-builder.config.cjs`, `resources/icon.png` (from the mark in `apps/web/public/apple-touch-icon.png`), `resources/nsis/protocol.nsh` (protocol + Open-with, guarded uninstall), `linuxIntegration.ts`, fuses, `just desktop-dist`, the doctor checks. Verify on Linux: <!-- docs-check: ignore -->
    - `just desktop-dist`; `git status` stays clean; <!-- docs-check: ignore -->
    - install the deb;
    - `xdg-mime query default x-scheme-handler/narrative` → `narrative.desktop`;
    - "Open with Narrative" on a `.pptx` → the import dialog;
    - `npx @electron/fuses read --app <binary>` shows the fuse table;
    - `narrative --remote-debugging-port=9222` exits at once.

    Then run the AppImage on Omarchy (sandboxed, integrated, `narrative://` handled), and the AppImage on Ubuntu (refused with the deb message). Build the NSIS with `just desktop-dist win` on Linux. <!-- docs-check: ignore -->

15. **Updates and the feed (local).**
    - `updates.ts` and `updateSignature.ts`; `scripts/sign-release.mjs`. <!-- docs-check: ignore -->
    - Put the public key of the 1Password item "Narrative desktop update signing key" (created by Petr 2026-10-11) in `servers.json`, and check that the 1Password SSH agent offers it on the Linux desktop and the MacBook.
    - The Caddy `handle_path /desktop/*`, the compose mount, the directory creation, the `remote-release.sh` exclude, `infra/scripts/desktop-publish.sh` and `just desktop-publish`. <!-- docs-check: ignore -->

    Verify locally:
    - `caddy validate` through the compose config check in `docs/deploy.md`;
    - build X.Y.Z and X.Y.Z+1 AppImages with a test `servers.json` pointing at a local feed (`DESKTOP_SERVERS_JSON=…` at build time, recorded as `serversJsonDefault: false`, which `desktop-publish` refuses), serve the feed locally, and check that X.Y.Z updates to X.Y.Z+1;
    - a feed with a tampered artefact or a missing `.sig` → no install;
    - "Later", then quit → nothing installed.

16. **macOS and Windows builds** (multi-OS handover: `HANDOVER.md` + one AI-handover task per OS).
    - **MacBook:** `just desktop-dist` (universal dmg + zip, ad-hoc); `codesign --verify --deep --strict` and `npx @electron/fuses read` on the app; the "Open Anyway" steps; `narrative://` from Safari and Chrome; Cmd+Z/X/C/V/A in the rename field, in the notes editor and on the canvas, with no double run; Delete on the canvas deletes once; the update notice against the local test feed opens only the feed URL and shows the SHA-512. <!-- docs-check: ignore -->
    - **Windows** (install and test only, installer from the Linux desktop): SmartScreen "Run anyway"; a per-user install with no UAC prompt; `HKCU\Software\Classes\narrative` and the Open-with keys; `.pptx` still opens in PowerPoint by default; a deep link from Edge; a silent update from the local test feed; after uninstall, `.pptx` is unchanged and the keys are gone.
17. **Docs and ownership.** `docs/desktop.md`, `AGENTS.md` (Layout, plan pointer, When-to-run row), `SETUP.md`, `README.md`, `docs/deploy.md` (the full release chain), `docs/testing-strategy.md`, `CHANGELOG.md` Unreleased, `.claude/agents/desktop.md`, `.claude/rules/desktop.md`, `docs/agents.md`, `CLAUDE.md`, `code-reviewer.md`, `security-reviewer.md`. Verify: `just check`. <!-- docs-check: ignore -->
18. **Phase gate.** `just ci` (including the `electron` project), the `code-reviewer` and `security-reviewer` agents on the branch diff, the `narrative-docs` sweep, then merge `feat/desktop` into `main` while the main worktree is clean. Commit, push and release only on Petr's word.
19. **After the release from `main`** (needs Petr's release word and per-host consent for VM 103):
    - `just deploy vX.Y.Z` ships the Caddy and compose changes;
    - `curl -I https://<domain>/desktop/latest-linux.yml` shows `no-cache` and a missing file returns 404;
    - `just desktop-publish linux` and `win` from the desktop, `mac` from the MacBook, all from the tag; <!-- docs-check: ignore -->
    - production sign-in through `narrative://` on each OS;
    - the next release (X.Y.Z+1) verifies the live update path: AppImage, deb (pkexec), NSIS silent, and the macOS notice.

---

## Rejected critiques

Most critiques were accepted. These were rejected outright or in part, and checked against the worktree at `1058d348`:

- **Invariants 5, the part that sends a synthetic keydown to every contenteditable.** Kept for ProseMirror (the slide notes, `SlideNotesPanel.tsx:91-97`). `TextEditOverlay.tsx` has no Mod+Z handler (grep finds none), so a synthetic keydown there would do nothing, and the native `webContents.undo()` is exactly what the trusted key does today. The chord dispatch in §5.1 covers both cases: handled means `defaultPrevented`, and otherwise the native fallback runs.
- **Invariants 7, the per-scope action list (`['object.copy', 'slide.copy']`).** The critique offered this or chord dispatch. Chord dispatch was chosen: it reuses `handleKeyDown`'s scope chain (`useShortcuts.ts:268-288`) and its matcher, so menu and key cannot drift apart.
- **Security minor 2, pinning the dev API origin and checking a page-supplied `apiUrl`.** Resolved differently. The page no longer sends `apiUrl`; the shell works it out from its own target (§3.2), which removes the attack surface instead of validating it. The dev value in `servers.json` (`developmentApi`) still matches `endpoints.ts:35`.
- **Security minor 5, downloading and verifying the dmg in the app.** Not adopted, because it would override Petr's stated decision ("links to the download"). The origin and path check and the displayed SHA-512 were adopted. The trade-off is in the decisions below.
- **Platform M4, the Linux part ("MimeType makes Narrative the de facto handler").** Kept on Linux. Without the MimeType line Narrative cannot appear in "Open with", and the shell never runs `xdg-mime default` for pptx, so it becomes the default only where no other app claims the type. Windows and macOS were changed as proposed.
- **Security minor 3, "refuse while a fresh pending entry exists".** Only the 5 s cooldown was adopted. Refusing for N seconds would block a legitimate retry after the user closed the browser tab. A new start replaces the old one, and the old verifier then becomes useless.

## Decisions (revision 3, Petr 2026-10-11)

1. **macOS updates install themselves.** Builds are signed with an Apple Developer ID and notarized; Squirrel.Mac installs updates (§3.11, §3.12). Petr enrolls in the Apple Developer Program before the first macOS release (step 16).
2. **Choosing the presentation display is a web-app feature** (Window Management API), which the shell reuses; GNOME Wayland falls back to the compositor's choice with the hint if step 12 shows Chromium cannot target an output there (§3.10).
3. **The update signing key is a new, dedicated 1Password SSH key** ("Narrative desktop update signing key"), used through the 1Password SSH agent; existing keys are not reused (§3.11).

No open decisions remain for D0.
