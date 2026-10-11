/**
 * main/hyprland.ts
 *
 * Placing the main window on a chosen display under Hyprland (ADR 0014
 * decision 8, docs/plans/desktop-d0-spec.md §3.10). A Wayland client cannot
 * place its own window, so Chromium's `requestFullscreen({ screen })` stays
 * on the window's display there (checked on Hyprland 0.56.2 with a second
 * output); the shell asks the compositor instead. Pure: the matching and the
 * commands are built here, main/presentPlacement.ts runs them.
 */

export interface HyprMonitor {
  name: string
  x: number
  y: number
  width: number
  height: number
  scale: number
  transform: number
  activeWorkspace: { id: number; name: string }
}

export interface HyprClient {
  address: string
  pid: number
  title: string
  mapped: boolean
  workspace: { id: number; name: string }
}

export interface ScreenRect {
  left: number
  top: number
  width: number
  height: number
}

/** A monitor's size in logical pixels (what the Window Management API reports). */
export function logicalSize(m: HyprMonitor): { width: number; height: number } {
  const rotated = m.transform % 2 === 1 // 90° and 270°, flipped or not
  const width = Math.round((rotated ? m.height : m.width) / m.scale)
  const height = Math.round((rotated ? m.width : m.height) / m.scale)
  return { width, height }
}

/** The monitor at `screen` (position and logical size, within a pixel of rounding). */
export function matchMonitor(
  screen: ScreenRect,
  monitors: readonly HyprMonitor[],
): HyprMonitor | null {
  const near = (a: number, b: number) => Math.abs(a - b) <= 1
  return (
    monitors.find((m) => {
      const size = logicalSize(m)
      return (
        near(m.x, screen.left) &&
        near(m.y, screen.top) &&
        near(size.width, screen.width) &&
        near(size.height, screen.height)
      )
    }) ?? null
  )
}

/** The shell's own window: this process, this title. */
export function findWindow(
  clients: readonly HyprClient[],
  pid: number,
  title: string,
): HyprClient | null {
  return clients.find((c) => c.mapped && c.pid === pid && c.title === title) ?? null
}

/**
 * `hyprctl` arguments that move `address` to `workspace` without following
 * it: the Lua dispatcher of Hyprland's Lua config (0.55+), then the classic
 * dispatcher for older versions. The caller stops at the first that answers
 * `ok`.
 */
export function moveWindowCommands(address: string, workspace: number): string[][] {
  if (!/^0x[0-9a-f]+$/i.test(address) || !Number.isInteger(workspace)) return []
  return [
    [
      'dispatch',
      `hl.dsp.window.move({ window = "address:${address}", workspace = "${workspace}", follow = false })`,
    ],
    ['dispatch', 'movetoworkspacesilent', `${workspace},address:${address}`],
  ]
}

/** Whether the shell runs under Hyprland on Wayland. */
export function isHyprland(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['HYPRLAND_INSTANCE_SIGNATURE']) && env['XDG_SESSION_TYPE'] === 'wayland'
}
