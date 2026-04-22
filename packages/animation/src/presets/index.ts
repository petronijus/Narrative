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
import { fadeOut } from './fadeOut.js'
import { slideIn } from './slideIn.js'
import { slideOut } from './slideOut.js'
import { scaleIn } from './scaleIn.js'
import { scaleOut } from './scaleOut.js'
import { zoomIn } from './zoomIn.js'
import { rotateIn } from './rotateIn.js'
import { bounceIn } from './bounceIn.js'
import { flipIn } from './flipIn.js'
import { popIn } from './popIn.js'
import { dissolveIn } from './dissolveIn.js'
import { wipeIn } from './wipeIn.js'

export type PresetFactory = (
  step: AnimationStep,
  target: PixiTargetHandle | DomTargetHandle,
  tl: GsapTimeline,
  position: string | number,
) => void

const PRESET_REGISTRY = new Map<AnimationPreset, PresetFactory>([
  ['fadeIn', fadeIn],
  ['fadeOut', fadeOut],
  ['slideIn', slideIn],
  ['slideOut', slideOut],
  ['scaleIn', scaleIn],
  ['scaleOut', scaleOut],
  ['zoomIn', zoomIn],
  ['rotateIn', rotateIn],
  ['bounceIn', bounceIn],
  ['flipIn', flipIn],
  ['popIn', popIn],
  ['dissolveIn', dissolveIn],
  ['wipeIn', wipeIn],
])

/**
 * Vrátí factory funkci pro daný preset nebo null pokud preset neexistuje.
 */
export function getPresetFactory(preset: AnimationPreset): PresetFactory | null {
  return PRESET_REGISTRY.get(preset) ?? null
}

export {
  fadeIn,
  fadeOut,
  slideIn,
  slideOut,
  scaleIn,
  scaleOut,
  zoomIn,
  rotateIn,
  bounceIn,
  flipIn,
  popIn,
  dissolveIn,
  wipeIn,
}
