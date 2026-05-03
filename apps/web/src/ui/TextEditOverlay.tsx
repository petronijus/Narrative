/**
 * ui/TextEditOverlay.tsx
 *
 * Inline text-edit overlay backed by a `contenteditable` div instead
 * of a `<textarea>`. The contenteditable lets us render each Y.Text
 * run with its actual inline styling (size / weight / italic /
 * underline / family / color), so the browser's native selection
 * highlight follows the per-character glyph metrics — a textarea
 * could only render one uniform style and produced a mismatched
 * highlight on mixed-size text.
 *
 * Architecture notes:
 * - During edit, we HIDE the Pixi text node for this object so the
 *   contenteditable IS the visible rendering — no double draw, no
 *   "transparent overlay" trick. On end-edit we restore visibility.
 * - User edits are diffed (common-prefix / common-suffix) into Y.Text
 *   insert/delete operations. New characters inherit the format
 *   attributes of the run at the insertion point so typing inside a
 *   bolded word stays bold.
 * - Incoming Y.Text changes (peer edits, Inspector format toggles)
 *   trigger a full innerHTML rebuild; we save+restore the caret /
 *   selection by character offset so the user doesn't lose their place.
 *
 * Scope intentionally narrow:
 * - Plain typing, backspace/delete, Enter (newline), arrow keys,
 *   selection drag.
 * - Cmd+B / Cmd+I / Cmd+U browser shortcuts are NOT intercepted —
 *   the Inspector toolbar drives formatting.
 * - Paste is normalised to plain text.
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as Y from 'yjs'
import { isTokenRef } from '@narrative/shared'
import type { TokenRef } from '@narrative/shared'
import {
  type ObjectsMutationContext,
  toDelta,
  toHtml,
  type HtmlDefaults,
} from '@narrative/slide-model'
import type { TextObject } from '@narrative/shared'
import { setActiveTextSelection } from './textEditSelection.js'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { useTextEdit } from '../state/TextEditContext.js'

export interface TextEditOverlayProps {
  obj: TextObject
  mutationCtx: ObjectsMutationContext
  onEnd: () => void
}

function weightToCss(w: TextObject['fontWeight']): string {
  if (w === 'normal' || w === 'bold') return w
  return String(w)
}

function hexToCss(n: number | TokenRef): string {
  if (isTokenRef(n)) return '#000000' // TokenRef: fallback to black until token picker lands (M16 P4)
  return '#' + n.toString(16).padStart(6, '0')
}

/**
 * Build an HTML string for the contenteditable mirroring exactly what
 * `textRenderer.buildHtml` produces for Pixi. Done locally rather than
 * imported from the renderer so this overlay never depends on
 * Pixi-side state.
 */
function buildOverlayHtml(obj: TextObject): string {
  const defaults: HtmlDefaults = {}
  if (obj.italic === true) defaults.italic = true
  if (obj.underline === true) defaults.underline = true
  const t = obj.text
  if (t instanceof Y.Text) {
    const delta = toDelta(t)
    return toHtml(delta, defaults)
  }
  const escaped = (typeof t === 'string' ? t : '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  return toHtml([{ insert: escaped }], defaults)
}

/**
 * Read the body content as a plain string regardless of whether the
 * underlying schema slot is a Y.Text or a legacy plain string. Used
 * by the diff-on-input path so the incoming DOM innerText can be
 * compared against the current Y.Text snapshot.
 */
function readPlainText(t: TextObject['text']): string {
  if (t instanceof Y.Text) return t.toString()
  if (typeof t === 'string') return t
  return ''
}

/**
 * Read the format attributes that a fresh insertion at `index` should
 * inherit. Walks the Y.Text delta and returns the attributes of the
 * run that contains `index`. Returns an empty object when the
 * insertion lands in an unformatted run, or before the first run.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function attrsAtIndex(yText: Y.Text, index: number): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const delta = yText.toDelta() as Array<{ insert: unknown; attributes?: Record<string, any> }>
  let pos = 0
  for (const op of delta) {
    const insert = typeof op.insert === 'string' ? op.insert : ''
    const next = pos + insert.length
    if (index <= next) {
      return { ...(op.attributes ?? {}) }
    }
    pos = next
  }
  return {}
}

/**
 * Convert a DOM Range endpoint (node, offset) inside `root` to a
 * character index in the plain-text projection where each text node
 * contributes its length and each `<br>` contributes one '\n'.
 */
function domPositionToCharIndex(root: Node, containerNode: Node, containerOffset: number): number {
  let count = 0
  let found = false
  const walk = (node: Node): boolean => {
    if (found) return true
    if (node === containerNode) {
      if (node.nodeType === Node.TEXT_NODE) {
        count += containerOffset
      } else {
        // Element-level offset: count chars inside the first
        // `containerOffset` children.
        for (let i = 0; i < containerOffset && i < node.childNodes.length; i++) {
          walk(node.childNodes[i]!)
        }
      }
      found = true
      return true
    }
    if (node.nodeType === Node.TEXT_NODE) {
      count += (node.nodeValue ?? '').length
      return false
    }
    if (node.nodeName === 'BR') {
      count += 1
      return false
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      if (walk(node.childNodes[i]!)) return true
    }
    return false
  }
  walk(root)
  return count
}

/**
 * Convert a character index back into a DOM (node, offset) pair so we
 * can place the caret / selection after a innerHTML rebuild.
 */
function charIndexToDomPosition(root: Node, index: number): { node: Node; offset: number } {
  let remaining = index
  let result: { node: Node; offset: number } = { node: root, offset: 0 }
  let done = false
  const walk = (node: Node): void => {
    if (done) return
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node.nodeValue ?? '').length
      if (remaining <= len) {
        result = { node, offset: remaining }
        done = true
        return
      }
      remaining -= len
      return
    }
    if (node.nodeName === 'BR') {
      if (remaining === 0) {
        // Place caret right before the <br> via the parent.
        const parent = node.parentNode
        if (parent !== null) {
          const idx = Array.prototype.indexOf.call(parent.childNodes, node)
          result = { node: parent, offset: idx }
          done = true
        }
        return
      }
      remaining -= 1
      return
    }
    for (let i = 0; i < node.childNodes.length; i++) {
      walk(node.childNodes[i]!)
      if (done) return
    }
  }
  walk(root)
  if (!done) {
    // Past the end — place caret after the last child.
    result = { node: root, offset: root.childNodes.length }
  }
  return result
}

function getElementInnerText(el: HTMLElement): string {
  // We avoid `el.innerText` because some browsers normalise whitespace
  // / collapse runs of spaces. Walk the tree and reconstruct the
  // plain string so it matches Y.Text.toString() byte-for-byte.
  let out = ''
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.nodeValue ?? ''
      return
    }
    if (node.nodeName === 'BR') {
      out += '\n'
      return
    }
    for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]!)
  }
  walk(el)
  return out
}

export function TextEditOverlay({ obj, mutationCtx, onEnd }: TextEditOverlayProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const canvas = useCanvasInstance()
  const { consumeSelectAllOnEnter, clearSelectAllOnEnter } = useTextEdit()
  /**
   * Fade the Pixi text node during inline edit so the contenteditable
   * is the only visible rendering. Keep the node in the render tree
   * (alpha=0, not visible=false) so Pixi's HTMLText pipe still
   * receives addRenderable calls and re-rasterises the SVG texture
   * as Y.Text changes flow in.
   */
  const setFaded = (faded: boolean): void => {
    canvas?.sceneGraph.setTextNodeFaded(obj.id, faded)
  }
  /** Plain-text snapshot of Y.Text content. Updated on every successful
   *  diff-apply so the next input event diffs against the just-committed
   *  state, not the stale pre-input snapshot. */
  const lastPlainRef = useRef<string>(readPlainText(obj.text))
  /** When true, suppress the Y.Text observer's innerHTML rebuild —
   *  used to skip the rebuild we'd otherwise do for our own diff-applied
   *  insertions / deletions, which would needlessly disrupt the caret. */
  const localEditRef = useRef<boolean>(false)
  /** Most recently published selection range. Used by `refocus()` to
   *  restore the user's selection after an Inspector control round-
   *  trips focus through one of its inputs. */
  const lastRangeRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 })
  const onEndRef = useRef(onEnd)
  onEndRef.current = onEnd
  const mutationCtxRef = useRef(mutationCtx)
  mutationCtxRef.current = mutationCtx

  // Defaults applied to runs that don't override the corresponding
  // attribute. Box-wide values come from the TextObject.
  const baseStyle = useMemo<React.CSSProperties>(
    () => ({
      fontFamily: obj.fontFamily ?? 'system-ui, -apple-system, sans-serif',
      fontSize: `${obj.fontSize}px`,
      fontWeight: weightToCss(obj.fontWeight),
      fontStyle: obj.italic === true ? 'italic' : 'normal',
      textDecoration: obj.underline === true ? 'underline' : 'none',
      // Match Pixi: fixed pixel line height = multiplier × box fontSize.
      // A unitless multiplier would let each child element compute its
      // own line box from its own font-size, so a 100px run on a line
      // with otherwise small text balloons the line height — visible
      // as the line spacing growing while in edit mode and snapping
      // back smaller on exit.
      lineHeight: `${(obj.lineHeight !== undefined && obj.lineHeight > 0 ? obj.lineHeight : 1.2) * obj.fontSize}px`,
      letterSpacing: `${obj.letterSpacing ?? 0}px`,
      textAlign: obj.align,
      color: hexToCss(obj.color),
      caretColor: hexToCss(obj.color),
      ...(obj.textTransform !== undefined && obj.textTransform !== 'none'
        ? { textTransform: obj.textTransform }
        : {}),
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
      obj.textTransform,
    ],
  )

  // ── Mount: render initial HTML, focus, hide Pixi text node ───────────
  useLayoutEffect(() => {
    const el = editorRef.current
    if (el === null) return
    el.innerHTML = buildOverlayHtml(obj)
    setFaded(true)
    el.focus()
    // For freshly-created text (toolbar drop), select everything so the first
    // keystroke replaces the placeholder. Otherwise place caret at end so the
    // user continues from where they left off (double-click-to-edit case).
    const selectAll = consumeSelectAllOnEnter()
    const sel = window.getSelection()
    if (sel !== null) {
      const r = document.createRange()
      r.selectNodeContents(el)
      if (!selectAll) r.collapse(false)
      sel.removeAllRanges()
      sel.addRange(r)
    }
    return () => {
      setFaded(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
  }, [])

  // Resync the plain-text baseline whenever the obj prop changes so the
  // diff path in handleInput compares against the live Y.Text content.
  // Without this, a parent re-render that hands us a fresh `obj`
  // reference (peer edits a sibling field while we're editing) would
  // leave lastPlainRef pointing at the mount-time snapshot, and the
  // next user keystroke would diff against stale text and produce
  // spurious insert/delete ops.
  useEffect(() => {
    lastPlainRef.current = readPlainText(obj.text)
  }, [obj.text])

  // ── Y.Text → DOM observer (peer edits + Inspector inline format) ─────
  useEffect(() => {
    const yText = obj.text instanceof Y.Text ? obj.text : null
    if (yText === null) return
    const onYTextChange = (): void => {
      if (localEditRef.current) return
      const el = editorRef.current
      if (el === null) return
      // Save caret position by char index, rebuild HTML, restore — but
      // ONLY when the editor itself is the document's active element.
      // If focus has moved into a satellite control (Inspector input,
      // colour picker popover, etc.) the document selection can still
      // technically be anchored in the editor; calling
      // `selection.addRange` on that range re-focuses the editor and
      // Radix's DismissableLayer treats the focus move as "focus left
      // the popover" → it dismisses immediately, killing the in-flight
      // drag (e.g. you can't drag the colour picker beyond the first
      // few values). When the editor isn't focused, just rebuild the
      // HTML and leave the selection alone.
      const sel = window.getSelection()
      const editorIsFocused = document.activeElement === el
      let savedStart: number | null = null
      let savedEnd: number | null = null
      if (editorIsFocused && sel !== null && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
        const r = sel.getRangeAt(0)
        savedStart = domPositionToCharIndex(el, r.startContainer, r.startOffset)
        savedEnd = domPositionToCharIndex(el, r.endContainer, r.endOffset)
      }
      el.innerHTML = buildOverlayHtml(obj)
      lastPlainRef.current = yText.toString()
      if (savedStart !== null && savedEnd !== null) {
        const a = charIndexToDomPosition(el, savedStart)
        const b = charIndexToDomPosition(el, savedEnd)
        const r = document.createRange()
        try {
          r.setStart(a.node, a.offset)
          r.setEnd(b.node, b.offset)
          sel?.removeAllRanges()
          sel?.addRange(r)
        } catch {
          /* defensive — DOM shape edge cases */
        }
      }
    }
    yText.observe(onYTextChange)
    return () => {
      yText.unobserve(onYTextChange)
    }
  }, [obj])

  // ── Selection publish for Inspector inline-format buttons ────────────
  useEffect(() => {
    const el = editorRef.current
    if (el === null) return
    const yText = obj.text instanceof Y.Text ? obj.text : null
    if (yText === null) return

    const refocus = (): void => {
      const target = editorRef.current
      if (target === null) return
      const sel = window.getSelection()
      target.focus()
      if (sel === null) return
      // Restore the last-published selection range so the user can
      // see what the Inspector mutation just hit. Without this, a
      // refocus after the Inspector clicks would collapse the caret
      // wherever the browser placed it.
      const { start, end } = lastRangeRef.current
      try {
        const a = charIndexToDomPosition(target, start)
        const b = charIndexToDomPosition(target, end)
        const r = document.createRange()
        r.setStart(a.node, a.offset)
        r.setEnd(b.node, b.offset)
        sel.removeAllRanges()
        sel.addRange(r)
      } catch {
        /* range out of date — leave caret wherever focus put it */
      }
    }
    const publish = (): void => {
      const sel = window.getSelection()
      // When the document selection is OUTSIDE the editor (the user
      // clicked into the Inspector size input or a font picker), do
      // NOT clobber the slot — the Inspector controls need the last
      // valid range so an inline-format change still targets the
      // right characters. setActiveTextSelection(null) only happens
      // on overlay unmount.
      if (sel === null || sel.rangeCount === 0) return
      if (!el.contains(sel.anchorNode)) return
      const r = sel.getRangeAt(0)
      const start = domPositionToCharIndex(el, r.startContainer, r.startOffset)
      const end = domPositionToCharIndex(el, r.endContainer, r.endOffset)
      const lo = Math.min(start, end)
      const hi = Math.max(start, end)
      lastRangeRef.current = { start: lo, end: hi }
      setActiveTextSelection({ objectId: obj.id, yText, start: lo, end: hi, refocus })
    }
    publish()
    document.addEventListener('selectionchange', publish)
    return () => {
      document.removeEventListener('selectionchange', publish)
      setActiveTextSelection(null)
    }
  }, [obj.id, obj.text])

  // ── User input → Y.Text diff/apply ───────────────────────────────────
  const handleInput = (): void => {
    // The first real input means the user accepted the placeholder
    // selection (or typed past the initial caret); the select-all-on-enter
    // intent has been served.
    clearSelectAllOnEnter()
    const el = editorRef.current
    if (el === null) return
    const yText = obj.text instanceof Y.Text ? obj.text : null
    if (yText === null) return

    const next = getElementInnerText(el)
    const prev = lastPlainRef.current
    if (next === prev) return

    // Common-prefix / common-suffix diff. Handles single-position
    // typing, backspace, paste replace-selection in one go.
    let pStart = 0
    const minLen = Math.min(prev.length, next.length)
    while (pStart < minLen && prev[pStart] === next[pStart]) pStart += 1
    let pSuffix = 0
    while (
      pSuffix < minLen - pStart &&
      prev[prev.length - 1 - pSuffix] === next[next.length - 1 - pSuffix]
    ) {
      pSuffix += 1
    }
    const removeLen = prev.length - pStart - pSuffix
    const insertText = next.slice(pStart, next.length - pSuffix)

    if (removeLen === 0 && insertText.length === 0) return

    localEditRef.current = true
    try {
      mutationCtxRef.current.doc.transact(() => {
        if (removeLen > 0) yText.delete(pStart, removeLen)
        if (insertText.length > 0) {
          // Inherit the format of the run at the insertion point so
          // typing inside a bolded word stays bold.
          const attrs = attrsAtIndex(yText, pStart)
          if (Object.keys(attrs).length > 0) {
            yText.insert(pStart, insertText, attrs)
          } else {
            yText.insert(pStart, insertText)
          }
        }
      })
    } finally {
      localEditRef.current = false
    }
    lastPlainRef.current = next
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
      // Mirror Pixi's applyVerticalAlign — without this, edit mode
      // always rendered text from the top while the rendered Pixi
      // glyphs sat at middle/bottom, producing a vertical jump on
      // edit-enter and a snap-back on edit-exit.
      display: 'flex',
      flexDirection: 'column',
      justifyContent:
        obj.vAlign === 'middle' ? 'center' : obj.vAlign === 'bottom' ? 'flex-end' : 'flex-start',
      overflow: 'hidden',
    }),
    [obj.x, obj.y, obj.width, obj.height, obj.rotation, obj.vAlign],
  )

  const editorStyle = useMemo<React.CSSProperties>(
    () => ({
      // Flex child — the wrapper handles vertical positioning, so we
      // size to content (auto height) and only cap at the box height
      // so very tall text still clips inside the box edge.
      width: '100%',
      maxHeight: '100%',
      boxSizing: 'border-box',
      background: 'transparent',
      border: 'none',
      outline: 'none',
      padding: 0,
      margin: 0,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      ...baseStyle,
    }),
    [baseStyle],
  )

  return (
    <div style={wrapperStyle}>
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        style={editorStyle}
        onInput={handleInput}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onEnd()
            return
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            // contenteditable's default Enter inserts a <div> in
            // Chrome (or <p> elsewhere) which our diff doesn't see
            // as a newline. Use insertLineBreak so a <br> lands and
            // getElementInnerText counts it as '\n'.
            e.preventDefault()
            document.execCommand('insertLineBreak')
          }
        }}
        onBlur={(e) => {
          const next = e.relatedTarget as HTMLElement | null
          if (next !== null && next.closest('[data-text-edit-keep-focus]') !== null) {
            return
          }
          onEnd()
        }}
        onPaste={(e) => {
          // Paste plain text only — we never want HTML / styles to
          // bleed into the contenteditable from the clipboard.
          e.preventDefault()
          const txt = e.clipboardData.getData('text/plain')
          if (txt === '') return
          document.execCommand('insertText', false, txt)
        }}
        onPointerDown={(e) => {
          // User chose a caret position manually — drop the auto-select-all
          // intent so a subsequent re-mount (StrictMode) doesn't reselect.
          clearSelectAllOnEnter()
          e.stopPropagation()
        }}
      />
    </div>
  )
}
