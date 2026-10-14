/**
 * multi-client-collab.spec.ts
 *
 * E2E counterpart to packages/slide-model/src/convergence.property.test.ts:
 * the property test proves Yjs CRDT semantics in isolation; this spec
 * proves the FULL pipeline (browser → WebSocket → Hocuspocus →
 * Postgres persistence → broadcast back) converges three real browser
 * contexts on the same deck.
 *
 * It catches what the unit-level convergence test cannot:
 *   - Hocuspocus auth path drops messages
 *   - Awareness storms desync the Y.Doc
 *   - Mid-flight reconnects lose state
 *   - The Tier 2-B `unloadImmediately:false` regression we guard against
 *     (a doc unloaded mid-debounce would leak edits when the next client
 *     reconnects)
 *
 * Strategy: spawn 3 isolated browser contexts on the same deck URL,
 * have each issue a small batch of mutations through window.__narrative_test_api,
 * wait for sync, then assert all three clients see identical listSlides()
 * output. Uses the test API rather than UI clicks for speed and
 * determinism — same trade-off as inspector-flows.spec.ts.
 */

import { expect, test, type BrowserContext, type Page } from '@playwright/test'

async function createDeck(page: Page, title = 'multi-client-collab'): Promise<string> {
  const res = await page.request.post('http://localhost:3001/decks', { data: { title } })
  const { id } = (await res.json()) as { id: string }
  return id
}

/**
 * Open the deck and wait for the whole editor, not only its document. The
 * test API arrives with the document (DeckShell syncs it), while the editor
 * route (DeckEditor) is a separate lazy module still loading; a client taken
 * offline in that gap fails the route load, the error boundary unmounts the
 * document, and the spec reads "no live deck document". The artboard is
 * the editor's.
 */
async function openDeckReady(page: Page, deckId: string): Promise<void> {
  await page.goto(`/deck/${deckId}`)
  await expect(page.locator('.artboard')).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 15_000 })
    .toBe('object')
}

/**
 * Wait until both pages report the same `listSlides()` snapshot. Uses
 * polling with a generous timeout so the test stays robust to network
 * jitter on a busy CI runner. Returns the converged snapshot for
 * additional assertions.
 */
async function waitForConvergence(
  pages: Page[],
  expectedSlideCount: number,
  expectedObjectCounts?: number[],
): Promise<void> {
  await expect
    .poll(
      async () => {
        const snapshots = await Promise.all(
          pages.map((p) =>
            p.evaluate(() => {
              const api = window.__narrative_test_api
              if (api === undefined) return null
              const slides = api.listSlides()
              return slides.map((s) => ({
                id: s.id,
                objectIds: s.objects.map((o) => o.id).sort(),
              }))
            }),
          ),
        )
        if (snapshots.some((s) => s === null)) return null
        // Convergence requires every page to have:
        //   1. The same slide count
        //   2. The same object id set per slide
        const first = JSON.stringify(snapshots[0])
        const allMatch = snapshots.every((s) => JSON.stringify(s) === first)
        if (!allMatch) return null
        if (snapshots[0]!.length !== expectedSlideCount) return null
        if (expectedObjectCounts !== undefined) {
          for (let i = 0; i < expectedObjectCounts.length; i++) {
            if (snapshots[0]![i]!.objectIds.length !== expectedObjectCounts[i]) return null
          }
        }
        return 'converged'
      },
      { timeout: 15_000, intervals: [200, 400, 800] },
    )
    .toBe('converged')
}

test.describe('Multi-client convergence', () => {
  test('three clients adding slides + objects in parallel converge', async ({ browser }) => {
    test.setTimeout(60_000)

    // Build three isolated browser contexts so each has its own
    // localStorage / cookies / awareness peer-id.
    const contexts: BrowserContext[] = []
    const pages: Page[] = []
    try {
      for (let i = 0; i < 3; i++) {
        const ctx = await browser.newContext()
        contexts.push(ctx)
        pages.push(await ctx.newPage())
      }

      // Client A creates the deck — the other two open the same URL. One
      // after another: what converges here are the parallel edits below,
      // and three cold editor loads at once on the dev server (unbundled
      // modules, Pixi init) took 13–17 s each under a parallel suite — past
      // openDeckReady's 15 s, the flake recorded on 2026-09-26.
      const deckId = await createDeck(pages[0]!)
      for (const p of pages) await openDeckReady(p, deckId)

      // Each client adds two slides. End state: 1 (initial) + 6 = 7 slides.
      await Promise.all(
        pages.map((p) =>
          p.evaluate(() => {
            const api = window.__narrative_test_api!
            api.addSlide()
            api.addSlide()
          }),
        ),
      )

      await waitForConvergence(pages, 7)

      // Each client adds one object to the first slide.
      await Promise.all(
        pages.map((p, idx) =>
          p.evaluate((id) => {
            const api = window.__narrative_test_api!
            const slides = api.listSlides()
            const firstSlide = slides[0]!
            api.addRect(
              { id: `rect-${id}`, x: 100, y: 100, w: 80, h: 60, fill: 0xff0000 },
              firstSlide.id,
            )
          }, `client${idx}`),
        ),
      )

      // First slide should have all 3 client rects, others zero.
      await waitForConvergence(pages, 7, [3, 0, 0, 0, 0, 0, 0])

      // Cross-check the actual object ids match across clients.
      const finalSnapshot = await pages[0]!.evaluate(() => {
        return window
          .__narrative_test_api!.listSlides()
          .map((s) => s.objects.map((o) => o.id).sort())
      })
      expect(finalSnapshot[0]).toEqual(['rect-client0', 'rect-client1', 'rect-client2'])
    } finally {
      await Promise.all(contexts.map((c) => c.close()))
    }
  })

  test('client B catches up after a brief disconnect (offline → online)', async ({ browser }) => {
    test.setTimeout(60_000)

    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    try {
      const pageA = await ctxA.newPage()
      const pageB = await ctxB.newPage()

      const deckId = await createDeck(pageA)
      await openDeckReady(pageA, deckId)
      await openDeckReady(pageB, deckId)

      // Both connected. Disconnect B's WebSocket via the page-level
      // network state.
      await ctxB.setOffline(true)

      // A makes 5 changes while B is offline.
      await pageA.evaluate(() => {
        const api = window.__narrative_test_api!
        api.addSlide()
        const slide = api.listSlides()[0]!
        for (let i = 0; i < 4; i++) {
          api.addRect(
            { id: `offline-rect-${i}`, x: i * 50, y: 100, w: 30, h: 30, fill: 0x00ff00 },
            slide.id,
          )
        }
      })

      // B reconnects.
      await ctxB.setOffline(false)

      // After reconnect, B must catch up to A's state. listSlides on
      // B should show the new slide + 4 rects on slide 0. Hocuspocus's
      // initial-sync handshake handles this without us doing anything.
      await waitForConvergence([pageA, pageB], 2, [4, 0])
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })
})
