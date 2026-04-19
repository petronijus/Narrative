/**
 * data/demoSlide.ts
 *
 * Hardcoded demo slide data pro M1.
 * V M2 bude nahrazeno Yjs Y.Doc state napájejícím SceneGraph přes reconciler.
 */

import type { SlideObjectData } from '../renderer/types'

export const demoSlide: SlideObjectData[] = [
  {
    id: 'rect-1',
    type: 'rectangle',
    x: 200,
    y: 150,
    width: 300,
    height: 200,
    fill: 0x4060e0,
    rotation: 0,
    opacity: 1,
  },
  {
    id: 'rect-2',
    type: 'rectangle',
    x: 560,
    y: 380,
    width: 180,
    height: 120,
    fill: 0xe06040,
    rotation: 0.15,
    opacity: 0.8,
  },
]
