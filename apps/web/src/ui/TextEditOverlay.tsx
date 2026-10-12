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
 * - User edits are diffed (common-prefix / common-suffix) into a
 *   `text.edit` command (ADR 0010: the editor writes only through
 *   commands). Enter, Tab and the list Backspace are structural: `text.edit`
 *   with `key` (the Enter / Backspace rules live in the command) and
 *   `text.list` with `indent`. New characters inherit the format
 *   attributes of the run at the insertion point so typing inside a
 *   bolded word stays bold — the command's rule.
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

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { powerpointLineOffsetPx, resolveLineHeightPx } from '../lib/fontLineMetrics.js'
import { firstLineFontSizePx, listedHtmlOptionsFor, paragraphsOf } from '../lib/textLayout.js'
import * as Y from 'yjs'
import { isTokenRef } from '@narrative/shared'
import type { TokenRef } from '@narrative/shared'
import {
  buildListedHtml,
  getParagraphs,
  getPlainString,
  PARAGRAPH_SEP,
} from '@narrative/slide-model'
import type { TextObject } from '@narrative/shared'
import { MAX_BODY_LENGTH, displayRangeOf, rawOffsetOf, type TextTarget } from '@narrative/commands'
import { useCommand } from '../state/useCommand.js'
import { setActiveTextSelection } from './textEditSelection.js'
import {
  getElementInnerText,
  domPositionToCharIndex,
  charIndexToDomPosition,
} from './textEditDom.js'
import { useCanvasInstance } from '../renderer/CanvasInstanceContext.js'
import { cssFontFamily } from '../renderer/fontFallback.js'
import { useTextEdit } from '../state/TextEditContext.js'

export interface TextEditOverlayProps {
  obj: TextObject
  /** The body as commands address it: the text box, or a table cell (`cell`). */
  target: TextTarget
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
 * Build the contenteditable HTML — the SAME `buildListedHtml` output the
 * Pixi renderer uses, so markers, numbering, nesting indent, and paragraph
 * blocks are WYSIWYG while editing. Each paragraph is a `<div data-pb>`;
 * markers are `<span data-marker contenteditable="false">`; empty
 * paragraphs carry `<br data-empty>`. The DOM↔char helpers below know to
 * treat those structurally.
 */
function buildOverlayHtml(obj: TextObject): string {
  return buildListedHtml(paragraphsOf(obj), listedHtmlOptionsFor(obj))
}

/**
 * The editable string projection of the body: paragraphs joined by the
 * U+2029 separator, WITHOUT the trailing-separator the list model keeps to
 * anchor the final paragraph's block attrs. The contenteditable DOM holds
 * exactly this projection (N paragraphs ⇒ N−1 visible separators), so the
 * diff path and caret math operate in these coordinates. Y.Text indices
 * map 1:1 to editable indices across [0, editableLength]; the trailing
 * separator (when present) sits at Y.Text index editableLength, beyond the
 * editable range, so inserts at the end land before it automatically.
 */
function editableString(t: TextObject['text']): string {
  if (t instanceof Y.Text)
    return getParagraphs(t)
      .map((p) => p.text)
      .join(PARAGRAPH_SEP)
  if (typeof t === 'string') return t
  return ''
}

/** The body's stored text (a legacy plain-string body counts as its string). */
function storedText(t: TextObject['text']): string {
  if (t instanceof Y.Text) return getPlainString(t)
  return typeof t === 'string' ? t : ''
}

/** Typed text as `text.edit` takes it: a paragraph separator is the display "\n\n". */
function toDisplayText(s: string): string {
  return s.split(PARAGRAPH_SEP).join('\n\n')
}

export function TextEditOverlay({ obj, target, onEnd }: TextEditOverlayProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const command = useCommand()
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
  const lastPlainRef = useRef<string>(editableString(obj.text))
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

  // Defaults applied to runs that don't override the corresponding
  // attribute. Box-wide values come from the TextObject.
  const baseStyle = useMemo<React.CSSProperties>(
    () => ({
      // Run the same CSS-safe stack the renderer uses for HTMLText, so
      // edit mode and render mode share a font fallback chain. Without
      // `cssFontFamily` the editor would render in raw `obj.fontFamily`
      // (no quoting, no category fallback), which means an unknown
      // PPTX face like "Northwind Sans ST Pro 36 Bold" falls all the
      // way to the browser default serif — a jarring "doubleclick to
      // edit, font changes" experience.
      fontFamily: cssFontFamily(obj.fontFamily) ?? 'Arial, Helvetica, sans-serif',
      fontSize: `${obj.fontSize}px`,
      fontWeight: weightToCss(obj.fontWeight),
      fontStyle: obj.italic === true ? 'italic' : 'normal',
      textDecoration: obj.underline === true ? 'underline' : 'none',
      // Match Pixi: fixed pixel line heights. Each paragraph carries its own
      // (buildListedHtml, from the fonts in it); this is the frame's, for
      // anything outside a paragraph. A unitless multiplier would let each
      // run compute its own line box, so edit and render mode would draw
      // different lines — same resolver, same boxes.
      lineHeight: `${resolveLineHeightPx(obj)}px`,
      // The renderer moves laid-out text by the same amount to put spare
      // line height above the glyphs, as PowerPoint does (see
      // powerpointLineOffsetPx). Relative positioning shifts what is drawn
      // and where the caret goes without changing the flex layout, so
      // vertical alignment is computed on the same block in both.
      position: 'relative',
      top: powerpointLineOffsetPx(obj, firstLineFontSizePx(obj)),
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
      obj.lineSpacing,
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
    lastPlainRef.current = editableString(obj.text)
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
      lastPlainRef.current = editableString(obj.text)
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
      setActiveTextSelection({ objectId: obj.id, target, yText, start: lo, end: hi, refocus })
    }
    publish()
    document.addEventListener('selectionchange', publish)
    return () => {
      document.removeEventListener('selectionchange', publish)
      setActiveTextSelection(null)
    }
  }, [obj.id, obj.text, target])

  // ── User input → text.edit ───────────────────────────────────────────

  /** Current selection as editable-string char indices, or null. */
  const getCaretRange = (): { start: number; end: number } | null => {
    const el = editorRef.current
    const sel = window.getSelection()
    if (el === null || sel === null || sel.rangeCount === 0) return null
    if (!el.contains(sel.anchorNode)) return null
    const r = sel.getRangeAt(0)
    const a = domPositionToCharIndex(el, r.startContainer, r.startOffset)
    const b = domPositionToCharIndex(el, r.endContainer, r.endOffset)
    return { start: Math.min(a, b), end: Math.max(a, b) }
  }

  const restoreCaret = (start: number, end: number): void => {
    const el = editorRef.current
    const sel = window.getSelection()
    if (el === null || sel === null) return
    const a = charIndexToDomPosition(el, start)
    const b = charIndexToDomPosition(el, end)
    const r = document.createRange()
    try {
      r.setStart(a.node, a.offset)
      r.setEnd(b.node, b.offset)
      sel.removeAllRanges()
      sel.addRange(r)
    } catch {
      /* defensive — DOM shape edge cases */
    }
  }

  /**
   * Redraw the editor from the document and put the caret at `caret`
   * (stored offsets; editable offsets are the same). Used after a change
   * the DOM cannot show by itself — a structural edit, or typed text the
   * command turned into more (a pasted blank line becomes a paragraph).
   */
  const redraw = (caret: { start: number; end: number } | null): void => {
    const el = editorRef.current
    if (el === null) return
    el.innerHTML = buildOverlayHtml(obj)
    lastPlainRef.current = editableString(obj.text)
    if (caret !== null) restoreCaret(caret.start, caret.end)
  }

  /**
   * Dispatch an edit of this body. The editor's own change must not come
   * back through the Y.Text observer (it would rebuild the DOM under the
   * caret), so the observer is muted while the command runs. Null when the
   * command did not apply (a collaborator removed the body a moment ago).
   */
  const dispatch = <T,>(commandId: string, input: Record<string, unknown>): T | null => {
    localEditRef.current = true
    try {
      return command.tryRun<T>(commandId, input)
    } finally {
      localEditRef.current = false
    }
  }

  /** A `text.edit` caret (display offset) as a stored offset. */
  const caretFromDisplay = (display: number): { start: number; end: number } => {
    const pos = rawOffsetOf(storedText(obj.text), display)
    return { start: pos, end: pos }
  }

  const handleInput = (): void => {
    // The first real input means the user accepted the placeholder
    // selection (or typed past the initial caret); the select-all-on-enter
    // intent has been served.
    clearSelectAllOnEnter()
    const el = editorRef.current
    if (el === null) return

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

    // Editable offsets are stored offsets; the command takes the display
    // offsets queries use (a paragraph break counts 2).
    const range = displayRangeOf(storedText(obj.text), pStart, pStart + removeLen)
    const result = dispatch<{ caret: number }>('text.edit', {
      target,
      edits: [{ at: range.start, delete: range.length, insert: toDisplayText(insertText) }],
    })
    if (result === null) {
      redraw(getCaretRange())
      return
    }
    // A legacy plain-string body is promoted to rich text by the command;
    // the new body arrives with the next render.
    if (!(obj.text instanceof Y.Text)) {
      lastPlainRef.current = next
      return
    }
    const model = editableString(obj.text)
    if (model === next) lastPlainRef.current = next
    else redraw(caretFromDisplay(result.caret))
  }

  // ── Structural edits (Enter / Tab / list Backspace) ──────────────────
  // The DOM cannot express a paragraph separator carrying block attributes,
  // so these are commands followed by a redraw with the caret put back.

  /** Enter: split the paragraph (a new list item continues the list), or on
   *  an empty list item outdent / end the list — the command's rule. */
  const handleEnter = (): void => {
    if (!(obj.text instanceof Y.Text)) {
      document.execCommand('insertLineBreak')
      return
    }
    const range = getCaretRange()
    if (range === null) return
    clearSelectAllOnEnter()
    const d = displayRangeOf(storedText(obj.text), range.start, range.end)
    const result = dispatch<{ caret: number }>('text.edit', {
      target,
      edits: [
        ...(d.length > 0 ? [{ at: d.start, delete: d.length }] : []),
        { at: d.start, key: 'Enter' },
      ],
    })
    redraw(result === null ? range : caretFromDisplay(result.caret))
  }

  /**
   * Paste plain text over the selection as one `text.edit`: a blank line in
   * it starts a new paragraph (continuing a list), a single line break stays
   * a line break — the text.set convention. Handled here rather than by the
   * browser, whose own insertion of multi-line text builds DOM the diff
   * cannot read back faithfully.
   */
  const handlePaste = (pasted: string): void => {
    const text = pasted.replace(/\r\n?/g, '\n').slice(0, MAX_BODY_LENGTH)
    if (!(obj.text instanceof Y.Text)) {
      document.execCommand('insertText', false, text)
      return
    }
    const range = getCaretRange()
    if (range === null) return
    clearSelectAllOnEnter()
    const d = displayRangeOf(storedText(obj.text), range.start, range.end)
    const result = dispatch<{ caret: number }>('text.edit', {
      target,
      edits: [{ at: d.start, delete: d.length, insert: text }],
    })
    redraw(result === null ? range : caretFromDisplay(result.caret))
  }

  /** Tab / Shift+Tab: indent / outdent the covered paragraphs. */
  const handleIndent = (delta: number): void => {
    if (!(obj.text instanceof Y.Text)) return
    const range = getCaretRange()
    if (range === null) return
    dispatch('text.list', {
      target,
      range: displayRangeOf(storedText(obj.text), range.start, range.end),
      indent: delta,
    })
    redraw(range)
  }

  /**
   * Backspace at the very start of a list/indented paragraph. Native
   * contenteditable refuses to merge across the leading non-editable marker
   * span, so it is the command's Backspace rule (Keynote/PowerPoint
   * progression): outdent if nested, strip the list on the first item, else
   * merge into the previous paragraph. Returns true when handled (caller
   * preventDefaults).
   */
  const handleListBackspace = (): boolean => {
    const yText = obj.text instanceof Y.Text ? obj.text : null
    if (yText === null) return false
    const range = getCaretRange()
    if (range === null || range.start !== range.end) return false
    const pos = range.start
    const para = getParagraphs(yText).find((p) => p.start <= pos && pos <= p.end)
    if (para === undefined) return false
    // Only intervene at the very start of a paragraph; mid-paragraph delete is
    // plain and handled by the diff path.
    if (pos !== para.start) return false
    // Plain, non-indented paragraphs merge natively — leave them alone.
    if (para.attrs.list === undefined && (para.attrs.level ?? 0) === 0) return false
    const at = displayRangeOf(storedText(yText), pos, pos).start
    const result = dispatch<{ caret: number }>('text.edit', {
      target,
      edits: [{ at, key: 'Backspace' }],
    })
    redraw(result === null ? range : caretFromDisplay(result.caret))
    return true
  }

  // Autofit (A4.2), drawn as the renderer draws it: a growing box is as tall
  // as the text being typed into it; a shrinking box shows its type at the
  // scale the renderer found, re-read whenever the renderer rescales it.
  const grows = obj.autofit === 'grow-down'
  const [, setLayoutTick] = useState(0)
  useEffect(() => {
    if (canvas === null || obj.autofit !== 'shrink') return
    return canvas.sceneGraph.onTextLayout((id) => {
      if (id === obj.id) setLayoutTick((n) => n + 1)
    })
  }, [canvas, obj.id, obj.autofit])
  const shrinkScale =
    obj.autofit === 'shrink' ? (canvas?.sceneGraph.textLayout(obj.id)?.scale ?? 1) : 1

  const wrapperStyle = useMemo<React.CSSProperties>(
    () => ({
      position: 'absolute',
      left: obj.x,
      top: obj.y,
      width: obj.width,
      height: grows ? 'auto' : obj.height,
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
        grows || obj.vAlign === undefined || obj.vAlign === 'top'
          ? 'flex-start'
          : obj.vAlign === 'middle'
            ? 'center'
            : 'flex-end',
      // An unwrapped line may extend past the box, as it renders; clipping
      // it here would hide the caret at the end of it.
      overflow: obj.wrap === 'none' || grows ? 'visible' : 'hidden',
    }),
    [obj.x, obj.y, obj.width, obj.height, obj.rotation, obj.vAlign, obj.wrap, grows],
  )

  const editorStyle = useMemo<React.CSSProperties>(
    () => ({
      // Flex child — the wrapper handles vertical positioning, so we
      // size to content (auto height) and only cap at the box height
      // so very tall text still clips inside the box edge.
      width: '100%',
      maxHeight: grows ? 'none' : '100%',
      // `zoom` (not a transform) so the scaled text also lays out scaled:
      // lines break at the box width at the smaller size, as rendered.
      ...(shrinkScale !== 1 ? { zoom: shrinkScale } : {}),
      boxSizing: 'border-box',
      background: 'transparent',
      border: 'none',
      outline: 'none',
      padding: 0,
      margin: 0,
      whiteSpace: obj.wrap === 'none' ? 'pre' : 'pre-wrap',
      wordBreak: obj.wrap === 'none' ? 'normal' : 'break-word',
      // Unwrapped text is as wide as its longest line and may be wider than
      // the box; it grows the way the renderer anchors it (align-self below
      // mirrors applyHorizontalAlign), so caret and glyphs stay together.
      ...(obj.wrap === 'none'
        ? {
            width: 'max-content',
            minWidth: '100%',
            alignSelf:
              obj.align === 'right' ? 'flex-end' : obj.align === 'center' ? 'center' : 'flex-start',
          }
        : {}),
      ...baseStyle,
    }),
    [baseStyle, obj.wrap, obj.align, grows, shrinkScale],
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
            // Enter starts a new paragraph (= new list item / <a:p>) by
            // inserting a U+2029 separator that carries the paragraph's
            // block attributes. Handled explicitly rather than via
            // contenteditable's default (which inserts a bare <div>).
            e.preventDefault()
            handleEnter()
            return
          }
          if (e.key === 'Enter' && e.shiftKey) {
            // Shift+Enter is a soft line break (continuation line inside
            // the same paragraph / list item) — a plain <br> = '\n'.
            e.preventDefault()
            document.execCommand('insertLineBreak')
            return
          }
          if (e.key === 'Tab') {
            // Tab / Shift+Tab indent / outdent the current paragraph(s).
            e.preventDefault()
            handleIndent(e.shiftKey ? -1 : 1)
            return
          }
          if (e.key === 'Backspace') {
            // Structural backspace at the start of a list/indented paragraph
            // (native can't merge across the marker span). Falls through to
            // the diff path for everything else.
            if (handleListBackspace()) e.preventDefault()
            return
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
          handlePaste(txt)
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
