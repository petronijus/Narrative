/**
 * Caret-movement chords for a contenteditable, per platform.
 *
 * The browser runs on the machine that runs the specs, so it follows that
 * platform's text-editing keys: on macOS `Home` / `End` scroll instead of
 * moving the caret and `Control+Home` does nothing, while `Cmd+Arrow` moves
 * to the line or text edges. A spec that hard-codes the Linux chords leaves
 * the caret where it was on a Mac and then edits the wrong text. For undo
 * and redo use Playwright's `ControlOrMeta+z`, which the app's `Mod`
 * shortcuts expect (`state/useShortcuts.ts`).
 */
const MAC = process.platform === 'darwin'

export const caret = {
  /** The start of the whole text. */
  textStart: MAC ? 'Meta+ArrowUp' : 'Control+Home',
  /** The end of the whole text. */
  textEnd: MAC ? 'Meta+ArrowDown' : 'Control+End',
  /** The start of the caret's line. */
  lineStart: MAC ? 'Meta+ArrowLeft' : 'Home',
  /** The end of the caret's line. */
  lineEnd: MAC ? 'Meta+ArrowRight' : 'End',
} as const
