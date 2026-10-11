/**
 * desktop/bridge.ts
 *
 * The editor's view of the desktop shell (ADR 0014): `window.narrativeDesktop`
 * exists only when the editor runs inside the Narrative desktop app, which
 * loads it from this same server. The shell installed on a machine and the
 * editor served by the server come in any combination, so everything here
 * feature-detects by `bridgeVersion`; in a browser it all answers "no shell".
 */

import type { NarrativeDesktopBridge } from '@narrative/shared'

declare global {
  interface Window {
    narrativeDesktop?: NarrativeDesktopBridge
  }
}

/** The shell's bridge in its main window, or undefined in a browser. */
export function desktopBridge(): NarrativeDesktopBridge | undefined {
  const bridge = typeof window === 'undefined' ? undefined : window.narrativeDesktop
  return bridge !== undefined && bridge.bridgeVersion >= 1 && bridge.role === 'main'
    ? bridge
    : undefined
}

/** Whether the editor runs inside the desktop app. */
export function isDesktop(): boolean {
  return desktopBridge() !== undefined
}
