/**
 * slide-model/src/mutations.ts
 *
 * Mutation API — všechny Yjs operace obaleny v doc.transact(fn, LOCAL_ORIGIN).
 * LOCAL_ORIGIN je Symbol importovatelný do UndoManageru pro filtrování.
 *
 * Konzumenti (editor-ui, test code) nesmí přistupovat k Y.Doc přímo —
 * všechny mutace jdou přes toto API.
 */

import type * as Y from 'yjs'
import { nanoid } from 'nanoid'
import type { SlideObject, SlideObjectType, SlideObjectPatch } from '@narrative/shared'
import { plainObjectToYMap } from './bindings.js'
import { getObjectTypeDef } from './registry.js'

/**
 * Symbol pro identifikaci lokálních user mutací.
 * UndoManager filtruje jen operace s tímto originem.
 * Remote changes (Hocuspocus v M4) budou mít jiný origin → nebudou undo-ovány.
 */
export const LOCAL_ORIGIN = Symbol('local-user')

export interface MutationContext {
  doc: Y.Doc
  objects: Y.Array<Y.Map<unknown>>
}

/**
 * Přidá SlideObject do Y.Array.
 * Objekt musí mít platné id a type.
 */
export function addObject(ctx: MutationContext, obj: SlideObject): void {
  const yMap = plainObjectToYMap(obj)
  ctx.doc.transact(() => {
    ctx.objects.push([yMap])
  }, LOCAL_ORIGIN)
}

/**
 * Odstraní objekt podle id z Y.Array.
 * Pokud id neexistuje, operace je no-op.
 */
export function removeObject(ctx: MutationContext, id: string): void {
  ctx.doc.transact(() => {
    const idx = findIndexById(ctx.objects, id)
    if (idx !== -1) {
      ctx.objects.delete(idx, 1)
    }
  }, LOCAL_ORIGIN)
}

/**
 * Aktualizuje properties objektu. Patch může obsahovat libovolnou podmnožinu
 * properties (kromě id a type — ty jsou immutable).
 *
 * Pokud objekt s daným id neexistuje, operace je no-op.
 */
export function updateObject<T extends SlideObject>(
  ctx: MutationContext,
  id: string,
  patch: SlideObjectPatch<T>,
): void {
  ctx.doc.transact(() => {
    const idx = findIndexById(ctx.objects, id)
    if (idx === -1) return

    const yMap = ctx.objects.get(idx)
    for (const [key, value] of Object.entries(patch)) {
      yMap.set(key, value)
    }
  }, LOCAL_ORIGIN)
}

/**
 * Vytvoří objekt daného typu s defaultProps z registry + volitelné overrides,
 * přidá ho do doc a vrátí plain object (s vygenerovaným id).
 *
 * @throws Pokud typ není registrován v registry.
 */
export function createObjectOfType(
  ctx: MutationContext,
  type: SlideObjectType,
  overrides?: Partial<Omit<SlideObject, 'type'>>,
): SlideObject {
  const def = getObjectTypeDef(type)
  if (def === undefined) {
    throw new Error(`createObjectOfType: type '${type}' is not registered`)
  }

  const id = nanoid()
  // defaultProps() vrací Omit<T, 'id' | 'type'> — cast je bezpečný
  const defaults = def.defaultProps() as Omit<SlideObject, 'id' | 'type'>
  const obj: SlideObject = {
    ...defaults,
    ...overrides,
    id,
    type,
  } as SlideObject

  addObject(ctx, obj)

  return obj
}

// ---------------------------------------------------------------------------
// Interní helper
// ---------------------------------------------------------------------------

function findIndexById(objects: Y.Array<Y.Map<unknown>>, id: string): number {
  for (let i = 0; i < objects.length; i++) {
    const yMap = objects.get(i)
    if (yMap.get('id') === id) return i
  }
  return -1
}
