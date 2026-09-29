/**
 * ui/useTextFormat.ts — the Inspector's typography routing while a text
 * body is being edited on the canvas.
 *
 * A typography change goes to the SELECTED part of the text being edited
 * when there is one (`text.format` on that range), otherwise to the whole
 * box — the caller's `box` write, which is `text.setBoxTypography` for a
 * text box (it also removes the inline formatting that would hide the new
 * value) or the table style commands for a table. A whole-body selection
 * (Cmd+A) counts as the whole box, so the picker keeps showing the box
 * value.
 */

import { useMemo } from 'react'
import { displayRangeOf } from '@narrative/commands'
import { getPlainString, type RichAttrs } from '@narrative/slide-model'
import { useCommand } from '../state/useCommand.js'
import { getActiveTextSelection, isEntireContentSelected } from './textEditSelection.js'

/** Inline attributes as `text.format`'s `set` takes them (colours stay 0xRRGGBB). */
export function runFormatOf(attrs: RichAttrs): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (attrs.fontWeight !== undefined) out['fontWeight'] = attrs.fontWeight
  if (attrs.italic !== undefined) out['italic'] = attrs.italic
  if (attrs.underline !== undefined) out['underline'] = attrs.underline
  if (attrs.color !== undefined) out['color'] = attrs.color
  if (attrs.fontFamily !== undefined) out['fontFamily'] = attrs.fontFamily
  if (attrs.fontSize !== undefined) out['fontSize'] = attrs.fontSize
  return out
}

export interface TextFormat {
  /**
   * Format the part of `objectId`'s body selected in the editor; false
   * when nothing of it is selected (or the change could not apply).
   */
  formatSelection(objectId: string, attrs: RichAttrs): boolean
  /**
   * `inline` on the selected part of the text being edited, else `box()`
   * for the whole box.
   */
  applyTypography(objectId: string, inline: RichAttrs, box: () => void): void
}

export function useTextFormat(): TextFormat {
  const command = useCommand()
  return useMemo<TextFormat>(() => {
    const formatSelection = (objectId: string, attrs: RichAttrs): boolean => {
      const sel = getActiveTextSelection()
      if (sel === null || sel.objectId !== objectId || sel.end <= sel.start) return false
      const set = runFormatOf(attrs)
      if (Object.keys(set).length === 0) return false
      const range = displayRangeOf(getPlainString(sel.yText), sel.start, sel.end)
      return command.tryRun('text.format', { target: sel.target, range, set }) !== null
    }
    return {
      formatSelection,
      applyTypography(objectId, inline, box) {
        if (!isEntireContentSelected(objectId) && formatSelection(objectId, inline)) return
        box()
      },
    }
  }, [command])
}
