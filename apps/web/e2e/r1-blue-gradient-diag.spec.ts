import { test, expect } from '@playwright/test'

/**
 * Diagnostic for R1 — slide 5 radial-gradient ellipses render solid
 * blue instead of their authored black→near-white gradient.
 *
 * Walks the Pixi scene graph for slide 5 in present mode, dumps every
 * ellipse's resolved fill (color + texture state + container alpha +
 * filter chain), and reports back. We're hunting for whichever value
 * is multiplying the gradient into blue.
 *
 * Reusable: pass FIDELITY_DECK_ID=<id> to point at an already-imported
 * deck. Otherwise the spec uses the most-recent deck title that matches
 * the fixture name.
 */

test('dump slide 5 ellipse fill state', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1920, height: 1080 })

  const deckId = process.env['FIDELITY_DECK_ID']
  if (!deckId) throw new Error('Set FIDELITY_DECK_ID to a deck id')

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error(`[browser] ${msg.text()}`)
  })

  // Editor mode — the test-api only attaches to the editor's sceneGraph,
  // not the present-mode renderer. We pick slide 5 via SlidesPanel.
  await page.goto(`/deck/${deckId}`)
  await page.waitForSelector('[data-slide-index]', { timeout: 30_000 })
  // Wait until the test API is attached.
  await page.waitForFunction(
    () =>
      (window as unknown as { __narrative_scene_graph?: unknown }).__narrative_scene_graph !==
      undefined,
    null,
    { timeout: 15_000 },
  )
  // Click the 5th slide thumb (index 4).
  await page.locator('[data-slide-index="4"]').click()
  await page.waitForTimeout(2_000)

  // Reach into the Pixi scene and dump every ellipse-shaped child's
  // resolved fill state. We look at the Graphics' `context._fillStyle`
  // (Pixi v8 internal cache of the converted fill style).
  const report = await page.evaluate(() => {
    interface DumpEntry {
      x: number
      y: number
      w: number
      h: number
      visible: boolean
      alpha: number
      tint?: number
      childAt0?: {
        kind: string
        contextFillColor?: number
        contextFillAlpha?: number
        hasTexture?: boolean
        textureWidth?: number
        textureHeight?: number
        textureLabel?: string
      }
      filters?: number
    }
    // Find the slide container's Pixi root. The renderer attaches a
    // sceneGraph instance to window.__narrative_test_api in dev.
    const sg = (
      window as unknown as {
        __narrative_scene_graph?: {
          getRoot: () => Record<string, unknown>
          getMountedIds: () => string[]
          getContainer: (id: string) => Record<string, unknown> | undefined
        }
      }
    ).__narrative_scene_graph
    if (!sg) return { error: 'no __narrative_scene_graph' }
    const root = sg.getRoot()

    // Walk every descendant
    function* walk(node: Record<string, unknown>): IterableIterator<Record<string, unknown>> {
      yield node
      const kids = node['children'] as Array<Record<string, unknown>> | undefined
      if (kids) for (const k of kids) yield* walk(k)
    }

    const results: DumpEntry[] = []
    for (const node of walk(root as Record<string, unknown>)) {
      const w = Number(node['width']) || 0
      const h = Number(node['height']) || 0
      // We're after the two ~1456px ellipses on slide 5.
      if (w < 1200 || h < 1200) continue
      const tnode = node as {
        x?: number
        y?: number
        width?: number
        height?: number
        visible?: boolean
        alpha?: number
        tint?: number
        children?: unknown[]
        filters?: unknown[]
      }
      const entry: DumpEntry = {
        x: tnode.x ?? 0,
        y: tnode.y ?? 0,
        w: tnode.width ?? 0,
        h: tnode.height ?? 0,
        visible: tnode.visible ?? true,
        alpha: tnode.alpha ?? 1,
      }
      if (typeof tnode.tint === 'number') entry.tint = tnode.tint
      if (tnode.filters) entry.filters = tnode.filters.length
      const childList = tnode.children as Array<Record<string, unknown>> | undefined
      const first = childList?.[0]
      if (first) {
        const kind = (first.constructor as { name?: string }).name ?? 'unknown'
        const child: DumpEntry['childAt0'] = { kind }
        // Pixi v8 Graphics has `.context._fillStyle` after a fill is set.
        const ctx = (first as { context?: { _fillStyle?: Record<string, unknown> } }).context
        const fs = ctx?._fillStyle
        if (fs) {
          if (typeof fs['color'] === 'number') child.contextFillColor = fs['color']
          if (typeof fs['alpha'] === 'number') child.contextFillAlpha = fs['alpha']
          const tex = fs['texture'] as
            | { width?: number; height?: number; label?: string }
            | undefined
          if (tex) {
            child.hasTexture = true
            child.textureWidth = tex.width
            child.textureHeight = tex.height
            child.textureLabel = tex.label
          }
        }
        entry.childAt0 = child
      }
      results.push(entry)
    }
    return { results }
  })

  console.log('[R1 diag]', JSON.stringify(report, null, 2))
  expect(report).toBeDefined()
})
