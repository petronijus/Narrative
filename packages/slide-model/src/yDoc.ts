/**
 * slide-model/src/yDoc.ts
 *
 * Y.Doc factory pro jeden slide.
 *
 * Architektonická volba (ADR-0003):
 * Místo Y.Array uvnitř Y.Map používáme doc.getArray('objects') přímo na root doc.
 * Důvod: Y.Array uvnitř Y.Map má na Windows/jsdom observer gotchy s timing
 * a Y.UndoManager trackingem. Root-level getArray() je robustnější.
 * Slide metadata (id) jsou v separátním doc.getMap('slideMeta').
 *
 * M6 extension: Přidán root-level 'animations' Y.Array (sibling k 'objects').
 * Backward compat: existující decky bez animations Y.Array se chovají jako
 * prázdný array — doc.getArray() vytvoří prázdný array pokud neexistuje.
 */

import * as Y from 'yjs'
import { nanoid } from 'nanoid'

export interface SlideDocHandles {
  doc: Y.Doc
  /** Y.Map pro metadata slidu (id, budoucí: background, theme...) */
  slideMeta: Y.Map<unknown>
  /** Y.Array objektů na slidu — root-level na doc pro stabilní observer tracking */
  objects: Y.Array<Y.Map<unknown>>
  /**
   * Y.Array animačních kroků — root-level sibling k objects.
   * Pořadí v array = play order animací na slide.
   * Přidáno v M6. Backward compat: getArray vrátí prázdný array pro starší decky.
   */
  animations: Y.Array<Y.Map<unknown>>
}

/**
 * Vytvoří nový Y.Doc s prázdným slidem.
 * objects i animations jsou root-level Y.Array — stabilnější pro UndoManager a observe.
 */
export function createSlideDoc(): SlideDocHandles {
  const doc = new Y.Doc()

  // Root-level Y.Map pro metadata slidu
  const slideMeta = doc.getMap<unknown>('slideMeta')

  // Root-level Y.Array pro objekty — viz architektonická volba výše
  const objects = doc.getArray<Y.Map<unknown>>('objects')

  // Root-level Y.Array pro animace (M6) — sibling k objects
  // getArray() je idempotentní: vrátí existující array nebo vytvoří prázdný.
  const animations = doc.getArray<Y.Map<unknown>>('animations')

  // Inicializace metadat v transakci
  doc.transact(() => {
    slideMeta.set('id', nanoid())
  })

  return { doc, slideMeta, objects, animations }
}
