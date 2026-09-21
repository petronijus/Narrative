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
import { resolveLineHeightPx } from '../lib/fontLineMetrics.js'
import * as Y from 'yjs'
import { isTokenRef } from '@narrative/shared'
import type { TokenRef } from '@narrative/shared'
import {
  type ObjectsMutationContext,
  buildListedHtml,
  getParagraphDeltas,
  getParagraphs,
  blockAttrsToInsertAttrs,
  applyParagraphPatch,
  indentParagraphs,
  spliceRichText,
  LOCAL_ORIGIN,
  PARAGRAPH_SEP,
  type ListedHtmlOptions,
} from '@narrative/slide-model'
import type { TextObject } from '@narrative/shared'
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
 * Shared list/paragraph HTML options for a TextObject. Mirrors the Pixi
 * renderer's `listedHtmlOptionsFor` (kept local so the overlay never
 * imports Pixi-side state) so edit mode and render mode draw identical
 * markers, indents, and paragraph spacing.
 */
function listedOptionsFor(obj: TextObject): ListedHtmlOptions {
  const o: ListedHtmlOptions = {}
  if (obj.italic === true) o.italic = true
  if (obj.underline === true) o.underline = true
  if (typeof obj.paragraphSpaceBefore === 'number' && obj.paragraphSpaceBefore > 0) {
    o.paragraphSpaceBefore = obj.paragraphSpaceBefore
  }
  if (typeof obj.paragraphSpaceAfter === 'number' && obj.paragraphSpaceAfter > 0) {
    o.paragraphSpaceAfter = obj.paragraphSpaceAfter
  }
  if (obj.listStyle !== undefined) o.legacyListStyle = obj.listStyle
  return o
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
  const t = obj.text
  const paras =
    t instanceof Y.Text
      ? getParagraphDeltas(t)
      : (typeof t === 'string' ? t : '')
          .split(PARAGRAPH_SEP)
          .map((seg) => ({ ops: seg.length > 0 ? [{ insert: seg }] : [], attrs: {} }))
  return buildListedHtml(paras, listedOptionsFor(obj))
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
  const mutationCtxRef = useRef(mutationCtx)
  mutationCtxRef.current = mutationCtx

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
      // Match Pixi: fixed pixel line height = multiplier × box fontSize.
      // A unitless multiplier would let each child element compute its
      // own line box from its own font-size, so a 100px run on a line
      // with otherwise small text balloons the line height — visible
      // as the line spacing growing while in edit mode and snapping
      // back smaller on exit.
      // Same resolver as the renderer, so edit and render mode share the
      // exact same line boxes (lineHeight → lineSpacing → the font's normal).
      lineHeight: `${resolveLineHeightPx(obj)}px`,
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
      // Delegate the Y.Text splice to slide-model (mutations live there).
      //
      // LOCAL_ORIGIN is what puts this edit on the undo stack: the UndoManager
      // is built with `trackedOrigins: new Set([LOCAL_ORIGIN])`, so a
      // transaction without it is invisible to undo. Typing used to pass no
      // origin at all, which meant every keystroke was unundoable — you could
      // undo moving a text box but not writing the sentence inside it.
      //
      // The observer echo is suppressed by the localEditRef flag above, not by
      // the absence of an origin; the two are independent.
      spliceRichText(mutationCtxRef.current.doc, yText, pStart, removeLen, insertText, LOCAL_ORIGIN)
    } finally {
      localEditRef.current = false
    }
    lastPlainRef.current = next
  }

  // ── Structural list/paragraph edits (Enter / Tab) ────────────────────
  // These mutate Y.Text directly (insert a U+2029 separator carrying block
  // attrs, or shift paragraph levels) then rebuild the overlay HTML and
  // restore the caret by char index — the diff path can't express a
  // separator with block attributes.

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

  const runStructural = (mutate: (yText: Y.Text) => { start: number; end: number }): void => {
    const el = editorRef.current
    const yText = obj.text instanceof Y.Text ? obj.text : null
    if (el === null || yText === null) return
    localEditRef.current = true
    let caret = { start: 0, end: 0 }
    try {
      // LOCAL_ORIGIN so Enter / Tab / list restructuring lands on the undo
      // stack alongside ordinary typing — see the splice above.
      mutationCtxRef.current.doc.transact(() => {
        caret = mutate(yText)
      }, LOCAL_ORIGIN)
    } finally {
      localEditRef.current = false
    }
    el.innerHTML = buildOverlayHtml(obj)
    lastPlainRef.current = editableString(obj.text)
    restoreCaret(caret.start, caret.end)
  }

  /** Enter: split the paragraph (new list item continues the list), or on an
   *  empty list item outdent / end the list. */
  const handleEnter = (): void => {
    const yText = obj.text instanceof Y.Text ? obj.text : null
    if (yText === null) {
      document.execCommand('insertLineBreak')
      return
    }
    const range = getCaretRange()
    if (range === null) return
    clearSelectAllOnEnter()
    runStructural((yt) => {
      if (range.end > range.start) yt.delete(range.start, range.end - range.start)
      const pos = range.start
      const paras = getParagraphs(yt)
      const para = paras.find((p) => p.start <= pos && pos <= p.end) ?? paras[paras.length - 1]!
      if (para.text.length === 0 && para.attrs.list !== undefined) {
        // Empty list item: outdent one level, or convert to a plain
        // paragraph once at level 0 (Keynote/PowerPoint behavior).
        if ((para.attrs.level ?? 0) > 0) {
          indentParagraphs(yt, pos, pos, -1)
        } else {
          applyParagraphPatch(yt, pos, pos, {
            list: null,
            level: null,
            bulletChar: null,
            numberFormat: null,
            startAt: null,
          })
        }
        return { start: pos, end: pos }
      }
      // Split: the inserted separator carries this paragraph's block attrs
      // so the new paragraph continues the list at the same kind/level.
      const blockAttrs = blockAttrsToInsertAttrs(para.attrs)
      const insertSep = (at: number): void => {
        if (blockAttrs !== undefined) yt.insert(at, PARAGRAPH_SEP, blockAttrs)
        else yt.insert(at, PARAGRAPH_SEP)
      }
      insertSep(pos)
      // Splitting at the very end leaves the new (empty) paragraph with no
      // terminator, which `getParagraphs` would collapse away — so it would
      // never render and the caret would fall back into the previous block.
      // Append a terminator so the trailing empty paragraph actually exists.
      if (pos + 1 === yt.length) insertSep(yt.length)
      return { start: pos + 1, end: pos + 1 }
    })
  }

  /** Tab / Shift+Tab: indent / outdent the covered paragraphs. */
  const handleIndent = (delta: number): void => {
    const yText = obj.text instanceof Y.Text ? obj.text : null
    if (yText === null) return
    const range = getCaretRange()
    if (range === null) return
    runStructural((yt) => {
      indentParagraphs(yt, range.start, range.end, delta)
      return range
    })
  }

  /**
   * Backspace at the very start of a list/indented paragraph. Native
   * contenteditable refuses to merge across the leading non-editable marker
   * span, so we handle it structurally (Keynote/PowerPoint progression):
   * outdent if nested, strip the list on the first item, else merge into the
   * previous paragraph. Returns true when handled (caller preventDefaults).
   */
  const handleListBackspace = (): boolean => {
    const yText = obj.text instanceof Y.Text ? obj.text : null
    if (yText === null) return false
    const range = getCaretRange()
    if (range === null || range.start !== range.end) return false
    const pos = range.start
    const paras = getParagraphs(yText)
    const idx = paras.findIndex((p) => p.start <= pos && pos <= p.end)
    if (idx < 0) return false
    const para = paras[idx]!
    // Only intervene at the very start of a paragraph; mid-paragraph delete is
    // plain and handled by the diff path.
    if (pos !== para.start) return false
    // Plain, non-indented paragraphs merge natively — leave them alone.
    if (para.attrs.list === undefined && (para.attrs.level ?? 0) === 0) return false
    if ((para.attrs.level ?? 0) > 0) {
      handleIndent(-1)
      return true
    }
    if (idx === 0) {
      runStructural((yt) => {
        applyParagraphPatch(yt, pos, pos, {
          list: null,
          level: null,
          bulletChar: null,
          numberFormat: null,
          startAt: null,
        })
        return { start: pos, end: pos }
      })
      return true
    }
    runStructural((yt) => {
      yt.delete(pos - 1, 1)
      return { start: pos - 1, end: pos - 1 }
    })
    return true
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
