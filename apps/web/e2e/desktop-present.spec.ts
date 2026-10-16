/**
 * The presentation's Display choice in the desktop app (ADR 0015 decision
 * 8; apps/web/src/present/): the shell grants window management to its
 * server, so the choice is offered; on a machine with one display it says
 * so instead of listing one. Needs the dev stack (`just dev`).
 */

import { expect, test } from './fixtures/desktop'
import { provisionDeckWithText } from './fixtures/provisionDeck'

test('offers the presentation display, granted by the shell', async ({ launchShell }) => {
  const shell = await launchShell('dev')
  const deck = await provisionDeckWithText(shell.window, {
    origin: 'http://localhost:5173',
    title: 'e2e-desktop-present',
  })
  await shell.window.goto(`http://localhost:5173${deck.deckUrl}/present`)
  const display = shell.window.getByRole('button', { name: 'Display' })
  await expect(display).toBeVisible({ timeout: 20_000 })
  await display.click()
  await expect(shell.window.getByRole('status')).toHaveText(/Only one display is connected/)
  expect(
    await shell.window.evaluate(() =>
      navigator.permissions
        .query({ name: 'window-management' as PermissionName })
        .then((s) => s.state),
    ),
  ).toBe('granted')
})
