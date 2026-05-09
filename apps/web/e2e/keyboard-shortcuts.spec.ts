/**
 * keyboard-shortcuts.spec.ts
 *
 * E2E coverage for keyboard shortcuts. Replaces the 14 unit tests we
 * skipped in Toolbar.test.tsx, SlidesPanel.test.tsx, and
 * PresentLayout.test.tsx.
 *
 * Why unit tests were the wrong place: keyboard handlers in the editor
 * are scoped via `data-shortcut-scope` attributes and `useShortcuts`
 * matches against `document.activeElement` to ignore key events when an
 * input has focus. jsdom's focus model is approximate, and synthesised
 * `fireEvent.keyDown(window, ...)` doesn't traverse the same target/scope
 * chain as a real browser keydown — so unit tests had to mock half of
 * the wiring and verify almost nothing worth catching.
 *
 * Real browser + Playwright eliminates all that: a real `keyboard.press`
 * fires a real keydown that walks the real document and is gated by the
 * real focused element.
 */

import { expect, test, type Page } from '@playwright/test'

async function createDeck(page: Page): Promise<string> {
  const res = await page.request.post('http://localhost:3001/decks', {
    data: { title: 'keyboard-shortcuts-spec' },
  })
  const { id } = (await res.json()) as { id: string }
  return id
}

async function openDeckReady(page: Page, deckId: string): Promise<void> {
  await page.goto(`/deck/${deckId}`)
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 15_000 })
    .toBe('object')
  // Defocus any input the route mount might have grabbed (the title
  // header is contenteditable). Click on the canvas wrapper so the
  // shortcut scope picks up `canvas`.
  await page.locator('[data-shortcut-scope="canvas"]').first().click()
}

/**
 * The active tool surfaces in the DOM as `aria-pressed=true` on the
 * matching toolbar button. We don't need to peek into React state.
 */
async function getActiveTool(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const pressed = document.querySelector(
      'button[aria-pressed="true"][aria-label]',
    ) as HTMLButtonElement | null
    if (pressed === null) return null
    const label = pressed.getAttribute('aria-label') ?? ''
    // Toolbar labels are like "Select tool", "Rectangle tool", etc. —
    // keep just the first word.
    return label.split(' ')[0]?.toLowerCase() ?? null
  })
}

// ---------------------------------------------------------------------------
// Toolbar shortcuts
// ---------------------------------------------------------------------------

test.describe('Toolbar keyboard shortcuts', () => {
  test('R selects rectangle, O ellipse, T text, V back to select', async ({ page }) => {
    test.setTimeout(30_000)
    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)

    // Default state should be Select.
    expect(await getActiveTool(page)).toBe('select')

    await page.keyboard.press('r')
    await expect.poll(() => getActiveTool(page), { timeout: 2000 }).toBe('rectangle')

    await page.keyboard.press('o')
    await expect.poll(() => getActiveTool(page), { timeout: 2000 }).toBe('ellipse')

    await page.keyboard.press('t')
    await expect.poll(() => getActiveTool(page), { timeout: 2000 }).toBe('text')

    await page.keyboard.press('v')
    await expect.poll(() => getActiveTool(page), { timeout: 2000 }).toBe('select')
  })

  test('uppercase variants (Shift+R, Shift+O, Shift+T) also switch tools', async ({ page }) => {
    test.setTimeout(30_000)
    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)

    await page.keyboard.press('Shift+R')
    await expect.poll(() => getActiveTool(page), { timeout: 2000 }).toBe('rectangle')

    await page.keyboard.press('Shift+O')
    await expect.poll(() => getActiveTool(page), { timeout: 2000 }).toBe('ellipse')

    await page.keyboard.press('Shift+T')
    await expect.poll(() => getActiveTool(page), { timeout: 2000 }).toBe('text')
  })

  test('shortcuts are ignored when an input has focus', async ({ page }) => {
    test.setTimeout(30_000)
    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)

    // Add a rectangle so the inspector mounts.
    await page.evaluate(() => {
      window.__narrative_test_api!.addRect({
        id: 'rect-keyboard-spec',
        x: 100,
        y: 100,
        w: 200,
        h: 100,
        fill: 0xff0000,
      })
      window.__narrative_test_api!.setSelection(['rect-keyboard-spec'])
    })

    // Focus the first numeric input in the inspector.
    const input = page.locator('input[type="number"]').first()
    await input.waitFor({ state: 'visible', timeout: 5000 })
    await input.focus()

    // Pressing R while typing in a numeric field must NOT switch tool —
    // the user is editing a number.
    await input.press('r')
    expect(await getActiveTool(page)).toBe('select')
  })
})

// ---------------------------------------------------------------------------
// Ctrl+Enter → present mode
// ---------------------------------------------------------------------------

test.describe('Present mode shortcut', () => {
  test('Ctrl+Enter from the editor navigates to present mode', async ({ page }) => {
    test.setTimeout(30_000)
    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)

    await page.keyboard.press('ControlOrMeta+Enter')

    await expect
      .poll(() => page.url(), { timeout: 5000 })
      .toMatch(new RegExp(`/deck/${deckId}/present`))
  })
})

// ---------------------------------------------------------------------------
// Slides panel keyboard navigation
// ---------------------------------------------------------------------------

test.describe('Slides panel keyboard navigation', () => {
  test('ArrowDown + ArrowUp move active slide through the deck', async ({ page }) => {
    test.setTimeout(30_000)
    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)

    // Add two more slides → 3 total.
    await page.evaluate(() => {
      window.__narrative_test_api!.addSlide()
      window.__narrative_test_api!.addSlide()
    })

    // Initial active is the first slide.
    const slides = await page.evaluate(() => window.__narrative_test_api!.listSlides())
    expect(slides.length).toBe(3)

    // Click the first slide row to focus the panel.
    const firstRow = page.locator('[role="option"][data-slide-id]').first()
    await firstRow.click()

    // ArrowDown → next slide (index 1).
    await page.keyboard.press('ArrowDown')
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const el = document.querySelector(
              '[role="option"][aria-selected="true"][data-slide-id]',
            )
            return el?.getAttribute('data-slide-id') ?? null
          }),
        { timeout: 3000 },
      )
      .toBe(slides[1]!.id)

    // ArrowDown → index 2.
    await page.keyboard.press('ArrowDown')
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const el = document.querySelector(
              '[role="option"][aria-selected="true"][data-slide-id]',
            )
            return el?.getAttribute('data-slide-id') ?? null
          }),
        { timeout: 3000 },
      )
      .toBe(slides[2]!.id)

    // ArrowUp → back to index 1.
    await page.keyboard.press('ArrowUp')
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const el = document.querySelector(
              '[role="option"][aria-selected="true"][data-slide-id]',
            )
            return el?.getAttribute('data-slide-id') ?? null
          }),
        { timeout: 3000 },
      )
      .toBe(slides[1]!.id)
  })
})

// ---------------------------------------------------------------------------
// Present mode keyboard navigation
// ---------------------------------------------------------------------------

test.describe('Present mode keyboard shortcuts', () => {
  test('ArrowRight, Space, PageDown all advance the slide; Esc returns to editor', async ({
    page,
  }) => {
    test.setTimeout(60_000)
    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)

    // Add 3 more slides → 4 total.
    await page.evaluate(() => {
      const api = window.__narrative_test_api!
      api.addSlide()
      api.addSlide()
      api.addSlide()
    })

    // Enter present mode via the dedicated route.
    await page.goto(`/deck/${deckId}/present`)
    // Wait for present-mode to mount (URL is enough — there's no
    // testApi reinstall on this route; SlideDocProvider runs again).
    await expect
      .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 15_000 })
      .toBe('object')

    const slideIds = await page.evaluate(() =>
      window.__narrative_test_api!.listSlides().map((s) => s.id),
    )
    expect(slideIds.length).toBe(4)

    /** Read the active slide id via the same selector the slides panel uses. */
    const getActiveId = async (): Promise<string | null> =>
      page.evaluate(() => {
        const el = document.querySelector('[role="option"][aria-selected="true"][data-slide-id]')
        return el?.getAttribute('data-slide-id') ?? null
      })

    // ArrowRight → next.
    await page.keyboard.press('ArrowRight')
    await expect.poll(getActiveId, { timeout: 3000 }).toBe(slideIds[1]!)

    // Space → next.
    await page.keyboard.press(' ')
    await expect.poll(getActiveId, { timeout: 3000 }).toBe(slideIds[2]!)

    // PageDown → next.
    await page.keyboard.press('PageDown')
    await expect.poll(getActiveId, { timeout: 3000 }).toBe(slideIds[3]!)

    // Esc → exit present mode (URL drops the /present suffix).
    await page.keyboard.press('Escape')
    await expect.poll(() => page.url(), { timeout: 5000 }).not.toMatch(/\/present$/)
  })
})
