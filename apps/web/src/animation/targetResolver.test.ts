/**
 * animation/targetResolver.test.ts
 *
 * M6: Unit testy pro createPixiTargetResolver.
 *
 * Testuje:
 * - resolve() vrátí null pokud objekt neexistuje v SceneGraph
 * - resolve() vrátí PixiTargetHandle s proxy inicializovaným ze současných hodnot
 * - apply() kopíruje proxy stav na Pixi container
 * - kind je 'pixi'
 */

import { describe, it, expect, vi } from 'vitest'
import { createPixiTargetResolver } from './targetResolver.js'
import type { SceneGraph } from '../renderer/SceneGraph.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockScale {
  x: number
  y: number
  set: ReturnType<typeof vi.fn>
}

interface MockContainer {
  x: number
  y: number
  rotation: number
  alpha: number
  scale: MockScale
  position: { set: ReturnType<typeof vi.fn> }
}

function createMockContainer(
  overrides: Partial<Omit<MockContainer, 'scale' | 'position'>> = {},
): MockContainer {
  return {
    x: 100,
    y: 200,
    rotation: 0.5,
    alpha: 0.8,
    scale: { x: 1.2, y: 1.4, set: vi.fn() },
    position: { set: vi.fn() },
    ...overrides,
  }
}

function createMockSceneGraph(
  nodeMap: Map<string, { container: MockContainer; data: unknown }>,
): SceneGraph {
  return {
    getNode: (id: string) => nodeMap.get(id),
  } as unknown as SceneGraph
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createPixiTargetResolver', () => {
  it('vrátí null pro neexistující objectId', () => {
    const sceneGraph = createMockSceneGraph(new Map())
    const resolver = createPixiTargetResolver(sceneGraph)

    expect(resolver.resolve('nonexistent-id')).toBeNull()
  })

  it('vrátí PixiTargetHandle s kind "pixi"', () => {
    const container = createMockContainer()
    const nodeMap = new Map([['obj-1', { container, data: {} }]])
    const sceneGraph = createMockSceneGraph(nodeMap)
    const resolver = createPixiTargetResolver(sceneGraph)

    const handle = resolver.resolve('obj-1')
    expect(handle).not.toBeNull()
    expect(handle?.kind).toBe('pixi')
  })

  it('proxy je inicializován z Pixi containeru (apply zapisuje zpět na container)', () => {
    // Proxy.x musí sémanticky odpovídat container.x (apply kopíruje proxy → container).
    // Pro rectangleRenderer je container.x = data.x + pivot.x, ne data.x.
    const container = createMockContainer({ x: 42, y: 99, rotation: 1.2, alpha: 0.5 })
    const nodeMap = new Map([['obj-1', { container, data: {} }]])
    const sceneGraph = createMockSceneGraph(nodeMap)
    const resolver = createPixiTargetResolver(sceneGraph)

    const handle = resolver.resolve('obj-1')
    if (handle === null || handle.kind !== 'pixi') throw new Error('Expected pixi handle')

    expect(handle.proxy.x).toBe(42)
    expect(handle.proxy.y).toBe(99)
    expect(handle.proxy.rotation).toBe(1.2)
    expect(handle.proxy.alpha).toBe(0.5)
    expect(handle.proxy.scaleX).toBe(1.2)
    expect(handle.proxy.scaleY).toBe(1.4)
  })

  it('apply() volá container.position.set s proxy x, y', () => {
    const container = createMockContainer({ x: 10, y: 20 })
    const nodeMap = new Map([['obj-1', { container, data: {} }]])
    const sceneGraph = createMockSceneGraph(nodeMap)
    const resolver = createPixiTargetResolver(sceneGraph)

    const handle = resolver.resolve('obj-1')
    if (handle === null || handle.kind !== 'pixi') throw new Error('Expected pixi handle')

    // GSAP mění proxy hodnoty
    handle.proxy.x = 300
    handle.proxy.y = 400

    handle.apply()

    expect(container.position.set).toHaveBeenCalledWith(300, 400)
  })

  it('apply() nastaví rotation, alpha a scale na container', () => {
    const container = createMockContainer()

    const nodeMap = new Map([['obj-1', { container, data: {} }]])
    const sceneGraph = createMockSceneGraph(nodeMap)
    const resolver = createPixiTargetResolver(sceneGraph)

    const handle = resolver.resolve('obj-1')
    if (handle === null || handle.kind !== 'pixi') throw new Error('Expected pixi handle')

    handle.proxy.rotation = 2.5
    handle.proxy.alpha = 0.3
    handle.proxy.scaleX = 2.0
    handle.proxy.scaleY = 0.5

    handle.apply()

    expect(container.rotation).toBe(2.5)
    expect(container.alpha).toBe(0.3)
    expect(container.scale.set).toHaveBeenCalledWith(2.0, 0.5)
  })

  it('každý resolve() vrátí nový proxy objekt (izolace per animace)', () => {
    const container = createMockContainer({ x: 50 })
    const nodeMap = new Map([['obj-1', { container, data: {} }]])
    const sceneGraph = createMockSceneGraph(nodeMap)
    const resolver = createPixiTargetResolver(sceneGraph)

    const handle1 = resolver.resolve('obj-1')
    const handle2 = resolver.resolve('obj-1')

    if (handle1 === null || handle1.kind !== 'pixi') throw new Error('Expected pixi handle')
    if (handle2 === null || handle2.kind !== 'pixi') throw new Error('Expected pixi handle')

    expect(handle1.proxy).not.toBe(handle2.proxy)
  })
})
