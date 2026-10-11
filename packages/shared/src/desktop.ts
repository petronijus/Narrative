/**
 * desktop.ts
 *
 * The contract between the desktop shell (apps/desktop, Electron) and the
 * web editor it loads from the server (ADR 0014,
 * docs/plans/desktop-d0-spec.md §2). Kept in @narrative/shared so neither
 * app imports the other. Types and constants only.
 *
 * The shell's preload exposes `window.narrativeDesktop` to the server's
 * pages in the main window and nowhere else. The server versions the editor
 * and each install versions its shell, so the two meet in any combination:
 * the editor feature-detects with `bridgeVersion`, and a later bridge only
 * adds methods and raises the version — it never changes or removes one.
 *
 * Presenting on a chosen display is not here: it is a web-app feature
 * (the Window Management API, ADR 0014 decision 8) that the shell supports
 * through its window handlers, without a bridge call.
 */

export const DESKTOP_BRIDGE_VERSION = 1 as const

/** IPC channel names; only the shell's main process and its preload use them. */
export const DESKTOP_IPC = {
  /** invoke → DesktopInfo */
  info: 'narrative:info',
  /** invoke { returnTo } → 'opened' | 'refused' */
  signIn: 'narrative:sign-in',
  /** send DesktopMenuSection[] ([] resets to the shell's own menu) */
  setMenu: 'narrative:set-menu',
  /** main → page { seq, action, accelerator? } */
  menuAction: 'narrative:menu-action',
  /** send { seq, handled } */
  menuActionResult: 'narrative:menu-action-result',
  /** send: the page is ready for opened files */
  openFileSubscribe: 'narrative:open-file-subscribe',
  /** main → page DesktopOpenedFile */
  openFile: 'narrative:open-file',
  /** invoke { id, offset, length } → Uint8Array */
  openFileRead: 'narrative:open-file-read',
  /** send { id } */
  openFileConsumed: 'narrative:open-file-consumed',
} as const

export type DesktopIpcChannel = (typeof DESKTOP_IPC)[keyof typeof DESKTOP_IPC]

/** Which window a bridge belongs to; version 1 has only the main window. */
export type DesktopRole = 'main'

/** Edits the shell can run natively when the page does not handle a menu item. */
export type DesktopNativeEdit = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll'

export interface DesktopInfo {
  appVersion: string
  platform: 'darwin' | 'win32' | 'linux'
  role: DesktopRole
}

/** The longest menu label the shell accepts. */
export const DESKTOP_MENU_LABEL_MAX = 64

export interface DesktopMenuItem {
  /** An action id of the editor's catalog (apps/web/src/actions/catalog.ts). */
  action: string
  label: string
  /** Electron accelerator syntax; the shell accepts only its own allowlist. */
  accelerator?: string
  /** What the shell does itself when the page reports the action unhandled. */
  nativeFallback?: DesktopNativeEdit
  /** A shell-side item (the file dialog for importing PowerPoint). */
  shell?: 'openPptx'
}

export type DesktopMenuEntry = DesktopMenuItem | 'separator'

export interface DesktopMenuSection {
  id: 'file' | 'edit' | 'view' | 'arrange' | 'present'
  label: string
  items: readonly DesktopMenuEntry[]
}

/** A .pptx the operating system handed to the app (file association, dock drop). */
export interface DesktopOpenedFile {
  id: string
  name: string
  size: number
}

/** The largest chunk `readOpenFile` returns. */
export const DESKTOP_OPEN_FILE_CHUNK = 8 * 1024 * 1024

/** `window.narrativeDesktop` in the shell's main window. */
export interface NarrativeDesktopBridge {
  readonly bridgeVersion: typeof DESKTOP_BRIDGE_VERSION
  readonly role: DesktopRole
  info(): Promise<DesktopInfo>
  /** Start the sign-in in the system browser (ADR 0014); 'refused' while one is pending. */
  signIn(req: { returnTo: string }): Promise<'opened' | 'refused'>
  setMenu(sections: readonly DesktopMenuSection[]): void
  /** The handler returns whether it handled the action; unhandled ones get the native fallback. */
  onMenuAction(handler: (action: string, accelerator: string | undefined) => boolean): () => void
  onOpenFile(handler: (file: DesktopOpenedFile) => void): () => void
  readOpenFile(id: string, offset: number, length: number): Promise<Uint8Array>
  consumeOpenFile(id: string): void
}
