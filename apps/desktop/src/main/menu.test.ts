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

describe('application menu', () => {
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

  it('offers developer tools only in an unpackaged build', () => {
    const roles = (menu: MenuItemConstructorOptions[]) =>
      JSON.stringify(menu.map((m) => m.submenu)).includes('toggleDevTools')
    expect(roles(buildApplicationMenu(ctx({ packaged: true })))).toBe(false)
    expect(roles(buildApplicationMenu(ctx({ packaged: false })))).toBe(true)
  })
})
