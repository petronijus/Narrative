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
  setIdleOnly(): void {}
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
