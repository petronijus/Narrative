/**
 * slide-model/src/registry.ts
 *
 * Object type registry — plugin boundary pro object typy.
 * Každý typ registruje metadata (defaultProps atd.).
 * Render, hitTest, inspector registruje renderer/editor-ui package v M2 fázi 2.
 */

import type { SlideObject, SlideObjectType } from '@narrative/shared'
import { BUILTIN_OBJECT_TYPES } from './builtinObjectTypes.js'

export interface ObjectTypeDef<T extends SlideObject = SlideObject> {
  type: T['type']
  /**
   * Factory pro default properties nového objektu tohoto typu.
   * Vylučuje id a type — ty jsou generovány při vytvoření.
   */
  defaultProps: () => Omit<T, 'id' | 'type'>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- registr pojme různé generické varianty
const types = new Map<SlideObjectType, ObjectTypeDef<any>>(
  // The built-in types are here from the start (builtinObjectTypes.ts): no
  // import has to run for its side effect before createObjectOfType works.
  BUILTIN_OBJECT_TYPES.map((d) => [d.type, d]),
)

/**
 * Zaregistruje nový object type. Volej před použitím createObjectOfType().
 * Duplikátní registrace vyhodí chybu — každý typ smí být zaregistrován jen jednou.
 */
export function registerObjectType<T extends SlideObject>(def: ObjectTypeDef<T>): void {
  if (types.has(def.type)) {
    throw new Error(`Object type '${def.type}' is already registered`)
  }
  types.set(def.type, def)
}

/**
 * Vrátí ObjectTypeDef pro daný typ, nebo undefined pokud není registrovaný.
 */
export function getObjectTypeDef(type: SlideObjectType): ObjectTypeDef | undefined {
  return types.get(type)
}

/**
 * Vrátí seznam všech registrovaných type stringů.
 */
export function listRegisteredTypes(): SlideObjectType[] {
  return Array.from(types.keys())
}

/**
 * Interní — pro testování: smaže všechny registrace.
 * Nepoužívej v produkčním kódu.
 */
export function _clearRegistry(): void {
  types.clear()
}
