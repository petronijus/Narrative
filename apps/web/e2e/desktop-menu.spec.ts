/**
 * The desktop app's menu runs the editor's own shortcuts (ADR 0014;
 * apps/web/src/desktop/menu.ts, state/useShortcuts.ts runChord/runAction):
 * Edit ▸ Select All, Delete and Undo do on the canvas what their keys do,
 * and in a text field a menu edit falls back to the native one. Needs the
 * dev stack (`just dev`).
 */

import { expect, test, type DesktopShell } from './fixtures/desktop'
import { provisionDeckWithText } from './fixtures/provisionDeck'

const WEB = 'http://localhost:5173'

function clickMenu(shell: DesktopShell, id: string): Promise<boolean> {
  return shell.app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId)
    if (!item) return false
    item.click()
    return true
  }, id)
}

function objectCount(shell: DesktopShell, slideId: string): Promise<number> {
  return shell.window.evaluate(
    (sid) => window.__narrative_test_api?.objectIds(sid).length ?? -1,
    slideId,
  )
}

test.describe('desktop menu', () => {
  test('runs Select All, Delete and Undo as their keys do', async ({ launchShell }) => {
    const shell = await launchShell('dev')
    const deck = await provisionDeckWithText(shell.window, {
      origin: WEB,
      title: 'e2e-desktop-menu',
    })
    await expect.poll(() => clickMenu(shell, 'web.history.undo')).toBe(true)
    expect(await objectCount(shell, deck.slideId)).toBe(1)

    // The canvas has the ambient scope; nothing is focused in a field.
    await shell.window.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    expect(await clickMenu(shell, 'web.selection.all')).toBe(true)
    expect(await clickMenu(shell, 'web.object.delete')).toBe(true)
    await expect.poll(() => objectCount(shell, deck.slideId)).toBe(0)
    expect(await clickMenu(shell, 'web.history.undo')).toBe(true)
    await expect.poll(() => objectCount(shell, deck.slideId)).toBe(1)
  })

  test('falls back to the native edit in a text field', async ({ launchShell }) => {
    const shell = await launchShell('dev')
    await provisionDeckWithText(shell.window, { origin: WEB, title: 'e2e-desktop-menu-field' })
    await expect.poll(() => clickMenu(shell, 'web.selection.all')).toBe(true)
    await shell.window.evaluate(() => {
      const input = document.createElement('input')
      input.id = 'e2e-field'
      input.value = 'select me'
      document.body.append(input)
      input.focus()
      input.setSelectionRange(0, 0)
    })
    expect(await clickMenu(shell, 'web.selection.all')).toBe(true)
    await expect
      .poll(() =>
        shell.window.evaluate(() => {
          const input = document.getElementById('e2e-field') as HTMLInputElement
          return [input.selectionStart, input.selectionEnd]
        }),
      )
      .toEqual([0, 'select me'.length])
  })

  test('shows only the shell’s own items on a page that sent no menu', async ({
    stubServer,
    launchShell,
  }) => {
    const server = await stubServer()
    const shell = await launchShell(server.origin)
    await expect(shell.window.locator('h1')).toHaveText('stub')
    expect(
      await shell.app.evaluate(
        ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('web.history.undo') ?? null,
      ),
    ).toBeNull()
    expect(
      await shell.app.evaluate(({ Menu }) =>
        Boolean(Menu.getApplicationMenu()?.getMenuItemById('server.choose')),
      ),
    ).toBe(true)
  })
})
