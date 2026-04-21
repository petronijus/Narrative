/**
 * packages/animation/src/transitions/types.ts
 *
 * Shared types for the slide transition subsystem.
 *
 * Slide transitions operate on Pixi Containers (entire slide root containers),
 * not on individual scene graph objects. Each container is animated via a proxy
 * per Spike A rules — no direct gsap.to(pixiContainer, ...).
 */

import type { gsap } from 'gsap'
import type { SlideTransition } from '@narrative/shared'

// Re-export for consumers who import from this subpath.
export type { SlideTransition }

type GsapTimeline = ReturnType<typeof gsap.timeline>

/**
 * Minimal interface for a Pixi Container as seen by the transition engine.
 * Typed structurally so tests can provide plain object mocks without importing Pixi.
 */
export interface PixiContainer {
  position: { set(x: number, y: number): void }
  scale: { set(x: number, y: number): void }
  alpha: number
  /**
   * Rotation is only read/written by Magic Move for per-object tweens. The
   * root-slide containers don't rotate so it's optional here for backward
   * compatibility with tests using plain object mocks.
   */
  rotation?: number
}

/**
 * A pairing of matched-by-id per-object containers between the outgoing and
 * incoming slide. Populated only by the present-mode runtime when the active
 * transition kind is 'magic'; other transition factories ignore it.
 */
export interface MagicMoveObjectPair {
  /** Object ID shared by outgoing + incoming. */
  id: string
  /** The outgoing-slide Container for this object (what's currently on screen). */
  outgoing: PixiContainer
  /** The incoming-slide Container for this object (target layout). */
  incoming: PixiContainer
}

/**
 * The two slide root containers involved in a slide transition, plus optional
 * per-object pairing for Magic Move.
 */
export interface SlideTransitionTargets {
  /** The Pixi container holding the outgoing slide's objects. */
  outgoing: PixiContainer
  /** The Pixi container holding the incoming slide's objects. */
  incoming: PixiContainer
  /** Stage dimensions in world coordinates (SLIDE_WIDTH × SLIDE_HEIGHT). */
  slideSize: { width: number; height: number }
  /**
   * Objects present in BOTH outgoing and incoming (matched by id).
   * Only populated when the active transition kind is 'magic'; empty/undefined
   * otherwise. Unmatched objects are handled via the root-container fade path.
   */
  magicPairs?: MagicMoveObjectPair[]
}

/**
 * Result of compiling a slide transition.
 * Timeline is paused on creation — caller calls play().
 */
export interface CompiledTransition {
  timeline: GsapTimeline
  dispose(): void
}

/**
 * Uniform factory signature for all slide transition implementations.
 */
export type TransitionFactory = (
  targets: SlideTransitionTargets,
  transition: SlideTransition,
) => CompiledTransition

/**
 * Proxy shape used for animating Pixi container properties.
 * All fields are flat numerics — GSAP never touches ObservablePoints directly.
 */
export interface ContainerProxy {
  x: number
  y: number
  scaleX: number
  scaleY: number
  alpha: number
}

/**
 * Creates a proxy + onUpdate applicator for a given container.
 *
 * This enforces the Spike A proxy pattern: GSAP animates the proxy,
 * onUpdate pushes values back to the Pixi container each frame.
 */
export function makeContainerProxy(
  container: PixiContainer,
  initial?: Partial<ContainerProxy>,
): { proxy: ContainerProxy; applyProxy: () => void } {
  const proxy: ContainerProxy = {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    alpha: container.alpha,
    ...initial,
  }

  const applyProxy = () => {
    container.position.set(proxy.x, proxy.y)
    container.scale.set(proxy.scaleX, proxy.scaleY)
    container.alpha = proxy.alpha
  }

  return { proxy, applyProxy }
}
