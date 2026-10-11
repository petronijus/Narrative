/**
 * serverDialog/preload.ts
 *
 * The "Custom Server…" window's preload: three calls and nothing else. The
 * main process accepts them only from that window (main/serverDialog.ts).
 */

import { contextBridge, ipcRenderer } from 'electron'
import { SERVER_DIALOG_IPC } from './channels.js'

contextBridge.exposeInMainWorld('narrativeServerDialog', {
  initial: () => ipcRenderer.invoke(SERVER_DIALOG_IPC.initial) as Promise<string>,
  submit: (origin: string) =>
    ipcRenderer.invoke(SERVER_DIALOG_IPC.submit, String(origin)) as Promise<
      { ok: true } | { ok: false; error: string }
    >,
  cancel: () => ipcRenderer.send(SERVER_DIALOG_IPC.cancel),
})
