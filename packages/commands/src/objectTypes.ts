/**
 * commands/src/objectTypes.ts — the slide object types commands know, and a
 * guard for values read from input or from the document.
 */

import type { SlideObjectType } from '@narrative/shared'

export const OBJECT_TYPES: readonly SlideObjectType[] = [
  'rectangle',
  'ellipse',
  'triangle',
  'polygon',
  'line',
  'arrow',
  'path',
  'text',
  'image',
  'video',
  'table',
]

export function isObjectType(v: unknown): v is SlideObjectType {
  return typeof v === 'string' && (OBJECT_TYPES as readonly string[]).includes(v)
}
