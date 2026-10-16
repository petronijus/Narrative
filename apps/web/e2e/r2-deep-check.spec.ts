/**
 * Diagnostic capture against an imported pptx deck — opt-in via
 * FIDELITY_DECK_ID, since the deck only exists after a local import run.
 */

import { test } from './fixtures/test'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '..', '..', '..', 'tests', 'pptx-import', 'r2-check')
const FIDELITY_DECK_ID = process.env['FIDELITY_DECK_ID'] ?? ''

test('deep R2 inspection slide 7 in present mode', async ({ page }) => {
  test.skip(
    FIDELITY_DECK_ID === '',
    'fidelity capture — set FIDELITY_DECK_ID to an imported deck to run it',
  )
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await mkdir(OUT, { recursive: true })
  const deckId = FIDELITY_DECK_ID

  page.on('console', (msg) => {
    if (msg.text().includes('videoRenderer')) console.log(`[browser] ${msg.text()}`)
  })

  await page.goto(`/deck/${deckId}/present`)
  await page.waitForSelector('[data-testid="slide-container"]', { timeout: 30_000 })

  // Slide 1 baseline
  await page.waitForTimeout(2_000)
  await page.screenshot({ path: join(OUT, 'present-slide1-fullpage.png') })

  // Arrow to slide 7
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(800)
  }
  await page.waitForTimeout(5_000)

  // Full page screenshot to see everything
  await page.screenshot({ path: join(OUT, 'present-slide7-fullpage.png') })
  await page
    .locator('canvas')
    .first()
    .screenshot({ path: join(OUT, 'present-slide7-canvas.png') })

  // Walk Pixi scene graph for slide 7's video node
  const info = await page.evaluate(() => {
    const sg = (
      window as unknown as {
        __narrative_scene_graph?: {
          getRoot: () => Record<string, unknown>
          getMountedIds: () => string[]
          getContainer: (id: string) => Record<string, unknown> | undefined
        }
      }
    ).__narrative_scene_graph
    if (!sg) return { error: 'no sceneGraph' }

    const ids = sg.getMountedIds()
    interface NodeInfo {
      id: string
      x: number
      y: number
      visible: boolean
      alpha: number
      childCount: number
      worldBounds: { x: number; y: number; w: number; h: number } | null
      kids: Array<{
        kind: string
        visible: boolean
        alpha: number
        x: number
        y: number
        w: number
        h: number
        texture?: string
      }>
    }
    const out: NodeInfo[] = []
    for (const id of ids) {
      const c = sg.getContainer(id) as unknown as
        | {
            x?: number
            y?: number
            visible?: boolean
            alpha?: number
            children?: Array<Record<string, unknown>>
            width?: number
            height?: number
            getBounds?: () => { x: number; y: number; width: number; height: number }
          }
        | undefined
      if (!c) continue
      const w = c.width ?? 0
      const h = c.height ?? 0
      if (w < 500 || h < 500) continue // probably the video
      let worldBounds = null
      try {
        if (c.getBounds) {
          const b = c.getBounds()
          worldBounds = { x: b.x, y: b.y, w: b.width, h: b.height }
        }
      } catch {
        // ignore
      }
      const kids: NodeInfo['kids'] = []
      for (const k of c.children ?? []) {
        const kn = k as {
          visible?: boolean
          alpha?: number
          x?: number
          y?: number
          width?: number
          height?: number
          texture?: { label?: string; width?: number; height?: number }
        }
        const kind = (k.constructor as { name?: string }).name ?? '?'
        kids.push({
          kind,
          visible: kn.visible ?? true,
          alpha: kn.alpha ?? 1,
          x: kn.x ?? 0,
          y: kn.y ?? 0,
          w: kn.width ?? 0,
          h: kn.height ?? 0,
          texture: kn.texture?.label,
        })
      }
      out.push({
        id,
        x: c.x ?? 0,
        y: c.y ?? 0,
        visible: c.visible ?? true,
        alpha: c.alpha ?? 1,
        childCount: c.children?.length ?? 0,
        worldBounds,
        kids,
      })
    }
    return { out }
  })
  console.log('[r2-deep]', JSON.stringify(info, null, 2))
})
