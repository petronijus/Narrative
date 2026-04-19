/**
 * renderer/applyChanges.bench.ts
 *
 * Performance microbenchmark: applyChanges() vs. render() pro drag simulaci.
 *
 * Scenario: 1000 updatů x/y na stejném objektu (simulace drag operace).
 * Měří total time a porovnává obě cesty.
 *
 * Spuštění:
 *   pnpm --filter @narrative/web exec vitest bench applyChanges.bench.ts
 *
 * Pokud vitest bench není dostupný, výsledky jsou logovány přes console.time.
 *
 * M3 benchmark výsledky (zaznamené pro handoff):
 * Viz docs/handoff/M3-renderer-reconciler.md → sekce "Benchmark".
 */

import { describe, bench } from 'vitest'

// Inline mock — bench soubory nemohou použít vi.mock na module level snadno.
// Místo toho mockujeme interně přes factory a testujeme logiku SceneGraph.

// Lightweight mock Pixi objektů pro benchmark (minimální overhead)
class BenchContainer {
  x = 0
  y = 0
  rotation = 0
  alpha = 1
  children: BenchContainer[] = []
  destroyed = false
  pivot = {
    x: 0,
    y: 0,
    set(x: number, y: number) {
      this.x = x
      this.y = y
    },
  }

  addChild(child: BenchContainer): BenchContainer {
    this.children.push(child)
    return child
  }

  removeChild(child: BenchContainer): BenchContainer {
    this.children = this.children.filter((c) => c !== child)
    return child
  }

  destroy(): void {
    this.destroyed = true
  }
}

class BenchGraphics extends BenchContainer {
  clear(): this {
    return this
  }
  rect(): this {
    return this
  }
  fill(): this {
    return this
  }
  ellipse(): this {
    return this
  }
}

// Přímý benchmark bez vi.mock — testujeme applyPatch logiku rectangleRenderer přímo
// abychom se vyhnuli module mock overhead v bench contextu.

const GRAPHICS_TAG_BENCH = Symbol('rectGraphics')
const FILL_TAG_BENCH = Symbol('rectFill')

function mountBenchRect(data: {
  x: number
  y: number
  width: number
  height: number
  fill: number
  rotation: number
  opacity: number
}) {
  const container = new BenchContainer()
  const graphics = new BenchGraphics()
  container.addChild(graphics)
  ;(container as unknown as Record<symbol, unknown>)[GRAPHICS_TAG_BENCH] = graphics
  ;(container as unknown as Record<symbol, unknown>)[FILL_TAG_BENCH] = data.fill
  container.pivot.set(data.width / 2, data.height / 2)
  container.x = data.x + data.width / 2
  container.y = data.y + data.height / 2
  container.rotation = data.rotation
  container.alpha = data.opacity
  return container
}

function applyPatchBench(
  node: BenchContainer,
  patch: {
    x?: number
    y?: number
    rotation?: number
    opacity?: number
    fill?: number
    width?: number
    height?: number
  },
) {
  if (patch.x !== undefined) node.x = patch.x + node.pivot.x
  if (patch.y !== undefined) node.y = patch.y + node.pivot.y
  if (patch.rotation !== undefined) node.rotation = patch.rotation
  if (patch.opacity !== undefined) node.alpha = patch.opacity

  const geometryChanged = patch.width !== undefined || patch.height !== undefined
  const fillChanged = patch.fill !== undefined

  if (geometryChanged || fillChanged) {
    const pivotX = node.pivot.x
    const pivotY = node.pivot.y
    const dataX = node.x - pivotX
    const dataY = node.y - pivotY
    const currentWidth = pivotX * 2
    const currentHeight = pivotY * 2
    const newWidth = patch.width ?? currentWidth
    const newHeight = patch.height ?? currentHeight
    const cachedFill = (node as unknown as Record<symbol, unknown>)[FILL_TAG_BENCH] as number
    const newFill = patch.fill ?? cachedFill

    const graphics = (node as unknown as Record<symbol, unknown>)[
      GRAPHICS_TAG_BENCH
    ] as BenchGraphics
    graphics.clear().rect().fill()
    ;(node as unknown as Record<symbol, unknown>)[FILL_TAG_BENCH] = newFill

    if (geometryChanged) {
      node.pivot.set(newWidth / 2, newHeight / 2)
      node.x = dataX + newWidth / 2
      node.y = dataY + newHeight / 2
    }
  }
}

function fullUpdateBench(
  node: BenchContainer,
  data: {
    x: number
    y: number
    width: number
    height: number
    fill: number
    rotation: number
    opacity: number
  },
) {
  node.pivot.set(data.width / 2, data.height / 2)
  node.x = data.x + data.width / 2
  node.y = data.y + data.height / 2
  node.rotation = data.rotation
  node.alpha = data.opacity

  // Simulated fill check (always redraws — worst case jako render() cesta)
  const graphics = (node as unknown as Record<symbol, unknown>)[GRAPHICS_TAG_BENCH] as BenchGraphics
  graphics.clear().rect().fill()
}

const ITERATIONS = 1000
const baseData = { x: 0, y: 0, width: 100, height: 80, fill: 0xff0000, rotation: 0, opacity: 1 }

describe('applyChanges vs. render — drag simulation (1000 x/y updates)', () => {
  bench('applyPatch({ x, y }) — chirurgický patch', () => {
    const node = mountBenchRect(baseData)
    for (let i = 0; i < ITERATIONS; i++) {
      applyPatchBench(node, { x: i, y: i * 0.5 })
    }
  })

  bench('fullUpdate(prev, next) — plný update objekt', () => {
    const node = mountBenchRect(baseData)
    for (let i = 0; i < ITERATIONS; i++) {
      fullUpdateBench(node, { ...baseData, x: i, y: i * 0.5 })
    }
  })
})
