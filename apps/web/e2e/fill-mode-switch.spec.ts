import { test, expect, type Page } from '@playwright/test'

/**
 * Repro spec: switching fill method Linear → Solid leaves gradient visible.
 *
 * Strategy:
 * 1. Create deck via API, open it.
 * 2. Seed a BLUE rectangle (0x3b82f6) via testApi — blue is clearly
 *    distinguishable from the gradient tint (a darker blue) and from the
 *    slide background (white). Gradient endpoint will be ~0x20476f.
 * 3. Select it, confirm Inspector shows "Solid".
 * 4. Switch to "Linear" — gradient is applied.
 * 5. Switch back to "Solid" — wait for thumbnail debounce + re-render.
 * 6. Read the thumbnail <img> src (data URL) and sample pixels via an
 *    offscreen 2D canvas — the thumbnail IS a raster so it IS readable.
 *    After switching back to solid the thumbnail must show uniform blue.
 * 7. Also read Y.Doc state: fillStyle must be undefined after solid switch.
 *
 * Pixel sampling rationale:
 * - The main Pixi canvas uses WebGL. Without preserveDrawingBuffer the
 *   buffer is cleared after each composite — drawImage to a 2D canvas
 *   returns transparent black. We avoid that by sampling the thumbnail
 *   <img> instead. The thumbnail is rendered by a separate offscreen Pixi
 *   instance that renders to a PNG data URL (pure raster, readable).
 *
 * If fillStyle is still present after switch-to-solid → Inspector state bug.
 * If fillStyle is cleared but thumbnail still dark → renderer/thumbnail bug.
 */

const RECT_ID = 'fill-test-rect'
// Blue: clearly not white (slide bg) and not near-black. Gradient endpoint
// is Math.round(0x3b * 0.55) etc = ~0x20476f (clearly darker blue).
const RECT_FILL = 0x3b82f6

async function createDeck(page: Page): Promise<string> {
  const res = await page.request.post('http://localhost:3001/decks', {
    data: { title: 'fill-mode-switch-repro' },
  })
  const { id } = (await res.json()) as { id: string }
  return id
}

interface PixelSample {
  r: number
  g: number
  b: number
  a: number
}

/**
 * Decode the slide thumbnail <img> data URL and sample one pixel at
 * (normX, normY) in [0,1] normalised coordinates.
 *
 * The thumbnail is a PNG data URL — it can be drawn onto a 2D canvas and
 * pixel-sampled without any WebGL readback issues.
 */
async function sampleThumbnailPixel(
  page: Page,
  normX: number,
  normY: number,
): Promise<PixelSample> {
  return page.evaluate(
    async ({ normX, normY }) => {
      // The slide panel renders thumbnails as <img> elements.
      // Find the first visible thumbnail (current slide).
      const img = document.querySelector('.slide-thumbnail-img') as HTMLImageElement | null
      if (img === null || !img.src.startsWith('data:')) {
        // Fallback: try any img with a data: src
        const fallback = Array.from(document.querySelectorAll('img')).find((el) =>
          el.src.startsWith('data:image/png'),
        ) as HTMLImageElement | undefined
        if (fallback === undefined) throw new Error('no thumbnail img found')
        const src = fallback.src
        return new Promise<{ r: number; g: number; b: number; a: number }>((res, rej) => {
          const tmp = new Image()
          tmp.onload = () => {
            const c = document.createElement('canvas')
            c.width = tmp.naturalWidth
            c.height = tmp.naturalHeight
            const ctx = c.getContext('2d')!
            ctx.drawImage(tmp, 0, 0)
            const px = Math.round(normX * (tmp.naturalWidth - 1))
            const py = Math.round(normY * (tmp.naturalHeight - 1))
            const d = ctx.getImageData(px, py, 1, 1).data
            res({ r: d[0], g: d[1], b: d[2], a: d[3] })
          }
          tmp.onerror = () => rej(new Error('img load failed'))
          tmp.src = src
        })
      }
      const src = img.src
      return new Promise<{ r: number; g: number; b: number; a: number }>((res, rej) => {
        const tmp = new Image()
        tmp.onload = () => {
          const c = document.createElement('canvas')
          c.width = tmp.naturalWidth
          c.height = tmp.naturalHeight
          const ctx = c.getContext('2d')!
          ctx.drawImage(tmp, 0, 0)
          const px = Math.round(normX * (tmp.naturalWidth - 1))
          const py = Math.round(normY * (tmp.naturalHeight - 1))
          const d = ctx.getImageData(px, py, 1, 1).data
          res({ r: d[0], g: d[1], b: d[2], a: d[3] })
        }
        tmp.onerror = () => rej(new Error('img load failed'))
        tmp.src = src
      })
    },
    { normX, normY },
  )
}

/**
 * Wait until the thumbnail <img> src changes. Returns the new src (data URL).
 * Polls until src changes from `prevSrc` or timeout.
 */
async function waitForThumbnailUpdate(page: Page, prevSrc: string): Promise<string> {
  let newSrc = prevSrc
  await expect
    .poll(
      async () => {
        newSrc = await page.evaluate((): string => {
          const img = document.querySelector('.slide-thumbnail-img') as HTMLImageElement | null
          if (img !== null) return img.src
          const fallback = Array.from(document.querySelectorAll('img')).find((el) =>
            el.src.startsWith('data:image/png'),
          ) as HTMLImageElement | undefined
          return fallback?.src ?? ''
        })
        return newSrc !== prevSrc
      },
      { timeout: 3000, intervals: [100, 200, 300] },
    )
    .toBe(true)
  return newSrc
}

/** Get current thumbnail img src. */
async function getThumbnailSrc(page: Page): Promise<string> {
  return page.evaluate((): string => {
    const img = document.querySelector('.slide-thumbnail-img') as HTMLImageElement | null
    if (img !== null) return img.src
    const fallback = Array.from(document.querySelectorAll('img')).find((el) =>
      el.src.startsWith('data:image/png'),
    ) as HTMLImageElement | undefined
    return fallback?.src ?? ''
  })
}

test('fill-mode: Linear → Solid clears gradient in state AND thumbnail', async ({ page }) => {
  test.setTimeout(90_000)

  const consoleErrors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => consoleErrors.push(`[pageerror] ${err.message}`))

  // 1. Create deck and open it
  const deckId = await createDeck(page)
  await page.goto(`/deck/${deckId}`)

  // Wait for testApi to be installed
  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 15_000 })
    .toBe('object')

  // 2. Seed a blue rectangle
  await page.evaluate(
    ({ rectId, fill }) => {
      window.__narrative_test_api!.addRect({ id: rectId, x: 200, y: 150, w: 600, h: 400, fill })
    },
    { rectId: RECT_ID, fill: RECT_FILL },
  )

  // 3. Wait for SceneGraph to mount the rect
  await expect
    .poll(
      () =>
        page.evaluate((id) => window.__narrative_test_api!.sceneGraphHasMountedNode(id), RECT_ID),
      { timeout: 8000, intervals: [200, 300, 500] },
    )
    .toBe(true)

  // Select it so Inspector shows the Appearance section
  await page.evaluate((id) => window.__narrative_test_api!.setSelection([id]), RECT_ID)
  await page.waitForTimeout(200)

  // Confirm selection
  await expect
    .poll(() => page.evaluate(() => window.__narrative_test_api!.getSelection()), { timeout: 5000 })
    .toContain(RECT_ID)

  // 4. Inspector should show Fill type = Solid
  const fillSelect = page.getByLabel('Fill type')
  await expect(fillSelect).toBeVisible({ timeout: 5000 })
  await expect(fillSelect).toHaveValue('solid')

  // Capture initial state
  await page.screenshot({ path: 'test-results/fill-mode-01-solid-initial.png' })

  // Wait for thumbnail to reflect the solid blue rect (thumbnail debounce = 500 ms)
  // We can't assert fill color yet because the rect might still be rendering for
  // the first time. Just record the current src to detect changes.
  await page.waitForTimeout(800)
  const srcAfterSolid = await getThumbnailSrc(page)
  console.log('Thumbnail src after solid (length):', srcAfterSolid.length)

  // 5. Switch to Linear gradient
  await fillSelect.selectOption('linearGradient')
  await page.waitForTimeout(200)
  await expect(fillSelect).toHaveValue('linearGradient')

  // Read Y.Doc state after switching to linear
  const stateAfterLinear = await page.evaluate(
    ({ rectId }) => window.__narrative_test_api!.getObject(rectId),
    { rectId: RECT_ID },
  )
  console.log('State after Linear:', JSON.stringify(stateAfterLinear?.fillStyle ?? 'undefined'))

  // Wait for thumbnail to update (debounce 500 ms + render async)
  let srcAfterLinear = srcAfterSolid
  try {
    srcAfterLinear = await waitForThumbnailUpdate(page, srcAfterSolid)
    console.log('Thumbnail updated after Linear switch.')
  } catch {
    console.log('Thumbnail did not update after Linear switch (may already match).')
  }

  await page.screenshot({ path: 'test-results/fill-mode-02-linear-applied.png' })

  // Rect is at slide coords (200, 150) size 600×400 on a 1920×1080 slide.
  // Normalised coords of rect center in the thumbnail:
  //   normX = (200 + 300) / 1920 ≈ 0.26,  normY = (150 + 200) / 1080 ≈ 0.32
  // Bottom-right of rect: normX = (200+600)/1920 ≈ 0.42, normY = (150+400)/1080 ≈ 0.51
  const RECT_CENTER_X = (200 + 300) / 1920
  const RECT_CENTER_Y = (150 + 200) / 1080
  const RECT_BR_X = (200 + 580) / 1920 // slightly inside the bottom-right corner
  const RECT_BR_Y = (150 + 380) / 1080

  const pixelLinearCenter = await sampleThumbnailPixel(page, RECT_CENTER_X, RECT_CENTER_Y)
  const pixelLinearBottomRight = await sampleThumbnailPixel(page, RECT_BR_X, RECT_BR_Y)
  console.log('Linear center pixel:', JSON.stringify(pixelLinearCenter))
  console.log('Linear bottom-right pixel:', JSON.stringify(pixelLinearBottomRight))

  // 6. Switch BACK to Solid
  await fillSelect.selectOption('solid')
  await page.waitForTimeout(200)
  await expect(fillSelect).toHaveValue('solid')

  // 7. Read Y.Doc state after switching back to solid
  const stateAfterSolid = await page.evaluate(
    ({ rectId }) => window.__narrative_test_api!.getObject(rectId),
    { rectId: RECT_ID },
  )
  const fillStyleAfterSolid = stateAfterSolid?.fillStyle
  console.log('State after Solid:', JSON.stringify(fillStyleAfterSolid ?? 'undefined'))

  // Wait for thumbnail to update (debounce 500 ms + render)
  let srcAfterSolidRestore = srcAfterLinear
  try {
    srcAfterSolidRestore = await waitForThumbnailUpdate(page, srcAfterLinear)
    console.log('Thumbnail updated after Solid restore.')
  } catch {
    console.log('WARNING: Thumbnail did NOT update after switching back to Solid. This is the bug.')
  }

  await page.screenshot({ path: 'test-results/fill-mode-03-solid-restored.png' })

  // Sample thumbnail pixels at the same positions
  const pixelSolidCenter = await sampleThumbnailPixel(page, RECT_CENTER_X, RECT_CENTER_Y)
  const pixelSolidBottomRight = await sampleThumbnailPixel(page, RECT_BR_X, RECT_BR_Y)
  console.log('Solid-restored center pixel:', JSON.stringify(pixelSolidCenter))
  console.log('Solid-restored bottom-right pixel:', JSON.stringify(pixelSolidBottomRight))

  // Helper: is pixel "near blue" (0x3b82f6 = rgb(59, 130, 246))?
  const isNearBlue = (p: PixelSample): boolean => p.b > 200 && p.r < 120 && p.g > 80 && p.g < 200

  // Helper: is pixel significantly darker than the expected blue?
  const isDarkGradient = (p: PixelSample): boolean => {
    const luma = 0.299 * p.r + 0.587 * p.g + 0.114 * p.b
    return p.a > 100 && luma < 100
  }

  // === Assertions ===

  // A. Y.Doc: fillStyle must be gone (undefined in JSON = key absent)
  expect(
    fillStyleAfterSolid,
    `Y.Doc still has fillStyle after switching to Solid: ${JSON.stringify(fillStyleAfterSolid)}`,
  ).toBeUndefined()

  // B. Thumbnail must have updated (src changed from linear state)
  expect(
    srcAfterSolidRestore,
    'Thumbnail src did not change after switching back to Solid — thumbnail stuck on gradient',
  ).not.toBe(srcAfterLinear)

  // C. The bottom-right corner should NOT be a dark gradient (gradient bottom-right
  //    is ~0x20476f = luma ~55). After solid restore it should be uniform blue.
  expect(
    isDarkGradient(pixelSolidBottomRight),
    `Bottom-right thumbnail pixel is still dark after solid restore: ${JSON.stringify(pixelSolidBottomRight)}. Gradient still rendering.`,
  ).toBe(false)

  // D. Center pixel should be near-blue (matching the rect fill)
  expect(
    isNearBlue(pixelSolidCenter) || pixelSolidCenter.a === 0, // a=0 means the rect isn't visible at that position — ok if slide bg is visible
    `Center thumbnail pixel is not near-blue after solid restore: ${JSON.stringify(pixelSolidCenter)}.`,
  ).toBe(true)

  // E. No JS errors (filter known Pixi/HocusPocus warnings)
  const realErrors = consoleErrors.filter(
    (e) =>
      !e.includes('No available adapters') &&
      !e.includes('HocuspocusProvider') &&
      !e.includes('WebSocket') &&
      !e.includes('Failed to load resource') &&
      !e.includes('404'),
  )
  expect(realErrors, `unexpected JS errors: ${realErrors.join(' | ')}`).toHaveLength(0)
})

/**
 * Rapid-switch variant: switch Linear → Solid without waiting for the
 * 200 ms CSS close animation to complete. This exercises the race condition
 * where the GradientEditor is still mounted (inside the collapsing wrapper)
 * and could fire onChange before it unmounts.
 *
 * If fillStyle reappears in Y.Doc after this rapid switch → Inspector bug
 * (onChange fires during close animation and re-applies gradient to state).
 */
test('fill-mode: rapid Linear → Solid does not leak gradient to Y.Doc', async ({ page }) => {
  test.setTimeout(60_000)

  const stateUpdates: string[] = []
  // Track all object updates to catch gradient re-application during close animation
  page.on('console', (msg) => {
    if (msg.type() === 'verbose' || msg.text().includes('fillStyle')) {
      stateUpdates.push(msg.text())
    }
  })

  const deckId = await (async () => {
    const res = await page.request.post('http://localhost:3001/decks', {
      data: { title: 'fill-mode-rapid-switch' },
    })
    const { id } = (await res.json()) as { id: string }
    return id
  })()
  await page.goto(`/deck/${deckId}`)

  await expect
    .poll(() => page.evaluate(() => typeof window.__narrative_test_api), { timeout: 15_000 })
    .toBe('object')

  const RAPID_ID = 'rapid-test-rect'
  await page.evaluate(
    ({ id, fill }) => {
      window.__narrative_test_api!.addRect({ id, x: 200, y: 150, w: 600, h: 400, fill })
    },
    { id: RAPID_ID, fill: 0x3b82f6 },
  )

  await expect
    .poll(
      () =>
        page.evaluate((id) => window.__narrative_test_api!.sceneGraphHasMountedNode(id), RAPID_ID),
      { timeout: 8000 },
    )
    .toBe(true)

  await page.evaluate((id) => window.__narrative_test_api!.setSelection([id]), RAPID_ID)
  await page.waitForTimeout(200)

  const fillSelect = page.getByLabel('Fill type')
  await expect(fillSelect).toBeVisible({ timeout: 5000 })
  await expect(fillSelect).toHaveValue('solid')

  // Switch to linear
  await fillSelect.selectOption('linearGradient')
  // NO wait — immediately switch back (tests the race window during animation)
  await fillSelect.selectOption('solid')

  // Now wait for 500 ms so any delayed re-apply would have fired
  await page.waitForTimeout(600)

  const stateAfterRapid = await page.evaluate(
    (id) => window.__narrative_test_api!.getObject(id),
    RAPID_ID,
  )
  const fillStyleAfterRapid = stateAfterRapid?.fillStyle
  console.log('Rapid-switch fillStyle:', JSON.stringify(fillStyleAfterRapid ?? 'undefined'))

  expect(
    fillStyleAfterRapid,
    `Y.Doc has fillStyle=${JSON.stringify(fillStyleAfterRapid)} after rapid Linear→Solid switch — ` +
      `onChange fired during close animation and re-applied gradient to state`,
  ).toBeUndefined()
})
