/**
 * e2e/notes-panel.spec.ts — the speaker notes after L1 / L2
 * (docs/plans/performance.md, 2026-10-18).
 *
 * The notes editor (Tiptap) and the presenter view's rich notes are chunks
 * loaded after the first paint: the panel shows a stand-in of the same shape
 * until the editor is idle or the user goes for the notes. These pin down
 * that nothing a user does is lost to that: a click into the stand-in lands
 * in the editor, typed notes reach the document and the presenter view, and
 * opening the editor does not shift its layout (the CLS of 0.12 Lighthouse
 * measured, mostly the stage re-centring after the toolbar and bottom panels
 * were measured a frame late, and the notes panel growing when the deck
 * synced).
 */

import { expect, test, type Page } from './fixtures/test'

const API_BASE = process.env['NARRATIVE_API_URL'] ?? 'http://localhost:3001'

async function createDeck(page: Page, title: string): Promise<string> {
  const res = await page.request.post(`${API_BASE}/decks`, { data: { title } })
  expect(res.ok(), `deck creation failed: ${res.status()}`).toBe(true)
  return ((await res.json()) as { id: string }).id
}

async function openEditor(page: Page, deckId: string): Promise<void> {
  await page.goto(`/deck/${deckId}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 30_000 })
    .toBe('object')
}

/** The notes editor's contenteditable — there once the lazy chunk arrived. */
const notesEditor = (page: Page) =>
  page.locator('[contenteditable="true"][aria-label="Speaker notes editor"]')

test.describe('speaker notes, loaded after the first paint', () => {
  test('a click into the notes before the editor loaded types into the editor', async ({
    page,
  }) => {
    const deckId = await createDeck(page, 'e2e-notes-panel')
    await openEditor(page, deckId)

    const panel = page.locator('.panel', { hasText: 'Speaker notes' })
    await expect(panel).toBeVisible()
    const add = panel.getByRole('button', { name: 'Add speaker notes' })
    if (await add.isVisible()) await add.click()

    // Whichever is there — the stand-in's box or the editor — a click on it
    // ends in the editor with the focus.
    await panel.getByLabel('Speaker notes editor').first().click()
    await expect(notesEditor(page)).toBeFocused({ timeout: 15_000 })
    await page.keyboard.type('Hello notes')
    await expect(panel).toContainText('11 chars')

    // In the document: a reload shows them at once, in the stand-in or the editor.
    await page.reload()
    await expect(panel.getByLabel('Speaker notes editor').first()).toContainText('Hello notes', {
      timeout: 30_000,
    })

    // The presenter view's rich notes (their own chunk too) show them.
    await page.goto(`/deck/${deckId}/present`)
    await page.waitForSelector('[data-testid="slide-container"]', { timeout: 30_000 })
    await page.keyboard.press('n')
    const presenter = page.getByRole('region', { name: 'Presenter view' })
    await expect(presenter).toContainText('Hello notes')
    await expect(presenter.locator('.ProseMirror')).toContainText('Hello notes', {
      timeout: 15_000,
    })
  })

  test('opening the editor shifts no layout while it loads and syncs', async ({ page }) => {
    const deckId = await createDeck(page, 'e2e-notes-panel-cls')
    await page.addInitScript(() => {
      const w = window as unknown as { __layoutShifts: { value: number; sources: string[] }[] }
      w.__layoutShifts = []
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as unknown as {
          value: number
          hadRecentInput: boolean
          sources?: { node?: Node | null }[]
        }[]) {
          if (entry.hadRecentInput) continue
          w.__layoutShifts.push({
            value: entry.value,
            sources: (entry.sources ?? []).map((s) =>
              s.node instanceof Element ? s.node.outerHTML.slice(0, 120) : String(s.node),
            ),
          })
        }
      }).observe({ type: 'layout-shift', buffered: true })
    })
    await openEditor(page, deckId)
    // The notes editor arrives when the editor is idle (or within ~4 s).
    await expect(notesEditor(page).or(page.getByText('Add speaker notes'))).toBeVisible({
      timeout: 30_000,
    })
    // Then whatever loads or syncs after it has had its chance to move things.
    await page.waitForTimeout(1500)

    const shifts = await page.evaluate(
      () =>
        (window as unknown as { __layoutShifts: { value: number; sources: string[] }[] })
          .__layoutShifts,
    )
    const cls = shifts.reduce((sum, s) => sum + s.value, 0)
    // Before the fix a production build measured 0.11–0.12 here.
    expect(cls, JSON.stringify(shifts, null, 2)).toBeLessThan(0.05)
  })
})
