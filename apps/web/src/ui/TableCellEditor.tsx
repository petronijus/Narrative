/**
 * ui/TableCellEditor.tsx
 *
 * M29 Phase 2 — inline cell editor for the first-class TableObject.
 *
 * Plain-text contenteditable over the active cell, two-way bound to
 * the cell's Y.Text via the same diff-on-input pattern as
 * `TextEditOverlay`. Publishes its selection to the global
 * `textEditSelection` slot so the Inspector's existing inline-format
 * toolbar lights up against the cell text (font weight / italic /
 * underline / color → run-level Y.Text format).
 *
 * Keyboard:
 *   Tab / Shift+Tab → next / prev cell (Tab past last appends a row)
 *   Enter           → next row, same col (appends row if at bottom)
 *   Shift+Enter     → newline within the cell
 *   Escape          → exit edit mode, keep cell selected
 */

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as Y from 'yjs'
import {
  type ObjectsMutationContext,
  getTableCellYMap,
  insertTableRow,
} from '@narrative/slide-model'
import { isTokenRef, type TableObject } from '@narrative/shared'
import type { TokenRef } from '@narrative/shared'
import { useTableEdit } from '../state/TableEditContext.js'
import { setActiveTextSelection } from './textEditSelection.js'

export interface TableCellEditorProps {
  table: TableObject
  mutationCtx: ObjectsMutationContext
}

const hexToCss = (n: number | TokenRef | undefined, fallback: string): string =>
  n === undefined || (typeof n === 'object' && isTokenRef(n))
    ? fallback
    : '#' + (n as number).toString(16).padStart(6, '0')

/** Renderer's exact bbox math — keep in sync with `tableRenderer.cellBbox`. */
function cellBbox(
  table: TableObject,
  r: number,
  c: number,
): { x: number; y: number; w: number; h: number } | null {
  if (table.rows[r]?.[c] === undefined) return null
  const colSum = table.colWidths.reduce((a, b) => a + b, 0) || 1
  const rowSum = table.rowHeights.reduce((a, b) => a + b, 0) || 1
  const sx = table.width / colSum
  const sy = table.height / rowSum
  let lx = 0
  for (let i = 0; i < c; i++) lx += (table.colWidths[i] ?? 0) * sx
  let ty = 0
  for (let i = 0; i < r; i++) ty += (table.rowHeights[i] ?? 0) * sy
  return {
    x: table.x + lx,
    y: table.y + ty,
    w: (table.colWidths[c] ?? 0) * sx,
    h: (table.rowHeights[r] ?? 0) * sy,
  }
}

function readDomText(el: HTMLElement): string {
  let out = ''
  const walk = (n: Node): void => {
    if (n.nodeType === Node.TEXT_NODE) out += n.nodeValue ?? ''
    else if (n.nodeName === 'BR') out += '\n'
    else for (let i = 0; i < n.childNodes.length; i++) walk(n.childNodes[i]!)
  }
  walk(el)
  return out
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').split('\n').join('<br>')

/** Char-offset → DOM (node, offset) pair, mirroring TextEditOverlay's
 *  `charIndexToDomPosition`. Returns the offset past the last child
 *  when index runs off the end so the caret still lands somewhere. */
function caretAt(root: Node, idx: number): { node: Node; offset: number } {
  let remaining = idx
  let res: { node: Node; offset: number } = { node: root, offset: 0 }
  let done = false
  const walk = (n: Node): void => {
    if (done) return
    if (n.nodeType === Node.TEXT_NODE) {
      const len = (n.nodeValue ?? '').length
      if (remaining <= len) {
        res = { node: n, offset: remaining }
        done = true
        return
      }
      remaining -= len
      return
    }
    if (n.nodeName === 'BR') {
      if (remaining === 0) {
        const p = n.parentNode
        if (p !== null) {
          res = { node: p, offset: Array.prototype.indexOf.call(p.childNodes, n) }
          done = true
        }
        return
      }
      remaining -= 1
      return
    }
    for (let i = 0; i < n.childNodes.length; i++) {
      walk(n.childNodes[i]!)
      if (done) return
    }
  }
  walk(root)
  if (!done) res = { node: root, offset: root.childNodes.length }
  return res
}

function countCharsUpTo(root: Node, container: Node, offset: number): number {
  let count = 0
  let found = false
  const walk = (n: Node): boolean => {
    if (found) return true
    if (n === container) {
      if (n.nodeType === Node.TEXT_NODE) count += offset
      else for (let i = 0; i < offset && i < n.childNodes.length; i++) walk(n.childNodes[i]!)
      found = true
      return true
    }
    if (n.nodeType === Node.TEXT_NODE) {
      count += (n.nodeValue ?? '').length
      return false
    }
    if (n.nodeName === 'BR') {
      count += 1
      return false
    }
    for (let i = 0; i < n.childNodes.length; i++) if (walk(n.childNodes[i]!)) return true
    return false
  }
  walk(root)
  return count
}

export function TableCellEditor({ table, mutationCtx }: TableCellEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const { active, setActive, beginEdit, endEdit } = useTableEdit()
  const lastPlainRef = useRef<string>('')
  const localEditRef = useRef<boolean>(false)
  const mutationCtxRef = useRef(mutationCtx)
  mutationCtxRef.current = mutationCtx

  const binding = useMemo(() => {
    if (active === null || !active.editing || active.tableId !== table.id) return null
    const cellY = getTableCellYMap(mutationCtxRef.current, active.tableId, active.r, active.c)
    if (cellY === null) return null
    const yt = cellY.get('text')
    return yt instanceof Y.Text ? { yText: yt, r: active.r, c: active.c } : null
  }, [active, table.id])

  const bbox = useMemo(
    () => (binding === null ? null : cellBbox(table, binding.r, binding.c)),
    [binding, table],
  )

  const styleForCell = useMemo(() => {
    if (binding === null) return null
    const cell = table.rows[binding.r]?.[binding.c]
    if (cell === undefined) return null
    const d = table.defaults
    return {
      fontSize: cell.fontSize ?? d.fontSize,
      fontWeight: cell.fontWeight ?? d.fontWeight,
      color: hexToCss(cell.color ?? d.color, '#111111'),
      align: cell.align ?? d.align,
      vAlign: cell.vAlign ?? d.vAlign,
      padding: cell.padding ?? d.padding,
      fontFamily: d.fontFamily,
    }
  }, [binding, table])

  // Mount: render initial text, focus, select all so first keystroke
  // replaces the placeholder.
  useLayoutEffect(() => {
    if (binding === null) return
    const el = editorRef.current
    if (el === null) return
    const initial = binding.yText.toString()
    lastPlainRef.current = initial
    el.innerHTML = escapeHtml(initial)
    el.focus()
    const sel = window.getSelection()
    if (sel !== null) {
      const r = document.createRange()
      r.selectNodeContents(el)
      sel.removeAllRanges()
      sel.addRange(r)
    }
  }, [binding])

  // Peer-edit observer.
  useEffect(() => {
    if (binding === null) return
    const yText = binding.yText
    const onChange = (): void => {
      if (localEditRef.current) return
      const el = editorRef.current
      if (el === null) return
      const next = yText.toString()
      if (readDomText(el) === next) return
      const sel = window.getSelection()
      let savedIdx = -1
      if (sel !== null && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
        const r = sel.getRangeAt(0)
        savedIdx = countCharsUpTo(el, r.startContainer, r.startOffset)
      }
      el.innerHTML = escapeHtml(next)
      lastPlainRef.current = next
      if (savedIdx >= 0 && sel !== null) {
        const t = caretAt(el, savedIdx)
        const r = document.createRange()
        try {
          r.setStart(t.node, t.offset)
          r.collapse(true)
          sel.removeAllRanges()
          sel.addRange(r)
        } catch {
          /* ignore */
        }
      }
    }
    yText.observe(onChange)
    return () => yText.unobserve(onChange)
  }, [binding])

  // Publish selection to the global slot so Inspector's inline-format
  // toolbar binds to this cell's Y.Text (font weight / italic / etc.).
  useEffect(() => {
    if (binding === null) return
    const el = editorRef.current
    if (el === null) return
    // A stable id for the cell so the Inspector can scope inline-
    // format actions to this edit session. Includes (r,c) so peer
    // row inserts don't accidentally re-target a different cell.
    const objectId = `${table.id}#${binding.r},${binding.c}`
    const refocus = (): void => {
      el.focus()
    }
    const publish = (): void => {
      const sel = window.getSelection()
      if (sel === null || sel.rangeCount === 0) return
      if (!el.contains(sel.anchorNode)) return
      const r = sel.getRangeAt(0)
      const a = countCharsUpTo(el, r.startContainer, r.startOffset)
      const b = countCharsUpTo(el, r.endContainer, r.endOffset)
      setActiveTextSelection({
        objectId,
        yText: binding.yText,
        start: Math.min(a, b),
        end: Math.max(a, b),
        refocus,
      })
    }
    publish()
    document.addEventListener('selectionchange', publish)
    return () => {
      document.removeEventListener('selectionchange', publish)
      setActiveTextSelection(null)
    }
  }, [binding, table.id])

  if (binding === null || bbox === null || styleForCell === null) return null

  const handleInput = (): void => {
    const el = editorRef.current
    if (el === null) return
    const next = readDomText(el)
    const prev = lastPlainRef.current
    if (next === prev) return
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
        if (removeLen > 0) binding.yText.delete(pStart, removeLen)
        if (insertText.length > 0) binding.yText.insert(pStart, insertText)
      })
    } finally {
      localEditRef.current = false
    }
    lastPlainRef.current = next
  }

  const moveTo = (r: number, c: number): void => {
    setActive({ tableId: table.id, r, c })
    beginEdit({ tableId: table.id, r, c })
  }

  const tabNext = (): void => {
    const cols = table.colWidths.length
    const rows = table.rows.length
    let nr = binding.r
    let nc = binding.c + 1
    if (nc >= cols) {
      nc = 0
      nr += 1
      if (nr >= rows) {
        insertTableRow(mutationCtxRef.current, table.id, -1)
        nr = rows
      }
    }
    moveTo(nr, nc)
  }

  const tabPrev = (): void => {
    const cols = table.colWidths.length
    let nr = binding.r
    let nc = binding.c - 1
    if (nc < 0) {
      if (nr === 0) return
      nr -= 1
      nc = cols - 1
    }
    moveTo(nr, nc)
  }

  const enterRow = (): void => {
    const rows = table.rows.length
    let nr = binding.r + 1
    if (nr >= rows) {
      insertTableRow(mutationCtxRef.current, table.id, -1)
      nr = rows
    }
    moveTo(nr, binding.c)
  }

  // Wrapper covers the cell bbox in world coords. Flex column with
  // justifyContent driven by vAlign keeps the contenteditable's vertical
  // anchor matching what the Pixi renderer draws — without this, top/
  // middle/bottom cells always rendered the editor at the top.
  const wrapperStyle: React.CSSProperties = {
    position: 'absolute',
    left: bbox.x,
    top: bbox.y,
    width: bbox.w,
    height: bbox.h,
    transform: `rotate(${table.rotation}rad)`,
    transformOrigin: `${table.width / 2 - (bbox.x - table.x)}px ${table.height / 2 - (bbox.y - table.y)}px`,
    boxSizing: 'border-box',
    padding: `${styleForCell.padding.top}px ${styleForCell.padding.right}px ${styleForCell.padding.bottom}px ${styleForCell.padding.left}px`,
    display: 'flex',
    flexDirection: 'column',
    justifyContent:
      styleForCell.vAlign === 'middle'
        ? 'center'
        : styleForCell.vAlign === 'bottom'
          ? 'flex-end'
          : 'flex-start',
    background: 'rgba(255,255,255,0.95)',
    outline: '2px solid rgba(59, 130, 246, 0.9)',
    outlineOffset: '-1px',
    overflow: 'hidden',
    zIndex: 30,
  }

  const editorStyle: React.CSSProperties = {
    width: '100%',
    border: 'none',
    outline: 'none',
    background: 'transparent',
    padding: 0,
    margin: 0,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: styleForCell.fontFamily ?? 'system-ui, -apple-system, sans-serif',
    fontSize: `${styleForCell.fontSize}px`,
    fontWeight: styleForCell.fontWeight as React.CSSProperties['fontWeight'],
    color: styleForCell.color,
    textAlign: styleForCell.align,
    caretColor: styleForCell.color,
  }

  return (
    <div style={wrapperStyle} data-testid="table-cell-editor">
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
            endEdit()
            return
          }
          if (e.key === 'Tab') {
            e.preventDefault()
            if (e.shiftKey) tabPrev()
            else tabNext()
            return
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            enterRow()
            return
          }
          if (e.key === 'Enter' && e.shiftKey) {
            e.preventDefault()
            document.execCommand('insertLineBreak')
          }
        }}
        onPaste={(e) => {
          e.preventDefault()
          const txt = e.clipboardData.getData('text/plain')
          if (txt !== '') document.execCommand('insertText', false, txt)
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      />
    </div>
  )
}
