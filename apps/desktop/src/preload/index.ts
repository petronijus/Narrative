/**
 * preload/index.ts
 *
 * The main window's preload: exposes `window.narrativeDesktop`
 * (NarrativeDesktopBridge, packages/shared/src/desktop.ts) to the server's
 * pages. Every method is a thin IPC call; the main process validates every
 * payload and checks every sender (src/main/ipc.ts). Nothing else crosses:
 * no `ipcRenderer`, no channel names, no Node globals.
 *
 * Bundled by scripts/build.mjs into one CommonJS file whose only require is
 * `electron` (a sandboxed preload may load nothing else).
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  DESKTOP_BRIDGE_VERSION,
  DESKTOP_IPC,
  type DesktopInfo,
  type DesktopMenuSection,
  type DesktopOpenedFile,
  type NarrativeDesktopBridge,
} from '@narrative/shared'

interface MenuActionMessage {
  seq: number
  action: string
  accelerator?: string
}

const menuHandlers = new Set<(action: string, accelerator: string | undefined) => boolean>()
const openFileHandlers = new Set<(file: DesktopOpenedFile) => void>()

// Every menu action gets an answer, so the main process can run the native
// fallback (undo, copy, …) when no page handler took it.
ipcRenderer.on(DESKTOP_IPC.menuAction, (_event: IpcRendererEvent, message: MenuActionMessage) => {
  let handled = false
  for (const handler of menuHandlers) {
    try {
      if (handler(message.action, message.accelerator)) handled = true
    } catch (err) {
      console.error('[narrative-desktop] menu handler failed', err)
    }
  }
  ipcRenderer.send(DESKTOP_IPC.menuActionResult, { seq: message.seq, handled })
})

ipcRenderer.on(DESKTOP_IPC.openFile, (_event: IpcRendererEvent, file: DesktopOpenedFile) => {
  for (const handler of openFileHandlers) handler(file)
})

const bridge: NarrativeDesktopBridge = {
  bridgeVersion: DESKTOP_BRIDGE_VERSION,
  role: 'main',
  info: () => ipcRenderer.invoke(DESKTOP_IPC.info) as Promise<DesktopInfo>,
  signIn: (req) =>
    ipcRenderer.invoke(DESKTOP_IPC.signIn, { returnTo: req.returnTo }) as Promise<
      'opened' | 'refused'
    >,
  setMenu: (sections: readonly DesktopMenuSection[]) =>
    ipcRenderer.send(DESKTOP_IPC.setMenu, sections),
  onMenuAction: (handler) => {
    menuHandlers.add(handler)
    return () => {
      menuHandlers.delete(handler)
    }
  },
  onOpenFile: (handler) => {
    const first = openFileHandlers.size === 0
    openFileHandlers.add(handler)
    // The main process holds files opened before the page was ready and
    // hands them over once someone listens.
    if (first) ipcRenderer.send(DESKTOP_IPC.openFileSubscribe)
    return () => {
      openFileHandlers.delete(handler)
    }
  },
  readOpenFile: (id, offset, length) =>
    ipcRenderer.invoke(DESKTOP_IPC.openFileRead, { id, offset, length }) as Promise<Uint8Array>,
  consumeOpenFile: (id) => ipcRenderer.send(DESKTOP_IPC.openFileConsumed, { id }),
  placeForPresentation: (screen) =>
    ipcRenderer.invoke(DESKTOP_IPC.placeForPresentation, {
      left: Math.round(screen.left),
      top: Math.round(screen.top),
      width: Math.round(screen.width),
      height: Math.round(screen.height),
    }) as Promise<boolean>,
}

contextBridge.exposeInMainWorld('narrativeDesktop', bridge)
