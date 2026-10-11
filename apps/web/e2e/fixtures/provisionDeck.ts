/**
 * e2e/fixtures/provisionDeck.ts
 *
 * Give a spec its own deck instead of pointing it at one that happened to
 * exist in somebody's local database.
 *
 * Several specs used to open a hard-coded id (`/deck/GoYLg0H4-wSp`,
 * `/deck/FsVfor6N8cI0`). Those decks live in one developer's Postgres and
 * nowhere else, so on any other machine the page 403s and every test in the
 * file fails on a `waitForFunction` timeout — which is exactly how ~34 of them
 * were failing on 2026-09-09. A spec that cannot run anywhere but the machine
 * it was written on reports nothing about the code.
 *
 * The deck is created through the same API the app uses and populated through
 * the dev test hooks, so a spec gets a known-good starting point in a second
 * or so.
 */

import { expect, type Page } from '@playwright/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'

export interface ProvisionedTextDeck {
  deckId: string
  deckUrl: string
  /** Id of the text object created on the first slide. */
  objectId: string
  /** Id of the slide the object lives on. */
  slideId: string
}

export interface ProvisionTextOptions {
  title?: string
  objectId?: string
  text?: string
  x?: number
  y?: number
  width?: number
  height?: number
  /** The web app's origin, for a page without Playwright's baseURL (the desktop shell's window). */
  origin?: string
}

/**
 * Create a deck, open it, and put one text object on its first slide.
 *
 * Waits until the object is mounted in the Pixi SceneGraph, so callers can
 * hit-test or double-click it immediately on return.
 */
export async function provisionDeckWithText(
  page: Page,
  opts: ProvisionTextOptions = {},
): Promise<ProvisionedTextDeck> {
  const {
    title = 'e2e-provisioned',
    objectId = 'e2e-text-1',
    text = 'Hello',
    x = 700,
    y = 500,
    width = 600,
    height = 300,
    origin = '',
  } = opts

  const res = await page.request.post(`${API_BASE}/decks`, { data: { title } })
  expect(res.ok(), `deck creation failed: ${res.status()}`).toBe(true)
  const { id: deckId } = (await res.json()) as { id: string }
  const deckUrl = `/deck/${deckId}`

  await page.goto(`${origin}${deckUrl}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
    .toBe('object')

  // Seed the object, and keep seeding until it is actually in the doc.
  //
  // The window hook is (re)installed by whichever Y.Doc is live, and React
  // StrictMode's double mount means the first doc is torn down moments after
  // it appears. `uninstallTestApi` now removes the hook with its doc, so the
  // window here is small — but a seed that raced the swap has to be retried
  // against the surviving doc rather than silently disappearing.
  const deadline = Date.now() + 15_000
  let slideId = ''
  for (;;) {
    const seeded = await page.evaluate(
      ({ id, body, px, py, pw, ph }) => {
        const api = window.__narrative_test_api
        if (api === undefined) return null
        const slide = api.listSlideIds()[0]
        if (slide === undefined) return null
        if (!api.objectIds(slide).includes(id)) {
          api.addText({ id, x: px, y: py, w: pw, h: ph, text: body }, slide)
        }
        return api.objectIds(slide).includes(id) ? slide : null
      },
      { id: objectId, body: text, px: x, py: y, pw: width, ph: height },
    )
    if (seeded !== null) {
      slideId = seeded
      break
    }
    if (Date.now() >= deadline) {
      throw new Error(`provisionDeckWithText: could not seed "${objectId}" into deck ${deckId}`)
    }
    await page.waitForTimeout(200)
  }

  await waitForMountedNode(page, objectId, slideId)

  return { deckId, deckUrl, objectId, slideId }
}

/**
 * Wait until the reconciler has a Pixi container for `objectId`.
 *
 * On failure this reports the deck's actual state — which slides exist, which
 * objects are on the seeded slide, and what the SceneGraph has mounted. A bare
 * `expect.poll(...).toBe(true)` says only "false after 20s", which is the same
 * message whether the object never reached Y.Doc, landed on a second slide the
 * editor isn't showing, or reached the reconciler and was dropped — three very
 * different bugs.
 */
async function waitForMountedNode(page: Page, objectId: string, slideId: string): Promise<void> {
  const deadline = Date.now() + 20_000
  for (;;) {
    const mounted = await page.evaluate(
      (id) => window.__narrative_scene_graph?.getContainer(id) !== undefined,
      objectId,
    )
    if (mounted) return
    if (Date.now() >= deadline) break
    await page.waitForTimeout(250)
  }

  const diag = await page.evaluate(
    ({ id, sid }) => {
      const api = window.__narrative_test_api
      return {
        testApi: api !== undefined,
        slideIds: api?.listSlideIds() ?? null,
        seededSlideStillPresent: api?.listSlideIds().includes(sid) ?? null,
        objectsOnSeededSlide: api?.objectIds(sid) ?? null,
        sceneGraphIds: api?.sceneGraphIds() ?? null,
        sceneGraphPresent: window.__narrative_scene_graph !== undefined,
        objectInYDoc: api?.getObject(id, sid) !== null && api?.getObject(id, sid) !== undefined,
      }
    },
    { id: objectId, sid: slideId },
  )
  throw new Error(
    `provisionDeckWithText: "${objectId}" never mounted in the SceneGraph within 20s. ` +
      `Deck state: ${JSON.stringify(diag)}`,
  )
}
