/**
 * present/presentScreen.ts
 *
 * Presenting on a chosen display (ADR 0015 decision 8): with the Window
 * Management API (Chrome, Edge and the desktop app) the person picks which
 * of this computer's displays the presentation goes fullscreen on — the
 * projector, say, while the presenter view stays on the laptop. The choice
 * belongs to this device and browser, so it lives in localStorage, never in
 * the deck. Where the API is missing (Firefox, Safari) or the person never
 * chose, fullscreen stays where the window is, as before.
 *
 * The API is not in TypeScript's DOM library yet; the shapes used are
 * declared here.
 */

import { desktopBridge } from '../desktop/bridge.js'

/** A display as the Window Management API describes it. */
export interface DisplayScreen {
  readonly label: string
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
  readonly isPrimary: boolean
  readonly isInternal: boolean
}

interface ScreenDetails {
  readonly screens: readonly (DisplayScreen & Screen)[]
  readonly currentScreen: DisplayScreen & Screen
}

type WindowWithScreens = Window & { getScreenDetails?: () => Promise<ScreenDetails> }

/** What is remembered of the chosen display: enough to find it again. */
export interface DisplayChoice {
  label: string
  left: number
  top: number
}

const STORAGE_KEY = 'narrative.present.display'
/** How long fullscreen waits for the desktop shell to move the window. */
const PLACEMENT_WAIT_MS = 1_000

/** Whether this browser can put a presentation on another display. */
export function canChooseDisplay(): boolean {
  return typeof (window as WindowWithScreens).getScreenDetails === 'function'
}

/**
 * The displays of this computer. Asks the person for the window-management
 * permission the first time (call it from a click); null when the API is
 * missing or the person declined.
 */
export async function listDisplays(): Promise<{
  screens: readonly DisplayScreen[]
  current: DisplayScreen
} | null> {
  const get = (window as WindowWithScreens).getScreenDetails
  if (typeof get !== 'function') return null
  try {
    const details = await get.call(window)
    return { screens: details.screens, current: details.currentScreen }
  } catch {
    return null
  }
}

/** A human name for a display (its label, or its position and size). */
export function displayName(screen: DisplayScreen): string {
  const name = screen.label.trim() || `Display at ${screen.left}, ${screen.top}`
  return `${name} (${screen.width} × ${screen.height}${screen.isPrimary ? ', primary' : ''})`
}

export function readDisplayChoice(): DisplayChoice | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const value = JSON.parse(raw) as Partial<DisplayChoice>
    return typeof value.label === 'string' &&
      typeof value.left === 'number' &&
      typeof value.top === 'number'
      ? { label: value.label, left: value.left, top: value.top }
      : null
  } catch {
    return null
  }
}

/** Remember `screen` (null: present wherever the window is). */
export function writeDisplayChoice(screen: DisplayScreen | null): void {
  try {
    if (screen === null) localStorage.removeItem(STORAGE_KEY)
    else {
      const choice: DisplayChoice = { label: screen.label, left: screen.left, top: screen.top }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(choice))
    }
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

/** The display `choice` names among `screens`: same label and position, else same label. */
export function findChosenDisplay<S extends DisplayScreen>(
  screens: readonly S[],
  choice: DisplayChoice | null,
): S | null {
  if (choice === null) return null
  return (
    screens.find(
      (s) => s.label === choice.label && s.left === choice.left && s.top === choice.top,
    ) ??
    screens.find((s) => s.label !== '' && s.label === choice.label) ??
    null
  )
}

/**
 * Go fullscreen — on the chosen display when there is one, it is still
 * connected and the permission is granted (never asking here: this runs on
 * a key press during a talk), otherwise where the window is.
 */
export async function requestPresentationFullscreen(element: Element): Promise<void> {
  const choice = readDisplayChoice()
  let screen: (DisplayScreen & Screen) | null = null
  if (choice !== null && canChooseDisplay()) {
    const status = await navigator.permissions
      .query({ name: 'window-management' as PermissionName })
      .catch(() => null)
    if (status?.state === 'granted') {
      const details = await listDisplays()
      screen =
        details === null
          ? null
          : (findChosenDisplay(details.screens, choice) as (DisplayScreen & Screen) | null)
    }
  }
  const bridge = desktopBridge()
  if (screen !== null && bridge !== undefined) {
    // In the desktop app under Hyprland the shell moves the window there
    // first: a Wayland page cannot place its own window. At most a second:
    // fullscreen needs the key press's user activation, which expires.
    await Promise.race([
      bridge
        .placeForPresentation({
          left: screen.left,
          top: screen.top,
          width: screen.width,
          height: screen.height,
        })
        .catch(() => false),
      new Promise((resolve) => setTimeout(resolve, PLACEMENT_WAIT_MS)),
    ])
  }
  await element.requestFullscreen(screen === null ? undefined : ({ screen } as FullscreenOptions))
}
