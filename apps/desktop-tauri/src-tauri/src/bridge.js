// window.narrativeDesktop, bridge version 1 (packages/shared/src/desktop.ts),
// injected by the Tauri prototype into the server's pages in its main window.
// info() and signIn() reach the shell (lib.rs); the rest of version 1 is
// inert here: no native menu, no opened files, the page places its own
// presentation window. The editor feature-detects, so inert is safe.
;(() => {
  if (window.top !== window || window.narrativeDesktop !== undefined) return
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args)
  const bridge = Object.freeze({
    bridgeVersion: 1,
    role: 'main',
    info: () => invoke('info'),
    signIn: (req) => invoke('sign_in', { returnTo: String(req && req.returnTo) }),
    setMenu: () => {},
    onMenuAction: () => () => {},
    onOpenFile: () => () => {},
    readOpenFile: () => Promise.reject(new Error('no opened files in this shell')),
    consumeOpenFile: () => {},
    placeForPresentation: () => Promise.resolve(false),
  })
  Object.defineProperty(window, 'narrativeDesktop', { value: bridge, enumerable: false })
})()
