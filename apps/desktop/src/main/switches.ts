/**
 * main/switches.ts
 *
 * The command-line switches a packaged app starts with (security review of
 * D0, M1). Chromium reads its switches from the command line, and many of
 * them expose the session to whoever starts the app: a proxy with
 * certificate errors ignored, a network log written to disk, debugging,
 * another profile, web security off. Another program can quit Narrative and
 * start it again with any of them, so a packaged build starts only with the
 * few a desktop or launcher passes itself; the fuses already cover Node's
 * own switches. An unpackaged build (development, the e2e specs) takes any.
 * Pure: no Electron here.
 */

/** What desktops and launchers pass: Wayland/X11 selection, scaling, input methods. */
export const ALLOWED_SWITCHES: ReadonlySet<string> = new Set([
  'ozone-platform',
  'ozone-platform-hint',
  'enable-wayland-ime',
  'wayland-text-input-version',
  'gtk-version',
  'force-device-scale-factor',
])

/**
 * The switches in `argv` (after the executable) a packaged app refuses.
 * Chromium takes `--name`, `--name=value` and the single-dash forms alike;
 * everything after a bare `--` is not a switch. macOS's legacy process
 * serial number (`-psn_…`) is the launcher's own.
 */
export function refusedSwitches(argv: readonly string[]): string[] {
  const refused: string[] = []
  for (const arg of argv.slice(1)) {
    if (arg === '--') break
    if (!arg.startsWith('-') || arg === '-') continue
    if (/^-psn_\d+_\d+$/.test(arg)) continue
    const name = arg.replace(/^--?/, '').split('=')[0]!.toLowerCase()
    if (!ALLOWED_SWITCHES.has(name)) refused.push(name)
  }
  return refused
}
