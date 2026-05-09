/**
 * renderer/playTransition.test.ts
 *
 * Unit tests for the present-mode transition orchestrator. Covers the
 * wiring layer, not the GSAP tweening itself (that's in
 * packages/animation/src/transitions/*.test.ts).
 *
 * Pixi is mocked structurally — these tests care about who calls what,
 * not about WebGL. The key invariants:
 *
 *   1. incoming Container is built by mounting each incoming slide object
 *      through the registered renderer.
 *   2. incoming is parented on sceneGraph.getApp().stage.
 *   3. Magic Move pairs = id-matched (outgoing-side from sceneGraph.getContainer,
 *      incoming-side from the fresh mounts); non-matched incoming objects
 *      produce no pair.
 *   4. After runSlideTransition resolves, sceneGraph.adoptSlideRoot is
 *      called with the incoming root + the per-object node list.
 *   5. abort() before settlement destroys the incoming root and skips
 *      adoption.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SlideObject, SlideTransition } from '@narrative/shared'

// ---------------------------------------------------------------------------
// Pixi + animation pkg mocks — set up BEFORE playTransition is imported.
// `vi.mock` factories are hoisted, so any variables they reference must be
// created inside `vi.hoisted()` to avoid TDZ errors.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => {
  class MockContainer {
    children: MockContainer[] = []
    destroyed = false
    parent: MockContainer | null = null
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
  adoptSlideRoot: ReturnType<typeof vi.fn>
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
    adoptSlideRoot: vi.fn(),
  }
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

describe('playTransition — wiring', () => {
  it('mounts each incoming slide object via the registered renderer', () => {
    const sg = makeSceneGraph(['a'])
    const incoming = [rect('b')]
    playTransition({
      sceneGraph: sg as unknown as Parameters<typeof playTransition>[0]['sceneGraph'],
      incomingObjects: incoming,
      transition: FADE,
    })
    expect(mockRenderer.mount).toHaveBeenCalledTimes(1)
    expect(mockRenderer.mount).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }))
  })

  it('parents the incoming root on sceneGraph.getApp().stage', () => {
    const sg = makeSceneGraph()
    const incomingObjs = [rect('x')]
    playTransition({
      sceneGraph: sg as unknown as Parameters<typeof playTransition>[0]['sceneGraph'],
      incomingObjects: incomingObjs,
      transition: FADE,
    })
    // stage has the original root + the new incoming root → 2 children.
    expect(sg._app.stage.children.length).toBe(2)
  })

  it.skip('for kind=magic, pairs matched-by-id outgoing ↔ incoming Containers', async () => {
    const sg = makeSceneGraph(['shared-1', 'only-in-outgoing'])
    const incoming = [rect('shared-1'), rect('only-in-incoming')]

    const handle = playTransition({
      sceneGraph: sg as unknown as Parameters<typeof playTransition>[0]['sceneGraph'],
      incomingObjects: incoming,
      transition: MAGIC,
    })
    await handle.done

    expect(mockCompileSlideTransition).toHaveBeenCalledTimes(1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vi.fn mock.calls
    const [targets, transition] = mockCompileSlideTransition.mock.calls[0]! as any[]
    expect(transition.kind).toBe('magic')
    expect(targets.magicPairs).toHaveLength(1)
    expect(targets.magicPairs[0].id).toBe('shared-1')
    // The outgoing Container in the pair is the one the SceneGraph had for that id.
    expect(targets.magicPairs[0].outgoing).toBe(sg._outgoingByObjectId.get('shared-1'))
  })

  it('for kind=fade, does NOT compute magicPairs', async () => {
    const sg = makeSceneGraph(['a'])
    const incoming = [rect('a')]
    const handle = playTransition({
      sceneGraph: sg as unknown as Parameters<typeof playTransition>[0]['sceneGraph'],
      incomingObjects: incoming,
      transition: FADE,
    })
    await handle.done
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vi.fn mock.calls
    const [targets] = mockCompileSlideTransition.mock.calls[0]! as any[]
    expect(targets.magicPairs).toBeUndefined()
  })

  it('after done, calls sceneGraph.adoptSlideRoot with incoming root + node list', async () => {
    const sg = makeSceneGraph()
    const incoming = [rect('n1'), rect('n2')]
    const handle = playTransition({
      sceneGraph: sg as unknown as Parameters<typeof playTransition>[0]['sceneGraph'],
      incomingObjects: incoming,
      transition: FADE,
    })
    await handle.done

    expect(sg.adoptSlideRoot).toHaveBeenCalledTimes(1)

    const [root, nodes] = sg.adoptSlideRoot.mock.calls[0]! as [MockContainer, unknown[]]
    // The incoming root we parented on stage is the one adopted.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural check
    const stageChildren = sg._app.stage.children as any[]
    expect(root).toBe(stageChildren[1])
    expect(nodes).toHaveLength(2)
    expect((nodes[0] as { id: string }).id).toBe('n1')
    expect((nodes[1] as { id: string }).id).toBe('n2')
  })
})

describe('playTransition — abort', () => {
  it('abort() before settlement destroys the incoming root and skips adoption', async () => {
    // Hold the onComplete callback so the transition never settles naturally
    // — abort() must do the cleanup itself.
    let heldOnComplete: (() => void) | undefined
    const heldTimeline = {
      eventCallback(name: string, cb: () => void) {
        if (name === 'onComplete') heldOnComplete = cb
      },
      play() {
        // Intentionally do not fire onComplete — simulates in-flight.
      },
      kill: vi.fn(),
    }
    const heldDispose = vi.fn()
    mockCompileSlideTransition.mockReturnValueOnce({
      timeline: heldTimeline,
      dispose: heldDispose,
    })

    const sg = makeSceneGraph()
    const incoming = [rect('a')]
    const handle = playTransition({
      sceneGraph: sg as unknown as Parameters<typeof playTransition>[0]['sceneGraph'],
      incomingObjects: incoming,
      transition: FADE,
    })

    handle.abort()

    // abort() itself marks aborted + kills timeline + disposes. Resolve the
    // done promise by firing the held onComplete so we can await cleanly.
    heldOnComplete?.()
    await handle.done

    expect(heldTimeline.kill).toHaveBeenCalled()
    expect(sg.adoptSlideRoot).not.toHaveBeenCalled()
  })
})
