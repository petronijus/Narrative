/**
 * slide-model/src/bindings.ts
 *
 * Konverze mezi plain SlideObject a Y.Map<unknown>.
 *
 * DŮLEŽITÉ: Y.Map musí být inicializován uvnitř Y.Doc před čtením/zápisem.
 * Standalone new Y.Map() bez doc kontextu nefunguje v Yjs 13+.
 * plainObjectToYMap() vrací Y.Map připravený pro insert do Y.Array uvnitř transact().
 *
 * Bindings nesmí importovat nic z Pixi ani React.
 */

import * as Y from 'yjs'
import type { SlideObject } from '@narrative/shared'

/**
 * Konvertuje Y.Map na plain SlideObject.
 * Y.Map musí být integrovaný v Y.Doc (po insertu do Y.Array).
 *
 * @throws Pokud Y.Map neobsahuje platný `type` field.
 */
export function yMapToPlainObject<T extends SlideObject>(yMap: Y.Map<unknown>): T {
  const plain = Object.fromEntries(yMap.entries()) as Record<string, unknown>

  if (typeof plain['type'] !== 'string') {
    throw new Error('yMapToPlainObject: Y.Map missing required "type" field')
  }

  // Cast je justifikovaný: plainObjectToYMap() garantuje správný tvar při zápisu,
  // a yMapToPlainObject je vždy voláno na Y.Map vytvořené přes plainObjectToYMap.
  return plain as unknown as T
}

/**
 * Vytvoří Y.Map naplněný daty z plain SlideObject.
 *
 * POZNÁMKA: Vrácený Y.Map musí být ihned vložen do Y.Array uvnitř doc.transact(),
 * než bude čten. Standalone Y.Map bez doc kontextu vrací undefined pro get().
 * Viz mutations.ts addObject() pro správné použití.
 */
export function plainObjectToYMap<T extends SlideObject>(obj: T): Y.Map<unknown> {
  const yMap = new Y.Map<unknown>()

  // Iterujeme přes entries — obj je plain object, unknown cast přes any je nutný
  // protože SlideObject diskriminované union nemá index signature.
  const entries = Object.entries(obj as unknown as Record<string, unknown>)
  for (const [key, value] of entries) {
    yMap.set(key, value)
  }

  return yMap
}

/**
 * Varianta pro testování: vytvoří Y.Map integrovaný v doc.
 * Hodnoty jsou čitelné ihned po volání (doc kontext je zajištěn).
 *
 * @internal Pro použití v bindings.test.ts a jiných testech
 */
export function plainObjectToYMapInDoc<T extends SlideObject>(doc: Y.Doc, obj: T): Y.Map<unknown> {
  const tempArr = doc.getArray<Y.Map<unknown>>('__temp_bindings_test')
  const yMap = new Y.Map<unknown>()

  doc.transact(() => {
    const entries = Object.entries(obj as unknown as Record<string, unknown>)
    for (const [key, value] of entries) {
      yMap.set(key, value)
    }
    tempArr.push([yMap])
  })

  return yMap
}
