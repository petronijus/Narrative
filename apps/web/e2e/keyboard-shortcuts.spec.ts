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
import { uploadTestPicture } from './fixtures/media'

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

// ---------------------------------------------------------------------------
// Canvas object shortcuts — moves carry the crop, duplicates are one undo step
// ---------------------------------------------------------------------------

/**
 * The undo manager merges LOCAL_ORIGIN writes that land within 500 ms of
 * each other into one step. Seeding goes through the same origin, so a
 * spec that undoes "the action" waits this long after seeding, or Mod+Z
 * would take the seed with it.
 */
const UNDO_CAPTURE_GAP_MS = 700

type Rect4 = { x: number; y: number; width: number; height: number }

async function objectState(
  page: Page,
  id: string,
): Promise<{ x: number; y: number; imageRect?: Rect4 } | null> {
  return page.evaluate((objId) => {
    const o = window.__narrative_test_api!.getObject(objId)
    if (o === null) return null
    return {
      x: o['x'] as number,
      y: o['y'] as number,
      ...(o['imageRect'] !== undefined ? { imageRect: o['imageRect'] as Rect4 } : {}),
    }
  }, id)
}

/** Select `ids`, re-issuing until the editor's object list has caught up. */
async function selectWhenKnown(page: Page, ids: string[]): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((want) => {
          const api = window.__narrative_test_api!
          const sel = api.getSelection()
          if (want.some((id) => !sel.includes(id))) api.setSelection(want)
          return [...api.getSelection()].sort()
        }, ids),
      { timeout: 10_000 },
    )
    .toEqual([...ids].sort())
}

/** Slide-space (1920×1080) point → viewport point, via the artboard's box. */
async function slideToViewport(
  page: Page,
  sx: number,
  sy: number,
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ x, y }) => {
      const artboard = document.querySelector<HTMLElement>('.artboard')
      if (artboard === null) throw new Error('artboard not found')
      const r = artboard.getBoundingClientRect()
      const scale = r.width / 1920
      return { x: r.left + x * scale, y: r.top + y * scale }
    },
    { x: sx, y: sy },
  )
}

test.describe('Canvas object shortcuts', () => {
  test('arrow nudge carries a cropped image with its frame, undone together', async ({ page }) => {
    test.setTimeout(30_000)
    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)

    const crop = { x: 150, y: 120, width: 600, height: 450 }
    const assetId = await uploadTestPicture(page.request, deckId)
    await page.evaluate(
      ({ imageRect, assetId }) =>
        window.__narrative_test_api!.addImage({
          id: 'img-nudge',
          x: 200,
          y: 200,
          w: 400,
          h: 300,
          imageRect,
          assetId,
        }),
      { imageRect: crop, assetId },
    )
    await selectWhenKnown(page, ['img-nudge'])
    await page.waitForTimeout(UNDO_CAPTURE_GAP_MS)

    // 1 px right: frame AND crop move — a crop left behind slides the
    // picture inside its frame.
    await page.keyboard.press('ArrowRight')
    await expect
      .poll(() => objectState(page, 'img-nudge'), { timeout: 3000 })
      .toEqual({ x: 201, y: 200, imageRect: { ...crop, x: 151 } })

    // The crop is part of the same undo step as the frame.
    await page.keyboard.press('ControlOrMeta+z')
    await expect
      .poll(() => objectState(page, 'img-nudge'), { timeout: 3000 })
      .toEqual({ x: 200, y: 200, imageRect: crop })
    await page.waitForTimeout(UNDO_CAPTURE_GAP_MS)

    // Shift = 10 px.
    await page.keyboard.press('Shift+ArrowDown')
    await expect
      .poll(() => objectState(page, 'img-nudge'), { timeout: 3000 })
      .toEqual({ x: 200, y: 210, imageRect: { ...crop, y: 130 } })
  })

  test('Mod+D duplicates the selection in one undo step and selects the copies', async ({
    page,
  }) => {
    test.setTimeout(30_000)
    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)

    await page.evaluate(() => {
      const api = window.__narrative_test_api!
      api.addRect({ id: 'dup-a', x: 100, y: 100, w: 200, h: 120, fill: 0xff0000 })
      api.addRect({ id: 'dup-b', x: 400, y: 100, w: 200, h: 120, fill: 0x00ff00 })
    })
    await selectWhenKnown(page, ['dup-a', 'dup-b'])
    await page.waitForTimeout(UNDO_CAPTURE_GAP_MS)

    await page.keyboard.press('ControlOrMeta+d')
    await expect
      .poll(() => page.evaluate(() => window.__narrative_test_api!.objectCount()), {
        timeout: 3000,
      })
      .toBe(4)
    const ids = await page.evaluate(() => window.__narrative_test_api!.objectIds())
    const copies = ids.filter((id) => id !== 'dup-a' && id !== 'dup-b')
    expect(copies).toHaveLength(2)
    expect(
      [...(await page.evaluate(() => window.__narrative_test_api!.getSelection()))].sort(),
    ).toEqual([...copies].sort())

    await page.keyboard.press('ControlOrMeta+z')
    await expect
      .poll(() => page.evaluate(() => window.__narrative_test_api!.objectIds()), {
        timeout: 3000,
      })
      .toEqual(['dup-a', 'dup-b'])
  })

  test('Alt-drag duplicates, drags the copy, and undoes as one step', async ({ page }) => {
    test.setTimeout(30_000)
    // Large enough that the artboard point we press on is not under chrome.
    await page.setViewportSize({ width: 1920, height: 1080 })
    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)

    await page.evaluate(() =>
      window.__narrative_test_api!.addRect({
        id: 'alt-src',
        x: 600,
        y: 300,
        w: 300,
        h: 200,
        fill: 0x3366ff,
      }),
    )
    // Not pre-selected: pressing on an unselected object selects it and
    // starts the drag in the same pointerdown, through the canvas hit-test
    // rather than any selection chrome.
    await expect
      .poll(
        () => page.evaluate(() => window.__narrative_test_api!.sceneGraphHasMountedNode('alt-src')),
        { timeout: 10_000 },
      )
      .toBe(true)
    await page.waitForTimeout(UNDO_CAPTURE_GAP_MS)

    const from = await slideToViewport(page, 750, 400)
    const to = await slideToViewport(page, 950, 500)
    await page.mouse.move(from.x, from.y)
    await page.keyboard.down('Alt')
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 6 })
    await page.mouse.up()
    await page.keyboard.up('Alt')

    // The source stays; the copy followed the pointer.
    await expect
      .poll(() => page.evaluate(() => window.__narrative_test_api!.objectCount()), {
        timeout: 3000,
      })
      .toBe(2)
    expect(await objectState(page, 'alt-src')).toEqual({ x: 600, y: 300 })
    const copyId = (await page.evaluate(() => window.__narrative_test_api!.objectIds())).find(
      (id) => id !== 'alt-src',
    )!
    const copy = await objectState(page, copyId)
    expect(copy!.x).toBeGreaterThan(600)
    expect(copy!.y).toBeGreaterThan(300)
    expect(await page.evaluate(() => window.__narrative_test_api!.getSelection())).toEqual([copyId])

    // One Mod+Z takes back the whole gesture — copy gone, not just moved
    // back onto the source (the old origin-less clone was not undoable).
    await page.keyboard.press('ControlOrMeta+z')
    await expect
      .poll(() => page.evaluate(() => window.__narrative_test_api!.objectIds()), {
        timeout: 3000,
      })
      .toEqual(['alt-src'])
    expect(await objectState(page, 'alt-src')).toEqual({ x: 600, y: 300 })
  })
})

// ---------------------------------------------------------------------------
// Snapping: toolbar toggle + ⌘ / Ctrl held during a drag
// ---------------------------------------------------------------------------

/**
 * An anchor to snap against and a small mover below it. The mover's left
 * edge is dragged to 4 slide px right of the anchor's left edge (x 600):
 * inside the 6 px snap threshold, and off the 10 px grid, so a snapped
 * drag lands on exactly 600 and a free one near 604.
 */
async function setUpSnapScene(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = window.__narrative_test_api!
    api.addRect({ id: 'snap-anchor', x: 600, y: 200, w: 300, h: 200, fill: 0x3366ff })
    api.addRect({ id: 'snap-mover', x: 200, y: 600, w: 200, h: 100, fill: 0xff6633 })
  })
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__narrative_test_api!.sceneGraphHasMountedNode('snap-anchor') &&
            window.__narrative_test_api!.sceneGraphHasMountedNode('snap-mover'),
        ),
      { timeout: 10_000 },
    )
    .toBe(true)
}

/** Press the mover and carry it so its left edge would sit at x 604. */
async function pressAndCarryMover(page: Page): Promise<void> {
  const from = await slideToViewport(page, 300, 650)
  const to = await slideToViewport(page, 704, 650)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
}

const FREE_X = 604

test.describe('Snapping', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
  })

  test('holding Mod frees a drag from snapping; without it the drag snaps', async ({ page }) => {
    test.setTimeout(30_000)
    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)
    await setUpSnapScene(page)

    await pressAndCarryMover(page)
    await page.mouse.up()
    await expect.poll(() => objectState(page, 'snap-mover')).toEqual({ x: 600, y: 600 })

    // Back to the start, then the same drag with Mod held throughout.
    await page.evaluate(() =>
      window.__narrative_test_api!.updateObject('snap-mover', { x: 200, y: 600 }),
    )
    await expect.poll(() => objectState(page, 'snap-mover')).toEqual({ x: 200, y: 600 })
    await page.keyboard.down('ControlOrMeta')
    await pressAndCarryMover(page)
    await page.mouse.up()
    await page.keyboard.up('ControlOrMeta')
    const free = await objectState(page, 'snap-mover')
    expect(Math.abs(free!.x - FREE_X)).toBeLessThanOrEqual(2)
    expect(free!.x).not.toBe(600)
    // Whole slide px — a free drag does not leave sub-pixel coordinates.
    expect(Number.isInteger(free!.x)).toBe(true)
  })

  test('Mod acts live: pressing and releasing it mid-drag re-applies the frame', async ({
    page,
  }) => {
    test.setTimeout(30_000)
    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)
    await setUpSnapScene(page)

    await pressAndCarryMover(page)
    await expect.poll(() => objectState(page, 'snap-mover')).toEqual({ x: 600, y: 600 })

    // The pointer stands still; only the modifier changes.
    await page.keyboard.down('ControlOrMeta')
    await expect
      .poll(async () => Math.abs((await objectState(page, 'snap-mover'))!.x - FREE_X))
      .toBeLessThanOrEqual(2)
    await page.keyboard.up('ControlOrMeta')
    await expect.poll(() => objectState(page, 'snap-mover')).toEqual({ x: 600, y: 600 })

    await page.mouse.up()
  })

  test('the toolbar toggle turns snapping off, and Mod then snaps', async ({ page }) => {
    test.setTimeout(30_000)
    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)
    await setUpSnapScene(page)

    const toggle = page.getByTestId('toolbar-snapping')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')

    await pressAndCarryMover(page)
    await page.mouse.up()
    const free = await objectState(page, 'snap-mover')
    expect(Math.abs(free!.x - FREE_X)).toBeLessThanOrEqual(2)
    expect(free!.x).not.toBe(600)

    await page.evaluate(() =>
      window.__narrative_test_api!.updateObject('snap-mover', { x: 200, y: 600 }),
    )
    await expect.poll(() => objectState(page, 'snap-mover')).toEqual({ x: 200, y: 600 })
    await page.keyboard.down('ControlOrMeta')
    await pressAndCarryMover(page)
    await page.mouse.up()
    await page.keyboard.up('ControlOrMeta')
    await expect.poll(() => objectState(page, 'snap-mover')).toEqual({ x: 600, y: 600 })

    // The preference outlives a reload.
    await page.reload()
    await expect(page.getByTestId('toolbar-snapping')).toHaveAttribute('aria-pressed', 'false')
  })

  test('a resize with Mod held follows the handle without snapping', async ({ page }) => {
    test.setTimeout(30_000)
    const deckId = await createDeck(page)
    await openDeckReady(page, deckId)
    await setUpSnapScene(page)
    await selectWhenKnown(page, ['snap-mover'])

    // Bottom-right handle from the mover's right edge (400) to 904 — 4 px
    // past the anchor's right edge (900), inside the snap threshold.
    const handle = page.getByLabel('Resize bottom-right handle')
    const box = (await handle.boundingBox())!
    const to = await slideToViewport(page, 904, 700)
    await page.keyboard.down('ControlOrMeta')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 8 })
    await page.mouse.up()
    await page.keyboard.up('ControlOrMeta')

    const o = await page.evaluate(() => window.__narrative_test_api!.getObject('snap-mover'))
    // The box keeps its origin; only the dragged edge moved, freely.
    expect(o!['x']).toBe(200)
    expect(o!['y']).toBe(600)
    expect(Math.abs((o!['x'] as number) + (o!['width'] as number) - 904)).toBeLessThanOrEqual(2)
  })
})
