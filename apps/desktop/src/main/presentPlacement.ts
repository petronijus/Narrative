/**
 * main/presentPlacement.ts
 *
 * `placeForPresentation`: move the main window onto the chosen display
 * before the page goes fullscreen there (main/hyprland.ts). Only under
 * Hyprland; everywhere else the page's own `requestFullscreen({ screen })`
 * does it (Windows, macOS, X11), or the compositor decides (other Wayland
 * desktops), and this answers false.
 */

import type { BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import {
  findWindow,
  isHyprland,
  matchMonitor,
  moveWindowCommands,
  type HyprClient,
  type HyprMonitor,
  type ScreenRect,
} from './hyprland.js'
import type { Logger } from './log.js'

function hyprctl(args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('hyprctl', args, { timeout: 2_000 }, (err, stdout) => resolve(err ? null : stdout))
  })
}

async function json<T>(what: 'monitors' | 'clients'): Promise<T | null> {
  const out = await hyprctl(['-j', what])
  if (out === null) return null
  try {
    return JSON.parse(out) as T
  } catch {
    return null
  }
}

async function move(address: string, workspace: number): Promise<boolean> {
  for (const args of moveWindowCommands(address, workspace)) {
    if ((await hyprctl(args))?.trim() === 'ok') return true
  }
  return false
}

/** A page may ask this often at most: it spawns hyprctl and moves a window. */
const MIN_INTERVAL_MS = 2_000
let lastPlacement = 0

export async function placeForPresentation(
  win: BrowserWindow,
  screen: ScreenRect,
  log: Logger,
  now: number = Date.now(),
): Promise<boolean> {
  if (process.platform !== 'linux' || !isHyprland(process.env)) return false
  if (now - lastPlacement < MIN_INTERVAL_MS) return false
  lastPlacement = now
  const [monitors, clients] = await Promise.all([
    json<HyprMonitor[]>('monitors'),
    json<HyprClient[]>('clients'),
  ])
  if (monitors === null || clients === null) return false
  const monitor = matchMonitor(screen, monitors)
  const own = findWindow(clients, process.pid, win.getTitle())
  if (monitor === null || own === null) {
    log.warn('presentation placement: monitor or window not found')
    return false
  }
  if (own.workspace.id === monitor.activeWorkspace.id) return true
  if (!(await move(own.address, monitor.activeWorkspace.id))) {
    log.warn('presentation placement: hyprctl refused the move')
    return false
  }
  log.info('presentation placed', { monitor: monitor.name })
  // Back where it was when the presentation ends, as Chromium restores a
  // window it placed itself.
  const home = own.workspace.id
  win.once('leave-html-full-screen', () => {
    void move(own.address, home).then((ok) => {
      if (!ok) log.warn('presentation placement: the window could not go back')
    })
  })
  return true
}
