/**
 * main/window.ts
 *
 * The main window (docs/plans/desktop-d0-spec.md §3.2): the editor of the
 * chosen server in that server's partition, with the bridge preload, the
 * sandbox and context isolation on and no Node in the page. Its size is
 * remembered; its position is not (Wayland cannot set one).
 */

import { BrowserWindow } from 'electron'
import path from 'node:path'
import { displayHost, partitionFor, serverOrigin, type ServerTarget } from './servers.js'
import type { Settings } from './settings.js'

export interface MainWindowOptions {
  target: ServerTarget
  window: Settings['window']
  /** Directory of the built shell (dist/), where the preload lives. */
  distDir: string
  devTools: boolean
  /** Called with the window's size when it closes. */
  onBoundsSaved(window: Settings['window']): void
}

export function createMainWindow(opts: MainWindowOptions): BrowserWindow {
  const host = displayHost(opts.target)
  const win = new BrowserWindow({
    width: opts.window.width,
    height: opts.window.height,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#030712',
    title: host === null ? 'Narrative' : `Narrative — ${host}`,
    webPreferences: {
      partition: partitionFor(opts.target),
      preload: path.join(opts.distDir, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: true,
      devTools: opts.devTools,
    },
  })

  if (opts.window.maximized) win.maximize()
  win.once('ready-to-show', () => win.show())

  // Outside production the server is part of the title, shown by the window
  // manager outside the page, so a test server is never mistaken for the real one.
  if (host !== null) {
    win.on('page-title-updated', (event, title) => {
      event.preventDefault()
      win.setTitle(`${title} — ${host}`)
    })
  }

  win.on('close', () => {
    const maximized = win.isMaximized()
    const [width, height] = maximized
      ? [opts.window.width, opts.window.height]
      : (win.getSize() as [number, number])
    opts.onBoundsSaved({ width, height, maximized })
  })

  void win.loadURL(`${serverOrigin(opts.target)}/`)
  return win
}
