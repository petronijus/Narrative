/**
 * state/SlideDocProvider.tsx
 *
 * React context provider pro SlideDoc.
 * Na mount: vytvoří Y.Doc, seeduje demo daty.
 * Na unmount: doc.destroy() pro cleanup Yjs subscriptions.
 */

import { useEffect, useRef, useState } from 'react'
import { createSlideDoc, addObject, createUndoManager } from '@narrative/slide-model'
import type { SlideDocHandles } from '@narrative/slide-model'
import { SlideDocContext } from './slideDocContext.js'
import type { SlideDocContextValue } from './slideDocContext.js'
import { demoObjects } from '../data/demoSlide.js'

interface SlideDocProviderProps {
  children: React.ReactNode
}

export function SlideDocProvider({ children }: SlideDocProviderProps) {
  const [value, setValue] = useState<SlideDocContextValue | null>(null)

  // Ref pro StrictMode double-mount safety
  const handleRef = useRef<SlideDocHandles | null>(null)

  useEffect(() => {
    // intentional empty deps: mount-only effect with StrictMode guard
    if (handleRef.current !== null) return

    const handles = createSlideDoc()
    handleRef.current = handles

    const mutationCtx = {
      doc: handles.doc,
      objects: handles.objects,
    }

    const undoManager = createUndoManager(mutationCtx)

    for (const obj of demoObjects) {
      addObject(mutationCtx, obj)
    }

    setValue({ mutationCtx, undoManager })

    return () => {
      handles.doc.destroy()
      handleRef.current = null
      setValue(null)
    }
  }, [])

  if (value === null) {
    return null
  }

  return <SlideDocContext.Provider value={value}>{children}</SlideDocContext.Provider>
}
