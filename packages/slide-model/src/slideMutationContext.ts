/**
 * slide-model/src/slideMutationContext.ts
 *
 * SlideMutationContext — unified kontext spojující MutationContext (objects)
 * a AnimationMutationContext (animations).
 *
 * Konzumenti, kteří potřebují obě mutations API dohromady, používají
 * SlideMutationContext. createSlideDoc() vrací SlideDocHandles které tvar
 * SlideMutationContext splňují (doc + objects + animations jsou přítomné).
 */

import type { MutationContext } from './mutations.js'
import type { AnimationMutationContext } from './animationMutations.js'

/**
 * Unified mutation context — kombinuje objects i animations.
 * SlideDocHandles tvar splňuje tento interface.
 */
export interface SlideMutationContext extends MutationContext, AnimationMutationContext {}
