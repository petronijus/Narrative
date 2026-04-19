/**
 * slide-model/src/animationBindings.ts
 *
 * Konverze mezi plain AnimationStep a Y.Map<unknown>.
 *
 * Analogie k bindings.ts pro SlideObject — stejný pattern.
 * Bindings nesmí importovat nic z Pixi ani React.
 */

import * as Y from 'yjs'
import type { AnimationStep } from '@narrative/shared'

/**
 * Konvertuje Y.Map na plain AnimationStep.
 * Y.Map musí být integrovaný v Y.Doc (po insertu do Y.Array).
 *
 * @throws Pokud Y.Map neobsahuje platné povinné fieldy (id, objectId, preset, trigger).
 */
export function yMapToAnimationStep(yMap: Y.Map<unknown>): AnimationStep {
  const plain = Object.fromEntries(yMap.entries()) as Record<string, unknown>

  if (typeof plain['id'] !== 'string') {
    throw new Error('yMapToAnimationStep: Y.Map missing required "id" field')
  }
  if (typeof plain['objectId'] !== 'string') {
    throw new Error('yMapToAnimationStep: Y.Map missing required "objectId" field')
  }
  if (typeof plain['preset'] !== 'string') {
    throw new Error('yMapToAnimationStep: Y.Map missing required "preset" field')
  }
  if (typeof plain['trigger'] !== 'string') {
    throw new Error('yMapToAnimationStep: Y.Map missing required "trigger" field')
  }
  if (typeof plain['duration'] !== 'number') {
    throw new Error('yMapToAnimationStep: Y.Map missing required "duration" field')
  }
  if (typeof plain['delay'] !== 'number') {
    throw new Error('yMapToAnimationStep: Y.Map missing required "delay" field')
  }
  if (typeof plain['easing'] !== 'string') {
    throw new Error('yMapToAnimationStep: Y.Map missing required "easing" field')
  }

  // Cast je justifikovaný: animationStepToYMap() garantuje správný tvar při zápisu.
  return plain as unknown as AnimationStep
}

/**
 * Vytvoří Y.Map naplněný daty z plain AnimationStep.
 *
 * POZNÁMKA: Vrácený Y.Map musí být ihned vložen do Y.Array uvnitř doc.transact(),
 * než bude čten. Standalone Y.Map bez doc kontextu vrací undefined pro get().
 */
export function animationStepToYMap(step: AnimationStep): Y.Map<unknown> {
  const yMap = new Y.Map<unknown>()

  const entries = Object.entries(step as unknown as Record<string, unknown>)
  for (const [key, value] of entries) {
    yMap.set(key, value)
  }

  return yMap
}

/**
 * Varianta pro testování: vytvoří Y.Map integrovaný v doc.
 * Hodnoty jsou čitelné ihned po volání (doc kontext je zajištěn).
 *
 * @internal Pro použití v animationBindings.test.ts a jiných testech
 */
export function animationStepToYMapInDoc(doc: Y.Doc, step: AnimationStep): Y.Map<unknown> {
  const tempArr = doc.getArray<Y.Map<unknown>>('__temp_animation_bindings_test')
  const yMap = new Y.Map<unknown>()

  doc.transact(() => {
    const entries = Object.entries(step as unknown as Record<string, unknown>)
    for (const [key, value] of entries) {
      yMap.set(key, value)
    }
    tempArr.push([yMap])
  })

  return yMap
}
