/**
 * present/densityHandover.ts — present mode following a change of the
 * display's density (the window moved to another screen, a display's
 * scaling changed) without a flicker, a loading slide or a hitch
 * (docs/plans/performance.md → F2; ADR 0016).
 *
 * The slides on the GPU were prepared for the canvas's density: their texts
 * rasterised at it, their pictures loaded at the variant it wants. When the
 * density changes, the old set keeps presenting — the compositor scales the
 * canvas as before — while a second set is prepared for the new density off
 * stage, in idle time (the standby set: `createSet`). Once it is ready
 * (`isReady`: the slides around the one shown, and the rest of its plan as
 * far as the budget goes) it takes over:
 *   - at once, when the slide shown can be swapped without anyone seeing a
 *     difference (`swapNow` answers true: nothing moves, no build has run on
 *     it, no video plays on it);
 *   - otherwise at the next slide boundary (`armBoundary`: the presentation
 *     takes the incoming slide from the new set and switches the canvas's
 *     resolution in the same task).
 * A second change cancels the standby set and starts over (or just drops it,
 * when the display is back at the density the old set has); so does a
 * layout that moves the device grid the set's texts were placed for
 * (`restart`). `adopted` is
 * the presentation's word that the swap happened; the old set is the
 * presentation's to free.
 *
 * DOM-free: the display watch (renderer/devicePixelRatioWatch.ts) and the
 * caches are injected, so the state machine is unit-tested in node.
 */

export interface DensityHandoverDeps<S> {
  /** The density the presenting set was prepared for. */
  currentDensity(): number
  /** A standby set prepared for `density`, building in idle time. */
  createSet(density: number): S
  /** Free a standby set that will never present. */
  destroySet(set: S): void
  /** Be told when the set's preparation moved on. */
  subscribe(set: S, listener: () => void): () => void
  /** Whether the set is ready to present (see the module comment). */
  isReady(set: S): boolean
  /** Swap to `set` now, if nobody would see it; false when it has to wait. */
  swapNow(set: S, density: number): boolean
  /** Swap to `set` at the next slide boundary (calls `adopted` then). */
  armBoundary(set: S, density: number): void
  /** Take back an armed boundary swap (the set is about to be destroyed). */
  disarmBoundary(): void
}

export type DensityHandoverState<S> =
  | { kind: 'idle' }
  | { kind: 'preparing'; density: number; set: S }
  | { kind: 'armed'; density: number; set: S }

export class DensityHandover<S> {
  private readonly deps: DensityHandoverDeps<S>
  private current: DensityHandoverState<S> = { kind: 'idle' }
  private unsubscribe: (() => void) | null = null
  private destroyed = false

  constructor(deps: DensityHandoverDeps<S>) {
    this.deps = deps
  }

  get state(): DensityHandoverState<S> {
    return this.current
  }

  /** The display's density is `density` now. */
  densityChanged(density: number): void {
    if (this.destroyed || !(density > 0)) return
    const s = this.current
    if (s.kind !== 'idle' && s.density === density) return
    this.cancel()
    this.start(density)
  }

  /**
   * What the standby set prepared so far is void (the canvas's device grid
   * at its density moved before the swap — a resize: its texts were placed
   * for the old one): it is prepared again from the start, for the same
   * density. Nothing on stage changes.
   */
  restart(): void {
    const s = this.current
    if (this.destroyed || s.kind === 'idle') return
    this.cancel()
    this.start(s.density)
  }

  private start(density: number): void {
    if (density === this.deps.currentDensity()) return
    const set = this.deps.createSet(density)
    this.current = { kind: 'preparing', density, set }
    this.unsubscribe = this.deps.subscribe(set, () => this.check())
    this.check()
  }

  /**
   * The presentation swapped to the armed set (a slide boundary) or the
   * caller swapped now: the standby set presents from here on.
   */
  adopted(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.current = { kind: 'idle' }
  }

  /**
   * Try the immediate swap again (the presentation stopped moving): an armed
   * set takes over now when the slide shown allows it.
   */
  retry(): void {
    const s = this.current
    if (s.kind !== 'armed') return
    this.deps.disarmBoundary()
    if (this.deps.swapNow(s.set, s.density)) this.adopted()
    else this.deps.armBoundary(s.set, s.density)
  }

  destroy(): void {
    if (this.destroyed) return
    this.cancel()
    this.destroyed = true
  }

  private check(): void {
    const s = this.current
    if (this.destroyed || s.kind !== 'preparing' || !this.deps.isReady(s.set)) return
    if (this.deps.swapNow(s.set, s.density)) {
      this.adopted()
      return
    }
    this.current = { kind: 'armed', density: s.density, set: s.set }
    this.deps.armBoundary(s.set, s.density)
  }

  private cancel(): void {
    const s = this.current
    this.unsubscribe?.()
    this.unsubscribe = null
    this.current = { kind: 'idle' }
    if (s.kind === 'idle') return
    if (s.kind === 'armed') this.deps.disarmBoundary()
    this.deps.destroySet(s.set)
  }
}
