/**
 * main/menu.ts
 *
 * The application menu (docs/plans/desktop-d0-spec.md §3.7). The shell owns
 * its own items — the server choice, About, the logs folder, reload, the
 * developer tools of an unpackaged build, quitting — and the standard edit
 * roles; the editor's own sections (File, Edit, View, Arrange, Present) come
 * from the page through `setMenu` and are merged in by `webSections`.
 *
 * Pure: the template is built from data and callbacks, so it is tested
 * without Electron; index.ts turns it into a `Menu`. The shell's own items
 * carry ids (`server.*`), which the Electron e2e specs click by.
 */

import type { MenuItemConstructorOptions } from 'electron'
import type { MenuSections } from './ipcSchemas.js'
import type { ServerTarget } from './servers.js'

type WebSection = MenuSections[number]
export type WebMenuItem = Exclude<WebSection['items'][number], 'separator'>

export interface MenuContext {
  platform: NodeJS.Platform
  packaged: boolean
  appName: string
  server: ServerTarget
  /** The custom origin last used, offered again under Server ▸. */
  lastCustomOrigin: string | null
  chooseServer(target: ServerTarget): void
  chooseCustomServer(): void
  showAbout(): void
  openLogsFolder(): void
  /** The editor's sections, as its page last sent them (empty: the shell's own menu). */
  webSections: MenuSections
  /** A click on one of the editor's items. */
  runWebItem(item: WebMenuItem): void
}

/**
 * The editor's items. On Linux and Windows a key is shown but not
 * registered, so keys reach only the page; on macOS a menu key is a key
 * equivalent, which fires when the page did not prevent the key.
 */
function webItems(section: WebSection | undefined, ctx: MenuContext): MenuItemConstructorOptions[] {
  if (section === undefined) return []
  return section.items.map((entry): MenuItemConstructorOptions => {
    if (entry === 'separator') return { type: 'separator' }
    return {
      id: `web.${entry.action}`,
      label: entry.label,
      ...(entry.accelerator !== undefined
        ? { accelerator: entry.accelerator, registerAccelerator: ctx.platform === 'darwin' }
        : {}),
      click: () => ctx.runWebItem(entry),
    }
  })
}

function section(ctx: MenuContext, id: WebSection['id']): WebSection | undefined {
  return ctx.webSections.find((s) => s.id === id)
}

/** A web section with the shell's own items appended after a separator. */
function withShellItems(
  label: string,
  web: MenuItemConstructorOptions[],
  shell: MenuItemConstructorOptions[],
): MenuItemConstructorOptions {
  const submenu =
    web.length > 0 && shell.length > 0
      ? [...web, { type: 'separator' as const }, ...shell]
      : [...web, ...shell]
  return { label, submenu }
}

function serverMenu(ctx: MenuContext): MenuItemConstructorOptions {
  const custom = ctx.server.kind === 'custom' ? ctx.server.origin : ctx.lastCustomOrigin
  const items: MenuItemConstructorOptions[] = [
    {
      id: 'server.production',
      label: 'Production',
      type: 'radio',
      checked: ctx.server.kind === 'production',
      click: () => ctx.chooseServer({ kind: 'production' }),
    },
    {
      id: 'server.development',
      label: 'Development (this computer)',
      type: 'radio',
      checked: ctx.server.kind === 'development',
      click: () => ctx.chooseServer({ kind: 'development' }),
    },
  ]
  if (custom !== null) {
    items.push({
      id: 'server.custom',
      label: new URL(custom).host,
      type: 'radio',
      checked: ctx.server.kind === 'custom',
      click: () => ctx.chooseServer({ kind: 'custom', origin: custom }),
    })
  }
  items.push(
    { type: 'separator' },
    { id: 'server.choose', label: 'Custom Server…', click: () => ctx.chooseCustomServer() },
  )
  return { label: 'Server', submenu: items }
}

const editRoles: MenuItemConstructorOptions[] = [
  { role: 'undo' },
  { role: 'redo' },
  { type: 'separator' },
  { role: 'cut' },
  { role: 'copy' },
  { role: 'paste' },
  { role: 'selectAll' },
]

function viewMenu(ctx: MenuContext): MenuItemConstructorOptions {
  const items: MenuItemConstructorOptions[] = [{ role: 'reload' }]
  if (!ctx.packaged) items.push({ role: 'toggleDevTools' })
  items.push({ type: 'separator' }, { role: 'togglefullscreen' })
  return withShellItems('View', webItems(section(ctx, 'view'), ctx), items)
}

/** Edit: the editor's items once it sent them, the standard roles before (and on any other page). */
function editMenu(ctx: MenuContext): MenuItemConstructorOptions {
  const web = webItems(section(ctx, 'edit'), ctx)
  return { label: 'Edit', submenu: web.length > 0 ? web : editRoles }
}

/** Arrange and Present, present only while the editor sends them. */
function editorMenus(ctx: MenuContext): MenuItemConstructorOptions[] {
  return (['arrange', 'present'] as const).flatMap((id) => {
    const s = section(ctx, id)
    return s === undefined ? [] : [{ label: s.label, submenu: webItems(s, ctx) }]
  })
}

/** File: the editor's items, then the shell's (none on macOS, where they live in the app menu). */
function fileMenu(
  ctx: MenuContext,
  shell: MenuItemConstructorOptions[],
): MenuItemConstructorOptions[] {
  const web = webItems(section(ctx, 'file'), ctx)
  if (web.length === 0 && shell.length === 0) return []
  return [withShellItems('File', web, shell)]
}

/** The application menu: the shell's items with the editor's sections merged in. */
export function buildApplicationMenu(ctx: MenuContext): MenuItemConstructorOptions[] {
  const logs: MenuItemConstructorOptions = {
    label: 'Open Logs Folder',
    click: () => ctx.openLogsFolder(),
  }
  if (ctx.platform === 'darwin') {
    return [
      {
        label: ctx.appName,
        submenu: [
          { label: `About ${ctx.appName}`, click: () => ctx.showAbout() },
          serverMenu(ctx),
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      ...fileMenu(ctx, []),
      editMenu(ctx),
      viewMenu(ctx),
      ...editorMenus(ctx),
      { role: 'windowMenu' },
      { label: 'Help', submenu: [logs] },
    ]
  }
  return [
    ...fileMenu(ctx, [serverMenu(ctx), { type: 'separator' }, { role: 'quit' }]),
    editMenu(ctx),
    viewMenu(ctx),
    ...editorMenus(ctx),
    {
      label: 'Help',
      submenu: [{ label: `About ${ctx.appName}`, click: () => ctx.showAbout() }, logs],
    },
  ]
}
