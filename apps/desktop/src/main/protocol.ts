/**
 * main/protocol.ts
 *
 * The custom scheme that brings the sign-in back from the browser
 * (docs/plans/desktop-d0-spec.md §3.5). A packaged build registers
 * `narrative` (macOS through its Info.plist, Windows through its installer
 * and a self-healing runtime registration, Linux through the package's
 * .desktop file); an unpackaged build registers `narrative-dev` for this
 * checkout, so a dev run never answers the installed app's links.
 */

import { app } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DesktopScheme } from './deepLinks.js'
import { renderDesktopEntry } from './desktopEntry.js'
import type { Logger } from './log.js'

export function activeScheme(): DesktopScheme {
  return app.isPackaged ? 'narrative' : 'narrative-dev'
}

/** Whether this build can receive its scheme's links at all. */
export function canReceiveLinks(): boolean {
  // macOS takes schemes only from an app bundle's Info.plist.
  return app.isPackaged || process.platform !== 'darwin'
}

function run(command: string, args: readonly string[], log: Logger): void {
  execFile(command, args, (err) => {
    if (err) log.warn(`${command} failed`, { err: err.message })
  })
}

export function registerScheme(log: Logger): void {
  const scheme = activeScheme()
  if (app.isPackaged) {
    // Windows: repairs the installer's HKCU key if something removed it.
    // macOS and Linux: the bundle or package declares the scheme.
    if (process.platform === 'win32') app.setAsDefaultProtocolClient(scheme)
    return
  }
  // Tests run with their own user data and must not take over the dev scheme.
  if (process.env['NARRATIVE_DESKTOP_USER_DATA']) return

  const appPath = path.resolve(app.getAppPath())
  if (process.platform === 'win32') {
    app.setAsDefaultProtocolClient(scheme, process.execPath, [appPath])
    return
  }
  if (process.platform === 'linux') {
    const id = createHash('sha256').update(appPath).digest('hex').slice(0, 8)
    const name = `narrative-dev-${id}.desktop`
    const dir = path.join(
      process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local/share'),
      'applications',
    )
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, name),
      renderDesktopEntry({
        name: 'Narrative Dev',
        exec: [process.execPath, appPath],
        fieldCode: '%U',
        mimeTypes: [`x-scheme-handler/${scheme}`],
        noDisplay: true,
      }),
    )
    run('xdg-mime', ['default', name, `x-scheme-handler/${scheme}`], log)
    app.setDesktopName(name)
  }
}
