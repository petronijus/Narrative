/**
 * packages/animation/src/index.ts
 *
 * @narrative/animation — veřejné API
 *
 * DSL types re-exportovány z @narrative/shared (single source of truth).
 * Engine-specific types + runtime funkce exportovány přímo.
 */

// DSL schema types (sdílené s state-sync, AI agentem v M16)
export type { AnimationStep, AnimationPreset, AnimationTrigger } from './types.js'

// Engine-internal types (pro konzumenty buildující TargetResolver implementaci)
export type {
  CompiledTimeline,
  AnimationTarget,
  AnimationContext,
  TargetResolver,
  PixiTargetHandle,
  DomTargetHandle,
  InputBridge,
} from './types.js'

// Compiler — DSL → GSAP timeline
export { compileSteps } from './compiler.js'

// Runtime — lifecycle management
export { createAnimationRuntime } from './runtime.js'
export type { AnimationRuntime } from './runtime.js'

// InputBridge implementace pro browser + testy
export { createClickInputBridge, createManualInputBridge } from './inputBridge.js'

// Preset factories (pro DSL generátory, AI agent v M16, extension v M15)
export { fadeIn, slideIn, getPresetFactory } from './presets/index.js'
export type { PresetFactory } from './presets/index.js'

// Slide transitions — global slide-level animations (M9)
export { runSlideTransition, compileSlideTransition } from './transitions/index.js'
export type {
  SlideTransitionTargets,
  CompiledTransition,
  TransitionFactory,
} from './transitions/index.js'
