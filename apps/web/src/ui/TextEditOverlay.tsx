/**
 * ui/TextEditOverlay.tsx
 *
 * P7: inline text edit overlay. Renders a <textarea> at the text
 * object's slide-local position with matching typography so the user
 * sees WYSIWYG editing. On every keystroke we write back to Y.Doc via
 * updateObject — the Pixi renderer then updates the text beneath (but
 * we keep the textarea on top so the user sees their live input).
 *
 * Escape / blur / click outside the overlay ends editing.
 */

import { useEffect, useMemo, useRef } from 'react'
import { updateObject, type ObjectsMutationContext } from '@narrative/slide-model'
import type { TextObject } from '@narrative/shared'

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

export function TextEditOverlay({ obj, mutationCtx, onEnd }: TextEditOverlayProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
    textareaRef.current?.select()
  }, [])

  // Stable commit helper — writes Y.Doc without React re-creating on every tick.
  const commit = (value: string): void => {
    if (value === obj.text) return
    updateObject(mutationCtx, obj.id, { text: value } as Partial<TextObject>)
  }

  // Match Pixi rendering as closely as possible so the overlay isn't
  // visually jumpy against the text that's still rendered underneath.
  const style = useMemo<React.CSSProperties>(() => {
    const justifyContent =
      obj.vAlign === 'middle' ? 'center' : obj.vAlign === 'bottom' ? 'flex-end' : 'flex-start'
    return {
      position: 'absolute',
      left: obj.x,
      top: obj.y,
      width: obj.width,
      height: obj.height,
      transform: `rotate(${obj.rotation}rad)`,
      transformOrigin: 'top left',
      display: 'flex',
      flexDirection: 'column',
      justifyContent,
      // The textarea itself is the edit surface; this wrapper handles vAlign.
    }
  }, [obj.x, obj.y, obj.width, obj.height, obj.rotation, obj.vAlign])

  const textareaStyle = useMemo<React.CSSProperties>(
    () => ({
      width: '100%',
      height: '100%',
      minHeight: 0,
      boxSizing: 'border-box',
      background: 'transparent',
      // P15: \`outline\` instead of a solid \`border\` so the dashed
      // edit-mode indicator paints OUTSIDE the box without shifting
      // the textarea's content — a 2 px border was pushing every
      // character 2 px right + down compared to the Pixi render
      // underneath, which is what made the live edit "drift".
      border: 'none',
      outline: '2px dashed rgba(59, 130, 246, 0.8)',
      outlineOffset: '0px',
      resize: 'none',
      padding: 0,
      margin: 0,
      color: hexToCss(obj.color),
      fontFamily: obj.fontFamily ?? 'system-ui, -apple-system, sans-serif',
      fontSize: `${obj.fontSize}px`,
      fontWeight: weightToCss(obj.fontWeight),
      fontStyle: obj.italic === true ? 'italic' : 'normal',
      textDecoration: obj.underline === true ? 'underline' : 'none',
      // Pixi Text in v8 derives its default line height from font
      // metrics (≈ ascent + descent, typically ~1.2× fontSize for
      // system fonts). Browser textarea \`line-height: normal\` lands
      // in the same range but isn't pixel-identical. Lock both ends
      // to the same explicit multiplier so the rendered Pixi text
      // and the live textarea sit on the same baselines.
      lineHeight:
        obj.lineHeight !== undefined && obj.lineHeight > 0 ? String(obj.lineHeight) : '1.2',
      letterSpacing: `${obj.letterSpacing ?? 0}px`,
      textAlign: obj.align,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      verticalAlign: 'top',
      // Match the rendered Pixi text — overflow at the bottom of the
      // box is clipped, not scrolled, so editing previews exactly
      // what will be rendered.
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
    <div style={style}>
      <textarea
        ref={textareaRef}
        defaultValue={obj.text}
        style={textareaStyle}
        onChange={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onEnd()
          }
        }}
        onBlur={() => onEnd()}
        onPointerDown={(e) => e.stopPropagation()}
      />
    </div>
  )
}
