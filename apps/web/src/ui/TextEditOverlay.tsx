/**
 * ui/TextEditOverlay.tsx
 *
 * Inline text-edit overlay. Renders a <textarea> sized exactly to the
 * underlying text object's box so the editing surface is identical to
 * the rendered Pixi text — same width, height, and (via padding-top)
 * the same vertical-alignment offset. text-align on the textarea
 * mirrors `obj.align` for horizontal positioning.
 *
 * Why padding-top instead of auto-sizing the textarea:
 *   - The box and the textarea must visibly cover the same area so
 *     "what you click is what you edit."
 *   - Pixi's vertical alignment is implemented by shifting the text
 *     node's local Y; we match that by pushing the textarea's content
 *     down with `padding-top` instead.
 *   - Keeping textarea height === obj.height means a very tall text box
 *     stays a very tall edit surface, instead of collapsing to a
 *     single-line slit.
 *
 * Escape / blur ends editing.
 */

import { useEffect, useMemo, useRef } from 'react'
import * as Y from 'yjs'
import { updateObject, type ObjectsMutationContext } from '@narrative/slide-model'
import type { TextObject } from '@narrative/shared'
import { setActiveTextSelection } from './textEditSelection.js'

/**
 * Project the body content to a plain string regardless of whether
 * the schema slot is a Y.Text (rich-text) or a legacy plain string.
 * Phase A: the textarea content stays string-shaped; partial-range
 * formatting arrives in Phase D.
 */
function readPlainText(t: TextObject['text']): string {
  if (t instanceof Y.Text) return t.toString()
  if (typeof t === 'string') return t
  return ''
}

export interface TextEditOverlayProps {
  obj: TextObject
  mutationCtx: ObjectsMutationContext
  onEnd: () => void
}

function weightToCss(w: TextObject['fontWeight']): string {
  if (w === 'normal' || w === 'bold') return w
  return String(w)
}

function hexToCss(n: number): string {
  return '#' + n.toString(16).padStart(6, '0')
}

/**
 * Read the live Pixi text node's Y offset so the textarea's caret /
 * selection sit at the same vertical position as the rendered glyphs.
 * Using Pixi's measured value (instead of recomputing it DOM-side)
 * guarantees the editor and the renderer can never disagree on
 * descender-aware bottom alignment.
 */
function pixiTextNodeY(objectId: string): number {
  const sg = (
    window as unknown as {
      __narrative_scene_graph?: {
        getContainer: (id: string) =>
          | {
              children: Array<{ y?: number; anchor?: unknown }>
            }
          | undefined
      }
    }
  ).__narrative_scene_graph
  if (sg === undefined) return 0
  const c = sg.getContainer(objectId)
  if (c === undefined) return 0
  const text = c.children.find((ch) => ch.anchor !== undefined)
  return text?.y ?? 0
}

export function TextEditOverlay({ obj, mutationCtx, onEnd }: TextEditOverlayProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Mirror Pixi's textNode.y onto the textarea's padding-top so the
  // caret / selection align with the rendered glyphs. Re-read on every
  // keystroke since adding/removing lines shifts Pixi's offset for
  // vAlign=middle/bottom.
  const refreshPadding = (): void => {
    const ta = textareaRef.current
    if (ta === null) return
    ta.style.paddingTop = `${pixiTextNodeY(obj.id)}px`
  }

  useEffect(() => {
    const ta = textareaRef.current
    if (ta === null) return
    ta.focus()
    // Place caret at end instead of select-all — selecting everything
    // would obscure the Pixi-rendered text underneath with the
    // selection background, defeating the "transparent overlay" goal.
    const len = ta.value.length
    ta.setSelectionRange(len, len)
    refreshPadding()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount
  }, [])

  // Publish the active textarea selection so the Inspector's inline
  // style toggles (B / I / U) format only the highlighted Y.Text range
  // instead of patching the whole object's field.
  useEffect(() => {
    const ta = textareaRef.current
    if (ta === null) return
    const yText = obj.text instanceof Y.Text ? obj.text : null
    if (yText === null) return
    const refocus = (): void => {
      const target = textareaRef.current
      if (target === null) return
      const s = target.selectionStart
      const e = target.selectionEnd
      target.focus()
      target.setSelectionRange(s, e)
    }
    const publish = (): void => {
      setActiveTextSelection({
        objectId: obj.id,
        yText,
        start: ta.selectionStart,
        end: ta.selectionEnd,
        refocus,
      })
    }
    publish()
    ta.addEventListener('select', publish)
    ta.addEventListener('keyup', publish)
    ta.addEventListener('mouseup', publish)
    ta.addEventListener('input', publish)
    return () => {
      ta.removeEventListener('select', publish)
      ta.removeEventListener('keyup', publish)
      ta.removeEventListener('mouseup', publish)
      ta.removeEventListener('input', publish)
      setActiveTextSelection(null)
    }
  }, [obj.id, obj.text])

  // Re-run when vAlign / box size / font size changes from the inspector.
  useEffect(() => {
    refreshPadding()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obj.vAlign, obj.height, obj.fontSize, obj.lineHeight])

  const commit = (value: string): void => {
    if (value === readPlainText(obj.text)) return
    updateObject(mutationCtx, obj.id, { text: value } as Partial<TextObject>)
  }

  const wrapperStyle = useMemo<React.CSSProperties>(
    () => ({
      position: 'absolute',
      left: obj.x,
      top: obj.y,
      width: obj.width,
      height: obj.height,
      transform: `rotate(${obj.rotation}rad)`,
      transformOrigin: 'top left',
      outline: '2px dashed rgba(59, 130, 246, 0.8)',
      outlineOffset: '0px',
      // Wrapper hosts the dashed indicator so the editable area is the
      // full box even when the text is short. Pointer events fall
      // through to the textarea below.
    }),
    [obj.x, obj.y, obj.width, obj.height, obj.rotation],
  )

  const textareaStyle = useMemo<React.CSSProperties>(
    () => ({
      position: 'absolute',
      inset: 0,
      width: '100%',
      height: '100%',
      boxSizing: 'border-box',
      background: 'transparent',
      border: 'none',
      outline: 'none',
      resize: 'none',
      // padding-top is set imperatively in refreshPadding(); other sides 0.
      padding: 0,
      margin: 0,
      // Glyph fill is transparent so the textarea acts as a pure caret /
      // selection surface laid over the authoritative Pixi-rendered
      // text. caret-color keeps the cursor visible.
      color: 'transparent',
      caretColor: hexToCss(obj.color),
      fontFamily: obj.fontFamily ?? 'system-ui, -apple-system, sans-serif',
      fontSize: `${obj.fontSize}px`,
      fontWeight: weightToCss(obj.fontWeight),
      fontStyle: obj.italic === true ? 'italic' : 'normal',
      textDecoration: obj.underline === true ? 'underline' : 'none',
      lineHeight:
        obj.lineHeight !== undefined && obj.lineHeight > 0 ? String(obj.lineHeight) : '1.2',
      letterSpacing: `${obj.letterSpacing ?? 0}px`,
      textAlign: obj.align,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      overflow: 'hidden',
    }),
    [
      obj.color,
      obj.fontFamily,
      obj.fontSize,
      obj.fontWeight,
      obj.italic,
      obj.underline,
      obj.lineHeight,
      obj.letterSpacing,
      obj.align,
    ],
  )

  return (
    <div style={wrapperStyle}>
      {/* Inline ::selection rules so the Pixi-rendered text stays
          visible inside highlighted ranges — default selection paints
          opaque white-on-blue which would hide the underlying glyphs. */}
      <style>{`
        .narrative-text-edit::selection { background: rgba(59, 130, 246, 0.3); color: transparent; }
        .narrative-text-edit::-moz-selection { background: rgba(59, 130, 246, 0.3); color: transparent; }
      `}</style>
      <textarea
        ref={textareaRef}
        className="narrative-text-edit"
        defaultValue={readPlainText(obj.text)}
        style={textareaStyle}
        onChange={(e) => {
          commit(e.target.value)
          refreshPadding()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onEnd()
          }
        }}
        onBlur={(e) => {
          // Native <select> elements steal focus on click without
          // honouring preventDefault on mousedown, so an Inspector
          // weight / family change would terminate edit mode mid-
          // selection. Keep the overlay alive when focus moves into
          // an element marked `data-text-edit-keep-focus` (the
          // Inspector wraps its style controls in that hook).
          const next = e.relatedTarget as HTMLElement | null
          if (next !== null && next.closest('[data-text-edit-keep-focus]') !== null) {
            // The Inspector control will call refocusActiveTextEdit()
            // on its onChange to put focus back on the textarea.
            return
          }
          onEnd()
        }}
        onPointerDown={(e) => e.stopPropagation()}
      />
    </div>
  )
}
