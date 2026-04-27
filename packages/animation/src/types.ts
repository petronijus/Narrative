/**
 * packages/animation/src/types.ts
 *
 * Re-exportuje sdílené DSL types z @narrative/shared.
 * Přidává engine-interní types (CompiledTimeline, handles, context).
 *
 * PRAVIDLO: Žádný React import. Tento package je framework-agnostic engine.
 */

// Re-export sdíleného DSL schema — single source of truth
export type { AnimationStep, AnimationPreset, AnimationTrigger } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Engine-only types (nepatří do shared — jsou implementační detail enginu)
// ---------------------------------------------------------------------------

import type { gsap } from 'gsap'

// gsap.core.Timeline je ambient namespace — přistupujeme přes ReturnType
type GsapTimeline = ReturnType<typeof gsap.timeline>

/**
 * Výsledek kompilace DSL kroků.
 * Drží GSAP timeline a cleanup funkci.
 */
export interface CompiledTimeline {
  /** Root GSAP timeline — pausovaný po kompilaci, play() spouští engine. */
  gsapTimeline: GsapTimeline
  /** Uklidí timeline (kill) a odebere event listenery. */
  dispose(): void
}

/**
 * Identifikace animačního cíle.
 * Format `id`:
 *   'pixi:<objectId>'  — Pixi DisplayObject v scene graph
 *   'dom:<overlayId>'  — DOM element přes OverlayCompositor
 */
export interface AnimationTarget {
  id: string
  kind: 'pixi' | 'dom'
}

/**
 * Handle pro Pixi target.
 *
 * Proxy pattern (povinný pro Pixi — viz Spike A ADR):
 * GSAP animuje plain JS proxy objekt. onUpdate kopíruje state na Pixi.
 * Důvod: Pixi v8 scale je ObservablePoint — GSAP nemůže animovat scale přímo.
 * Pro konzistenci proxy pattern pro všechny Pixi properties.
 */
export interface PixiTargetHandle {
  kind: 'pixi'
  /**
   * Plain JS proxy objekt, který GSAP animuje.
   * Všechny animovatelné Pixi properties jsou zde jako flat numerics.
   */
  proxy: {
    x: number
    y: number
    rotation: number
    alpha: number
    scaleX: number
    scaleY: number
  }
  /**
   * Aplikuje aktuální proxy stav na Pixi objekt.
   * Voláno z GSAP onUpdate callback — GSAP zaručuje že to volá na každý frame.
   */
  apply(): void
}

/**
 * Handle pro DOM target.
 * GSAP animuje CSS properties přímo na elementu.
 * Flip plugin funguje na DOM targets (ne na Pixi).
 */
export interface DomTargetHandle {
  kind: 'dom'
  /** HTMLElement přímo animovaný přes GSAP CSS plugin. */
  element: HTMLElement
}

/**
 * TargetResolver — bridge mezi animation engine a renderer/overlay systémem.
 * Implementaci dodá konzument enginu (PresentLayout, editor wrapper).
 */
export interface TargetResolver {
  /**
   * Resolvuje objectId na konkrétní target handle.
   * Vrací null pokud target neexistuje (objekt byl smazán nebo není namontován).
   *
   * Engine skip + warn při null — necrashne, ale zaloguje.
   */
  resolve(objectId: string): PixiTargetHandle | DomTargetHandle | null
}

/**
 * InputBridge — abstrakce pro user-advance input (onClick trigger).
 * PresentLayout v M6 fáze 2 dodá implementaci přes click/tap event.
 *
 * Pokud je null, onClick trigger se chová jako afterPrevious.
 */
export interface InputBridge {
  /**
   * Registruje callback pro příští user-advance akci.
   * Vrací unsubscribe funkci.
   */
  onAdvance(cb: () => void): () => void
}

/**
 * Kontext předaný compileru a runtime.
 * Injektuje závislosti — engine sám nezná Pixi ani DOM.
 */
export interface AnimationContext {
  /** Resolvuje DSL objectId na animovatelný target. */
  targetResolver: TargetResolver
  /**
   * Input bridge pro onClick triggery.
   * Pokud null → onClick se chová jako afterPrevious.
   */
  inputBridge?: InputBridge | undefined
  /**
   * P12b — render wake-up hook.
   *
   * Pixi v8 with `autoStart: false` does not paint by itself. GSAP writes
   * proxy values inside its own rAF loop, but the resulting Pixi state
   * never reaches the screen unless someone calls `app.renderer.render()`.
   *
   * The runtime invokes `onTick` once per timeline `onUpdate` callback so
   * the scheduler can mark dirty and render a frame. Consumers wire this
   * to `RenderScheduler.markDirty`.
   *
   * Optional — when omitted (tests, headless contexts), playback works but
   * no render happens. The presence of this hook is also how the runtime
   * decides whether to manage `app.ticker.start()/stop()` for high-FPS
   * playback (handled by consumers, not the runtime itself).
   */
  onTick?: (() => void) | undefined
}
