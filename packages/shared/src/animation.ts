/**
 * shared/src/animation.ts
 *
 * Animation DSL schema — sdílený kontrakt mezi @narrative/animation engine,
 * state-sync (Y.Doc storage) a budoucím AI agentem (M16).
 *
 * Pravidlo: pure TypeScript types, žádné runtime dependencies.
 */

/**
 * Dostupné animation presety.
 * M15 rozšířilo sadu o 10 nových factories (fadeOut, slideOut, scaleIn/Out,
 * zoomIn, rotateIn, bounceIn, flipIn, popIn, dissolveIn, wipeIn). Text
 * presety (typewriter, letter-by-letter, word-by-word) vyžadují DOM text
 * overlay — přijdou v další fázi.
 */
export type AnimationPreset =
  | 'fadeIn'
  | 'fadeOut'
  | 'slideIn'
  | 'slideOut'
  | 'scaleIn'
  | 'scaleOut'
  | 'zoomIn'
  | 'rotateIn'
  | 'bounceIn'
  | 'flipIn'
  | 'popIn'
  | 'dissolveIn'
  | 'wipeIn'

/**
 * Trigger semantics:
 * - onEnter:       Spustí se při vstupu na slide (výchozí chování).
 * - onClick:       Čeká na user klik/tap, pak pokračuje.
 * - withPrevious:  Spustí se současně s předchozím krokem.
 * - afterPrevious: Spustí se po dokončení předchozího kroku.
 */
export type AnimationTrigger = 'onEnter' | 'onClick' | 'withPrevious' | 'afterPrevious'

/**
 * AnimationStep — jedna animační instrukce v DSL sekvenci.
 *
 * DSL je single source of truth pro animace. Presety nejsou standalone funkce
 * — jsou to DSL factories, které generují AnimationStep hodnoty.
 */
export interface AnimationStep {
  /** Unikátní ID kroku (nanoid). */
  id: string
  /** Referuje na SlideObject.id (pixi target) nebo overlay ID (dom target). */
  objectId: string
  /** Preset factory použitý pro tuto animaci. */
  preset: AnimationPreset
  /** Jak je krok spouštěn relativně k předchozím krokům nebo user interakci. */
  trigger: AnimationTrigger
  /** Délka animace v sekundách. Musí být > 0. */
  duration: number
  /** Prodleva před startem animace v sekundách. Musí být >= 0. */
  delay: number
  /**
   * GSAP easing name, např. 'power2.out', 'sine.inOut', 'bounce.out'.
   * Viz https://gsap.com/docs/v3/Eases/
   */
  easing: string
  /**
   * Preset-specifické parametry.
   * fadeIn: {}  (žádné extra params)
   * slideIn: { direction: 'up' | 'down' | 'left' | 'right', distance?: number }
   */
  params?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

const ANIMATION_PRESETS: ReadonlySet<string> = new Set<string>([
  'fadeIn',
  'fadeOut',
  'slideIn',
  'slideOut',
  'scaleIn',
  'scaleOut',
  'zoomIn',
  'rotateIn',
  'bounceIn',
  'flipIn',
  'popIn',
  'dissolveIn',
  'wipeIn',
])

export function isAnimationPreset(s: string): s is AnimationPreset {
  return ANIMATION_PRESETS.has(s)
}

export function isAnimationTrigger(s: string): s is AnimationTrigger {
  return s === 'onEnter' || s === 'onClick' || s === 'withPrevious' || s === 'afterPrevious'
}
