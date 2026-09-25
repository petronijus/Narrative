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
/**
 * The armed tool, read off the toolbar root's `data-active-tool`.
 *
 * This used to scrape the first `button[aria-pressed="true"]` in the document
 * and take the first word of its aria-label. Both halves rotted: the shape
 * tools now live behind a dropdown (so no toolbar button is pressed for
 * "rectangle"), and other pressed buttons — the rulers toggle, inspector
 * segment controls — match the selector first.
 */
async function getActiveTool(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.querySelector('[role="toolbar"]')?.getAttribute('data-active-tool') ?? null,
  )
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

    // Add a rectangle so the inspector mounts, and let it reach the editor's
    // object state before selecting it: EditorLayout sanitises selections
    // against the objects it knows about, so selecting in the same tick as the
    // insert is dropped again immediately.
    await page.evaluate(() => {
      window.__narrative_test_api!.addRect({
        id: 'rect-keyboard-spec',
        x: 100,
        y: 100,
        w: 200,
        h: 100,
        fill: 0xff0000,
      })
    })
    await expect
      .poll(() => page.evaluate(() => window.__narrative_test_api!.objectIds()), {
        timeout: 10_000,
      })
      .toContain('rect-keyboard-spec')
    // Re-issue the selection until it sticks: it is dropped if the editor's
    // object list has not caught up yet, and a single dispatch that loses that
    // race is lost for good.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const api = window.__narrative_test_api!
            if (!api.getSelection().includes('rect-keyboard-spec')) {
              api.setSelection(['rect-keyboard-spec'])
            }
            return api.getSelection()
          }),
        { timeout: 10_000 },
      )
      .toEqual(['rect-keyboard-spec'])

    // Focus the object's X field. Not "the first number input on the page" —
    // that is the slide-transition duration, which is disabled until a
    // transition is set, so `focus()` was a no-op and the keypress went to
    // <body>, where the shortcut legitimately fires.
    const input = page.getByLabel('X position')
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

  test('Mod+D on a selected thumbnail duplicates the slide, not the canvas selection', async ({
    page,
  }) => {
    test.setTimeout(30_000)
    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)

    const second = await page.evaluate(() => {
      const api = window.__narrative_test_api!
      api.addSlide()
      const id = api.addSlide()
      api.addRect({ id: 'dup-rect', x: 100, y: 100, w: 200, h: 120 }, id)
      return id
    })
    const before = await page.evaluate(() => window.__narrative_test_api!.listSlideIds())
    expect(before.length).toBe(3)

    await page.locator(`[role="option"][data-slide-id="${second}"]`).click()
    // An object selected on the canvas too: the canvas's own Mod+D would
    // duplicate it. The slide list has the focus, so the slide is what's copied.
    await page.evaluate(() => window.__narrative_test_api!.setSelection(['dup-rect']))
    await page.keyboard.press('ControlOrMeta+d')

    await expect
      .poll(() => page.evaluate(() => window.__narrative_test_api!.listSlideIds().length), {
        timeout: 3000,
      })
      .toBe(4)
    const after = await page.evaluate(() => window.__narrative_test_api!.listSlideIds())
    const copy = after[3]!
    expect(after.slice(0, 3)).toEqual(before.slice(0, 3))
    expect(before).not.toContain(copy)
    // Right after the original, holding its content; the original untouched.
    expect(after.indexOf(copy)).toBe(after.indexOf(second) + 1)
    expect(await page.evaluate((id) => window.__narrative_test_api!.objectCount(id), second)).toBe(
      1,
    )
    expect(await page.evaluate((id) => window.__narrative_test_api!.objectCount(id), copy)).toBe(1)
    // And the copy is where the editor now is.
    await expect(
      page.locator(`[role="option"][aria-selected="true"][data-slide-id="${copy}"]`),
    ).toHaveCount(1)
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
    // Present mode renders no slides panel — the selected row in the editor's
    // panel (`[role="option"][aria-selected="true"]`) does not exist here, so
    // read the slide the presenter is actually showing.
    const getActiveId = async (): Promise<string | null> =>
      page.evaluate(
        () =>
          document
            .querySelector('[data-testid="slide-container"]')
            ?.getAttribute('data-active-slide-id') ?? null,
      )

    // The presenter opens on the first slide. Wait for that before pressing a
    // key — the deck route mounts, syncs and paints asynchronously, and a key
    // pressed into the gap is delivered to a view that has not decided which
    // slide it is showing yet.
    await expect.poll(getActiveId, { timeout: 10_000 }).toBe(slideIds[0]!)

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
