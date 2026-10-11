import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { buildApplicationMenu, type MenuContext } from './menu.js'

function ctx(overrides: Partial<MenuContext> = {}): MenuContext {
  return {
    platform: 'linux',
    packaged: true,
    appName: 'Narrative',
    server: { kind: 'production' },
    lastCustomOrigin: null,
    chooseServer: vi.fn(),
    chooseCustomServer: vi.fn(),
    showAbout: vi.fn(),
    openLogsFolder: vi.fn(),
    checkForUpdates: vi.fn(),
    webSections: [],
    runWebItem: vi.fn(),
    ...overrides,
  }
}

function find(
  items: readonly MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions | undefined {
  for (const item of items) {
    if (item.label === label) return item
    if (Array.isArray(item.submenu)) {
      const hit = find(item.submenu, label)
      if (hit) return hit
    }
  }
  return undefined
}

const click = (item: MenuItemConstructorOptions | undefined): void => (item?.click as () => void)()

const EDITOR: MenuContext['webSections'] = [
  {
    id: 'edit',
    label: 'Edit',
    items: [
      { action: 'history.undo', label: 'Undo', accelerator: 'CmdOrCtrl+Z', nativeFallback: 'undo' },
      'separator',
      { action: 'object.delete', label: 'Delete' },
    ],
  },
  { id: 'arrange', label: 'Arrange', items: [{ action: 'object.group', label: 'Group' }] },
]

describe('application menu', () => {
  it('uses the edit roles until the editor sends its menu, then the editor items', () => {
    expect(JSON.stringify(buildApplicationMenu(ctx()))).toContain('"role":"undo"')
    expect(find(buildApplicationMenu(ctx()), 'Arrange')).toBeUndefined()
    const c = ctx({ webSections: EDITOR })
    const menu = buildApplicationMenu(c)
    expect(JSON.stringify(menu)).not.toContain('"role":"undo"')
    expect(find(menu, 'Arrange')).toBeDefined()
    click(find(menu, 'Undo'))
    expect(c.runWebItem).toHaveBeenCalledWith(EDITOR[0]!.items[0])
  })

  it('registers editor keys only on macOS, where they are key equivalents', () => {
    const linux = find(buildApplicationMenu(ctx({ webSections: EDITOR })), 'Undo')
    expect(linux).toMatchObject({ accelerator: 'CmdOrCtrl+Z', registerAccelerator: false })
    const mac = find(buildApplicationMenu(ctx({ platform: 'darwin', webSections: EDITOR })), 'Undo')
    expect(mac).toMatchObject({ accelerator: 'CmdOrCtrl+Z', registerAccelerator: true })
    expect(
      find(buildApplicationMenu(ctx({ webSections: EDITOR })), 'Delete')?.accelerator,
    ).toBeUndefined()
  })

  it('offers the servers with the current one checked', () => {
    const c = ctx({
      server: { kind: 'custom', origin: 'https://narrative.example.com' },
    })
    const menu = buildApplicationMenu(c)
    expect(find(menu, 'Production')?.checked).toBe(false)
    expect(find(menu, 'narrative.example.com')?.checked).toBe(true)
    click(find(menu, 'Development (this computer)'))
    expect(c.chooseServer).toHaveBeenCalledWith({ kind: 'development' })
    click(find(menu, 'Custom Server…'))
    expect(c.chooseCustomServer).toHaveBeenCalled()
  })

  it('offers the last custom server again after switching away', () => {
    const c = ctx({ lastCustomOrigin: 'http://127.0.0.1:5173' })
    const menu = buildApplicationMenu(c)
    expect(find(menu, 'Production')?.checked).toBe(true)
    click(find(menu, '127.0.0.1:5173'))
    expect(c.chooseServer).toHaveBeenCalledWith({ kind: 'custom', origin: 'http://127.0.0.1:5173' })
  })

  it('puts the server choice under File on Linux and Windows, under the app menu on macOS', () => {
    const linux = buildApplicationMenu(ctx())
    expect(linux[0]!.label).toBe('File')
    expect(find([linux[0]!], 'Server')).toBeDefined()
    const mac = buildApplicationMenu(ctx({ platform: 'darwin' }))
    expect(mac[0]!.label).toBe('Narrative')
    expect(find([mac[0]!], 'Server')).toBeDefined()
  })

  it('offers a check for updates on every platform', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const c = ctx({ platform })
      click(find(buildApplicationMenu(c), 'Check for Updates…'))
      expect(c.checkForUpdates).toHaveBeenCalledOnce()
    }
  })

  it('offers developer tools only in an unpackaged build', () => {
    const roles = (menu: MenuItemConstructorOptions[]) =>
      JSON.stringify(menu.map((m) => m.submenu)).includes('toggleDevTools')
    expect(roles(buildApplicationMenu(ctx({ packaged: true })))).toBe(false)
    expect(roles(buildApplicationMenu(ctx({ packaged: false })))).toBe(true)
  })
})
