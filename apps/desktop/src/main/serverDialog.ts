/**
 * main/serverDialog.ts
 *
 * The "Custom Server…" window (docs/plans/desktop-d0-spec.md §3.8): a local
 * page in an in-memory partition with every permission denied, a CSP that
 * admits only its own script, and a preload with three calls. The address is
 * validated here, not trusted from the page; choosing one still asks for
 * confirmation, because the server sees everything done in the app.
 */

import { BrowserWindow, dialog, ipcMain, session } from 'electron'
import path from 'node:path'
import { SERVER_DIALOG_IPC } from '../serverDialog/channels.js'
import { installPermissionHandlers } from './permissions.js'
import { normalizeCustomOrigin } from './servers.js'

/** The partition of the shell's local pages: in memory, never a server's. */
export const LOCAL_PARTITION = 'narrative-local'

const INVALID_ORIGIN =
  'Enter the address of a server, such as https://narrative.example.com. ' +
  'Plain http works only for localhost.'

/**
 * Ask for a custom server; resolves with its origin once confirmed, or null
 * when cancelled. One dialog at a time: a second call focuses the first.
 */
let open: { win: BrowserWindow; result: Promise<string | null> } | null = null

export function chooseCustomServer(
  parent: BrowserWindow | null,
  opts: { distDir: string; initial: string; devTools: boolean },
): Promise<string | null> {
  if (open !== null && !open.win.isDestroyed()) {
    open.win.focus()
    return open.result
  }

  const local = session.fromPartition(LOCAL_PARTITION)
  installPermissionHandlers(local, null)

  const win = new BrowserWindow({
    width: 480,
    height: 250,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Custom Server',
    autoHideMenuBar: true,
    ...(parent ? { parent, modal: process.platform === 'darwin' } : {}),
    webPreferences: {
      partition: LOCAL_PARTITION,
      preload: path.join(opts.distDir, 'serverDialogPreload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
      devTools: opts.devTools,
    },
  })
  // The page loads its own file and goes nowhere else.
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  const fromDialog = (sender: Electron.WebContents): boolean => sender === win.webContents

  const result = new Promise<string | null>((resolve) => {
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      ipcMain.removeHandler(SERVER_DIALOG_IPC.initial)
      ipcMain.removeHandler(SERVER_DIALOG_IPC.submit)
      ipcMain.removeListener(SERVER_DIALOG_IPC.cancel, onCancel)
      if (!win.isDestroyed()) win.close()
      resolve(value)
    }
    const onCancel = (event: Electron.IpcMainEvent): void => {
      if (fromDialog(event.sender)) finish(null)
    }

    ipcMain.handle(SERVER_DIALOG_IPC.initial, (event) =>
      fromDialog(event.sender) ? opts.initial : '',
    )
    ipcMain.handle(SERVER_DIALOG_IPC.submit, async (event, raw: unknown) => {
      if (!fromDialog(event.sender) || typeof raw !== 'string' || raw.length > 2048) {
        return { ok: false, error: INVALID_ORIGIN }
      }
      const origin = normalizeCustomOrigin(raw)
      if (origin === null) return { ok: false, error: INVALID_ORIGIN }
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Use This Server', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Custom Server',
        message: `Narrative will load ${origin}.`,
        detail:
          'That server can see your work in Narrative and the PowerPoint files you open with it. ' +
          'Only use servers you trust.',
      })
      if (response !== 0) return { ok: false, error: '' }
      finish(origin)
      return { ok: true }
    })
    ipcMain.on(SERVER_DIALOG_IPC.cancel, onCancel)
    win.on('closed', () => {
      finish(null)
      open = null
    })
  })

  win.once('ready-to-show', () => win.show())
  void win.loadFile(path.join(opts.distDir, 'serverDialog.html'))
  open = { win, result }
  return result
}
