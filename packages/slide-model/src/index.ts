/**
 * @narrative/slide-model — public API
 *
 * Single import point pro všechny state/Yjs operace.
 * Renderer a editor-ui nesmí importovat Y.Doc přímo —
 * všechno přes toto API (viz ADR-0003).
 */

// Registry
export { registerObjectType, getObjectTypeDef, listRegisteredTypes } from './registry.js'
export type { ObjectTypeDef } from './registry.js'

// Y.Doc factory
export { createSlideDoc } from './yDoc.js'
export type { SlideDocHandles } from './yDoc.js'

// Mutations
export {
  LOCAL_ORIGIN,
  addObject,
  removeObject,
  updateObject,
  createObjectOfType,
} from './mutations.js'
export type { MutationContext } from './mutations.js'

// Bindings
export { yMapToPlainObject, plainObjectToYMap } from './bindings.js'

// Undo
export { createUndoManager } from './undo.js'

// Observer
export {
  subscribeToObjects,
  subscribeToObjectChanges,
  subscribeToObjectChangesWithFlush,
} from './observe.js'
export type { ObjectChangeSet } from './observe.js'

// ---------------------------------------------------------------------------
// Builtin object type registrations
// ---------------------------------------------------------------------------
// Importovat tento modul (index) garantuje že builtin typy jsou zaregistrovány.

import { registerObjectType } from './registry.js'
import type { RectangleObject, EllipseObject, TextObject } from '@narrative/shared'

registerObjectType<RectangleObject>({
  type: 'rectangle',
  defaultProps: () => ({
    x: 100,
    y: 100,
    width: 200,
    height: 150,
    fill: 0x4060e0,
    rotation: 0,
    opacity: 1,
  }),
})

registerObjectType<EllipseObject>({
  type: 'ellipse',
  defaultProps: () => ({
    x: 100,
    y: 100,
    width: 180,
    height: 180,
    fill: 0xe06040,
    rotation: 0,
    opacity: 1,
  }),
})

registerObjectType<TextObject>({
  type: 'text',
  defaultProps: () => ({
    x: 100,
    y: 100,
    width: 240,
    height: 40,
    text: 'Text',
    fontSize: 24,
    fontWeight: 'normal',
    color: 0x000000,
    align: 'left',
    rotation: 0,
    opacity: 1,
  }),
})
