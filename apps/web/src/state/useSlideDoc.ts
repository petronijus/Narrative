/**
 * state/useSlideDoc.ts
 *
 * Hook pro přístup k SlideDoc kontextu.
 */

import { useContext } from 'react'
import { SlideDocContext } from './slideDocContext.js'
import type { SlideDocContextValue } from './slideDocContext.js'

export type { SlideDocContextValue }

export function useSlideDoc(): SlideDocContextValue {
  const ctx = useContext(SlideDocContext)
  if (ctx === null) {
    throw new Error('useSlideDoc must be used within SlideDocProvider')
  }
  return ctx
}
