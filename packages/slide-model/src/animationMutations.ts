/**
 * slide-model/src/animationMutations.ts
 *
 * Mutation API pro animations Y.Array.
 * Všechny mutace přes doc.transact(fn, LOCAL_ORIGIN).
 *
 * Analogie k mutations.ts pro SlideObject.
 */

import type * as Y from 'yjs'
import { nanoid } from 'nanoid'
import type { AnimationStep } from '@narrative/shared'
import { LOCAL_ORIGIN } from './mutations.js'
import { animationStepToYMap, yMapToAnimationStep } from './animationBindings.js'

export interface AnimationMutationContext {
  doc: Y.Doc
  animations: Y.Array<Y.Map<unknown>>
}

/**
 * Přidá AnimationStep do Y.Array animations.
 * ID je vygenerováno automaticky (nanoid).
 *
 * @returns Přidaný AnimationStep s vygenerovaným id.
 */
export function addAnimation(
  ctx: AnimationMutationContext,
  step: Omit<AnimationStep, 'id'>,
): AnimationStep {
  const id = nanoid()
  const fullStep: AnimationStep = { ...step, id }
  const yMap = animationStepToYMap(fullStep)

  ctx.doc.transact(() => {
    ctx.animations.push([yMap])
  }, LOCAL_ORIGIN)

  return fullStep
}

/**
 * Odstraní AnimationStep podle id z Y.Array.
 * Pokud id neexistuje: no-op + warn (idempotent).
 */
export function removeAnimation(ctx: AnimationMutationContext, id: string): void {
  ctx.doc.transact(() => {
    const idx = findAnimationIndexById(ctx.animations, id)
    if (idx === -1) {
      console.warn(`removeAnimation: animation with id '${id}' not found — no-op`)
      return
    }
    ctx.animations.delete(idx, 1)
  }, LOCAL_ORIGIN)
}

/**
 * Aktualizuje vlastnosti AnimationStep.
 * Patch může obsahovat libovolnou podmnožinu properties (kromě id a objectId).
 *
 * Pokud id neexistuje: no-op + warn (idempotent).
 */
export function updateAnimation(
  ctx: AnimationMutationContext,
  id: string,
  patch: Partial<Omit<AnimationStep, 'id' | 'objectId'>>,
): void {
  ctx.doc.transact(() => {
    const idx = findAnimationIndexById(ctx.animations, id)
    if (idx === -1) {
      console.warn(`updateAnimation: animation with id '${id}' not found — no-op`)
      return
    }

    const yMap = ctx.animations.get(idx)
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      yMap.set(key, value)
    }
  }, LOCAL_ORIGIN)
}

/**
 * Přeuspořádá animations do nového pořadí.
 * newOrder musí obsahovat přesně stejné IDs jako existující animations (bijekce).
 *
 * @throws Pokud newOrder neobsahuje stejné IDs jako existující animations.
 */
export function reorderAnimations(ctx: AnimationMutationContext, newOrder: string[]): void {
  // Načteme existující steps jako plain objects (před transact, pro validaci)
  const existingSteps: AnimationStep[] = []
  for (let i = 0; i < ctx.animations.length; i++) {
    existingSteps.push(yMapToAnimationStep(ctx.animations.get(i)))
  }

  const existingIds = new Set(existingSteps.map((s) => s.id))
  const newOrderSet = new Set(newOrder)

  // Validace bijekce
  if (newOrder.length !== existingSteps.length) {
    throw new Error(
      `reorderAnimations: newOrder has ${newOrder.length} items but animations has ${existingSteps.length}`,
    )
  }
  // Zkontroluj neznámé IDs v newOrder (dříve než chybějící, aby byl error srozumitelnější)
  for (const id of newOrderSet) {
    if (!existingIds.has(id)) {
      throw new Error(`reorderAnimations: newOrder contains unknown id '${id}'`)
    }
  }
  // Zkontroluj chybějící IDs (po length check a unknown check, mělo by být redundantní —
  // ale zachováno pro explicitnost)
  for (const id of existingIds) {
    if (!newOrderSet.has(id)) {
      throw new Error(`reorderAnimations: existing animation id '${id}' missing from newOrder`)
    }
  }

  // Sestavíme mapu id → step pro rychlé vyhledání
  const stepMap = new Map<string, AnimationStep>()
  for (const step of existingSteps) {
    stepMap.set(step.id, step)
  }

  // Sestavíme nové seřazené Y.Map array mimo transact
  const newYMaps = newOrder.map((id) => {
    const step = stepMap.get(id)
    if (step === undefined) {
      // Nemělo by nastat — validace výše to zachytí
      throw new Error(`reorderAnimations: step for id '${id}' not found in map`)
    }
    return animationStepToYMap(step)
  })

  ctx.doc.transact(() => {
    // Smaž všechny existující animations
    ctx.animations.delete(0, ctx.animations.length)
    // Vlož v novém pořadí
    if (newYMaps.length > 0) {
      ctx.animations.push(newYMaps)
    }
  }, LOCAL_ORIGIN)
}

// ---------------------------------------------------------------------------
// Interní helper
// ---------------------------------------------------------------------------

function findAnimationIndexById(animations: Y.Array<Y.Map<unknown>>, id: string): number {
  for (let i = 0; i < animations.length; i++) {
    const yMap = animations.get(i)
    if (yMap.get('id') === id) return i
  }
  return -1
}
