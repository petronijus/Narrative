/**
 * A PowerPoint file the operating system opens with the desktop app reaches
 * the import dialog (ADR 0014; apps/desktop/src/main/openFiles.ts,
 * apps/web/src/desktop/openedFiles.ts): on the command line at start, and
 * handed over by a second launch. A file that is no .pptx is refused in the
 * shell and never reaches the page. Needs the dev stack (`just dev`).
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from './fixtures/desktop'

const pptx = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/import-test.pptx')

test.describe('desktop opened files', () => {
  test('a file on the command line opens the import dialog', async ({ launchShell }) => {
    const shell = await launchShell('dev', [pptx])
    const dialog = shell.window.getByRole('dialog', { name: /Import PowerPoint deck/i })
    await expect(dialog).toBeVisible({ timeout: 20_000 })
    await expect(dialog).toContainText('import-test')
  })

  test('a second launch hands its file over', async ({ launchShell }) => {
    const shell = await launchShell('dev')
    await expect(shell.window.locator('body')).toBeVisible()
    await shell.app.evaluate(({ app }, file) => {
      app.emit('second-instance', {}, [], '', { deepLink: null, files: [file] })
    }, pptx)
    await expect(shell.window.getByRole('dialog', { name: /Import PowerPoint deck/i })).toBeVisible(
      {
        timeout: 20_000,
      },
    )
  })
})
