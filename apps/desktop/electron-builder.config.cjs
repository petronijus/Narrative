/**
 * electron-builder.config.cjs
 *
 * How the desktop app is packaged (docs/plans/desktop-d0-spec.md §3.12,
 * revision 3; ADR 0015). The app is the bundled dist/ only — no
 * node_modules — so a pnpm workspace never leaks into it.
 *
 *   Linux    deb (Ubuntu: installs the SUID sandbox helper) and AppImage
 *            (Omarchy/Arch), both registering narrative:// and .pptx;
 *   macOS    universal dmg + zip, Developer ID signed (the certificate in
 *            the login keychain) and notarized with an App Store Connect
 *            API key from the environment; the zip feeds Squirrel.Mac;
 *   Windows  per-user NSIS, unsigned, with narrative:// and "Open with" for
 *            .pptx from resources/nsis/protocol.nsh.
 *
 * `just desktop-dist [linux|mac|win]` builds; it never publishes.
 */

// The same servers.json the bundle was built with (scripts/build.mjs).
const servers = require(process.env.DESKTOP_SERVERS_JSON || './servers.json')

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'com.bastla.narrative',
  productName: 'Narrative',
  // The packaged package.json's name names the updater's cache directory
  // (~/.cache/narrative-updater); the workspace name @narrative/desktop
  // would make it ~/.cache/@narrativedesktop-updater.
  extraMetadata: { name: 'narrative' },
  electronVersion: '44.7.0',
  directories: { output: 'release', buildResources: 'resources' },
  files: ['dist/**', '!dist/**/*.map', 'package.json'],
  asar: true,
  npmRebuild: false,
  nodeGypRebuild: false,
  extraResources: [{ from: 'resources/icon.png', to: 'icon.png' }],
  artifactName: 'narrative-${version}-${os}-${arch}.${ext}',
  protocols: [{ name: 'Narrative', schemes: ['narrative'] }],
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
    enableCookieEncryption: true,
  },
  publish: { provider: 'generic', url: servers.updateFeed, useMultipleRangeRequest: false },
  mac: {
    target: [
      { target: 'dmg', arch: 'universal' },
      { target: 'zip', arch: 'universal' },
    ],
    category: 'public.app-category.productivity',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    notarize: true,
    entitlements: 'resources/entitlements.mac.plist',
    entitlementsInherit: 'resources/entitlements.mac.plist',
    fileAssociations: [
      {
        ext: 'pptx',
        name: 'PowerPoint Presentation',
        role: 'Viewer',
        rank: 'Alternate',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      },
    ],
  },
  win: {
    target: [{ target: 'nsis', arch: 'x64' }],
    // No .pptx association through NSIS (it would take over the type's
    // default and break it on uninstall): protocol.nsh adds "Open with".
  },
  nsis: { oneClick: true, perMachine: false, include: 'resources/nsis/protocol.nsh' },
  linux: {
    target: ['deb', 'AppImage'],
    executableName: 'narrative',
    syncDesktopName: true,
    category: 'Office',
    maintainer: 'Petr Parkan Janda <petronijus@bastla.com>',
    fileAssociations: [
      {
        ext: 'pptx',
        name: 'PowerPoint Presentation',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      },
    ],
  },
  deb: { packageName: 'narrative' },
  // No hard-coded --no-sandbox in the AppImage's own .desktop entry.
  appImage: { executableArgs: [] },
}
