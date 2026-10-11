/**
 * main/linuxIntegration.ts
 *
 * An AppImage installs nothing, so on every start it integrates itself
 * (docs/plans/desktop-d0-spec.md §3.5): a `narrative.desktop` entry that
 * starts this AppImage (wherever it now lives) for narrative:// links and
 * offers it under "Open with" for .pptx, the icon, and narrative:// as that
 * entry's default. It never makes itself the default for .pptx. A missing
 * tool is logged, not fatal: the app runs, links just do not come back.
 */

import { execFile } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderDesktopEntry } from './desktopEntry.js'
import type { Logger } from './log.js'

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

function run(command: string, args: readonly string[], log: Logger): void {
  execFile(command, args, (err) => {
    if (err) log.warn(`${command} failed`, { err: err.message })
  })
}

/** Integrate the running AppImage; nothing to do for any other build. */
export function integrateAppImage(log: Logger, resourcesPath: string): void {
  const appImage = process.env['APPIMAGE']
  if (process.platform !== 'linux' || !appImage) return
  const data = process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local/share')
  const applications = path.join(data, 'applications')
  const icons = path.join(data, 'icons/hicolor/512x512/apps')
  try {
    mkdirSync(applications, { recursive: true })
    mkdirSync(icons, { recursive: true })
    copyFileSync(path.join(resourcesPath, 'icon.png'), path.join(icons, 'narrative.png'))
    writeFileSync(
      path.join(applications, 'narrative.desktop'),
      renderDesktopEntry({
        name: 'Narrative',
        exec: [appImage],
        fieldCode: '%U',
        mimeTypes: ['x-scheme-handler/narrative', PPTX_MIME],
        noDisplay: false,
        icon: 'narrative',
        categories: ['Office'],
      }),
    )
  } catch (err) {
    log.warn('AppImage integration failed', { err })
    return
  }
  run('update-desktop-database', [applications], log)
  run('xdg-mime', ['default', 'narrative.desktop', 'x-scheme-handler/narrative'], log)
}
