/**
 * renderer/experimental/textEngine/textBlock.ts — the serialisable text model
 * candidate (a1) of the E7 spike lays out without a DOM (EXPERIMENTAL).
 *
 * Every length is resolved to CSS px already (`blockModel.ts` reads them
 * from computed styles), so the layout (`blockLayout.ts`) needs no CSS
 * engine and runs in a worker with a Canvas2D measurer.
 */

/** A resolved inline style; `ascent` / `descent` are the browser's own (rounded) layout metrics. */
export interface BlockStyle {
  /** CSS `font` shorthand without stretch. */
  font: string
  size: number
  stretch: number
  color: string
  letterSpacing: number
  /** `text-transform`. */
  transform: string
  ascent: number
  descent: number
  underline?: { color: string; size: number }
  stroke?: { width: number; color: string }
}

export type BlockInline =
  | { kind: 'text'; text: string; style: number }
  | { kind: 'br' }
  /** An inline-block of a fixed width (a list marker), laid out on one line. */
  | { kind: 'box'; width: number; text: string; style: number }

export interface BlockParagraph {
  marginTop: number
  marginBottom: number
  paddingLeft: number
  textIndent: number
  /** `line-height` in px (the model always sets one). */
  lineHeight: number
  /** The paragraph's own style: its strut. */
  strut: number
  /** `text-align`. */
  align: 'left' | 'center' | 'right'
  inlines: BlockInline[]
}

export interface TextBlock {
  /** Wrap width in px; null for `white-space: pre` (no wrapping). */
  width: number | null
  padding: number
  /** `overflow-wrap: break-word`: an unbreakable word longer than the line is broken. */
  breakWord: boolean
  styles: BlockStyle[]
  paragraphs: BlockParagraph[]
}
