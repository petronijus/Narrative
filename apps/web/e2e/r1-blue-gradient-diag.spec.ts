import { test, expect } from './fixtures/test'

/**
 * Diagnostic for R1 — slide 5 radial-gradient ellipses render solid
 * blue instead of their authored black→near-white gradient.
 *
 * Walks the Pixi scene graph for slide 5 in present mode, dumps every
 * ellipse's resolved fill (color + texture state + container alpha +
 * filter chain), and reports back. We're hunting for whichever value
 * is multiplying the gradient into blue.
 *
 * Opt-in: pass FIDELITY_DECK_ID=<id> to point at an already-imported deck.
 * Without one the spec skips — it used to throw, reporting a missing opt-in as
 * a suite failure on every machine that had not run the import.
 */

const FIDELITY_DECK_ID = process.env['FIDELITY_DECK_ID'] ?? ''

test('dump slide 5 ellipse fill state', async ({ page }) => {
  test.skip(
    FIDELITY_DECK_ID === '',
    'fidelity diagnostic — set FIDELITY_DECK_ID to an imported deck to run it',
  )
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1920, height: 1080 })

  const deckId = FIDELITY_DECK_ID

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error(`[browser] ${msg.text()}`)
  })

  // Default to editor mode (where __narrative_scene_graph is exposed).
  // Pass DIAG_PRESENT=1 to drive present mode instead.
  const present = process.env['DIAG_PRESENT'] === '1'
  if (present) {
    await page.goto(`/deck/${deckId}/present`)
    await page.waitForSelector('[data-testid="slide-container"]', { timeout: 30_000 })
    const idx = Number(process.env['DIAG_SLIDE_INDEX'] ?? 4)
    for (let i = 0; i < idx; i++) {
      await page.keyboard.press('ArrowRight')
      await page.waitForTimeout(300)
    }
    await page.waitForTimeout(4_000)
  } else {
    await page.goto(`/deck/${deckId}`)
    await page.waitForSelector('[data-slide-index]', { timeout: 30_000 })
    await page.waitForFunction(
      () =>
        (window as unknown as { __narrative_scene_graph?: unknown }).__narrative_scene_graph !==
        undefined,
      null,
      { timeout: 15_000 },
    )
    const idx = Number(process.env['DIAG_SLIDE_INDEX'] ?? 4)
    await page.locator(`[data-slide-index="${idx}"]`).click()
    await page.waitForTimeout(4_000)
  }

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

    const minSize = Number(
      (window as unknown as { __diag_min_size?: number }).__diag_min_size ?? 100,
    )
    const results: DumpEntry[] = []
    for (const node of walk(root as Record<string, unknown>)) {
      const w = Number(node['width']) || 0
      const h = Number(node['height']) || 0
      if (w < minSize || h < minSize) continue
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
      const allChildren: Array<{
        kind: string
        visible: boolean
        alpha: number
        fillColor?: number
        textureLabel?: string
        textureWidth?: number
        textureHeight?: number
        spriteW?: number
        spriteH?: number
      }> = []
      for (const c of childList ?? []) {
        const k = (c.constructor as { name?: string }).name ?? 'unknown'
        const cn = c as {
          visible?: boolean
          alpha?: number
          context?: { _fillStyle?: Record<string, unknown> }
          texture?: { width?: number; height?: number; label?: string }
          width?: number
          height?: number
        }
        const entry: {
          kind: string
          visible: boolean
          alpha: number
          fillColor?: number
          textureLabel?: string
          textureWidth?: number
          textureHeight?: number
          spriteW?: number
          spriteH?: number
        } = {
          kind: k,
          visible: cn.visible ?? true,
          alpha: cn.alpha ?? 1,
        }
        const fs = cn.context?._fillStyle
        if (fs) {
          if (typeof fs['color'] === 'number') entry.fillColor = fs['color'] as number
          const tex = fs['texture'] as { label?: string } | undefined
          if (tex?.label !== undefined) entry.textureLabel = tex.label
        }
        if (k === '_Sprite' && cn.texture) {
          entry.textureLabel = cn.texture.label
          entry.textureWidth = cn.texture.width
          entry.textureHeight = cn.texture.height
          entry.spriteW = cn.width
          entry.spriteH = cn.height
        }
        allChildren.push(entry)
      }
      const first = childList?.[0]
      if (first) {
        const kind = (first.constructor as { name?: string }).name ?? 'unknown'
        const child: DumpEntry['childAt0'] = { kind }
        const ctx = (first as { context?: { _fillStyle?: Record<string, unknown> } }).context
        const fs = ctx?._fillStyle
        if (fs) {
          if (typeof fs['color'] === 'number') child.contextFillColor = fs['color']
          if (typeof fs['alpha'] === 'number') child.contextFillAlpha = fs['alpha']
          const tex = fs['texture'] as
            { width?: number; height?: number; label?: string } | undefined
          if (tex) {
            child.hasTexture = true
            child.textureWidth = tex.width
            child.textureHeight = tex.height
            child.textureLabel = tex.label
          }
        }
        entry.childAt0 = child
      }
      ;(entry as DumpEntry & { allChildren?: typeof allChildren }).allChildren = allChildren
      results.push(entry)
    }
    return { results }
  })

  console.log('[R1 diag]', JSON.stringify(report, null, 2))
  expect(report).toBeDefined()
})
