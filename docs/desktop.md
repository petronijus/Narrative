# The desktop app

Narrative's desktop app (`apps/desktop`) is an Electron shell around the
editor the server already serves: it loads the chosen server's origin in its
own window and adds what only an installed app can do — sign-in through the
system browser, a native menu, opening PowerPoint files from the operating
system, presenting on a chosen display under Hyprland, and signed
self-updates. Why it is built this way: [ADR 0014](./adr/0014-desktop-shell-loads-server-origin.md).
The plan (phases D0–D4, offline work from D1 on) is
[`plans/desktop-app.md`](./plans/desktop-app.md); D0's design and its
as-built notes are [`plans/desktop-d0-spec.md`](./plans/desktop-d0-spec.md).

Status (2026-10-11): D0 is built on branch `feat/desktop` and not released.
D0 is online only.

## Running it in development

```bash
just desktop            # against the dev stack (just dev): http://localhost:5173
just desktop prod       # against production
just desktop https://narrative.example.com   # any server (https, or http on localhost)
```

`just desktop` bundles `apps/desktop` (esbuild: `dist/main.cjs`, the
preloads, the server dialog) and starts Electron from `node_modules`, the
first time after downloading its binary (`electron:install`). An unpackaged
build calls itself **Narrative Dev**, keeps its data apart from an installed
app, and registers the `narrative-dev://` scheme for this checkout (Linux: a
`narrative-dev-<hash>.desktop` entry; the last checkout that ran owns the
scheme).

- **Ubuntu 26.04** restricts unprivileged user namespaces, which the
  Electron sandbox needs. Run `just desktop-apparmor` once per checkout (asks
  for sudo); `just doctor` says when it is missing. The shell never runs
  without its sandbox. The profile lets that checkout's
  `node_modules/electron/dist/electron` — a file the developer can replace —
  create user namespaces, which is what Ubuntu's restriction prevents: a
  deliberate trade-off for a development machine (security review of D0,
  L4). The installed app needs no such profile; its deb ships Electron's
  root-owned sandbox helper.
- **macOS**: an unpackaged build cannot receive `narrative-dev://` links
  (schemes come only from an app bundle's Info.plist), so signing in needs a
  packaged build.
- Tests run the shell with `NARRATIVE_DESKTOP_USER_DATA=<dir>` (their own
  profile, no scheme registration) and `--server=<dev|prod|origin>`, which
  only an unpackaged build honours.

Logs: Help ▸ Open Logs Folder (`main.log`, JSON lines, 5 MB rotation;
sign-in links, tickets and verifiers are masked).

## What the shell does

| Area          | Where                                                         | Notes                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server choice | File ▸ Server (macOS: app menu)                               | production, the dev stack, a custom origin; each server has its own on-disk partition, so sessions and data never mix                                                                                                                               |
| Security      | `src/main/{guards,navigationPolicy,permissions,ipc}.ts`       | sandbox and context isolation, navigation pinned to the server, other links to the system browser, only clipboard-write, fullscreen and window-management permissions, every IPC sender and payload checked; fuses in `electron-builder.config.cjs` |
| Sign-in       | `src/main/signIn.ts`, server `routes/desktopAuth.ts`          | the system browser signs in (Google refuses embedded windows); the server hands a one-time, PKCE-bound `ndt_` ticket back through `narrative://auth/complete`; a hidden window redeems it into the server's partition                               |
| Menu          | `src/main/menu.ts`, web `src/desktop/menu.ts`                 | the editor sends Edit/View/Arrange/Present/File; a click runs exactly what the item's key does (`runChord`), or the action's binding; keys come from `DESKTOP_MENU_ACCELERATORS` in `packages/shared`                                               |
| Opened files  | `src/main/openFiles.ts`, web `src/desktop/openedFiles.ts`     | file association, Dock drop, File ▸ Import PowerPoint…; checked and queued in the main process, read by the page in chunks, imported like a dropped file                                                                                            |
| Presenting    | web `src/present/`, `src/main/{hyprland,presentPlacement}.ts` | the presentation's Display choice (Window Management API, also in Chrome and Edge); under Hyprland the shell moves the window to that monitor first                                                                                                 |
| Updates       | `src/main/{updates,updateVerify,updateSignature}.ts`          | see below                                                                                                                                                                                                                                           |

The bridge between the editor and the shell is `window.narrativeDesktop`
(`packages/shared/src/desktop.ts`, version 1). The editor feature-detects it;
a later version only adds methods.

## Packaging

```bash
just desktop-dist          # Linux: deb + AppImage into apps/desktop/release/
just desktop-dist win      # Windows NSIS (per-user, unsigned), built on Linux
just desktop-dist mac      # on the MacBook: universal dmg + zip, Developer ID signed and notarized
```

- **Ubuntu** installs the **deb** (its SUID sandbox helper works where user
  namespaces are restricted). The AppImage refuses to run there with
  `--no-sandbox`, which Ubuntu's AppImage launcher adds.
- **Omarchy/Arch** uses the **AppImage**: on every start it writes its own
  `narrative.desktop` (scheme + "Open with" for .pptx) and icon.
- **Windows**: the installer registers `narrative://` and "Open with" for
  .pptx under HKCU without taking over the type; SmartScreen warns, because
  the build is unsigned.
- **macOS** needs Petr's Apple Developer Program membership, the Developer ID
  Application certificate in the MacBook's keychain, and an App Store
  Connect API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`)
  for notarization.

## Updates

The packaged app checks the feed at `https://<server>/desktop/` 10 s after
start, every 6 hours and from Check for Updates…. It installs nothing that
does not pass the signature gate: each artefact has a manifest (name,
version, SHA-512) signed with SSHSIG by **"Narrative desktop update signing
key"**, an Ed25519 key that lives only in 1Password; the shell pins its
public half in `apps/desktop/servers.json`. A refused download is deleted;
"Later" installs nothing.

### Releasing the desktop app

After a release tag is pushed and deployed (`docs/deploy.md`):

```bash
git checkout vX.Y.Z
just desktop-dist                 # (mac: on the MacBook)
just desktop-publish linux        # 1Password asks to approve each signature
just desktop-dist win && just desktop-publish win
```

`desktop-publish` refuses anything but a clean build of the checked-out
release tag with the committed `servers.json`; it signs through the
1Password SSH agent (`just doctor` checks that the agent offers the key),
checks the VM's free space, uploads the files and then `latest*.yml`, and
keeps the three newest versions per platform (older ones go to the VM's
trash). The feed directory on the VM is `/opt/narrative/desktop-feed`.

If the signing key is ever lost, existing installs can only be updated by a
manual reinstall of a build that carries the new public key.

## Known limits (D0)

- Online only: the editor needs its server (offline work is D1–D3).
- On Wayland desktops other than Hyprland (GNOME), the compositor decides
  which display a fullscreen presentation lands on.
- macOS and Windows builds, the deb on Ubuntu and presenting on a real second
  monitor still wait for their first check on those machines
  (`HANDOVER.md`).
