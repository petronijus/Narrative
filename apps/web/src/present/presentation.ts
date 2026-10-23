/**
 * present/presentation.ts — what happens on an advance in present mode
 * (docs/plans/performance.md → D; ADR 0016).
 *
 * The slides are prepared ahead (renderer/presentSlides.ts); an advance takes
 * the incoming slide's scene from the cache and swaps it in — at once for a
 * cut, at the end of its transition otherwise — and gives the outgoing one
 * back. Nothing is mounted, rasterised, uploaded or fetched on the way.
 *
 * The incoming slide's build animations are compiled before it is shown, on
 * its prepared containers, so the first state of every build is on the slide
 * from its first frame, the frames of its transition included (it used to be
 * mounted whole and only then hidden for its builds: a blink). The timeline
 * plays when the slide has arrived, as before; its onClick steps listen to
 * clicks from then on.
 *
 * Present mode's navigation rules stay as they were: the incoming slide's
 * transition plays forward and back, skipped slides are passed over, a
 * second advance while a transition runs cuts to the slide one step past its
 * target, and a jump (a link, the presenter window, `?slide=`) cuts.
 * A slide not prepared yet (a jump outside a big deck's window) is waited
 * for: the current slide stays until the target is whole.
 *
 * The plan follows the deck from `prepare` on, not only from `start`: an
 * edit during the upfront load replans around the slide the presentation
 * will start on (the slide after it when it was deleted), so the cache
 * rebuilds what the edit made stale while the load still runs, `isPrepared`
 * says no until it has, and the first slide shown leaves no preparation for
 * the first advance (ADR 0016, "ready means ready").
 */

import type { AnimationStep, Slide, SlideTransition } from '@narrative/shared'
import { computeSlideNumber } from '@narrative/shared'
import type { DeckStore } from '@narrative/slide-model'
import {
  createAnimationRuntime,
  createClickInputBridge,
  type AnimationRuntime,
  type InputBridge,
} from '@narrative/animation'
import { createPixiTargetResolver } from '../animation/targetResolver.js'
import { playTransition, type PlayTransitionResult } from '../renderer/playTransition.js'
import type { PresentSlideCache, PresentSlideSpec } from '../renderer/presentSlides.js'
import { getDefaultRenderScheduler } from '../renderer/RenderScheduler.js'
import type { SceneGraph, SlideScene } from '../renderer/SceneGraph.js'

export interface PresentationDeps {
  sceneGraph: SceneGraph
  cache: PresentSlideCache
  store: DeckStore
  /** React's active slide follows every swap (the counter, the notes, the canvas's subscription). */
  setActiveSlideId: (id: string) => void
  /** The click target for onClick builds (document.body). */
  clickTarget?: HTMLElement
}

/** An input bridge that hands clicks on only once `open()`ed — a slide's builds wait for its arrival. */
function gatedBridge(inner: InputBridge): InputBridge & { open(): void } {
  let open = false
  return {
    onAdvance(cb: () => void): () => void {
      return inner.onAdvance(() => {
        if (open) cb()
      })
    },
    dispose(): void {
      inner.dispose?.()
    },
    open(): void {
      open = true
    },
  }
}

interface SlideRuntime {
  slideId: string
  animations: AnimationStep[]
  runtime: AnimationRuntime
  bridge: InputBridge & { open(): void }
}

/** The transition into a slide, or null when it cuts. */
function transitionOf(slide: Slide): SlideTransition | null {
  const t = slide.transition
  return t.kind !== 'none' && t.durationMs > 0 ? t : null
}

/** The slides a slide links to (`hyperlink.kind === 'slide'`). */
function linkTargets(slide: Slide | undefined): string[] {
  if (slide === undefined) return []
  const out: string[] = []
  for (const o of slide.objects) {
    const link = o.hyperlink
    if (link?.kind === 'slide' && link.slideId !== '' && !out.includes(link.slideId))
      out.push(link.slideId)
  }
  return out
}

export class Presentation {
  private readonly deps: PresentationDeps
  private shownId: string | null = null
  private runtime: SlideRuntime | null = null
  /** The runtime compiled for the slide a transition brings in (plays on arrival). */
  private incomingRuntime: SlideRuntime | null = null
  private transition: { handle: PlayTransitionResult; targetId: string } | null = null
  /** A slide asked for before it was prepared: shown once it is. */
  private waitingFor: string | null = null
  /** The slide `prepare` plans around until the presentation is on stage (`start`, `follow`). */
  private startingAt: string | null = null
  /** The deck snapshot the plan was made from (DeckStore.getSlides keeps its identity until a slide changes). */
  private plannedFrom: Slide[] | null = null
  private destroyed = false
  private readonly unsubscribeStore: () => void

  constructor(deps: PresentationDeps) {
    this.deps = deps
    deps.cache.setBusyProbe(() => this.isMoving())
    // A live edit of the deck: the plan follows (stale scenes are rebuilt).
    this.unsubscribeStore = deps.store.subscribe(() => {
      const around = this.waitingFor ?? this.shownId
      if (around !== null) this.replan(around)
      else this.followDeckBeforeStart()
      this.syncRuntime()
    })
  }

  /** The slide on stage (null before `start`). */
  get shown(): string | null {
    return this.shownId
  }

  /**
   * The slide the presentation will start on, between `prepare` and the
   * first slide on stage (null otherwise): the one `prepare` was given, or,
   * when an edit deleted it, the slide that took its place.
   */
  get startSlide(): string | null {
    return this.startingAt
  }

  /** Whether a transition or a build animation runs. */
  isMoving(): boolean {
    return this.transition !== null || this.runtime?.runtime.isPlaying() === true
  }

  /**
   * Plan every slide around `startId`, by priority, before the presentation
   * is shown: the cache builds them all, or as many as the budget holds.
   */
  prepare(startId: string): void {
    // Started already (the presenter skipped the load): the plan follows the slide shown.
    if (this.shownId !== null || this.waitingFor !== null) return
    this.startingAt = startId
    this.replan(startId)
  }

  /**
   * Whether `startId` can be shown: it and its neighbours prepared, the plan
   * built as far as it goes — for the deck as it is now, also when the store
   * has not announced its latest change yet.
   */
  isPrepared(startId: string): boolean {
    this.followDeckBeforeStart()
    const { cache } = this.deps
    return this.required(startId).every((id) => cache.isReady(id)) && cache.settledPlan()
  }

  /** Show the first slide (a cut) and switch the cache to idle-time building. */
  start(startId: string): boolean {
    if (!this.show(startId, null)) return false
    this.deps.cache.setIdleOnly(true)
    return true
  }

  /**
   * Start at once, prepared or not (the presenter skipped the preparation):
   * the prepared scene of `slideId` is swapped in when there is one;
   * otherwise the slide stays as the canvas mounted it and the presentation
   * goes on from it — its builds compiled on the mounted scene and played,
   * as on any start — instead of waiting for its scene and swapping it in
   * (its builds starting over) whenever that lands. Either way the cache
   * builds in idle time from now on and keeps the slides around warm.
   */
  startNow(slideId: string): void {
    if (this.destroyed || this.shownId !== null || this.waitingFor !== null) return
    this.replan(slideId)
    if (this.deps.cache.isReady(slideId)) this.show(slideId, null)
    else {
      this.shownId = slideId
      this.startingAt = null
      this.stopRuntime()
      this.playMounted(slideId)
    }
    this.deps.cache.setIdleOnly(true)
  }

  next(): void {
    this.step(1)
  }

  previous(): void {
    this.step(-1)
  }

  /** Cut to `slideId` (a link, the presenter window, a jump). */
  jump(slideId: string): void {
    if (this.transition !== null) this.abortTransition()
    if (slideId === this.shownId) return
    this.show(slideId, null)
  }

  /**
   * The page's active slide moved without this controller (the slide shown
   * was deleted under the presenter and the page fell back to another): the
   * canvas mounted it the usual way; plan around it from now on.
   */
  follow(slideId: string): void {
    if (slideId === this.shownId || this.transition !== null || this.waitingFor !== null) return
    this.shownId = slideId
    this.startingAt = null
    this.stopRuntime()
    this.replan(slideId)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.unsubscribeStore()
    if (this.transition !== null) this.abortTransition()
    this.stopRuntime()
    this.incomingRuntime?.runtime.destroy()
    this.incomingRuntime?.bridge.dispose?.()
    this.incomingRuntime = null
  }

  // -------------------------------------------------------------------------

  private slides(): Slide[] {
    return this.deps.store.getSlides()
  }

  private step(direction: 1 | -1): void {
    const slides = this.slides()
    if (slides.length === 0) return
    // A second advance while a transition runs: no animation, straight to
    // the slide one step past the one it was bringing in.
    if (this.transition !== null) {
      const runningTarget = this.transition.targetId
      this.abortTransition()
      const idx = slides.findIndex((s) => s.id === runningTarget)
      if (idx === -1) return
      const landing = slides[Math.max(0, Math.min(idx + direction, slides.length - 1))]
      if (landing !== undefined) this.show(landing.id, null)
      return
    }
    const from = this.waitingFor ?? this.shownId
    const currentIdx = slides.findIndex((s) => s.id === from)
    if (currentIdx === -1) return
    // Skipped slides are passed over in the direction of travel.
    let targetIdx = currentIdx + direction
    while (targetIdx >= 0 && targetIdx < slides.length && slides[targetIdx]!.skipped === true)
      targetIdx += direction
    const target = slides[targetIdx]
    if (target === undefined) return
    this.show(target.id, transitionOf(target))
  }

  /**
   * Show `targetId`, with `transition` or as a cut. Returns false when it is
   * not prepared yet (it is then planned first and shown once it is).
   */
  private show(targetId: string, transition: SlideTransition | null): boolean {
    if (this.destroyed) return false
    const { cache, sceneGraph } = this.deps
    // Plan around the target first: the slide leaving the stage is one of
    // its neighbours, and the cache keeps it only when it is planned.
    this.replan(targetId)
    const scene = cache.take(targetId)
    if (scene === null) {
      this.waitingFor = targetId
      void cache.whenReady([targetId]).then(() => {
        if (this.destroyed || this.waitingFor !== targetId) return
        this.waitingFor = null
        this.show(targetId, transition)
      })
      return false
    }
    this.waitingFor = null
    const slide = this.slides().find((s) => s.id === targetId)
    const incoming = this.compileRuntime(targetId, slide?.animations ?? [], scene)

    if (transition === null) {
      cache.give(sceneGraph.swapSlideScene(scene))
      this.arrive(targetId, incoming)
      return true
    }
    this.incomingRuntime = incoming
    const handle = playTransition({
      sceneGraph,
      incoming: scene,
      transition,
      onSwapped: (outgoing) => cache.give(outgoing),
    })
    this.transition = { handle, targetId }
    void handle.done.then(() => {
      if (this.transition?.handle !== handle) return // aborted
      this.transition = null
      this.incomingRuntime = null
      this.arrive(targetId, incoming)
    })
    return true
  }

  private abortTransition(): void {
    const t = this.transition
    if (t === null) return
    this.transition = null
    const incoming = t.handle.abort()
    // Its builds never started; the scene goes back as it was built.
    this.incomingRuntime?.runtime.destroy()
    this.incomingRuntime?.bridge.dispose?.()
    this.incomingRuntime = null
    if (incoming !== null) this.deps.cache.give(incoming)
  }

  /** The slide is on stage: its builds play, the page follows, the plan moves on. */
  private arrive(targetId: string, incoming: SlideRuntime | null): void {
    this.stopRuntime()
    this.shownId = targetId
    this.startingAt = null
    this.runtime = incoming
    if (incoming !== null) {
      incoming.bridge.open()
      incoming.runtime.play()
    }
    this.deps.setActiveSlideId(targetId)
    this.replan(targetId)
    getDefaultRenderScheduler()?.markDirty()
  }

  /**
   * Compile a slide's build animations onto its scene (they set their first
   * state on it now). Null when it has none.
   */
  private compileRuntime(
    slideId: string,
    animations: AnimationStep[],
    scene: SlideScene,
  ): SlideRuntime | null {
    if (animations.length === 0) return null
    const byId = new Map(scene.nodes.map((n) => [n.id, n]))
    const resolver = createPixiTargetResolver({ getNode: (id: string) => byId.get(id) })
    const bridge = gatedBridge(createClickInputBridge(this.deps.clickTarget ?? document.body))
    const scheduler = getDefaultRenderScheduler()
    const runtime = createAnimationRuntime(animations, {
      targetResolver: resolver,
      inputBridge: bridge,
      // P12b: onTick wakes the render scheduler so GSAP-driven Pixi state
      // actually paints under autoStart:false.
      ...(scheduler !== null ? { onTick: () => scheduler.markDirty() } : {}),
    })
    return { slideId, animations, runtime, bridge }
  }

  private stopRuntime(): void {
    const r = this.runtime
    this.runtime = null
    if (r === null) return
    r.runtime.destroy()
    // Release the document.body click listener createClickInputBridge installed.
    r.bridge.dispose?.()
  }

  /**
   * The shown slide's build animations were edited live: compile them again
   * (they play from the start, as an edit in the editor's preview does).
   */
  private syncRuntime(): void {
    if (this.shownId === null || this.transition !== null) return
    const slide = this.slides().find((s) => s.id === this.shownId)
    const animations = slide?.animations ?? []
    const current = this.runtime?.animations ?? []
    if (animations === current || (animations.length === 0 && current.length === 0)) return
    this.stopRuntime()
    this.playMounted(this.shownId)
  }

  /** Compile the builds of `slideId` onto the scene the canvas mounted on stage, and play them. */
  private playMounted(slideId: string): void {
    const animations = this.slides().find((s) => s.id === slideId)?.animations ?? []
    const sg = this.deps.sceneGraph
    const runtime = this.compileRuntime(slideId, animations, {
      slideId,
      root: sg.getRoot(),
      background: null,
      nodes: sg.getMountedIds().flatMap((id) => {
        const n = sg.getNode(id)
        return n === undefined ? [] : [{ id, container: n.container, data: n.data }]
      }),
      paintedWith: null,
      objects: null,
    })
    this.runtime = runtime
    if (runtime !== null) {
      runtime.bridge.open()
      runtime.runtime.play()
    }
  }

  /**
   * Prepared but not on stage yet: when the deck moved on since the plan was
   * made, plan again around the slide the presentation will start on — the
   * slide after it, when it was deleted (the nearest presentable one after
   * it, else before it, else whatever is left).
   */
  private followDeckBeforeStart(): void {
    if (this.destroyed || this.startingAt === null || this.shownId !== null) return
    if (this.waitingFor !== null) return // start() asked for it: its plan is the current one
    const slides = this.slides()
    if (slides === this.plannedFrom) return
    const startId = this.startingAt
    if (!slides.some((s) => s.id === startId)) {
      const replacement = this.successorOf(startId, slides)
      if (replacement === null) return // an empty deck: nothing to plan
      this.startingAt = replacement
    }
    this.replan(this.startingAt)
  }

  /** The slide that takes the place of a deleted `slideId` in `slides`, by its place in the last plan's deck. */
  private successorOf(slideId: string, slides: Slide[]): string | null {
    const alive = new Set(slides.map((s) => s.id))
    const presentable = new Set(slides.filter((s) => s.skipped !== true).map((s) => s.id))
    const before = this.plannedFrom ?? []
    const at = before.findIndex((s) => s.id === slideId)
    if (at !== -1) {
      const after = before.slice(at + 1).map((s) => s.id)
      const behind = before
        .slice(0, at)
        .map((s) => s.id)
        .reverse()
      for (const pool of [presentable, alive])
        for (const id of [...after, ...behind]) if (pool.has(id)) return id
    }
    return (slides.find((s) => s.skipped !== true) ?? slides[0])?.id ?? null
  }

  /** The slides one step away from `slideId` and the ones it links to: resident whatever the budget. */
  private required(slideId: string): string[] {
    const slides = this.slides()
    const idx = slides.findIndex((s) => s.id === slideId)
    const out = [slideId]
    const near = (dir: 1 | -1): void => {
      let i = idx + dir
      while (i >= 0 && i < slides.length && slides[i]!.skipped === true) i += dir
      const s = slides[i]
      if (s !== undefined && !out.includes(s.id)) out.push(s.id)
    }
    if (idx >= 0) {
      near(1)
      near(-1)
    }
    for (const id of linkTargets(slides[idx])) if (!out.includes(id)) out.push(id)
    return out
  }

  /**
   * The cache's plan around `slideId`: it, the slides it can reach in one
   * step, then further ahead two for every one behind, and the slides linked
   * from the next one; skipped slides only when linked.
   */
  private replan(slideId: string): void {
    if (this.destroyed) return
    const slides = this.slides()
    const idx = slides.findIndex((s) => s.id === slideId)
    if (idx === -1) return
    this.plannedFrom = slides
    const required = this.required(slideId)
    const order: string[] = [...required]
    const push = (id: string | undefined): void => {
      if (id !== undefined && !order.includes(id)) order.push(id)
    }
    const presentable = slides.filter((s) => s.skipped !== true)
    const at = presentable.findIndex((s) => s.id === slideId)
    const nextSlide = presentable[at + 1]
    for (const id of linkTargets(nextSlide)) push(id)
    let ahead = at + 1
    let behind = at - 1
    while (ahead < presentable.length || behind >= 0) {
      for (let k = 0; k < 2 && ahead < presentable.length; k++) push(presentable[ahead++]?.id)
      if (behind >= 0) push(presentable[behind--]?.id)
    }
    const byId = new Map(slides.map((s) => [s.id, s]))
    const specs: PresentSlideSpec[] = []
    for (const id of order) {
      // The slide on stage stays planned: the cache does not build a slide
      // it handed out (PresentSlideCache.take), and keeps it when it comes back.
      const slide = byId.get(id)
      if (slide === undefined) continue
      specs.push({
        slide,
        slideNumber: computeSlideNumber(slides, id),
        surface: slide.layout?.surface,
      })
    }
    this.deps.cache.setPlan(
      specs,
      required.filter((id) => byId.has(id)),
    )
  }
}
