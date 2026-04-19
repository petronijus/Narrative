/**
 * packages/animation/src/presets/index.ts
 *
 * Preset registry — mapuje AnimationPreset name na factory funkci.
 *
 * JAK PŘIDAT NOVÝ PRESET (M15+):
 *   1. Vytvořit `packages/animation/src/presets/<name>.ts`
 *   2. Exportovat factory funkci se signaturou PresetFactory
 *   3. Přidat do PRESET_REGISTRY mapy níže
 *   4. Přidat string literal do AnimationPreset union v @narrative/shared
 *   5. Napsat unit test v presets/<name>.test.ts
 */

import type { AnimationStep } from '../types.js'
import type { PixiTargetHandle, DomTargetHandle } from '../types.js'
import type { gsap } from 'gsap'
import type { AnimationPreset } from '../types.js'

// gsap.core.Timeline je ambient namespace type
type GsapTimeline = ReturnType<typeof gsap.timeline>

import { fadeIn } from './fadeIn.js'
import { slideIn } from './slideIn.js'

export type PresetFactory = (
  step: AnimationStep,
  target: PixiTargetHandle | DomTargetHandle,
  tl: GsapTimeline,
  position: string | number,
) => void

const PRESET_REGISTRY = new Map<AnimationPreset, PresetFactory>([
  ['fadeIn', fadeIn],
  ['slideIn', slideIn],
])

/**
 * Vrátí factory funkci pro daný preset nebo null pokud preset neexistuje.
 */
export function getPresetFactory(preset: AnimationPreset): PresetFactory | null {
  return PRESET_REGISTRY.get(preset) ?? null
}

export { fadeIn, slideIn }
