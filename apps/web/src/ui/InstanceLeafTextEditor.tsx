/**
 * ui/InstanceLeafTextEditor.tsx
 *
 * Minimal inline text editor for a TextObject leaf inside an
 * activeInstanceEdit session.
 *
 * The slide-level TextEditOverlay reads/writes `obj.text` directly on
 * a slide-object Y.Map (with full Y.Text rich-text support). Component
 * instance leaves don't live in the slide's object array — their text
 * lives in `instance.overrides.leaves[leafId].text` as a plain string,
 * seeded from the master at insert time. This component edits that
 * plain string via `setLeafOverridePatch({ text })`. Rich-text
 * formatting on instance copies is intentionally NOT supported in this
 * milestone — copy on instances is plain only; style fields (font,
 * color, size, etc.) are still per-leaf overridable from the Inspector.
 *
 * Lifecycle:
 *   - Mounts when the parent passes a non-null `leafId` in instance-edit mode.
 *   - On Esc / outside-click / Enter-without-Shift → calls `onCommit()`.
 *   - On every change → debounced setLeafOverridePatch({ text }) so peers see
 *     edits live (matches Y.Doc rAF batching behaviour).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { setLeafOverridePatch } from '@narrative/slide-model'
import type { ObjectsMutationContext } from '@narrative/slide-model'
import type { ComponentInstanceObject, TextObject } from '@narrative/shared'
import type { SceneGraph } from '../renderer/SceneGraph.js'
import { getInstanceLeafContainer } from '../renderer/objectRenderers/componentInstanceRenderer.js'
import { useZoomLevel } from '../state/useZoomLevel.js'

export interface InstanceLeafTextEditorProps {
  instanceObj: ComponentInstanceObject
  leaf: TextObject
  sceneGraph: SceneGraph
  mutationCtx: ObjectsMutationContext
  onCommit: () => void
}

export function InstanceLeafTextEditor({
  instanceObj,
  leaf,
  sceneGraph,
  mutationCtx,
  onCommit,
}: InstanceLeafTextEditorProps) {
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const { zoom } = useZoomLevel()
  const [value, setValue] = useState<string>(typeof leaf.text === 'string' ? leaf.text : '')

  // Debounced commit to the override Y.Map. Per-keystroke writes saturate
  // the Pixi text-renderer's texSubImage2D path (and the offscreen thumb
  // renderer) — texture allocation lags content changes by a frame and
  // produces black rectangles / cropped glyphs / WebGL OFFSET_OVERFLOWS
  // errors. Coalesce inputs into one Y.Map write per ~150ms; flush on
  // commit so Esc / blur send the latest value through immediately.
  const pendingTextRef = useRef<string | null>(null)
  const debounceRef = useRef<number | null>(null)
  const flushPending = useCallback((): void => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    if (pendingTextRef.current !== null) {
      setLeafOverridePatch(mutationCtx, instanceObj.id, leaf.id, { text: pendingTextRef.current })
      pendingTextRef.current = null
    }
  }, [mutationCtx, instanceObj.id, leaf.id])
  const queueWrite = useCallback(
    (next: string): void => {
      pendingTextRef.current = next
      if (debounceRef.current !== null) return
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null
        flushPending()
      }, 150)
    },
    [flushPending],
  )
  useEffect(() => {
    return () => {
      // Component unmount path (parent flipped editing id back to null
      // without going through onCommit) — make sure pending text reaches
      // the Y.Map.
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current)
        debounceRef.current = null
      }
      if (pendingTextRef.current !== null) {
        setLeafOverridePatch(mutationCtx, instanceObj.id, leaf.id, {
          text: pendingTextRef.current,
        })
        pendingTextRef.current = null
      }
    }
  }, [mutationCtx, instanceObj.id, leaf.id])

  const commit = useCallback((): void => {
    flushPending()
    onCommit()
  }, [flushPending, onCommit])

  // Compute leaf bounds in slide-space — same path the InstanceEditHandles use.
  const node = sceneGraph.getNode(instanceObj.id)
  const leafContainer =
    node !== undefined ? getInstanceLeafContainer(node.container, leaf.id) : null
  const bounds =
    leafContainer !== null ? sceneGraph.getContainerBoundsFromData(leafContainer, leaf) : null

  // Auto-focus + select all on mount so the user can start typing immediately.
  useLayoutEffect(() => {
    const ta = taRef.current
    if (ta === null) return
    ta.focus()
    ta.select()
  }, [])

  // Esc commits. Enter is left to the textarea (inserts newline) — multi-
  // line text needs to be enterable; only an explicit cancel exits.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        commit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commit])

  // Click-outside commits.
  useEffect(() => {
    function onPointerDown(e: PointerEvent): void {
      const ta = taRef.current
      if (ta !== null && e.target instanceof Node && ta.contains(e.target)) return
      commit()
    }
    // Defer to next tick so the doubleclick that opened the editor
    // doesn't immediately close it.
    const id = window.setTimeout(() => {
      window.addEventListener('pointerdown', onPointerDown, true)
    }, 0)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [commit])

  if (bounds === null) return null
  const [tl, tr, , bl] = bounds.corners
  if (tl === undefined || tr === undefined || bl === undefined) return null
  const width = Math.hypot(tr.x - tl.x, tr.y - tl.y)
  const height = Math.hypot(bl.x - tl.x, bl.y - tl.y)
  const inv = 1 / (zoom || 1)

  return (
    <textarea
      ref={taRef}
      value={value}
      onChange={(e) => {
        const next = e.target.value
        setValue(next)
        // Debounced — see queueWrite. flushed by commit() / unmount.
        queueWrite(next)
      }}
      onBlur={commit}
      style={{
        position: 'absolute',
        left: tl.x,
        top: tl.y,
        width,
        height,
        margin: 0,
        padding: 0,
        border: 'none',
        outline: '2px solid #60a5fa',
        outlineOffset: 0,
        background: 'rgba(255,255,255,0.85)',
        color:
          typeof leaf.color === 'number' ? `#${leaf.color.toString(16).padStart(6, '0')}` : '#000',
        fontFamily: leaf.fontFamily ?? 'system-ui, -apple-system, sans-serif',
        fontSize: leaf.fontSize,
        fontWeight: leaf.fontWeight,
        fontStyle: leaf.italic === true ? 'italic' : 'normal',
        textDecoration: leaf.underline === true ? 'underline' : 'none',
        textAlign: leaf.align,
        lineHeight: leaf.lineHeight ?? 1.2,
        letterSpacing: leaf.letterSpacing ?? 0,
        textTransform: leaf.textTransform ?? 'none',
        resize: 'none',
        zIndex: 30,
        boxSizing: 'border-box',
        // Counter-scale stroke so it stays at 2px on screen at any zoom.
        outlineWidth: `${2 * inv}px`,
      }}
      aria-label="Edit component leaf text"
    />
  )
}
