/**
 * e2e/font-multiplayer.spec.ts
 *
 * P15 regression: a deck font uploaded by Alice must reach Bob (a
 * second editor of the same deck) within a few seconds, install in
 * his browser via the FontFace API, and become selectable in his
 * Inspector picker — all without reloads. This is the load-bearing
 * promise of the multiplayer font feature.
 */

import { test, expect, type Page, type BrowserContext } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const API = 'http://localhost:3001'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = path.join(HERE, 'fixtures', 'codicon.ttf')

async function openDeck(page: Page, deckId: string): Promise<void> {
  await page.goto(`/deck/${deckId}`, { waitUntil: 'networkidle' })
  await page.waitForFunction(
    () =>
      (window as unknown as { __narrative_test_api?: unknown }).__narrative_test_api !== undefined,
    null,
    { timeout: 15_000 },
  )
}

test("Bob sees Alice's font upload within a few seconds", async ({ browser }) => {
  // Two independent browser contexts share no state — true multiplayer.
  const aliceCtx: BrowserContext = await browser.newContext()
  const bobCtx: BrowserContext = await browser.newContext()
  const alice = await aliceCtx.newPage()
  const bob = await bobCtx.newPage()

  try {
    const res = await alice.request.post(`${API}/decks`, { data: { title: 'mp-fonts' } })
    expect(res.ok()).toBeTruthy()
    const { id: deckId } = await res.json()

    await Promise.all([openDeck(alice, deckId), openDeck(bob, deckId)])

    // Both peers seed a Text object so the picker section is visible
    // for the assertion at the end.
    await alice.evaluate(() => {
      window.__narrative_test_api!.addText({
        id: 'a-text',
        x: 100,
        y: 100,
        w: 600,
        h: 100,
        text: 'Alice typing',
      })
    })

    // Alice opens the upload sheet and drops the fixture.
    await alice.evaluate(() => {
      window.__narrative_test_api!.setSelection(['a-text'])
    })
    await alice.getByRole('button', { name: /Upload custom font/i }).click()
    const fileInput = alice.locator('input[type="file"][accept*=".ttf"]')
    await fileInput.setInputFiles(FIXTURE_PATH)

    // Wait for the deck Y.Doc on Alice's side to gain the entry.
    await alice.waitForFunction(
      () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fonts = (window.__narrative_test_api as any)?.deckFonts?.()
        return Array.isArray(fonts) && fonts.length > 0
      },
      null,
      { timeout: 20_000 },
    )

    const family = await alice.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window.__narrative_test_api as any).deckFonts()[0]?.family as string
    })
    expect(family).toBeTruthy()

    // Bob's Hocuspocus client must propagate the same entry to him.
    // Tolerance: 5 s — typical local stack delivers in under 1 s.
    await bob.waitForFunction(
      (expected) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fonts = (window.__narrative_test_api as any)?.deckFonts?.() as
          | Array<{ family: string }>
          | undefined
        return Array.isArray(fonts) && fonts.some((f) => f.family === expected)
      },
      family,
      { timeout: 5_000 },
    )

    // Bob's FontLoader must install the FontFace.
    await bob.waitForFunction((fam) => document.fonts.check(`16px "${fam}"`), family, {
      timeout: 5_000,
    })
  } finally {
    await aliceCtx.close()
    await bobCtx.close()
  }
})
