/**
 * E2E: Pixi v8 HTMLText texture isolation.
 *
 * This guards against a real race in `pixi.js@^8.9` where the WebGL
 * branch of `HTMLTextSystem._buildTexturePromise` writes the pooled
 * `<img>` element directly onto each freshly-built texture's
 * `source.resource`, then returns the htmlTextData (which still owns
 * that `<img>`) to a shared BigPool. The next concurrent build pops
 * the same htmlTextData out of the pool and reassigns `image.src`,
 * which corrupts every previously-built texture that still references
 * the same DOM node. In the editor this surfaces as: duplicate text
 * leaves rendering each other's content (or a third unrelated node's
 * content) for a frame.
 *
 * The fix lives in `apps/web/src/renderer/patchHTMLTextRace.ts` — it
 * snapshots the pooled image onto a per-call `<canvas>` so each
 * texture's resource is independent of the pool. The proper upstream
 * fix should land in pixi.js itself; until then this regression test
 * keeps the patch honest.
 *
 * What we assert:
 *   1. After multiple HTMLText nodes have rasterised, no two
 *      texture.source.resource references point at the SAME DOM node.
 *      Without the patch, two simultaneously-rasterising text nodes
 *      can share the pooled `<img>` and end up reading each other's
 *      pixels.
 *   2. Each texture.source.resource is a `<canvas>` (the snapshot the
 *      patch installs), not an `<img>` (the original pooled DOM that
 *      causes the race).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect, type Page } from '@playwright/test'

const API = 'http://localhost:3001'
/** A deck of its own (or E2E_DECK_ID's), made before the tests and deleted after. */
let deckId = process.env.E2E_DECK_ID ?? ''
let ownDeck = false

// Distinct ids and contents — if the race fires, one node's `<img>` is
// reused by another's texture upload, so the actual rendered glyphs
// would mismatch the assigned text. With the patch each texture has
// its own canvas snapshot.
const TEXTS: Array<{ id: string; text: string }> = [
  { id: 'e2e-htmltext-iso-a', text: 'Headline AAA' },
  { id: 'e2e-htmltext-iso-b', text: 'Body BBB' },
  { id: 'e2e-htmltext-iso-c', text: 'Caption CCC' },
  { id: 'e2e-htmltext-iso-d', text: 'Note DDD' },
  { id: 'e2e-htmltext-iso-e', text: 'Tag EEE' },
]

async function waitForTestApi(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__narrative_test_api !== undefined, null, {
    timeout: 20_000,
  })
  await page.waitForTimeout(1500)
}

async function waitForAllMounted(page: Page, ids: string[]): Promise<void> {
  await page.waitForFunction(
    (targetIds: string[]) => {
      const sg = (window as any).__narrative_scene_graph
      if (sg === undefined) return false
      const mounted: string[] = sg.getMountedIds?.() ?? []
      return targetIds.every((id) => mounted.includes(id))
    },
    ids,
    { timeout: 15_000 },
  )
  // Give the async SVG → texture pipeline a chance to land for every
  // node — the bug we're checking is specifically about the moment the
  // texture promise resolves.
  await page.waitForTimeout(1500)
}

interface ResourceSummary {
  id: string
  hasTextNode: boolean
  hasResource: boolean
  resourceTag: string | null
  resourceWidth: number | null
  resourceHeight: number | null
}

async function readTextureResources(page: Page, ids: string[]): Promise<ResourceSummary[]> {
  return page.evaluate((targetIds: string[]) => {
    const sg = (window as any).__narrative_scene_graph
    // We don't expose the Pixi renderer globally, but every HTMLText
    // node carries its per-renderer GPU data under a numeric uid key
    // in `_gpuData`. Walk the first text node's gpuData to recover the
    // renderer uid that's actually being used by this app.
    let rendererUid: number | undefined
    for (const probeId of targetIds) {
      const c = sg?.getContainer(probeId)
      const tn = c?.children.find((ch: any) => ch.anchor !== undefined)
      const keys = tn?._gpuData ? Object.keys(tn._gpuData) : []
      if (keys.length > 0) {
        rendererUid = Number(keys[0])
        break
      }
    }
    return targetIds.map((id) => {
      const c = sg?.getContainer(id)
      const textNode = c?.children.find((ch: any) => ch.anchor !== undefined)
      if (!textNode) {
        return {
          id,
          hasTextNode: false,
          hasResource: false,
          resourceTag: null,
          resourceWidth: null,
          resourceHeight: null,
        }
      }
      const gpu = rendererUid !== undefined ? textNode._gpuData?.[rendererUid] : undefined
      const resource = gpu?.texture?.source?.resource ?? null
      if (resource === null || resource === undefined) {
        return {
          id,
          hasTextNode: true,
          hasResource: false,
          resourceTag: null,
          resourceWidth: null,
          resourceHeight: null,
        }
      }
      const tag =
        resource instanceof HTMLCanvasElement
          ? 'canvas'
          : resource instanceof HTMLImageElement
            ? 'img'
            : (resource.constructor?.name ?? 'unknown')
      return {
        id,
        hasTextNode: true,
        hasResource: true,
        resourceTag: tag,
        resourceWidth: resource.width ?? resource.naturalWidth ?? null,
        resourceHeight: resource.height ?? resource.naturalHeight ?? null,
      }
    })
  }, ids)
}

async function readResourceIdentitySet(page: Page, ids: string[]): Promise<number> {
  // Walks the same path as readTextureResources but counts how many
  // distinct resource references exist across the requested ids.
  // Identity comparison is done in-page since DOM nodes can't cross
  // the Playwright bridge.
  return page.evaluate((targetIds: string[]) => {
    const sg = (window as any).__narrative_scene_graph
    // We don't expose the Pixi renderer globally, but every HTMLText
    // node carries its per-renderer GPU data under a numeric uid key
    // in `_gpuData`. Walk the first text node's gpuData to recover the
    // renderer uid that's actually being used by this app.
    let rendererUid: number | undefined
    for (const probeId of targetIds) {
      const c = sg?.getContainer(probeId)
      const tn = c?.children.find((ch: any) => ch.anchor !== undefined)
      const keys = tn?._gpuData ? Object.keys(tn._gpuData) : []
      if (keys.length > 0) {
        rendererUid = Number(keys[0])
        break
      }
    }
    if (rendererUid === undefined) return -1
    const resources = new Set<unknown>()
    for (const id of targetIds) {
      const c = sg?.getContainer(id)
      const textNode = c?.children.find((ch: any) => ch.anchor !== undefined)
      const gpu = textNode?._gpuData?.[rendererUid]
      const resource = gpu?.texture?.source?.resource
      if (resource !== undefined && resource !== null) resources.add(resource)
    }
    return resources.size
  }, ids)
}

test.describe('Pixi HTMLText texture isolation (Pixi v8 WebGL race)', () => {
  test.beforeAll(async ({ request }) => {
    if (deckId !== '') return
    const res = await request.post(`${API}/decks`, { data: { title: 'e2e htmltext isolation' } })
    expect(res.ok(), `POST /decks: ${res.status()}`).toBe(true)
    deckId = ((await res.json()) as { id: string }).id
    ownDeck = true
  })

  test.afterAll(async ({ request }) => {
    if (ownDeck) await request.delete(`${API}/decks/${deckId}`).catch(() => {})
  })

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    // Honour an env opt-out so we can run the suite with the patch
    // disabled and confirm the assertions actually fail when the
    // underlying Pixi race is uncovered.
    if (process.env.E2E_DISABLE_HTMLTEXT_PATCH === '1') {
      await page.addInitScript(() => {
        ;(globalThis as { __disableHtmlTextRacePatch?: boolean }).__disableHtmlTextRacePatch = true
      })
    }
    await page.goto(`/deck/${deckId}`)
    await waitForTestApi(page)

    // Reset slide: drop any stale objects from previous runs and seed
    // the five texts side-by-side.
    await page.evaluate((seeds) => {
      const api = window.__narrative_test_api!
      const slideId = api.listSlideIds()[0]!
      const seedIds = new Set(seeds.map((s) => s.id))
      const existing = api.debugObjectTypes(slideId)
      for (const o of existing) {
        if (!seedIds.has(o.id)) api.removeObject(o.id, slideId)
      }
      seeds.forEach((s, i) => {
        const opts = { id: s.id, x: 80, y: 80 + i * 140, w: 800, h: 100, text: s.text }
        const found = existing.find((o) => o.id === s.id)
        if (found === undefined) {
          api.addText(opts, slideId)
        } else {
          api.updateObject(
            s.id,
            { text: s.text, x: opts.x, y: opts.y, width: opts.w, height: opts.h },
            slideId,
          )
        }
      })
    }, TEXTS)

    await waitForAllMounted(
      page,
      TEXTS.map((t) => t.id),
    )
  })

  test('every HTMLText texture owns an independent canvas snapshot', async ({ page }) => {
    test.setTimeout(45_000)
    const ids = TEXTS.map((t) => t.id)

    // Force a re-rasterise on every node simultaneously — this is the
    // closest deterministic analog to the duplicate/refresh scenario
    // (many concurrent _buildTexturePromise calls).
    await page.evaluate((seeds) => {
      const api = window.__narrative_test_api!
      for (const s of seeds) {
        // Keep the displayed text identical so we exercise the cache
        // path AND the rasterise path — what matters is that all
        // nodes invalidate at once.
        api.updateObject(s.id, { text: `${s.text}.` })
      }
      for (const s of seeds) {
        api.updateObject(s.id, { text: s.text })
      }
    }, TEXTS)
    await page.waitForTimeout(1500)

    const summaries = await readTextureResources(page, ids)
    for (const s of summaries) {
      expect(s.hasTextNode, `HTMLText container missing for ${s.id}`).toBe(true)
      expect(s.hasResource, `Texture resource missing for ${s.id}`).toBe(true)
      // The patch installs a per-call canvas; the unpatched WebGL
      // path leaves an HTMLImageElement in here.
      expect(
        s.resourceTag,
        `Expected per-node canvas snapshot for ${s.id} (got ${s.resourceTag})`,
      ).toBe('canvas')
      expect(s.resourceWidth, `Canvas for ${s.id} should have a non-zero width`).toBeGreaterThan(0)
      expect(s.resourceHeight, `Canvas for ${s.id} should have a non-zero height`).toBeGreaterThan(
        0,
      )
    }

    const distinctCount = await readResourceIdentitySet(page, ids)
    expect(
      distinctCount,
      'Every HTMLText must have its own texture resource — a shared resource is the race',
    ).toBe(ids.length)
  })

  test('rapid invalidations keep each text node bound to its own resource', async ({ page }) => {
    test.setTimeout(45_000)
    const ids = TEXTS.map((t) => t.id)

    // Hammer the pipeline: 8 invalidation cycles across all 5 nodes,
    // simulating the worst-case dirty-flush after a deck reload with
    // multiple duplicate component instances.
    for (let cycle = 0; cycle < 8; cycle++) {
      await page.evaluate(
        ({ seeds, n }) => {
          const api = window.__narrative_test_api!
          for (const s of seeds) {
            api.updateObject(s.id, { text: `${s.text} #${n}` })
          }
        },
        { seeds: TEXTS, n: cycle },
      )
      // No wait between cycles → multiple in-flight texturePromises.
    }
    await page.waitForTimeout(2000)

    const distinctCount = await readResourceIdentitySet(page, ids)
    expect(
      distinctCount,
      'After concurrent rasterises, no two HTMLText nodes may share a resource',
    ).toBe(ids.length)
  })
})
