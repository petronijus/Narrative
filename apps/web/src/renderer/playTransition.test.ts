// @vitest-environment node
/**
 * renderer/playTransition.test.ts
 *
 * Unit tests for the present-mode transition orchestrator. Covers the
 * wiring layer, not the GSAP tweening itself (that's in
 * packages/animation/src/transitions/*.test.ts).
 *
 * Pixi is mocked structurally — these tests care about the contract, not
 * about WebGL. The key invariants:
 *
 *   1. the incoming scene (prepared off stage: renderer/presentSlides.ts) is
 *      put on sceneGraph.getApp().stage as it is — nothing is mounted;
 *   2. Magic Move pairs = id-matched (outgoing-side from sceneGraph.getContainer,
 *      incoming-side from the scene's nodes); non-matched objects produce no pair;
 *   3. when the timeline ends, sceneGraph.swapSlideScene(incoming) runs and the
 *      scene it took off the stage goes to `onSwapped`;
 *   4. abort() before the end swaps nothing, takes the incoming root off the
 *      stage without destroying it (it is returned, for the cache to keep),
 *      and gives the outgoing slide its transform and its objects' alphas back.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SlideObject, SlideTransition } from '@narrative/shared'
import type { SlideScene } from './SceneGraph.js'

// ---------------------------------------------------------------------------
// Pixi + animation pkg mocks — set up BEFORE playTransition is imported.
// `vi.mock` factories are hoisted, so any variables they reference must be
// created inside `vi.hoisted()` to avoid TDZ errors.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => {
  // Minimal ObservablePoint stand-in: real Pixi `scale`/`pivot`/`position`
  // expose `.x`/`.y` and a `.set(x, y?)`.
  class MockPoint {
    x: number
    y: number
    constructor(x = 0, y = 0) {
      this.x = x
      this.y = y
    }
    set(x: number, y?: number): void {
      this.x = x
      this.y = y ?? x
    }
  }
  class MockContainer {
    children: MockContainer[] = []
    destroyed = false
    parent: MockContainer | null = null
    // Transform props a real Pixi Container always has — playTransition snapshots
    // these on the outgoing root and restores them on abort.
    x = 0
    y = 0
    rotation = 0
    alpha = 1
    scale = new MockPoint(1, 1)
    pivot = new MockPoint(0, 0)
    position: MockPoint = Object.assign(new MockPoint(0, 0), {
      // Keep top-level x/y in sync so a snapshot-then-restore round-trips.
      set: (x: number, y?: number) => {
        this.x = x
        this.y = y ?? x
        this.position.x = this.x
        this.position.y = this.y
      },
    })
    addChild(c: MockContainer): MockContainer {
      this.children.push(c)
      c.parent = this
      return c
    }
    removeChild(c: MockContainer): MockContainer {
      this.children = this.children.filter((x) => x !== c)
      c.parent = null
      return c
    }
    destroy(_opts?: unknown): void {
      this.destroyed = true
    }
  }
  const mockRenderer = {
    type: 'rectangle' as const,
    mount: vi.fn((data: { id: string }) => {
      const c = new MockContainer()
      ;(c as unknown as Record<string, unknown>).__mockFor = data.id
      return c
    }),
    update: vi.fn(),
    destroy: vi.fn(),
  }
  const mockCompileSlideTransition = vi.fn<(...args: unknown[]) => unknown>()
  return { MockContainer, mockRenderer, mockCompileSlideTransition }
})

vi.mock('pixi.js', () => ({
  Container: hoisted.MockContainer,
  Application: vi.fn(),
  Graphics: class extends hoisted.MockContainer {
    clear() {
      return this
    }
    rect() {
      return this
    }
    fill() {
      return this
    }
    stroke() {
      return this
    }
  },
  Sprite: class extends hoisted.MockContainer {},
  Texture: { from: vi.fn() },
  Point: class {},
}))

vi.mock('@narrative/animation', () => ({
  compileSlideTransition: (...args: unknown[]) => hoisted.mockCompileSlideTransition(...args),
}))

vi.mock('./objectRenderers/index.js', () => ({
  getRenderer: () => hoisted.mockRenderer,
}))

type MockContainer = InstanceType<typeof hoisted.MockContainer>
const { mockRenderer, mockCompileSlideTransition } = hoisted

/**
 * Build a fake CompiledTransition whose timeline fires onComplete on the
 * next microtask. playTransition drives adoption from that callback, so
 * tests that want to observe adoption or done-resolution just `await
 * handle.done`.
 */
function makeFakeCompiled() {
  let onCompleteCb: (() => void) | undefined
  const timeline = {
    eventCallback(name: string, cb: () => void) {
      if (name === 'onComplete') onCompleteCb = cb
    },
    play() {
      // Fire onComplete async so the surrounding Promise is actually created
      // before the callback walks the adopt path.
      queueMicrotask(() => onCompleteCb?.())
    },
    kill: vi.fn(),
  }
  const dispose = vi.fn()
  return { timeline, dispose }
}

// Now import the subject (dynamic import inside beforeEach to ensure mocks
// are installed). Actually top-level import is fine — vi.mock calls above
// are hoisted by Vitest.
import { playTransition } from './playTransition.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FakeSceneGraph {
  _root: MockContainer
  _app: { stage: MockContainer }
  _outgoingByObjectId: Map<string, MockContainer>
  getRoot(): MockContainer
  getApp(): { stage: MockContainer }
  getContainer(id: string): MockContainer | undefined
  // Magic Move pair-matching path in playTransition queries the SceneGraph
  // for the full set of currently-mounted ids so it can intersect with the
  // incoming slide's id set in O(n+m).
  getMountedIds(): string[]
  // Magic Move ALSO does an explicit name-based pairing pass before the
  // id-fallback. It reads `node.data.name` to bridge two ids that share
  // a designer-supplied name across slides. Tests that don't set a name
  // get undefined → loop falls through to the id-equality path.
  getNode(id: string): { container: MockContainer; data: { name?: string } } | undefined
  swapSlideScene: ReturnType<typeof vi.fn>
}

function makeSceneGraph(outgoingIds: string[] = []): FakeSceneGraph {
  const outgoingByObjectId = new Map<string, MockContainer>()
  const root = new hoisted.MockContainer()
  for (const id of outgoingIds) {
    const c = new hoisted.MockContainer()
    ;(c as unknown as Record<string, unknown>).__outgoingFor = id
    root.addChild(c)
    outgoingByObjectId.set(id, c)
  }
  const stage = new hoisted.MockContainer()
  stage.addChild(root)
  return {
    _root: root,
    _app: { stage },
    _outgoingByObjectId: outgoingByObjectId,
    getRoot: () => root,
    getApp: () => ({ stage }),
    getContainer: (id: string) => outgoingByObjectId.get(id),
    getMountedIds: () => [...outgoingByObjectId.keys()],
    getNode: (id: string) => {
      const container = outgoingByObjectId.get(id)
      if (container === undefined) return undefined
      // Empty data → no `name`, so the name-based pass is a no-op and the
      // test's id-equality assertion is what gets exercised.
      return { container, data: {} }
    },
    swapSlideScene: vi.fn(() => OUTGOING_SCENE),
  }
}

/** What the fake scene graph hands back from a swap. */
const OUTGOING_SCENE = { slideId: 'out' } as unknown as SlideScene

/** A prepared incoming scene: a root (not on stage) and one node per object. */
function scene(objects: SlideObject[]): SlideScene & { root: MockContainer } {
  const root = new hoisted.MockContainer()
  const nodes = objects.map((data) => {
    const container = new hoisted.MockContainer()
    root.addChild(container)
    return { id: data.id, container, data }
  })
  return {
    slideId: 'in',
    root,
    background: null,
    nodes,
    paintedWith: null,
    objects,
  } as unknown as SlideScene & { root: MockContainer }
}

function rect(id: string, x = 0, y = 0): SlideObject {
  return {
    id,
    type: 'rectangle',
    x,
    y,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    fill: 0xff0000,
  }
}

const FADE: SlideTransition = { kind: 'fade', durationMs: 300 }
const MAGIC: SlideTransition = { kind: 'magic', durationMs: 500 }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  // Default: compileSlideTransition returns a fake CompiledTransition whose
  // play() fires onComplete on the next microtask. Individual tests can
  // override per-call (e.g. to hold the onComplete for the abort test).
  mockCompileSlideTransition.mockImplementation(() => makeFakeCompiled())
})

afterEach(() => {
  vi.clearAllMocks()
})

type SG = Parameters<typeof playTransition>[0]['sceneGraph']

describe('playTransition — wiring', () => {
  it('mounts nothing: the prepared scene goes on the stage as it is', () => {
    const sg = makeSceneGraph(['a'])
    const incoming = scene([rect('b')])
    playTransition({ sceneGraph: sg as unknown as SG, incoming, transition: FADE })
    expect(mockRenderer.mount).not.toHaveBeenCalled()
    // stage has the original root + the incoming one → 2 children.
    expect(sg._app.stage.children).toHaveLength(2)
    expect(sg._app.stage.children[1]).toBe(incoming.root)
  })

  it('for kind=magic, pairs matched-by-id outgoing ↔ incoming Containers', async () => {
    const sg = makeSceneGraph(['shared-1', 'only-in-outgoing'])
    const incoming = scene([rect('shared-1'), rect('only-in-incoming')])

    const handle = playTransition({ sceneGraph: sg as unknown as SG, incoming, transition: MAGIC })
    await handle.done

    expect(mockCompileSlideTransition).toHaveBeenCalledTimes(1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vi.fn mock.calls
    const [targets, transition] = mockCompileSlideTransition.mock.calls[0]! as any[]
    expect(transition.kind).toBe('magic')
    expect(targets.magicPairs).toHaveLength(1)
    expect(targets.magicPairs[0].id).toBe('shared-1')
    // The outgoing Container in the pair is the one the SceneGraph had for that id;
    // the incoming one is the scene's.
    expect(targets.magicPairs[0].outgoing).toBe(sg._outgoingByObjectId.get('shared-1'))
    expect(targets.magicPairs[0].incoming).toBe(incoming.nodes[0]!.container)
  })

  it('for kind=fade, does NOT compute magicPairs', async () => {
    const sg = makeSceneGraph(['a'])
    const handle = playTransition({
      sceneGraph: sg as unknown as SG,
      incoming: scene([rect('a')]),
      transition: FADE,
    })
    await handle.done
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vi.fn mock.calls
    const [targets] = mockCompileSlideTransition.mock.calls[0]! as any[]
    expect(targets.magicPairs).toBeUndefined()
  })

  it('at the end, swaps the incoming scene in and hands the outgoing one to onSwapped', async () => {
    const sg = makeSceneGraph()
    const incoming = scene([rect('n1'), rect('n2')])
    const onSwapped = vi.fn()
    const handle = playTransition({
      sceneGraph: sg as unknown as SG,
      incoming,
      transition: FADE,
      onSwapped,
    })
    expect(sg.swapSlideScene).not.toHaveBeenCalled()
    await handle.done

    expect(sg.swapSlideScene).toHaveBeenCalledTimes(1)
    expect(sg.swapSlideScene).toHaveBeenCalledWith(incoming)
    expect(onSwapped).toHaveBeenCalledWith(OUTGOING_SCENE)
    // Ended: nothing left to abort.
    expect(handle.abort()).toBeNull()
  })
})

describe('playTransition — abort', () => {
  it('abort() before the end swaps nothing and hands the incoming scene back whole', async () => {
    // Hold the onComplete callback so the transition never settles naturally
    // — abort() must do the cleanup itself.
    const heldTimeline = {
      eventCallback() {},
      play() {
        // Intentionally do not fire onComplete — simulates in-flight.
      },
      kill: vi.fn(),
    }
    mockCompileSlideTransition.mockReturnValueOnce({ timeline: heldTimeline, dispose: vi.fn() })

    const sg = makeSceneGraph(['a'])
    const outgoingChild = sg._outgoingByObjectId.get('a')!
    const incoming = scene([rect('a')])
    const onSwapped = vi.fn()
    const handle = playTransition({
      sceneGraph: sg as unknown as SG,
      incoming,
      transition: MAGIC,
      onSwapped,
    })
    // The transition moved things.
    sg._root.alpha = 0.3
    sg._root.position.set(400, 0)
    outgoingChild.alpha = 0

    const back = handle.abort()
    await handle.done

    expect(heldTimeline.kill).toHaveBeenCalled()
    expect(sg.swapSlideScene).not.toHaveBeenCalled()
    expect(onSwapped).not.toHaveBeenCalled()
    expect(back).toBe(incoming)
    expect(incoming.root.destroyed).toBe(false)
    expect(incoming.root.parent).toBeNull()
    expect(sg._app.stage.children).toHaveLength(1)
    // The outgoing slide is shown as it was.
    expect(sg._root.alpha).toBe(1)
    expect(sg._root.x).toBe(0)
    expect(outgoingChild.alpha).toBe(1)
    // Once only.
    expect(handle.abort()).toBeNull()
  })
})
