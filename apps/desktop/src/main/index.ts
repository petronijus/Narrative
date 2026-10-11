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
import { applyWebContentsGuards, createPresenterWindow } from './guards.js'
import { IpcRegistry, registerCoreIpc } from './ipc.js'
import { createLogger, type Logger } from './log.js'
import { buildApplicationMenu } from './menu.js'
import { installPermissionHandlers } from './permissions.js'
import { chooseCustomServer } from './serverDialog.js'
import { parseServerArg, partitionFor, serverOrigin, type ServerTarget } from './servers.js'
import { loadSettings, saveSettings, type Settings } from './settings.js'
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

// 7. One instance: a second launch hands over to the first and quits.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

const distDir = __dirname
const userData = app.getPath('userData')
let settings: Settings
// Set once settings are read (whenReady); null before, when nothing may load.
let target: ServerTarget | null = null
let mainWindow: BrowserWindow | null = null
const presenterWindows = new Set<BrowserWindow>()
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

// 8. A second launch focuses the existing window.
app.on('second-instance', () => {
  const win = ensureMainWindow()
  if (win === null) return
  if (win.isMinimized()) win.restore()
  win.focus()
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

  registerCoreIpc(
    new IpcRegistry({
      mainContents: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null),
      serverOrigin: currentOrigin,
      log,
    }),
  )

  applyMenu()
  ensureMainWindow()
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
