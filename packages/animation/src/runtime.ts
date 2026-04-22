/**
 * packages/animation/src/runtime.ts
 *
 * Animation runtime — lifecycle wrapper nad compiled timeline.
 *
 * Zodpovídá za:
 * - play/pause/reset/seek lifecycle
 * - advance() pro onClick triggery
 * - destroy() pro kompletní cleanup
 *
 * M6: seek(0) + play() je primární use case. Plné timeline scrubbing v M14.
 */

import type { AnimationStep, AnimationContext } from './types.js'
import { compileSteps } from './compiler.js'

/**
 * Public runtime API.
 * Konzumenti (PresentLayout, editor, budoucí AI agent) pracují s tímto interfacem.
 */
export interface AnimationRuntime {
  /** Přehraje sekvenci animací od aktuální pozice. */
  play(): void
  /** Pauza na aktuální pozici. */
  pause(): void
  /** Vrátí na začátek a pauzne (nepřehrává). */
  reset(): void
  /**
   * Seek na daný timestamp v sekundách.
   * M6: primárně seek(0) pro reset.
   * M14: plné scrubbing z timeline UI.
   */
  seek(timestamp: number): void
  /**
   * Pokud je timeline pausovaná na onClick trigger, pokračuje dál.
   * Noop pokud timeline není pausovaná nebo nemá onClick kroky.
   */
  advance(): void
  /**
   * Aktuální playhead position v sekundách. M14 timeline UI čte přes rAF
   * smyčku pro vykreslení visual playhead. Nezmění state — pure getter.
   */
  time(): number
  /**
   * Celková délka zkompilovaného timeline v sekundách (bez onClick pauz
   * za poslední animací). M14: viewport scaling.
   */
  duration(): number
  /**
   * Vrací true, pokud timeline aktuálně hraje. M14: Play/Pause toggle state.
   */
  isPlaying(): boolean
  /**
   * Kompletní cleanup — kill timeline, odebrat listenery.
   * Volat při unmount slide nebo opuštění present modu.
   */
  destroy(): void
}

/**
 * Vytvoří AnimationRuntime pro danou DSL sekvenci a kontext.
 *
 * Kroky se zkompilují okamžitě (synchronně).
 * Timeline je pausovaná — caller musí zavolat play().
 */
export function createAnimationRuntime(
  steps: AnimationStep[],
  ctx: AnimationContext,
): AnimationRuntime {
  const compiled = compileSteps(steps, ctx)
  const tl = compiled.gsapTimeline

  const runtime: AnimationRuntime = {
    play(): void {
      tl.play()
    },

    pause(): void {
      tl.pause()
    },

    reset(): void {
      tl.seek(0)
      tl.pause()
    },

    seek(timestamp: number): void {
      tl.seek(timestamp)
    },

    advance(): void {
      // Pokud je timeline pausovaná (onClick pause), pokračuje dál.
      // GSAP addPause() způsobí že tl.paused() === true na pause pointu.
      if (tl.paused()) {
        tl.play()
      }
    },

    time(): number {
      return tl.time()
    },

    duration(): number {
      return tl.duration()
    },

    isPlaying(): boolean {
      return tl.isActive() && !tl.paused()
    },

    destroy(): void {
      compiled.dispose()
    },
  }

  return runtime
}
