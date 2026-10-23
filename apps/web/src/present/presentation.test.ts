/**
 * present/presentation.test.ts — the decisions of an advance in present mode
 * (present/presentation.ts): which slides the cache is asked to prepare and
 * keep, that an advance takes a prepared scene and never mounts one, when the
 * builds are compiled and played, and the navigation rules (skipped slides,
 * a second advance during a transition, a jump to a slide not prepared yet).
 *
 * The cache, the scene graph and the deck store are fakes with the real
 * contracts; the animation runtime and the transition player are mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnimationStep, Slide, SlideTransition } from '@narrative/shared'
import type { DeckStore } from '@narrative/slide-model'
import type { PresentSlideCache, PresentSlideSpec } from '../renderer/presentSlides.js'
import type { SceneGraph, SlideScene } from '../renderer/SceneGraph.js'

const calls: string[] = []

const anim = vi.hoisted(() => {
  const runtimes: Array<{
    play: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    advance: ReturnType<typeof vi.fn>
  }> = []
  const bridges: Array<{ fire(): void }> = []
  return { runtimes, bridges }
})

vi.mock('@narrative/animation', () => ({
  createAnimationRuntime: vi.fn(
    (_steps: unknown, ctx: { inputBridge: { onAdvance(cb: () => void): () => void } }) => {
      calls.push('compile')
      const runtime = {
        play: vi.fn(() => calls.push('play')),
        destroy: vi.fn(() => calls.push('destroy-runtime')),
        isPlaying: () => false,
        advance: vi.fn(() => calls.push('advance')),
      }
      ctx.inputBridge.onAdvance(() => runtime.advance())
      anim.runtimes.push(runtime)
      return runtime
    },
  ),
  createClickInputBridge: vi.fn(() => {
    const subs = new Set<() => void>()
    const bridge = {
      onAdvance: (cb: () => void) => {
        subs.add(cb)
        return () => subs.delete(cb)
      },
      dispose: vi.fn(),
      fire: () => {
        for (const s of subs) s()
      },
    }
    anim.bridges.push(bridge)
    return bridge
  }),
}))

const transitions = vi.hoisted(() => ({
  pending: [] as Array<{
    incoming: SlideScene
    finish(): void
    aborted: boolean
  }>,
}))

vi.mock('../renderer/playTransition.js', () => ({
  playTransition: vi.fn(
    (args: {
      incoming: SlideScene
      onSwapped?: (s: SlideScene) => void
      sceneGraph: SceneGraph
    }) => {
      calls.push(`transition:${args.incoming.slideId}`)
      let resolve: () => void = () => undefined
      const done = new Promise<void>((r) => (resolve = r))
      const entry = {
        incoming: args.incoming,
        aborted: false,
        finish: () => {
          args.onSwapped?.(args.sceneGraph.swapSlideScene(args.incoming))
          resolve()
        },
      }
      transitions.pending.push(entry)
      return {
        done,
        abort: () => {
          entry.aborted = true
          calls.push(`abort:${args.incoming.slideId}`)
          resolve()
          return args.incoming
        },
      }
    },
  ),
}))

vi.mock('../renderer/RenderScheduler.js', () => ({
  getDefaultRenderScheduler: () => null,
}))

import { Presentation } from './presentation.js'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const NONE: SlideTransition = { kind: 'none', durationMs: 0 }
const FADE: SlideTransition = { kind: 'fade', durationMs: 400 }
const STEP: AnimationStep = {
  id: 'a1',
  objectId: 'o',
  preset: 'fadeIn',
  trigger: 'onClick',
  duration: 0.5,
  delay: 0,
  easing: 'power2.out',
}

function slide(id: string, extra: Partial<Slide> = {}): Slide {
  return { id, objects: [], animations: [], transition: NONE, ...extra }
}

function makeStore(slides: Slide[]): DeckStore {
  return {
    getSlides: () => slides,
    getSlide: (id: string) => slides.find((s) => s.id === id),
    getObject: () => undefined,
    subscribe: () => () => undefined,
    flush: () => undefined,
    destroy: () => undefined,
  }
}

function sceneFor(id: string): SlideScene {
  return {
    slideId: id,
    root: { id } as never,
    background: null,
    nodes: [],
    paintedWith: null,
    objects: [],
  }
}

class FakeCache {
  plans: Array<{ order: string[]; required: string[] }> = []
  ready = new Set<string>()
  given: string[] = []
  taken: string[] = []
  private listeners = new Set<() => void>()
  setPlan(plan: readonly PresentSlideSpec[], required: readonly string[]): void {
    this.plans.push({ order: plan.map((s) => s.slide.id), required: [...required] })
  }
  idleOnly = false
  setIdleOnly(on: boolean): void {
    this.idleOnly = on
  }
  setBusyProbe(): void {}
  isReady(id: string): boolean {
    return this.ready.has(id)
  }
  settledPlan(): boolean {
    return true
  }
  take(id: string): SlideScene | null {
    if (!this.ready.has(id)) return null
    this.ready.delete(id)
    this.taken.push(id)
    calls.push(`take:${id}`)
    return sceneFor(id)
  }
  give(scene: SlideScene): void {
    this.given.push(scene.slideId)
    calls.push(`give:${scene.slideId}`)
    this.ready.add(scene.slideId)
  }
  whenReady(ids: readonly string[]): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (ids.every((id) => this.ready.has(id))) {
          this.listeners.delete(check)
          resolve()
        }
      }
      this.listeners.add(check)
      check()
    })
  }
  prepareNow(id: string): void {
    this.ready.add(id)
    for (const l of [...this.listeners]) l()
  }
}

function makeSceneGraph() {
  let shown = 'initial'
  return {
    swapSlideScene: vi.fn((next: SlideScene) => {
      calls.push(`swap:${next.slideId}`)
      const out = sceneFor(shown)
      shown = next.slideId
      return out
    }),
    getRoot: () => ({}),
    getMountedIds: () => [],
    getNode: () => undefined,
  }
}

function setup(slides: Slide[], prepared: string[] = slides.map((s) => s.id)) {
  const cache = new FakeCache()
  for (const id of prepared) cache.ready.add(id)
  const sceneGraph = makeSceneGraph()
  const setActiveSlideId = vi.fn((id: string) => calls.push(`active:${id}`))
  const p = new Presentation({
    sceneGraph: sceneGraph as unknown as SceneGraph,
    cache: cache as unknown as PresentSlideCache,
    store: makeStore(slides),
    setActiveSlideId,
  })
  return { p, cache, sceneGraph, setActiveSlideId }
}

beforeEach(() => {
  calls.length = 0
  anim.runtimes.length = 0
  anim.bridges.length = 0
  transitions.pending.length = 0
})

// ---------------------------------------------------------------------------

describe('Presentation — the plan', () => {
  it('prepares the start slide, its neighbours and its links first, then ahead two for one behind', () => {
    const deck = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'].map((id) => slide(id))
    deck[3] = slide('s4', {
      objects: [
        {
          id: 'link',
          type: 'rectangle',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          rotation: 0,
          opacity: 1,
          hyperlink: { kind: 'slide', slideId: 's7' },
        } as never,
      ],
    })
    const { p, cache } = setup(deck)
    p.prepare('s4')
    const plan = cache.plans.at(-1)!
    expect(plan.required).toEqual(['s4', 's5', 's3', 's7'])
    expect(plan.order).toEqual(['s4', 's5', 's3', 's7', 's6', 's2', 's1'])
  })

  it('passes over skipped slides for the neighbours', () => {
    const deck = [slide('a'), slide('b', { skipped: true }), slide('c')]
    const { p, cache } = setup(deck)
    p.prepare('a')
    expect(cache.plans.at(-1)!.required).toEqual(['a', 'c'])
    expect(cache.plans.at(-1)!.order).not.toContain('b')
  })
})

describe('Presentation — an advance only swaps', () => {
  it('cuts to a prepared slide: its builds compiled before the swap, played after; the outgoing slide given back', () => {
    const deck = [slide('a'), slide('b', { animations: [STEP] })]
    const { p, cache } = setup(deck)
    expect(p.start('a')).toBe(true)
    calls.length = 0
    p.next()
    expect(calls).toEqual(['take:b', 'compile', 'swap:b', 'give:a', 'play', 'active:b'])
    expect(cache.given).toContain('a')
    expect(p.shown).toBe('b')
  })

  it('plays the incoming slide’s transition with its prepared scene; the page follows at the end', async () => {
    const deck = [slide('a'), slide('b', { transition: FADE, animations: [STEP] })]
    const { p, setActiveSlideId } = setup(deck)
    p.start('a')
    calls.length = 0
    setActiveSlideId.mockClear()
    p.next()
    // The builds' first state is on the incoming slide during its transition.
    expect(calls).toEqual(['take:b', 'compile', 'transition:b'])
    expect(setActiveSlideId).not.toHaveBeenCalled()
    expect(p.isMoving()).toBe(true)
    transitions.pending[0]!.finish()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual([
      'take:b',
      'compile',
      'transition:b',
      'swap:b',
      'give:a',
      'play',
      'active:b',
    ])
    expect(p.isMoving()).toBe(false)
  })

  it('starts a slide’s onClick builds only on clicks after it arrived', async () => {
    const deck = [slide('a'), slide('b', { transition: FADE, animations: [STEP] })]
    const { p } = setup(deck)
    p.start('a')
    p.next()
    anim.bridges.at(-1)!.fire()
    expect(anim.runtimes.at(-1)!.advance).not.toHaveBeenCalled()
    transitions.pending[0]!.finish()
    await Promise.resolve()
    await Promise.resolve()
    anim.bridges.at(-1)!.fire()
    expect(anim.runtimes.at(-1)!.advance).toHaveBeenCalledOnce()
  })

  it('a second advance during a transition aborts it, gives its scene back and cuts one slide further', async () => {
    const deck = [slide('a'), slide('b', { transition: FADE }), slide('c', { transition: FADE })]
    const { p } = setup(deck)
    p.start('a')
    p.next()
    calls.length = 0
    p.next()
    expect(calls).toEqual(['abort:b', 'give:b', 'take:c', 'swap:c', 'give:a', 'active:c'])
    expect(p.shown).toBe('c')
  })

  it('waits for a slide not prepared yet, showing nothing until it is', async () => {
    const deck = [slide('a'), slide('b'), slide('c')]
    const { p, cache } = setup(deck, ['a', 'b'])
    p.start('a')
    calls.length = 0
    p.jump('c')
    expect(calls).toEqual([])
    expect(p.shown).toBe('a')
    expect(cache.plans.at(-1)!.order[0]).toBe('c')
    cache.prepareNow('c')
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['take:c', 'swap:c', 'give:a', 'active:c'])
  })

  it('stops a slide’s builds when it leaves, and everything on destroy', () => {
    const deck = [slide('a', { animations: [STEP] }), slide('b', { animations: [STEP] })]
    const { p } = setup(deck)
    p.start('a')
    const first = anim.runtimes[0]!
    p.next()
    expect(first.destroy).toHaveBeenCalledOnce()
    p.destroy()
    expect(anim.runtimes[1]!.destroy).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// The deck changes during the upfront load
// ---------------------------------------------------------------------------

/** A deck store whose snapshot the test replaces; subscribers are told on `emit` (the store's next frame). */
function makeLiveStore(initial: Slide[]) {
  let slides = initial
  const listeners = new Set<() => void>()
  const store: DeckStore = {
    getSlides: () => slides,
    getSlide: (id: string) => slides.find((s) => s.id === id),
    getObject: () => undefined,
    subscribe: (l: () => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    flush: () => undefined,
    destroy: () => undefined,
  }
  return {
    store,
    set(next: Slide[]): void {
      slides = next
    },
    emit(): void {
      for (const l of [...listeners]) l()
    },
  }
}

/**
 * A cache with the real cache's notion of a version (presentSlides.ts
 * `sameVersion`): a scene is ready only while it was built from the planned
 * slide's objects, background and page number. `buildAll` is the
 * preparation running to its end.
 */
class VersionedCache {
  plan: PresentSlideSpec[] = []
  required: string[] = []
  builds: string[] = []
  private built = new Map<string, PresentSlideSpec>()
  private onStage = new Set<string>()
  private listeners = new Set<() => void>()
  setPlan(plan: readonly PresentSlideSpec[], required: readonly string[]): void {
    this.plan = [...plan]
    this.required = [...required]
    const planned = new Set(plan.map((s) => s.slide.id))
    for (const id of [...this.built.keys()]) if (!planned.has(id)) this.built.delete(id)
    this.notify()
  }
  setIdleOnly(): void {}
  setBusyProbe(): void {}
  isReady(id: string): boolean {
    const built = this.built.get(id)
    const wanted = this.plan.find((s) => s.slide.id === id)
    return (
      built !== undefined &&
      wanted !== undefined &&
      built.slide.objects === wanted.slide.objects &&
      built.slide.background === wanted.slide.background &&
      built.slideNumber === wanted.slideNumber
    )
  }
  /** The planned slides not prepared (and not on stage): preparation still to do. */
  unbuilt(): string[] {
    return this.plan
      .map((s) => s.slide.id)
      .filter((id) => !this.isReady(id) && !this.onStage.has(id))
  }
  settledPlan(): boolean {
    return this.unbuilt().length === 0
  }
  buildAll(): void {
    for (const spec of this.plan) {
      const id = spec.slide.id
      if (this.isReady(id) || this.onStage.has(id)) continue
      this.built.set(id, spec)
      this.builds.push(id)
    }
    this.notify()
  }
  take(id: string): SlideScene | null {
    if (!this.isReady(id)) return null
    this.built.delete(id)
    this.onStage.add(id)
    return sceneFor(id)
  }
  give(scene: SlideScene): void {
    this.onStage.delete(scene.slideId)
  }
  whenReady(ids: readonly string[]): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        if (ids.every((id) => this.isReady(id))) {
          this.listeners.delete(check)
          resolve()
        }
      }
      this.listeners.add(check)
      check()
    })
  }
  private notify(): void {
    for (const l of [...this.listeners]) l()
  }
}

function setupLive(slides: Slide[]) {
  const live = makeLiveStore(slides)
  const cache = new VersionedCache()
  const p = new Presentation({
    sceneGraph: makeSceneGraph() as unknown as SceneGraph,
    cache: cache as unknown as PresentSlideCache,
    store: live.store,
    setActiveSlideId: () => undefined,
  })
  return { p, cache, live }
}

const RECT = {
  id: 'r',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  rotation: 0,
  opacity: 1,
} as never

describe('Presentation — the deck changes between prepare() and start()', () => {
  const base = (): Slide[] => ['a', 'b', 'c', 'd'].map((id) => slide(id))
  const cases: Array<[string, (deck: Slide[]) => Slide[]]> = [
    ['a neighbour edited', (d) => d.map((s) => (s.id === 'b' ? { ...s, objects: [RECT] } : s))],
    [
      'the start slide’s background changed',
      (d) =>
        d.map((s) => (s.id === 'a' ? { ...s, background: { kind: 'color', color: 0xff0000 } } : s)),
    ],
    ['a slide added after the start slide', (d) => [d[0]!, slide('n'), ...d.slice(1)]],
    ['the next slide removed', (d) => d.filter((s) => s.id !== 'b')],
    ['the slides reordered', (d) => [d[0]!, d[2]!, d[1]!, d[3]!]],
  ]

  for (const [what, change] of cases) {
    it(`${what}: the prepared set matches the deck at start, nothing left for the first show`, () => {
      const { p, cache, live } = setupLive(base())
      p.prepare('a')
      cache.buildAll()
      expect(p.isPrepared('a')).toBe(true)

      live.set(change(live.store.getSlides()))
      live.emit()
      // The plan followed the deck: ready is not reported while it rebuilds.
      expect(cache.plan.map((s) => s.slide.id)).toEqual(live.store.getSlides().map((s) => s.id))
      expect(p.isPrepared('a')).toBe(false)
      // The rest of the long upfront load.
      cache.buildAll()
      expect(p.isPrepared('a')).toBe(true)

      const before = cache.builds.length
      expect(p.start('a')).toBe(true)
      expect(cache.unbuilt()).toEqual([])
      expect(cache.builds.length).toBe(before)
    })
  }

  it('a change the store has not announced yet (same frame) still unreadies the start', () => {
    const { p, cache, live } = setupLive(base())
    p.prepare('a')
    cache.buildAll()
    live.set(live.store.getSlides().map((s) => (s.id === 'b' ? { ...s, objects: [RECT] } : s)))
    expect(p.isPrepared('a')).toBe(false)
    cache.buildAll()
    expect(p.isPrepared('a')).toBe(true)
    expect(p.start('a')).toBe(true)
    expect(cache.unbuilt()).toEqual([])
  })

  it('the start slide deleted: the presentation starts on the slide that took its place', () => {
    const { p, cache, live } = setupLive(base())
    p.prepare('b')
    cache.buildAll()
    live.set(live.store.getSlides().filter((s) => s.id !== 'b'))
    live.emit()
    expect(p.startSlide).toBe('c')
    expect(cache.required).toEqual(['c', 'd', 'a'])
    cache.buildAll()
    expect(p.isPrepared('c')).toBe(true)
    const before = cache.builds.length
    expect(p.start('c')).toBe(true)
    expect(p.shown).toBe('c')
    expect(p.startSlide).toBeNull()
    expect(cache.builds.length).toBe(before)
  })

  it('once started, the plan follows the slide shown, not the start', () => {
    const { p, cache, live } = setupLive(base())
    p.prepare('a')
    cache.buildAll()
    p.start('a')
    p.next()
    live.set(live.store.getSlides().map((s) => (s.id === 'c' ? { ...s, objects: [RECT] } : s)))
    live.emit()
    expect(cache.required[0]).toBe('b')
  })
})

describe('Presentation — the presenter skips the preparation', () => {
  /** What PresentLayout's skipPreparation does. */
  const skip = (p: Presentation, slideId: string): void => p.startNow(slideId)

  it('the start slide not prepared: it goes on from the mounted slide, builds playing, the cache idle-only', async () => {
    const deck = [slide('a', { animations: [STEP] }), slide('b'), slide('c')]
    const { p, cache } = setup(deck, [])
    skip(p, 'a')
    // On stage now, as the canvas mounted it; its builds compiled there and playing.
    expect(p.shown).toBe('a')
    expect(calls).toEqual(['compile', 'play'])
    anim.bridges.at(-1)!.fire()
    expect(anim.runtimes.at(-1)!.advance).toHaveBeenCalledOnce()
    // Ready: building only in idle time, never during a transition or a build.
    expect(cache.idleOnly).toBe(true)
    expect(cache.plans.at(-1)!.required).toEqual(['a', 'b'])
    // Its scene landing later swaps nothing in and starts no build over.
    calls.length = 0
    cache.prepareNow('a')
    cache.prepareNow('b')
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual([])
    // The presentation goes on from it.
    p.next()
    expect(calls).toEqual(['take:b', 'swap:b', 'give:initial', 'destroy-runtime', 'active:b'])
  })

  it('the start slide prepared: swapped in as on a normal start', () => {
    const deck = [slide('a', { animations: [STEP] }), slide('b')]
    const { p, cache } = setup(deck)
    skip(p, 'a')
    expect(calls).toEqual(['take:a', 'compile', 'swap:a', 'give:initial', 'play', 'active:a'])
    expect(cache.idleOnly).toBe(true)
  })

  it('skipped during the media: a prepare() that comes after the start plans nothing', () => {
    const deck = [slide('a'), slide('b'), slide('c'), slide('d')]
    const { p, cache } = setup(deck, [])
    skip(p, 'c')
    const plans = cache.plans.length
    p.prepare('a')
    expect(cache.plans.length).toBe(plans)
    expect(cache.plans.at(-1)!.required[0]).toBe('c')
  })
})
