/**
 * data/demoSlide.ts
 *
 * Demo seed data pro M2. Tato data slouží pouze jako počáteční obsah Y.Doc.
 * Y.Doc je single source of truth — tato data se na startu seedují jednou.
 *
 * V M1 byl tento soubor "the source". Od M2 je jen seed input.
 */

import type { SlideObject } from '@narrative/shared'

export const demoObjects: SlideObject[] = [
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
