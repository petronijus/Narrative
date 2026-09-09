/**
 * state/TextEditContext.tsx
 *
 * P7: which text object is currently in inline-edit mode, if any.
 * One object at a time — double-clicking a second text object ends
 * editing on the first.
 *
 * Not persisted to Y.Doc — purely ephemeral editor chrome state.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

export interface BeginEditOptions {
  /**
   * Select all text on enter (typing replaces it). Used for the
   * just-created-from-toolbar case so the placeholder "Text" is wiped by the
   * first keystroke, matching Figma/Keynote.
   */
  selectAllOnEnter?: boolean
}

export interface TextEditContextValue {
  editingId: string | null
  beginEdit: (id: string, opts?: BeginEditOptions) => void
  endEdit: () => void
  /**
   * Read (without clearing) whether the most recent beginEdit asked to
   * select all on enter. Idempotent — survives React StrictMode's double
   * effect mount in dev. Pair with `clearSelectAllOnEnter` once the user
   * actually edits.
   */
  consumeSelectAllOnEnter: () => boolean
  /** Clear the pending select-all flag — call after the user types / clicks. */
  clearSelectAllOnEnter: () => void
}

const TextEditContext = createContext<TextEditContextValue | null>(null)

export function TextEditProvider({ children }: { children: React.ReactNode }) {
  const [editingId, setEditingId] = useState<string | null>(null)
  // Pair the flag with the id it was set for. The overlay clears the flag
  // (sets pendingForId=null) the first time the user actually edits. This
  // survives React 18 StrictMode's double effect invocation in dev, where a
  // single-shot consume-and-clear ref would be cleared by the first mount and
  // missed by the second.
  const pendingRef = useRef<{ id: string; selectAll: boolean } | null>(null)
  const beginEdit = useCallback((id: string, opts?: BeginEditOptions) => {
    pendingRef.current = { id, selectAll: opts?.selectAllOnEnter === true }
    setEditingId(id)
  }, [])
  const endEdit = useCallback(() => {
    pendingRef.current = null
    setEditingId(null)
  }, [])

  // E2E: enter/leave text editing from a spec without hit-testing the canvas,
  // mirroring `narrative:test-set-selection` in SelectionContext. Entering edit
  // mode by synthesising a double-click is not reliable — the DOM overlay root
  // sits above the canvas with `pointer-events: auto`, so the click never
  // reaches Pixi's hit test.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const onBegin = (e: Event): void => {
      const detail = (e as CustomEvent<{ id: string; selectAll?: boolean }>).detail
      if (typeof detail?.id !== 'string') return
      beginEdit(detail.id, { selectAllOnEnter: detail.selectAll === true })
    }
    const onEnd = (): void => endEdit()
    window.addEventListener('narrative:test-begin-text-edit', onBegin)
    window.addEventListener('narrative:test-end-text-edit', onEnd)
    return () => {
      window.removeEventListener('narrative:test-begin-text-edit', onBegin)
      window.removeEventListener('narrative:test-end-text-edit', onEnd)
    }
  }, [beginEdit, endEdit])
  const consumeSelectAllOnEnter = useCallback((): boolean => {
    const p = pendingRef.current
    return p !== null && p.selectAll
  }, [])
  const clearSelectAllOnEnter = useCallback((): void => {
    pendingRef.current = null
  }, [])
  return (
    <TextEditContext
      value={{
        editingId,
        beginEdit,
        endEdit,
        consumeSelectAllOnEnter,
        clearSelectAllOnEnter,
      }}
    >
      {children}
    </TextEditContext>
  )
}

export function useTextEdit(): TextEditContextValue {
  const ctx = useContext(TextEditContext)
  if (ctx === null) throw new Error('useTextEdit: missing TextEditProvider')
  return ctx
}
