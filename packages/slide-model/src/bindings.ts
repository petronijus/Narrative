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
 *
 * Většina fields je shallow-passthrough — primitives, plain objects,
 * Y.Text (TextObject body) zůstávají jak jsou. VÝJIMKA: pro
 * `componentInstance.overrides` deep-walkujeme nested Y.Map → plain JS,
 * protože override resolver (resolveOverrides.ts) i renderer očekávají
 * plain JSON. Storage layout je nested Y.Map (sdílí key-level CRDT s
 * scanTokenUsages.ts), reading layout je plain — boundary žije zde.
 */
export function yMapToPlainObject<T extends SlideObject>(yMap: Y.Map<unknown>): T {
  const plain = Object.fromEntries(yMap.entries()) as Record<string, unknown>

  if (typeof plain['type'] !== 'string') {
    throw new Error('yMapToPlainObject: Y.Map missing required "type" field')
  }

  if (plain['type'] === 'componentInstance' && plain['overrides'] !== undefined) {
    plain['overrides'] = deepPlainFromY(plain['overrides'])
  }

  // Cast je justifikovaný: plainObjectToYMap() garantuje správný tvar při zápisu,
  // a yMapToPlainObject je vždy voláno na Y.Map vytvořené přes plainObjectToYMap.
  return plain as unknown as T
}

/**
 * Recursive Y.Map / Y.Array → plain conversion. Mirrors the walker in
 * `apps/web/src/state/extractComponentSnapshot.ts:walkYValue` but lives
 * here so the slide-model package has no dependency on app code.
 *
 * Used only on the `overrides` slot for now (a small, bounded payload).
 * Not generalised to all Y.Map values because TextObject bodies must
 * stay as Y.Text — the renderer handles those specially.
 */
function deepPlainFromY(value: unknown): unknown {
  if (value === null) return null
  if (typeof value !== 'object') return value
  if (value instanceof Y.Map) {
    const out: Record<string, unknown> = {}
    value.forEach((v, k) => {
      out[k] = deepPlainFromY(v)
    })
    return out
  }
  if (value instanceof Y.Array) {
    const out: unknown[] = []
    for (let i = 0; i < value.length; i++) {
      out.push(deepPlainFromY(value.get(i)))
    }
    return out
  }
  if (value instanceof Y.Text) return value.toString()
  if (Array.isArray(value)) return value.map(deepPlainFromY)
  // POJO — copy keys (defensive; legacy plain-object overrides survive).
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = deepPlainFromY(v)
  }
  return out
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
