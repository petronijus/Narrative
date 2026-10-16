/**
 * main/index.ts
 *
 * The desktop shell's entry (ADR 0015, docs/plans/desktop-d0-spec.md §3.1).
 * Everything before `whenReady` runs at module top level, in this order,
 * because Electron reads it before the first window exists: the sandbox for
 * every renderer, a separate identity for an unpackaged build, the refusal
 * of debugging switches in a packaged one, and the single-instance lock.
 */

import {
  app,
  dialog,
  Menu,
  net,
  session,
  shell,
  type BrowserWindow,
  type WebContents,
} from 'electron'
import { DESKTOP_IPC } from '@narrative/shared'
import path from 'node:path'
import {
  capLaunchPayload,
  parseLaunchArgs,
  validateLaunchPayload,
  type LaunchPayload,
} from './deepLinks.js'
import { applyWebContentsGuards, createPresenterWindow } from './guards.js'
import { IpcRegistry, registerCoreIpc } from './ipc.js'
import { integrateAppImage } from './linuxIntegration.js'
import {
  menuActionResult,
  noPayload,
  openFileConsumedRequest,
  openFileReadRequest,
  screenRectRequest,
  setMenuRequest,
  signInRequest,
  type MenuSections,
} from './ipcSchemas.js'
import { createLogger, type Logger } from './log.js'
import { buildApplicationMenu } from './menu.js'
import { MenuRouter } from './menuRouting.js'
import { OpenedFiles } from './openFiles.js'
import { installPermissionHandlers } from './permissions.js'
import { refusedSwitches } from './switches.js'
import { placeForPresentation } from './presentPlacement.js'
import { activeScheme, canReceiveLinks, registerScheme } from './protocol.js'
import { redeemInHiddenWindow } from './redeemWindow.js'
import { chooseCustomServer } from './serverDialog.js'
import {
  apiUrl,
  feedBase,
  updatePublicKey,
  parseServerArg,
  partitionFor,
  serverOrigin,
  type ServerTarget,
} from './servers.js'
import { loadSettings, saveSettings, type Settings } from './settings.js'
import { SignInController } from './signIn.js'
import { Updates } from './updates.js'
import { createMainWindow } from './window.js'

// 1. Every renderer runs in the OS sandbox.
app.enableSandbox()

// 2. An unpackaged build never shares the installed app's name, app id,
//    window class or data; tests point it at their own directory.
if (!app.isPackaged) {
  app.setName('Narrative Dev')
  const testUserData = process.env['NARRATIVE_DESKTOP_USER_DATA']
  if (testUserData) app.setPath('userData', testUserData)
}

const log: Logger = createLogger(app.getPath('logs'), { mirror: !app.isPackaged })

// 3. A packaged build starts only with the switches a desktop or launcher
//    passes (main/switches.ts): a proxy, a network log, remote debugging, a
//    disabled sandbox or another profile would hand the editor's session to
//    whatever started it. A disabled sandbox (Ubuntu's AppImage launcher adds
//    --no-sandbox when it cannot use user namespaces) gets its own message.
const sandboxDisabled = app.isPackaged && app.commandLine.hasSwitch('no-sandbox')
const refused = app.isPackaged
  ? refusedSwitches(process.argv).filter((s) => s !== 'no-sandbox')
  : []
if (refused.length > 0) {
  log.error('refusing to start with these switches', { switches: refused })
  app.exit(1)
}

// 4. Hyprland sets no desktop the keyring detection knows; name it.
if ((process.env['XDG_CURRENT_DESKTOP'] ?? '').includes('Hyprland')) {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret')
}

const scheme = activeScheme()

// 5. Links and files the OS hands over (macOS delivers them as events, even
//    before ready); they wait in the launch queue until the app is ready.
const launchQueue: LaunchPayload[] = []
let launchReady = false
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleLaunch({ deepLink: url, files: [] })
})
app.on('open-file', (event, file) => {
  event.preventDefault()
  handleLaunch({ deepLink: null, files: [file] })
})

// 6. What this launch carries on its command line.
const launch = parseLaunchArgs(process.argv, app.getAppPath(), process.cwd(), scheme)

// 7. One instance: a second launch hands its link and files over to the
//    first and quits. Electron drops an oversized hand-over message whole, so
//    it is capped, and what did not fit is said, never lost silently.
const handOver = capLaunchPayload(launch)
const primary = app.requestSingleInstanceLock(handOver.payload)
if (!primary) {
  if (handOver.dropped === 0) app.quit()
  else {
    void app.whenReady().then(async () => {
      await dialog.showMessageBox({
        type: 'warning',
        title: 'Narrative',
        message: `${handOver.dropped} files were not opened: too many at once.`,
        buttons: ['OK'],
      })
      app.quit()
    })
  }
}

const distDir = __dirname
const userData = app.getPath('userData')
let settings: Settings
// Set once settings are read (whenReady); null before, when nothing may load.
let target: ServerTarget | null = null
let mainWindow: BrowserWindow | null = null
const presenterWindows = new Set<BrowserWindow>()
// The editor's menu sections, as its page last sent them; reset whenever the
// main window navigates, so a page that left never leaves its items behind.
let webSections: MenuSections = []
const menuRouter = new MenuRouter(log)
// PowerPoint files waiting for the editor; the page subscribes once it can
// import them and is told of every file from then on.
const openedFiles = new OpenedFiles()
let filesSubscribed = false

/** Check and queue a file the OS or the file dialog handed over. */
async function openFile(file: string): Promise<void> {
  const result = await openedFiles.enqueue(file)
  if (!result.ok) {
    log.warn('opened file refused', { reason: result.reason })
    await dialog.showMessageBox({
      type: 'warning',
      title: 'Narrative',
      message: `Narrative cannot import “${path.basename(file)}”.`,
      detail: result.reason,
      buttons: ['OK'],
    })
    return
  }
  const win = ensureMainWindow()
  if (win === null) return
  win.show()
  win.focus()
  if (filesSubscribed) win.webContents.send(DESKTOP_IPC.openFile, result.file)
}

async function chooseFilesToImport(): Promise<void> {
  const result = await dialog.showOpenDialog({
    title: 'Import PowerPoint',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
  })
  if (result.canceled) return
  for (const file of result.filePaths) await openFile(file)
}

const signIn = new SignInController({
  now: () => Date.now(),
  server: () => (target === null ? null : { origin: serverOrigin(target), apiUrl: apiUrl(target) }),
  scheme,
  openExternal: (url) => shell.openExternal(url),
  redeem: (req) => {
    if (target === null) return Promise.resolve({ kind: 'failed', reason: 'no_server' })
    return redeemInHiddenWindow(req, partitionFor(target))
  },
  signedIn: (url) => {
    const win = ensureMainWindow()
    if (win === null) return
    if (process.platform === 'darwin') app.focus({ steal: true })
    win.show()
    win.focus()
    void win.loadURL(url)
  },
  failed: () => {
    const win = ensureMainWindow()
    const origin = currentOrigin()
    if (win === null || origin === null) return
    win.show()
    void win.loadURL(`${origin}/auth/error?reason=desktop_sign_in_failed`)
  },
  log,
})

const updates = new Updates({
  packaged: app.isPackaged,
  currentVersion: app.getVersion(),
  log,
  feedBase: feedBase(),
  publicKey: updatePublicKey(),
  fetchText: async (url) => {
    try {
      // A feed that stalls the signature must not hold the gate open.
      const res = await net.fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
      return res.ok ? await res.text() : null
    } catch {
      return null
    }
  },
  offerRestart: async (version) => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Narrative',
      message: `Narrative ${version} is ready.`,
      detail:
        process.platform === 'linux' && !process.env['APPIMAGE']
          ? 'Installing asks for your password (system package).'
          : 'Restart Narrative to use it.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    return response === 0
  },
  report: (message, detail) => {
    void dialog.showMessageBox({
      type: 'info',
      title: 'Narrative',
      message,
      ...(detail !== undefined ? { detail } : {}),
    })
  },
})

/** A link or files the OS handed over; queued until the app is ready. */
function handleLaunch(payload: LaunchPayload): void {
  if (!launchReady) {
    launchQueue.push(payload)
    return
  }
  if (payload.deepLink !== null) void signIn.complete(payload.deepLink)
  for (const file of payload.files) void openFile(file)
}
// True while the main window is replaced for another server, so closing the
// old one does not quit the app.
let switchingServer = false

function currentOrigin(): string | null {
  return target === null ? null : serverOrigin(target)
}

function persist(next: Settings): void {
  settings = next
  try {
    saveSettings(userData, settings)
  } catch (err) {
    log.error('settings not saved', { err })
  }
}

function ensureMainWindow(): BrowserWindow | null {
  if (mainWindow !== null && !mainWindow.isDestroyed()) return mainWindow
  if (target === null) return null
  installPermissionHandlers(session.fromPartition(partitionFor(target)), serverOrigin(target))
  const win = createMainWindow({
    target,
    window: settings.window,
    distDir,
    devTools: !app.isPackaged,
    onBoundsSaved: (window) => persist({ ...settings, window }),
  })
  win.webContents.on('did-navigate', () => {
    webSections = []
    filesSubscribed = false
    applyMenu()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    for (const presenter of presenterWindows) presenter.close()
  })
  mainWindow = win
  return win
}

function applyMenu(): void {
  if (target === null) return
  const current = target
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildApplicationMenu({
        platform: process.platform,
        packaged: app.isPackaged,
        appName: app.getName(),
        server: current,
        lastCustomOrigin: settings.lastCustomOrigin,
        chooseServer: (next) => void switchServer(next),
        chooseCustomServer: () => {
          void chooseCustomServer(mainWindow, {
            distDir,
            initial: current.kind === 'custom' ? current.origin : (settings.lastCustomOrigin ?? ''),
            devTools: !app.isPackaged,
          }).then((origin) => {
            if (origin !== null) void switchServer({ kind: 'custom', origin })
          })
        },
        showAbout: () => {
          void dialog.showMessageBox({
            type: 'info',
            title: `About ${app.getName()}`,
            message: `${app.getName()} ${app.getVersion()}`,
            detail: `Server: ${serverOrigin(current)}\nElectron ${process.versions.electron}, Chromium ${process.versions.chrome}`,
          })
        },
        openLogsFolder: () => {
          void shell.openPath(app.getPath('logs'))
        },
        checkForUpdates: () => updates.check(true),
        webSections,
        runWebItem: (item) => {
          if (item.shell === 'openPptx') {
            void chooseFilesToImport()
            return
          }
          // Always the main window, never the focused one (the presenter popup).
          if (mainWindow !== null && !mainWindow.isDestroyed()) {
            menuRouter.dispatch(mainWindow.webContents, item)
          }
        },
      }),
    ),
  )
}

/**
 * Move the shell to another server: remember it, end what belonged to the
 * old one, and open the main window again in the new server's partition.
 */
async function switchServer(next: ServerTarget): Promise<void> {
  if (target !== null && serverOrigin(next) === serverOrigin(target)) return
  log.info('switching server', { from: currentOrigin(), to: serverOrigin(next) })
  persist({
    ...settings,
    server: next,
    lastCustomOrigin: next.kind === 'custom' ? next.origin : settings.lastCustomOrigin,
  })
  switchingServer = true
  try {
    signIn.cancel()
    // Files opened for the old server never go to the new one.
    openedFiles.clear()
    for (const presenter of presenterWindows) presenter.close()
    const old = mainWindow
    target = next
    mainWindow = null
    if (old !== null && !old.isDestroyed()) {
      await new Promise<void>((resolve) => {
        old.once('closed', () => resolve())
        old.close()
      })
    }
    ensureMainWindow()?.focus()
  } finally {
    switchingServer = false
  }
  applyMenu()
}

/** The partition id of a webContents the shell created. */
function partitionOf(wc: WebContents): string | null {
  if (target === null) return null
  const partition = partitionFor(target)
  return wc.session === session.fromPartition(partition) ? partition : null
}

// 8. A second launch focuses the existing window and hands over its link
//    and files (only the validated payload: Electron warns that argv there is
//    unreliable).
app.on('second-instance', (_event, _argv, _cwd, data) => {
  const win = ensureMainWindow()
  if (win !== null) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
  handleLaunch(validateLaunchPayload(data, scheme))
})

// 9. Every webContents, whoever creates it, gets the navigation rules.
app.on('web-contents-created', (_event, wc) => {
  applyWebContentsGuards(
    wc,
    {
      serverOrigin: currentOrigin,
      log,
      openPresenter: (url, partition) => {
        // One presenter view: another request brings it to the front.
        const existing = [...presenterWindows].find((w) => !w.isDestroyed())
        if (existing !== undefined) {
          existing.focus()
          return
        }
        const win = createPresenterWindow(url, partition, { devTools: !app.isPackaged })
        presenterWindows.add(win)
        win.on('closed', () => presenterWindows.delete(win))
      },
    },
    partitionOf,
  )
})

// A server asking for a client certificate gets none: Electron would
// otherwise hand it the first one in the store without asking.
app.on('select-client-certificate', (event, _wc, _url, _list, callback) => {
  event.preventDefault()
  callback()
})

// 10. Ready: settings, permissions, IPC, the window.
void app.whenReady().then(async () => {
  // A second instance only hands over and quits (step 7).
  if (!primary) return
  if (sandboxDisabled) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Narrative',
      message: 'Narrative cannot run without its sandbox here.',
      detail:
        'Install the .deb package instead of the AppImage (see the desktop app documentation).',
      buttons: ['Quit'],
    })
    app.quit()
    return
  }

  const loaded = loadSettings(userData)
  settings = loaded.settings
  if (loaded.setAside) log.warn('invalid settings set aside', { file: loaded.setAside })
  const override = app.isPackaged ? null : parseServerArg(process.argv)
  const chosen = override ?? settings.server
  target = chosen
  log.info('starting', {
    version: app.getVersion(),
    packaged: app.isPackaged,
    server: serverOrigin(chosen),
  })

  // Nothing the shell shows outside a server partition may ask for anything.
  installPermissionHandlers(session.defaultSession, null)

  const ipc = new IpcRegistry({
    mainContents: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null),
    serverOrigin: currentOrigin,
    log,
  })
  registerCoreIpc(ipc)
  ipc.on(DESKTOP_IPC.setMenu, setMenuRequest, (sections) => {
    webSections = sections
    applyMenu()
  })
  ipc.on(DESKTOP_IPC.menuActionResult, menuActionResult, ({ seq, handled }) =>
    menuRouter.answer(seq, handled),
  )
  ipc.on(DESKTOP_IPC.openFileSubscribe, noPayload, (_payload, event) => {
    filesSubscribed = true
    for (const file of openedFiles.waiting()) event.sender.send(DESKTOP_IPC.openFile, file)
  })
  ipc.handle(DESKTOP_IPC.openFileRead, openFileReadRequest, ({ id, offset, length }) =>
    openedFiles.read(id, offset, length),
  )
  ipc.on(DESKTOP_IPC.openFileConsumed, openFileConsumedRequest, ({ id }) => openedFiles.consume(id))
  ipc.handle(DESKTOP_IPC.placeForPresentation, screenRectRequest, (screen) =>
    mainWindow === null || mainWindow.isDestroyed()
      ? false
      : placeForPresentation(mainWindow, screen, log),
  )
  ipc.handle(DESKTOP_IPC.signIn, signInRequest, async ({ returnTo }) => {
    if (!canReceiveLinks()) {
      await dialog.showMessageBox({
        type: 'info',
        title: 'Narrative',
        message: 'Signing in needs the installed app on macOS.',
        detail:
          'macOS hands sign-in links only to an installed app bundle. Build one with `just desktop-dist`, or sign in on Linux or Windows.',
      })
      return 'refused'
    }
    return signIn.start(returnTo)
  })

  // An AppImage writes its .desktop entry before the scheme points at it.
  integrateAppImage(log, process.resourcesPath)
  registerScheme(log)
  applyMenu()
  ensureMainWindow()

  updates.start()

  launchReady = true
  for (const payload of [launch, ...launchQueue.splice(0)]) handleLaunch(payload)
})

// 11. Closing the last window quits, except on macOS, where the app stays
//     and a click on the dock icon brings the window back.
app.on('window-all-closed', () => {
  if (switchingServer) return
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (app.isReady()) ensureMainWindow()
})
