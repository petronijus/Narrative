/**
 * fixtures/consoleNoise.ts — console errors a browser engine prints on its own
 * that say nothing about the app, for the specs that fail on any console
 * error. Each entry names the engine and why it is noise.
 */

/**
 * Whether `text` (a console error's message) is the engine talking, not the
 * app:
 *   - WebKit logs "WebSocket connection to … failed: WebSocket is closed
 *     before the connection is established." whenever a socket is closed
 *     while still connecting — the sync provider does that on every route
 *     change and reconnect. Chromium closes such a socket silently. A socket
 *     that really fails is seen by the specs through the document's sync.
 */
export function isEngineNoise(text: string): boolean {
  return /WebSocket connection to .* failed: WebSocket is closed before the connection is established/.test(
    text,
  )
}
