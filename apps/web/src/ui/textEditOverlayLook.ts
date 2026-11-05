/**
 * ui/textEditOverlayLook.ts — how the edit overlay (TextEditOverlay.tsx)
 * draws a text box, from the same values the canvas draws it with.
 *
 * Entering edit mode hands the text from the canvas to a contenteditable laid
 * out by the page; the text must not move or change on the way (ADR 0018 →
 * Position gates, e2e/text-edit-parity.spec.ts). The canvas text is an
 * HTMLText whose box-wide look is CSS Pixi writes from `buildStyleOpts`
 * (renderer/objectRenderers/textRenderer.ts) and whose box sits in a Pixi
 * container (rotated and flipped about the box's centre, faded by the
 * object's opacity, clipped by a mask, filtered by shadow and blur). This
 * module states each of those for the overlay, value for value:
 *
 * - colours: the token resolver the canvas uses (renderer/colourResolver.ts),
 *   alpha as Pixi writes it (`#rrggbbaa`, alpha rounded to /255);
 * - the glyph stroke as Pixi's `strokeToCSS` writes it;
 * - the transform about the box's centre (the container's pivot);
 * - the clip: a wrapping box is clipped at its sides only, an unwrapped or
 *   growing one not at all (`applyClipMask`), a table cell at the cell's edge.
 */

import { useEffect, useState } from 'react'
import type { TextObject } from '@narrative/shared'
import { resolveAlpha, resolveColour, subscribeColourResolver } from '../renderer/colourResolver.js'

/**
 * A number that changes whenever the canvas's colour resolver does (the
 * folder's tokens arrived or changed): the canvas repaints its token colours
 * then, and an editor that resolved them must too.
 */
export function useColourResolverTick(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => subscribeColourResolver(() => setTick((n) => n + 1)), [])
  return tick
}

/** A colour as Pixi's `Color.toHexa` writes it into the HTMLText CSS: `#rrggbbaa`. */
export function cssHexa(rgb: number, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}${a.toString(16).padStart(2, '0')}`
}

/** A colour without alpha, `#rrggbb`. */
function cssHex(rgb: number): string {
  return `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`
}

/** What the text's glyphs are painted with: the CSS of `buildStyleOpts`'s fill and stroke. */
export interface TextPaintCss {
  color: string
  caretColor: string
  WebkitTextStrokeWidth?: string
  WebkitTextStrokeColor?: string
  paintOrder?: string
}

/**
 * The text colour (`colorAlpha` and a token's own alpha multiplied in) and
 * the glyph stroke, resolved as the canvas resolves them. The caret takes
 * the colour without its alpha, so a faint text keeps a visible caret.
 */
export function textPaintCss(obj: TextObject): TextPaintCss {
  const rgb = resolveColour(obj.color)
  const alpha = (obj.colorAlpha ?? 1) * resolveAlpha(obj.color)
  const out: TextPaintCss = { color: cssHexa(rgb, alpha), caretColor: cssHex(rgb) }
  const width = obj.strokeWidth ?? 1
  if (obj.stroke !== undefined && width > 0) {
    out.WebkitTextStrokeWidth = `${width}px`
    out.WebkitTextStrokeColor = cssHexa(
      resolveColour(obj.stroke),
      (obj.strokeAlpha ?? 1) * resolveAlpha(obj.stroke),
    )
    // Pixi's strokeToCSS: the stroke under the fill.
    out.paintOrder = 'stroke'
  }
  return out
}

/**
 * The container's transform for CSS: rotation and flip about the box's
 * centre (`transform-origin: center` on a box as tall as the canvas draws
 * it), in the canvas's order — the flip first, then the turn.
 */
export function boxTransformCss(obj: TextObject): string | undefined {
  const parts: string[] = []
  if (obj.rotation !== 0 && Number.isFinite(obj.rotation)) parts.push(`rotate(${obj.rotation}rad)`)
  const sx = obj.flipH === true ? -1 : 1
  const sy = obj.flipV === true ? -1 : 1
  if (sx !== 1 || sy !== 1) parts.push(`scale(${sx}, ${sy})`)
  return parts.length > 0 ? parts.join(' ') : undefined
}

/**
 * The object's shadow and blur as a CSS filter, in the canvas's order
 * (shadow, then blur over the text and its shadow). The values are the
 * schema's: a shadow blur radius and a blur in slide px, which the canvas
 * draws through Pixi's DropShadowFilter / BlurFilter — not the same kernel,
 * so a soft shadow's falloff is close to the canvas's, not identical to it.
 */
export function boxFilterCss(obj: TextObject): string | undefined {
  const parts: string[] = []
  const s = obj.shadow
  if (s !== undefined) {
    const colour = cssHexa(
      resolveColour(s.color),
      Math.max(0, Math.min(1, s.opacity)) * resolveAlpha(s.color),
    )
    parts.push(`drop-shadow(${s.offsetX}px ${s.offsetY}px ${Math.max(0, s.blur)}px ${colour})`)
  }
  if (obj.blur !== undefined && obj.blur > 0) parts.push(`blur(${obj.blur}px)`)
  return parts.length > 0 ? parts.join(' ') : undefined
}

/** Room around the text box before the canvas clips it (a table cell's padding). */
export interface ClipMargin {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * Where the canvas clips the text, as a `clip-path` of the overlay's text
 * frame (the box's own size, `scale` its autofit type scale: the frame is
 * laid out `1 / scale` as large and scaled down). Undefined: not clipped.
 *
 * - A table cell (`margin`): at the cell's edge, padding included, on every
 *   side (tableRenderer's per-cell mask).
 * - A text box that wraps: at its sides only; vertically the mask follows
 *   the text past the box (PowerPoint draws overflowing text), so ascenders
 *   above a tight first line and the lines of a box at its minimum autofit
 *   size stay visible (`applyClipMask`).
 * - An unwrapped or growing box: not at all.
 */
export function textClipPath(
  obj: TextObject,
  margin: ClipMargin | undefined,
  scale: number,
): string | undefined {
  if (margin !== undefined) {
    const k = 1 / scale
    return `inset(${-margin.top * k}px ${-margin.right * k}px ${-margin.bottom * k}px ${-margin.left * k}px)`
  }
  if (obj.wrap === 'none' || obj.autofit === 'grow-down') return undefined
  // Far past anything a slide can hold, vertically; flush with the box's sides.
  return `inset(${-UNCLIPPED_PX}px 0px ${-UNCLIPPED_PX}px 0px)`
}

/** How far "unclipped" reaches in a clip-path inset, CSS px. */
const UNCLIPPED_PX = 100_000
