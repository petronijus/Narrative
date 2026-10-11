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
 * Presenting on a chosen display is a web-app feature (the Window
 * Management API, ADR 0014 decision 8); the bridge adds one call for the
 * compositors where a page cannot place its own window (Wayland).
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
  /** invoke DesktopScreenRect → boolean */
  placeForPresentation: 'narrative:place-for-presentation',
} as const

export type DesktopIpcChannel = (typeof DESKTOP_IPC)[keyof typeof DESKTOP_IPC]

/** Which window a bridge belongs to; version 1 has only the main window. */
export type DesktopRole = 'main'

/** Edits the shell can run natively when the page does not handle a menu item. */
export type DesktopNativeEdit = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'delete' | 'selectAll'

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
  /** The key shown in the menu (Electron accelerator syntax); the shell accepts only the shared table's. */
  accelerator?: string
  /** A key the item presses without showing it (a bare key would compete with typing on macOS). */
  chord?: string
  /** What the shell does itself when the page reports the action unhandled. */
  nativeFallback?: DesktopNativeEdit
  /** A shell-side item (the file dialog for importing PowerPoint). */
  shell?: 'openPptx'
}

export type DesktopMenuEntry = DesktopMenuItem | 'separator'

/**
 * The keys of the editor's menu items, per catalog action, and the native
 * edit the shell runs when the page leaves the key unhandled (a text field).
 * One table for both sides: the editor builds its menu from it, the shell
 * refuses anything else (a page never binds its own keys, Quit or Reload).
 * `accelerator` is shown in the menu and always carries CmdOrCtrl: on macOS a
 * menu key is a live key equivalent, and a bare key (`=`, `Delete`) would
 * compete with typing. Such keys are a `chord`: pressed when the item is
 * chosen, never shown or registered.
 */
export const DESKTOP_MENU_ACCELERATORS: Readonly<
  Record<string, { accelerator?: string; chord?: string; nativeFallback?: DesktopNativeEdit }>
> = {
  'history.undo': { accelerator: 'CmdOrCtrl+Z', nativeFallback: 'undo' },
  'history.redo': { accelerator: 'Shift+CmdOrCtrl+Z', nativeFallback: 'redo' },
  'object.cut': { accelerator: 'CmdOrCtrl+X', nativeFallback: 'cut' },
  'object.copy': { accelerator: 'CmdOrCtrl+C', nativeFallback: 'copy' },
  'object.paste': { accelerator: 'CmdOrCtrl+V', nativeFallback: 'paste' },
  'object.duplicate': { accelerator: 'CmdOrCtrl+D' },
  'object.delete': { chord: 'Delete', nativeFallback: 'delete' },
  'view.zoomIn': { chord: '=' },
  'view.zoomOut': { chord: '-' },
  'selection.all': { accelerator: 'CmdOrCtrl+A', nativeFallback: 'selectAll' },
  'view.resetZoom': { accelerator: 'CmdOrCtrl+0' },
  'view.shortcuts': { accelerator: 'CmdOrCtrl+/' },
  'object.group': { accelerator: 'CmdOrCtrl+G' },
  'object.ungroup': { accelerator: 'Shift+CmdOrCtrl+G' },
  'present.start': { accelerator: 'CmdOrCtrl+Enter' },
}

/** The largest menu the shell accepts from a page. */
export const DESKTOP_MENU_MAX_ITEMS = 40

export interface DesktopMenuSection {
  id: 'file' | 'edit' | 'view' | 'arrange' | 'present'
  label: string
  items: readonly DesktopMenuEntry[]
}

/** A display's area as the Window Management API gives it (logical pixels). */
export interface DesktopScreenRect {
  left: number
  top: number
  width: number
  height: number
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
  /**
   * Start the sign-in in the system browser (ADR 0014). 'refused' within a
   * few seconds of the last start, or when the shell cannot take the answer
   * (an unpackaged build on macOS); a new start replaces a pending one.
   */
  signIn(req: { returnTo: string }): Promise<'opened' | 'refused'>
  setMenu(sections: readonly DesktopMenuSection[]): void
  /** The handler returns whether it handled the action; unhandled ones get the native fallback. */
  onMenuAction(handler: (action: string, accelerator: string | undefined) => boolean): () => void
  onOpenFile(handler: (file: DesktopOpenedFile) => void): () => void
  readOpenFile(id: string, offset: number, length: number): Promise<Uint8Array>
  consumeOpenFile(id: string): void
  /**
   * Move the main window onto the display at `screen` before it goes
   * fullscreen there, where the page cannot (Hyprland). False when the shell
   * has nothing to do or cannot: the page then goes fullscreen as usual.
   */
  placeForPresentation(screen: DesktopScreenRect): Promise<boolean>
}
