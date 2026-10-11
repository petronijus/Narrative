/**
 * main/index.ts
 *
 * The desktop shell's entry (ADR 0014, docs/plans/desktop-d0-spec.md §3.1).
 * Everything before `whenReady` runs at module top level, in this order,
 * because Electron reads it before the first window exists: the sandbox for
 * every renderer, a separate identity for an unpackaged build, the refusal
 * of debugging switches in a packaged one, and the single-instance lock.
 */

import { app, dialog, Menu, session, shell, type BrowserWindow, type WebContents } from 'electron'
import { DESKTOP_IPC } from '@narrative/shared'
import {
  capLaunchPayload,
  parseLaunchArgs,
  validateLaunchPayload,
  type LaunchPayload,
} from './deepLinks.js'
import { applyWebContentsGuards, createPresenterWindow } from './guards.js'
import { IpcRegistry, registerCoreIpc } from './ipc.js'
import { menuActionResult, setMenuRequest, signInRequest, type MenuSections } from './ipcSchemas.js'
import { createLogger, type Logger } from './log.js'
import { buildApplicationMenu } from './menu.js'
import { MenuRouter } from './menuRouting.js'
import { installPermissionHandlers } from './permissions.js'
import { activeScheme, canReceiveLinks, registerScheme } from './protocol.js'
import { redeemInHiddenWindow } from './redeemWindow.js'
import { chooseCustomServer } from './serverDialog.js'
import { apiUrl, parseServerArg, partitionFor, serverOrigin, type ServerTarget } from './servers.js'
import { loadSettings, saveSettings, type Settings } from './settings.js'
import { SignInController } from './signIn.js'
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

// 3. A packaged build refuses remote debugging (no fuse covers it) and a
//    disabled sandbox (Ubuntu's AppImage launcher adds --no-sandbox when it
//    cannot use user namespaces): both would hand the editor's session to
//    anything on the machine.
if (
  app.isPackaged &&
  (app.commandLine.hasSwitch('remote-debugging-port') ||
    app.commandLine.hasSwitch('remote-debugging-pipe'))
) {
  log.error('refusing to start with remote debugging')
  app.exit(1)
}
const sandboxDisabled = app.isPackaged && app.commandLine.hasSwitch('no-sandbox')

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

/** A link or files the OS handed over; queued until the app is ready. */
function handleLaunch(payload: LaunchPayload): void {
  if (!launchReady) {
    launchQueue.push(payload)
    return
  }
  if (payload.deepLink !== null) void signIn.complete(payload.deepLink)
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
        webSections,
        runWebItem: (item) => {
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
        const win = createPresenterWindow(url, partition, { devTools: !app.isPackaged })
        presenterWindows.add(win)
        win.on('closed', () => presenterWindows.delete(win))
      },
    },
    partitionOf,
  )
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

  registerScheme(log)
  applyMenu()
  ensureMainWindow()

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
