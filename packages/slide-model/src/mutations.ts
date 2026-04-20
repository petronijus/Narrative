/**
 * slide-model/src/mutations.ts
 *
 * Mutation API — všechny Yjs operace obaleny v doc.transact(fn, LOCAL_ORIGIN).
 * LOCAL_ORIGIN je Symbol importovatelný do UndoManageru pro filtrování.
 *
 * Konzumenti (editor-ui, test code) nesmí přistupovat k Y.Doc přímo —
 * všechny mutace jdou přes toto API.
 */

import * as Y from 'yjs'
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

/**
 * ObjectsMutationContext — context scoped to one slide's objects Y.Array.
 * Renamed from MutationContext in M9 for clarity.
 * Use getSlideObjectsCtx() from slides.ts to obtain from a deck context.
 */
export interface ObjectsMutationContext {
  doc: Y.Doc
  objects: Y.Array<Y.Map<unknown>>
}

/**
 * @deprecated Use ObjectsMutationContext. Alias kept for backward compat — removed in M10.
 */
export type MutationContext = ObjectsMutationContext

/**
 * Přidá SlideObject do Y.Array.
 * Objekt musí mít platné id a type.
 */
export function addObject(ctx: ObjectsMutationContext, obj: SlideObject): void {
  const yMap = plainObjectToYMap(obj)
  ctx.doc.transact(() => {
    ctx.objects.push([yMap])
  }, LOCAL_ORIGIN)
}

/**
 * Odstraní objekt podle id z Y.Array.
 * Pokud id neexistuje, operace je no-op.
 */
export function removeObject(ctx: ObjectsMutationContext, id: string): void {
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
  ctx: ObjectsMutationContext,
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
  ctx: ObjectsMutationContext,
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

/**
 * Duplikuje existující objekt — vytvoří kopii s novým id a volitelným posunem.
 *
 * - Offset default: { x: 20, y: 20 } aby byl duplikát viditelně posunutý.
 * - Duplikát je přidán na konec Y.Array (nejvyšší z-order).
 * - Celá operace v jedné transakci → jeden undo krok.
 *
 * @returns Plain object nově přidaného duplikátu, nebo null pokud source neexistuje.
 */
export function duplicateObject(
  ctx: ObjectsMutationContext,
  id: string,
  offset: { x: number; y: number } = { x: 20, y: 20 },
): SlideObject | null {
  const sourceIdx = findIndexById(ctx.objects, id)
  if (sourceIdx === -1) {
    console.warn(`duplicateObject: object '${id}' not found`)
    return null
  }

  const sourceMap = ctx.objects.get(sourceIdx)
  const sourcePlain = Object.fromEntries(sourceMap.entries()) as Record<string, unknown>

  const newId = nanoid()
  const clonedPlain: Record<string, unknown> = {
    ...sourcePlain,
    id: newId,
    x: (sourcePlain['x'] as number) + offset.x,
    y: (sourcePlain['y'] as number) + offset.y,
  }

  // Sestavíme Y.Map pro nový objekt
  const newYMap = new Y.Map<unknown>()
  for (const [key, value] of Object.entries(clonedPlain)) {
    newYMap.set(key, value)
  }

  ctx.doc.transact(() => {
    ctx.objects.push([newYMap])
  }, LOCAL_ORIGIN)

  // Vrátíme plain kopii — přečteme ze Y.Array (YMap je teď v doc kontextu)
  const insertedMap = ctx.objects.get(ctx.objects.length - 1)
  return Object.fromEntries(insertedMap.entries()) as unknown as SlideObject
}

/**
 * Popis jedné položky v batch update.
 */
export interface BulkUpdate {
  id: string
  patch: SlideObjectPatch<SlideObject>
}

/**
 * Aplikuje více patch operací v jedné Yjs transakci.
 *
 * Výhoda: N updatů = 1 Yjs update (1 WS message místo N).
 * Při 60Hz group drag (20 objektů) → 60× méně network trafficu.
 *
 * - Pro neexistující id: warn + skip, ostatní pokračují.
 * - Empty updates: no-op, žádná transakce se neotvírá.
 */
export function bulkUpdateObjects(ctx: ObjectsMutationContext, updates: BulkUpdate[]): void {
  if (updates.length === 0) return

  ctx.doc.transact(() => {
    for (const { id, patch } of updates) {
      const idx = findIndexById(ctx.objects, id)
      if (idx === -1) {
        console.warn(`bulkUpdateObjects: object '${id}' not found, skipping`)
        continue
      }
      const yMap = ctx.objects.get(idx)
      for (const [key, value] of Object.entries(patch)) {
        yMap.set(key, value)
      }
    }
  }, LOCAL_ORIGIN)
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
