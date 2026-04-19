/**
 * state/useUndoManager.ts
 *
 * Hook pro přístup k Y.UndoManager z SlideDocContext.
 * Vrací undo/redo funkce + stav canUndo/canRedo.
 *
 * Global keyboard shortcut handler je v EditorLayout.tsx,
 * který volá tyto funkce.
 */

import { useState, useEffect, useCallback } from 'react'
import { useSlideDoc } from './useSlideDoc.js'

export interface UseUndoManagerResult {
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
}

export function useUndoManager(): UseUndoManagerResult {
  const { undoManager } = useSlideDoc()

  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  useEffect(() => {
    const update = () => {
      setCanUndo(undoManager.canUndo())
      setCanRedo(undoManager.canRedo())
    }

    // Inicializační stav
    update()

    undoManager.on('stack-item-added', update)
    undoManager.on('stack-item-popped', update)
    undoManager.on('stack-cleared', update)

    return () => {
      undoManager.off('stack-item-added', update)
      undoManager.off('stack-item-popped', update)
      undoManager.off('stack-cleared', update)
    }
  }, [undoManager])

  const undo = useCallback(() => {
    undoManager.undo()
  }, [undoManager])

  const redo = useCallback(() => {
    undoManager.redo()
  }, [undoManager])

  return { undo, redo, canUndo, canRedo }
}
