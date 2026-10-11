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
import type { ServerTarget } from './servers.js'

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
  return { label: 'View', submenu: items }
}

/** The shell's menu template (before the editor sends its sections). */
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
      { label: 'Edit', submenu: editRoles },
      viewMenu(ctx),
      { role: 'windowMenu' },
      { label: 'Help', submenu: [logs] },
    ]
  }
  return [
    { label: 'File', submenu: [serverMenu(ctx), { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: editRoles },
    viewMenu(ctx),
    {
      label: 'Help',
      submenu: [{ label: `About ${ctx.appName}`, click: () => ctx.showAbout() }, logs],
    },
  ]
}
